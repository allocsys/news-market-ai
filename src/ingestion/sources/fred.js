// FRED / ALFRED adapter for XAUUSD macro context (ingestion/ingest.js#ingestMacro).
//
// POINT-IN-TIME: every request asks for ALL vintages from observationStart on
// (realtime_start=observationStart, realtime_end=9999-12-31), so each
// returned row carries the `realtime_start` date on which that value first became
// known. A later revision of the same observation date comes back as another row
// with a later realtime_start. available_at is the start of the UTC day AFTER
// realtime_start: day-granular vintages give no intraday release time, and the
// codebase already treats a daily value as unusable until the next UTC day
// (shared/price_availability.js). Slightly conservative on purpose.
//
// UNVERIFIED AGAINST THE LIVE API from this sandbox (egress to api.stlouisfed.org
// is blocked): the parameter names and row shape follow FRED's documented
// series/observations endpoint, and test/macro_adapters.test.js pins that shape
// with a mocked fetch. First live tick should be checked in observability.
//
// Requires config.fredApiKey (FRED_API_KEY, a free key). Error messages never
// include the request URL, which carries the key.

import { VendorError } from "../../shared/errors.js";
import { createThrottle } from "../../shared/throttle.js";
import { fetchWithTimeout } from "../../shared/fetch_with_timeout.js";

/** 10y TIPS real yield, broad dollar index, fed funds, 10y breakeven inflation, CPI (SA). */
export const DEFAULT_FRED_SERIES = Object.freeze(["DFII10", "DTWEXBGS", "DFF", "T10YIE", "CPIAUCSL"]);

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// FRED rejects a request (400) whose real-time period holds more than 2000 vintage dates, and a daily
// series (DFF, DFII10, T10YIE) has ~250 a year -- the old realtime_start=1776-07-04 made every one of
// them fail. An observation is first known on or after its own date, so starting the real-time period at
// observationStart loses no vintage. One request covers up to ~6 years of daily vintages (~1500); a longer
// backfill range is split into consecutive 5-year real-time windows.
const SINGLE_REQUEST_MAX_DAYS = 6 * 365;
const WINDOW_SPAN_DAYS = 5 * 365;

function addDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Real-time windows (`[{ start, end }]`, YYYY-MM-DD, contiguous, the last open-ended) that together cover observationStart..now. */
export function realtimeWindows(observationStart, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const spanDays = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${observationStart}T00:00:00Z`)) / DAY_MS;
  if (!(spanDays > SINGLE_REQUEST_MAX_DAYS)) return [{ start: observationStart, end: "9999-12-31" }];
  const windows = [];
  for (let start = observationStart; start <= today; ) {
    const end = addDays(start, WINDOW_SPAN_DAYS - 1);
    if (end >= today) {
      windows.push({ start, end: "9999-12-31" });
      break;
    }
    windows.push({ start, end });
    start = addDays(end, 1);
  }
  return windows;
}

/** Start of the UTC day after `realtimeStart` (YYYY-MM-DD) as an ISO string, or null when malformed. */
export function fredAvailableAt(realtimeStart) {
  if (!DATE_RE.test(String(realtimeStart ?? ""))) return null;
  const t = Date.parse(`${realtimeStart}T00:00:00Z`);
  return Number.isNaN(t) ? null : new Date(t + DAY_MS).toISOString();
}

const ERROR_DETAIL_MAX = 200;

/**
 * Short, key-free snippet of a non-OK FRED response body (FRED answers errors with
 * `{"error_code":400,"error_message":"..."}`), so a 400 says WHY in the logs. Any
 * `api_key=` value and the configured key itself are scrubbed. "" when the body
 * cannot be read.
 */
async function fredErrorDetail(response, apiKey) {
  let text;
  try {
    text = typeof response.text === "function" ? await response.text() : "";
  } catch {
    return "";
  }
  let detail = String(text ?? "");
  try {
    const parsed = JSON.parse(detail);
    if (typeof parsed?.error_message === "string") detail = parsed.error_message;
  } catch {
    // not JSON: use the raw text
  }
  detail = detail.replace(/api_key=[^&\s"']*/gi, "api_key=***");
  if (apiKey) detail = detail.split(apiKey).join("***");
  detail = detail.replace(/\s+/g, " ").trim().slice(0, ERROR_DETAIL_MAX);
  return detail === "{}" || detail === "[]" ? "" : detail;
}

/**
 * One series, every vintage from `observationStart` (YYYY-MM-DD) on, as
 * `[{ series, obsDate, availableAt, val, source: "fred" }]`. Rows with a missing
 * value (FRED's "."), a malformed date or a non-numeric value are skipped.
 * Throws a VendorError (transient on network failure, 429, 5xx) -- a missing key is
 * a non-transient VendorError thrown before any request.
 */
export async function fetchSeries(config, { series, observationStart, now }) {
  if (!DATE_RE.test(String(observationStart ?? ""))) {
    throw new Error(`fred.fetchSeries requires observationStart as YYYY-MM-DD (got "${observationStart}")`);
  }
  const windows = realtimeWindows(observationStart, now);
  const out = [];
  // obsDate -> last value seen in earlier windows. A value still current at a window boundary comes back from
  // the next window with realtime_start CLAMPED to that window's start; it is the same vintage, not a new one,
  // so it is dropped (a real revision has a different value and its own realtime_start).
  const lastVal = new Map();
  for (const w of windows) {
    const rows = await fetchWindow(config, { series, observationStart, realtimeStart: w.start, realtimeEnd: w.end });
    const clampedAvailableAt = fredAvailableAt(w.start);
    out.push(...(windows.length > 1 ? rows.filter((r) => !(r.availableAt === clampedAvailableAt && lastVal.get(r.obsDate) === r.val)) : rows));
    for (const r of [...rows].sort((a, b) => (a.availableAt < b.availableAt ? -1 : a.availableAt > b.availableAt ? 1 : 0))) lastVal.set(r.obsDate, r.val);
  }
  return out;
}

async function fetchWindow(config, { series, observationStart, realtimeStart, realtimeEnd }) {
  if (!config.fredApiKey) {
    throw new VendorError("fred", "config.fredApiKey is not set (FRED_API_KEY secret) -- see fred.js header");
  }
  if (!DATE_RE.test(String(observationStart ?? ""))) {
    throw new Error(`fred.fetchSeries requires observationStart as YYYY-MM-DD (got "${observationStart}")`);
  }

  const params = new URLSearchParams({
    series_id: series,
    api_key: config.fredApiKey,
    file_type: "json",
    observation_start: observationStart,
    realtime_start: realtimeStart,
    realtime_end: realtimeEnd,
  });

  let response;
  try {
    response = await fetchWithTimeout(`${config.fredApiBase}?${params}`, { timeoutMs: config.fetchTimeoutMs, headers: { Accept: "application/json" } });
  } catch (err) {
    throw new VendorError("fred", `network failure fetching FRED series ${series} (${err?.name ?? "error"})`, { transient: true });
  }
  if (!response.ok) {
    const detail = await fredErrorDetail(response, config.fredApiKey);
    throw new VendorError("fred", `FRED returned ${response.status} for series ${series}${detail ? `: ${detail}` : ""}`, {
      status: response.status,
      transient: response.status === 429 || response.status >= 500,
    });
  }

  const data = await response.json();
  const rows = Array.isArray(data?.observations) ? data.observations : [];
  const out = [];
  for (const row of rows) {
    if (!DATE_RE.test(String(row?.date ?? ""))) continue;
    if (row.value === undefined || row.value === null || row.value === "" || row.value === ".") continue;
    const val = Number(row.value);
    if (!Number.isFinite(val)) continue;
    const availableAt = fredAvailableAt(row.realtime_start);
    if (!availableAt) continue;
    out.push({ series, obsDate: row.date, availableAt, val, source: "fred" });
  }
  return out;
}

/**
 * Every configured series (default config.fredSeries, else DEFAULT_FRED_SERIES),
 * paced by config.fredMinRequestIntervalMs. Each series is its own failure domain:
 * a VendorError is collected in `errors` and the others still run (ingest.js logs
 * it); a non-VendorError (a bug) propagates. Returns `{ observations, errors }`.
 */
export async function fetchLatest(config, { series, observationStart } = {}) {
  const list = series ?? (config.fredSeries?.length ? config.fredSeries : DEFAULT_FRED_SERIES);
  const throttle = createThrottle({ minIntervalMs: config.fredMinRequestIntervalMs ?? 0 });
  const observations = [];
  const errors = [];
  for (const id of list) {
    await throttle.wait();
    try {
      observations.push(...(await fetchSeries(config, { series: id, observationStart })));
    } catch (err) {
      if (err instanceof VendorError) errors.push({ series: id, error: err });
      else throw err;
    }
  }
  return { observations, errors };
}
