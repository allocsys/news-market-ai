// Tiingo Crypto intraday adapter -- BTCUSD 5-minute bars. Modelled on
// tiingo_fx_intraday.js and satisfying the same contract
// (`{ bars, errors: [{ ticker, error }], requests }`), so
// intraday_backfill.js#fetchIntradayRange can route to it like any other
// vendor. Uses the SAME TIINGO_API_KEY as tiingo.js / tiingo_fx_intraday.js.
//
// API: Tiingo Crypto API, GET {base}/tiingo/crypto/prices
//   ?tickers=<btcusd>&startDate=<ISO>&endDate=<ISO>&resampleFreq=5min
// Same `Authorization: Token <key>` header as the other Tiingo adapters. The
// response is an array of per-ticker objects with the bars nested in
// `priceData` (NOT a flat array like the Forex API). Crypto rows carry
// `volume` (base currency), stored as-is. One request per (ticker, claimed
// range), same one-request-per-range shape as the other vendors.
//
// 24/7 MARKET: bars are expected on weekends and holidays. The write-time gate
// (shared/intraday_sanity.js) has no closed window for CRYPTO_24X7_TICKERS.
//
// UNVERIFIED (nothing here has been called with a real key yet -- check the
// first real run, or a manual request, before trusting it):
//   1. free-plan access to the Crypto endpoint, and its rate limit (assumed to
//      share the account-wide 50/hour, 1,000/day of tiingo.js's header);
//   2. how far back 5min crypto history reaches on the free plan (the default
//      90-day backfill seed may hit a wall);
//   3. whether the response is capped per request (a 1-3 day claim is
//      ~288-864 rows at 5min; this adapter does not paginate);
//   4. that a quiet 5-minute slot with no trades is simply absent (a gap), not
//      a repeated bar -- nothing downstream assumes one bar per slot, but check;
//   5. that the aggregated (all-exchange) series is what we want; the request
//      sends no `exchanges` filter.
//
// Failure shape matches the other adapters: a per-ticker VendorError (network,
// non-2xx, bad payload) is collected into `errors`, never aborts other
// tickers. A missing key throws once, up front.

import { PriceBarIntraday } from "../../schemas/index.js";
import { validatePriceBarIntraday } from "../market_data_validator.js";
import { VendorError } from "../../shared/errors.js";
import { createThrottle } from "../../shared/throttle.js";
import { fetchWithTimeout } from "../../shared/fetch_with_timeout.js";
import { withRetry } from "../../shared/retry.js";
import { canonicalIntradayTs } from "../../shared/intraday_availability.js";

const VENDOR = "tiingo_crypto_intraday";
const DEFAULT_API_BASE = "https://api.tiingo.com";
const DEFAULT_RESAMPLE_FREQ = "5min";

/**
 * Tickers this adapter serves. Deliberately separate from tiingo.js's
 * TIINGO_CRYPTO_TICKERS (daily bars): adding a ticker here commits its INTRADAY
 * bars to this vendor. test/btc_support.test.js pins the two sets equal and
 * pins shared/intraday_sanity.js#CRYPTO_24X7_TICKERS equal to this one.
 */
export const TIINGO_CRYPTO_INTRADAY_TICKERS = new Set(["BTCUSD"]);

export function isTiingoCryptoIntradayTicker(ticker) {
  return TIINGO_CRYPTO_INTRADAY_TICKERS.has(String(ticker).toUpperCase());
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

/** Fetches and parses ONE ticker's intraday bars for [from, to) (ISO8601 UTC instants). Throws a VendorError on any failure. */
async function fetchTickerBars(config, ticker, { from, to }, { throttle } = {}) {
  const base = String(config.tiingoApiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
  const resampleFreq = config.tiingoCryptoIntradayResampleFreq || DEFAULT_RESAMPLE_FREQ;
  const url = `${base}/tiingo/crypto/prices?${new URLSearchParams({
    tickers: ticker.toLowerCase(),
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
        throw new VendorError(VENDOR, `network failure fetching tiingo crypto intraday for ${ticker}: ${err.message}`, { transient: true });
      }

      if (!res.ok) {
        const detail = await readErrorDetail(res);
        const hint = res.status === 401 || res.status === 403 ? " -- check TIINGO_API_KEY (and that the plan includes the Crypto API)" : "";
        // 5xx is worth a retry; 429 (hourly/daily allowance) and other 4xx are not.
        throw new VendorError(VENDOR, `tiingo crypto intraday returned ${res.status} for ${ticker}${detail ? `: ${detail}` : ""}${hint}`, { status: res.status, transient: res.status >= 500 });
      }
      return res;
    },
    { maxAttempts: config.retryMaxAttempts, baseDelayMs: config.retryBaseDelayMs },
  );

  let payload;
  try {
    payload = await response.json();
  } catch (err) {
    throw new VendorError(VENDOR, `tiingo crypto intraday returned unparseable JSON for ${ticker}: ${err.message}`);
  }
  if (!Array.isArray(payload)) {
    throw new VendorError(VENDOR, `tiingo crypto intraday returned an unexpected response shape for ${ticker} (expected an array of per-ticker objects): ${JSON.stringify(payload).slice(0, 200)}`);
  }
  // No entry for the ticker = no bars in range (same as an empty array from the other vendors).
  const entry = payload.find((e) => String(e?.ticker ?? "").toUpperCase() === ticker.toUpperCase());
  const rows = entry ? entry.priceData : [];
  if (!Array.isArray(rows)) {
    throw new VendorError(VENDOR, `tiingo crypto intraday returned an entry without a priceData array for ${ticker}: ${JSON.stringify(entry).slice(0, 200)}`);
  }

  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  const bars = [];
  for (const row of rows) {
    // Canonical stored form (UTC, whole seconds, "Z") -- see tiingo_fx_intraday.js and shared/intraday_availability.js for why.
    const ts = row?.date ? canonicalIntradayTs(String(row.date)) : "";
    if (!ts) continue;
    const tsMs = Date.parse(ts);
    // Belt-and-suspenders window filter: exactly [from, to) even if the vendor's own date handling is looser.
    if (!Number.isFinite(tsMs) || tsMs < fromMs || tsMs >= toMs) continue;

    const { open, high, low, close } = row;
    // A null/unparseable price field means the vendor could not compute the bar: skip it rather than store made-up numbers.
    if (![open, high, low, close].every(isFiniteNumber)) continue;

    const bar = PriceBarIntraday.parse({
      ticker,
      ts,
      open,
      high,
      low,
      close,
      volume: isFiniteNumber(row.volume) ? row.volume : 0,
      source: VENDOR,
    });
    validatePriceBarIntraday(bar, { source: VENDOR });
    bars.push(bar);
  }
  return bars;
}

/**
 * Intraday bars for `tickers` over [from, to) (ISO8601 UTC instants), one
 * request per ticker. Same `{ bars, errors, requests }` contract as
 * tiingo_fx_intraday.js#fetchIntradayBars. Requires `config.tiingoApiKey`;
 * without it this throws before making any request.
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
  const throttle = createThrottle({ minIntervalMs: config.tiingoCryptoIntradayMinRequestIntervalMs ?? config.tiingoFxIntradayMinRequestIntervalMs ?? 0 });

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
