// CFTC Commitments of Traders adapter: gold futures (COMEX, contract market code
// 088691), DISAGGREGATED futures-only report, managed-money long/short + open
// interest. Source: the CFTC Public Reporting Environment's Socrata API
// (config.cotApiBase, default dataset 72hh-3qpy), one row per report week.
//
// TIMING (the point-in-time part): a row's report_date_as_yyyy_mm_dd is the
// TUESDAY the positions were taken; CFTC publishes them the following FRIDAY
// (15:30 ET). available_at is therefore Saturday 00:00Z after that Friday --
// obs_date + 4 days -- or later when the row was first SEEN later (live ingestion
// passes `firstSeenAt`, so a late pickup is never back-dated into the past).
// KNOWN LIMIT: a federal-holiday week delays the release (to Monday or later), so
// for HISTORICAL backfill rows (no firstSeenAt) that week is treated as available
// a few days too early. Acceptable for a swing-timeframe context input; do not
// read it as an exact release calendar.
//
// UNVERIFIED AGAINST THE LIVE API from this sandbox (egress to publicreporting.cftc.gov
// is blocked). Field names follow the dataset's published columns
// (m_money_positions_long_all, m_money_positions_short_all, open_interest_all) and
// test/macro_adapters.test.js pins them with a mocked fetch. A quick live check:
//   curl 'https://publicreporting.cftc.gov/resource/72hh-3qpy.json?cftc_contract_market_code=088691&$limit=1&$order=report_date_as_yyyy_mm_dd%20DESC'
// Rows missing any of the three required fields are skipped, never zero-filled.

import { VendorError } from "../../shared/errors.js";
import { fetchWithTimeout } from "../../shared/fetch_with_timeout.js";

export const GOLD_COT_CODE = "088691";

export const COT_SERIES = Object.freeze({
  MM_LONG: "COT_GC_MM_LONG",
  MM_SHORT: "COT_GC_MM_SHORT",
  OPEN_INTEREST: "COT_GC_OI",
});

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * When a report for Tuesday `obsDate` may be used: Saturday 00:00Z after the Friday
 * release; with `firstSeenAt` (ISO), no earlier than the start of the UTC day after
 * it. Null when `obsDate` is malformed.
 */
export function cotAvailableAt(obsDate, firstSeenAt) {
  if (!DATE_RE.test(String(obsDate ?? ""))) return null;
  const release = Date.parse(`${obsDate}T00:00:00Z`) + 4 * DAY_MS;
  if (Number.isNaN(release)) return null;
  const seen = firstSeenAt ? Date.parse(firstSeenAt) : NaN;
  if (Number.isNaN(seen)) return new Date(release).toISOString();
  const nextDay = Math.floor(seen / DAY_MS) * DAY_MS + DAY_MS;
  return new Date(Math.max(release, nextDay)).toISOString();
}

function num(value) {
  if (value === undefined || value === null || value === "") return NaN;
  return Number(value);
}

/**
 * Gold COT rows with report date >= `from` (YYYY-MM-DD), as
 * `[{ series, obsDate, availableAt, val, source: "cftc" }]` (three rows per week).
 * `skipObsDates` (optional Set of YYYY-MM-DD) drops weeks already stored, so a live
 * tick does not re-insert them under a new availability time. Throws a VendorError
 * (transient on network failure, 429, 5xx).
 */
export async function fetchLatest(config, { from, firstSeenAt, skipObsDates } = {}) {
  if (!DATE_RE.test(String(from ?? ""))) {
    throw new Error(`cftc_cot.fetchLatest requires from as YYYY-MM-DD (got "${from}")`);
  }
  const params = new URLSearchParams({
    $where: `cftc_contract_market_code='${GOLD_COT_CODE}' AND report_date_as_yyyy_mm_dd >= '${from}T00:00:00.000'`,
    $order: "report_date_as_yyyy_mm_dd ASC",
    $limit: "5000",
  });
  const headers = { Accept: "application/json" };
  if (config.cotAppToken) headers["X-App-Token"] = config.cotAppToken;

  let response;
  try {
    response = await fetchWithTimeout(`${config.cotApiBase}?${params}`, { timeoutMs: config.fetchTimeoutMs, headers });
  } catch (err) {
    throw new VendorError("cftc", `network failure fetching CFTC COT (${err?.name ?? "error"})`, { transient: true });
  }
  if (!response.ok) {
    throw new VendorError("cftc", `CFTC COT API returned ${response.status}`, {
      status: response.status,
      transient: response.status === 429 || response.status >= 500,
    });
  }

  const rows = await response.json();
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const obsDate = String(row?.report_date_as_yyyy_mm_dd ?? "").slice(0, 10);
    if (!DATE_RE.test(obsDate)) continue;
    if (skipObsDates?.has(obsDate)) continue;
    const mmLong = num(row.m_money_positions_long_all);
    const mmShort = num(row.m_money_positions_short_all);
    const openInterest = num(row.open_interest_all);
    if (![mmLong, mmShort, openInterest].every(Number.isFinite)) continue;
    const availableAt = cotAvailableAt(obsDate, firstSeenAt);
    if (!availableAt) continue;
    out.push(
      { series: COT_SERIES.MM_LONG, obsDate, availableAt, val: mmLong, source: "cftc" },
      { series: COT_SERIES.MM_SHORT, obsDate, availableAt, val: mmShort, source: "cftc" },
      { series: COT_SERIES.OPEN_INTEREST, obsDate, availableAt, val: openInterest, source: "cftc" }
    );
  }
  return out;
}
