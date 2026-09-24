// Tiingo FX intraday adapter -- XAUUSD intraday bars, replacing Twelve Data
// (plan.md finding G follow-up, 2026-09-24): the twelvedata.js XAUUSD feed
// turned out to be untrustworthy (288-289 bars/day including weekends, all
// volume 0, weekend hours a flat/jittered synthetic bridge, weekday opens
// not chaining to the prior close -- see plan.md's own note on this). Owner
// decision: switch XAUUSD intraday to Tiingo's Forex API instead, using the
// SAME TIINGO_API_KEY already used by tiingo.js's daily EOD/FX bars.
//
// API: Tiingo Forex API, GET {base}/tiingo/fx/<ticker>/prices
//   ?startDate=<YYYY-MM-DD>&endDate=<YYYY-MM-DD>&resampleFreq=5min
// Same `Authorization: Token <key>` header as tiingo.js. Rows carry
// open/high/low/close only, NO volume (same as the daily Forex bars tiingo.js
// already stores as 0) -- PriceBarIntraday requires a number for volume, so
// this also stores 0, same "0 means no volume data for this vendor"
// convention tiingo.js's own header already documents for the daily case.
//
// VERIFIED THIS SESSION (owner pasted a real GET .../xauusd/prices?
// startDate=2026-09-19&resampleFreq=5min response, 2026-09-24):
//   * the free plan DOES serve XAUUSD intraday at 5min resample (Basic/free
//     Tiingo plan, confirmed by the response actually returning data)
//   * the closed-market weekend window (Fri ~21:00 UTC -> Sun ~22:00 UTC)
//     comes back as a FLAT, SPARSE series -- one held price repeated at
//     irregular (not-every-5-minutes) timestamps, not Twelve Data's
//     constant-plus-jitter fake bridge. This is the opposite of
//     Twelve Data's problem: real data, just infrequent during closed hours.
//   * trading resumes with real, continuous OHLC variance at the correct FX
//     market open (~Sunday 22:00 UTC)
//   * the response is NOT paginated/capped in any way this adapter's code
//     needs to handle -- a ~6-day range at 5min resample came back as one
//     JSON array in a single request (no outputsize/cursor param in Tiingo's
//     Forex intraday docs either), unlike twelvedata.js's 5000-row page cap.
//     This adapter therefore makes exactly ONE request per (ticker, date)
//     claimed day, same one-request-per-day shape intraday_backfill.js's
//     fetchClaimedDay already uses for Alpaca.
//
// STILL UNVERIFIED (no live traffic beyond the owner's one manual sample):
//   1. free-plan rate limits for the Forex intraday endpoint specifically --
//      tiingo.js's header cites 50/hour, 1,000/day for the EOD/FX APIS
//      generally (Tiingo's published account-wide limits), assumed to apply
//      here too since it is the same account/key, but not confirmed against
//      a real sustained run;
//   2. how far back intraday history actually reaches on the free plan --
//      the one sample only covered ~6 days; intraday_backfill.js's default
//      90-day lookback may hit a wall Tiingo's docs don't clearly state;
//   3. the exact timestamp-sparseness behavior during low-liquidity but
//      NOT-fully-closed periods (e.g. thin Asian-session hours on a weekday)
//      -- only the fully-closed weekend was sampled. If weekday bars are
//      ever sparser than 5-minute-spaced too, downstream code that assumes
//      one bar per 5-minute slot (none does today, but worth flagging) would
//      need adjusting.
//
// Failure shape matches tiingo.js/twelvedata.js: a per-ticker VendorError
// (network, non-2xx, bad payload) is collected into `errors`, never aborts
// other tickers. A missing key throws once, up front, same "can never work
// for any ticker" convention as tiingo.js's own missing TIINGO_API_KEY case.

import { PriceBarIntraday } from "../../schemas/index.js";
import { validatePriceBarIntraday } from "../market_data_validator.js";
import { VendorError } from "../../shared/errors.js";
import { createThrottle } from "../../shared/throttle.js";
import { fetchWithTimeout } from "../../shared/fetch_with_timeout.js";
import { withRetry } from "../../shared/retry.js";

const VENDOR = "tiingo_fx_intraday";
const DEFAULT_API_BASE = "https://api.tiingo.com";
const DEFAULT_RESAMPLE_FREQ = "5min";

/**
 * Tickers this adapter serves. Only XAUUSD is wired today (the plan.md
 * finding G XAUUSD-vendor-switch decision, 2026-09-24) -- deliberately a
 * separate, small set from tiingo.js's TIINGO_FX_TICKERS (which lists every
 * daily FX/spot-metal symbol Tiingo offers): adding a ticker here means
 * committing to routing its INTRADAY bars through Tiingo too, a decision the
 * daily-bars ticker list should not silently make on this file's behalf.
 */
export const TIINGO_FX_INTRADAY_TICKERS = new Set(["XAUUSD"]);

export function isTiingoFxIntradayTicker(ticker) {
  return TIINGO_FX_INTRADAY_TICKERS.has(String(ticker).toUpperCase());
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/** First 200 characters of an error response body, or "" -- never throws. Never includes the request (so never the token). */
async function readErrorDetail(res) {
  try {
    const text = await res.text();
    return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  } catch {
    return "";
  }
}

/** Fetches and parses ONE ticker's intraday bars for [from, to) (ISO8601 UTC instants). Throws a VendorError on any failure. Exactly one request -- see header's "not paginated" note. */
async function fetchTickerBars(config, ticker, { from, to }, { throttle } = {}) {
  const base = String(config.tiingoApiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
  const resampleFreq = config.tiingoFxIntradayResampleFreq || DEFAULT_RESAMPLE_FREQ;
  // Tiingo's Forex intraday endpoint takes startDate/endDate as plain dates
  // or full ISO instants; passing the instants straight through (same as
  // this adapter's own [from, to) window, typically one calendar day) keeps
  // the request scoped to exactly what was asked for.
  const url = `${base}/tiingo/fx/${encodeURIComponent(ticker.toLowerCase())}/prices?${new URLSearchParams({
    startDate: from,
    endDate: to,
    resampleFreq,
  })}`;

  await throttle?.wait();

  const response = await withRetry(
    async () => {
      let res;
      try {
        res = await fetchWithTimeout(url, {
          timeoutMs: config.fetchTimeoutMs,
          headers: { "Content-Type": "application/json", Authorization: `Token ${config.tiingoApiKey}` },
        });
      } catch (err) {
        throw new VendorError(VENDOR, `network failure fetching tiingo fx intraday for ${ticker}: ${err.message}`, { transient: true });
      }

      if (!res.ok) {
        const detail = await readErrorDetail(res);
        const hint = res.status === 401 || res.status === 403 ? " -- check TIINGO_API_KEY" : "";
        // 5xx is worth a retry; 429 (hourly/daily allowance -- see header's UNVERIFIED note 1) and other 4xx are not.
        throw new VendorError(VENDOR, `tiingo fx intraday returned ${res.status} for ${ticker}${detail ? `: ${detail}` : ""}${hint}`, { status: res.status, transient: res.status >= 500 });
      }
      return res;
    },
    { maxAttempts: config.retryMaxAttempts, baseDelayMs: config.retryBaseDelayMs },
  );

  let rows;
  try {
    rows = await response.json();
  } catch (err) {
    throw new VendorError(VENDOR, `tiingo fx intraday returned unparseable JSON for ${ticker}: ${err.message}`);
  }
  if (!Array.isArray(rows)) {
    throw new VendorError(VENDOR, `tiingo fx intraday returned an unexpected response shape for ${ticker} (expected an array of bars): ${JSON.stringify(rows).slice(0, 200)}`);
  }

  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  const bars = [];
  for (const row of rows) {
    const ts = row?.date ? new Date(row.date).toISOString() : "";
    if (!ts) continue;
    const tsMs = Date.parse(ts);
    // Belt-and-suspenders window filter, same convention as tiingo.js's
    // daily adapter filtering `date < from || date > to`: keeps the result
    // scoped to exactly [from, to) even if the vendor's own date-window
    // handling is ever looser than requested.
    if (!Number.isFinite(tsMs) || tsMs < fromMs || tsMs >= toMs) continue;

    const open = row.open;
    const high = row.high;
    const low = row.low;
    const close = row.close;
    // A null/unparseable price field means the vendor could not compute the
    // bar: skip it rather than store made-up numbers (same convention as
    // tiingo.js/twelvedata.js/alpaca.js).
    if (![open, high, low, close].every(isFiniteNumber)) continue;

    const bar = PriceBarIntraday.parse({
      ticker,
      ts,
      open,
      high,
      low,
      close,
      volume: 0, // Tiingo Forex API carries no volume field -- see header.
      source: VENDOR,
    });
    validatePriceBarIntraday(bar, { source: VENDOR });
    bars.push(bar);
  }
  return bars;
}

/**
 * Intraday bars for `tickers` over [from, to) (ISO8601 UTC instants), one
 * request per ticker (no pagination -- see header). Same
 * `{ bars, errors: [{ ticker, error }], requests }` contract as
 * twelvedata.js#fetchIntradayBars/alpaca.js#fetchIntradayBars, so
 * intraday_backfill.js's fetchClaimedDay can use this vendor exactly like
 * either of the others.
 *
 * `config.tiingoApiKey` (TIINGO_API_KEY, a secret on the `ingest` Worker,
 * already required by tiingo.js's daily bars) must be set; without it this
 * throws before making any request, same "can never work for any ticker,
 * fail once up front" convention as tiingo.js/twelvedata.js. Unlike
 * twelvedata.js, no `db` handle is required here -- Tiingo's daily
 * request/rate limits are account-wide, not separately tracked per adapter,
 * and this adapter's per-request throttle (tiingoFxIntradayMinRequestIntervalMs)
 * is the only pacing applied for now (see header's UNVERIFIED note 1).
 */
export async function fetchIntradayBars(config, { tickers, from, to } = {}) {
  if (!Array.isArray(tickers) || tickers.length === 0) {
    throw new Error("fetchIntradayBars requires a non-empty tickers array");
  }
  if (!from || !to) {
    throw new Error("fetchIntradayBars requires an explicit {from, to} range (ISO8601 UTC instants)");
  }
  if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
    throw new Error(`fetchIntradayBars: invalid from/to (${from}, ${to}) -- expected ISO8601`);
  }
  if (!config.tiingoApiKey) {
    throw new VendorError(VENDOR, "TIINGO_API_KEY is not set on the ingest Worker -- add it as a repo secret (the ingest deploy pushes it)");
  }

  const bars = [];
  const errors = [];
  let requests = 0;
  const throttle = createThrottle({ minIntervalMs: config.tiingoFxIntradayMinRequestIntervalMs ?? 0 });

  for (const ticker of tickers) {
    try {
      bars.push(...(await fetchTickerBars(config, ticker, { from, to }, { throttle })));
      requests += 1;
    } catch (err) {
      if (err instanceof VendorError) {
        errors.push({ ticker, error: err });
      } else {
        throw err;
      }
    }
  }

  return { bars, errors, requests };
}
