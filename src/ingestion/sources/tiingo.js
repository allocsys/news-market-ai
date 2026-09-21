// Tiingo adapter -- historical daily bars for the price backfill (plan.md Next
// Steps step A2, replacing Yahoo as the backfill source after the first live
// run got a 429 on every ticker: see plan.md, "Live incident: first price
// backfill failed").
//
// TWO Tiingo APIs behind one function, chosen per ticker:
//   * Stocks and ETFs -> End-of-Day API
//       GET {base}/tiingo/daily/<ticker>/prices?startDate=&endDate=
//     Rows carry raw open/high/low/close/volume plus adjOpen/adjHigh/adjLow/
//     adjClose. This adapter stores the RAW fields, because that is what
//     yfinance.js stores (Yahoo's `indicators.quote` arrays are unadjusted),
//     so bars from the two sources stay comparable. Splits and dividends are
//     therefore NOT reflected in stored prices -- a known limit for a window
//     that spans a split, same as the yfinance bars.
//   * Spot gold and the FX pairs listed in TIINGO_FX_TICKERS -> Forex API
//       GET {base}/tiingo/fx/<ticker>/prices?startDate=&endDate=&resampleFreq=1day
//     Rows carry open/high/low/close only, NO volume: stored as 0, because
//     price_bars.volume is NOT NULL and PriceBar requires a number. Anything
//     that reads volume for these tickers must treat 0 as "no volume data".
//
// Both endpoints and the `Authorization: Token <key>` header are from Tiingo's
// own documentation (documentation/end-of-day, /forex, /general/connecting,
// read 2026-09-21). NOTHING here has been called from a Worker or with a real
// key yet -- confirm after the first real run:
//   1. that the free plan can pull the Forex API at all;
//   2. that "xauusd" is Tiingo's symbol for spot gold;
//   3. what date a Forex daily bar is stamped with (the docs give a market week
//      of Sunday 8pm to Friday 5pm US Eastern, but not the daily cut-off), and
//      whether the Forex API's `endDate` is inclusive -- the code asks for the
//      day AFTER `to` and drops anything past `to`, so it does not depend on
//      that, but the day boundary itself is unverified;
//   4. class-share symbols (e.g. BRK.B) -- passed through unchanged.
//
// Free-plan limits (published): 50 requests an hour, 1,000 a day, 500 unique
// symbols a month. One request per ticker for the whole range, so a backfill of
// ten tickers uses ten of the fifty hourly requests. A 429 is NOT retried in
// process (retrying a rate limit only burns the hourly allowance); it fails that
// ticker and the job names it.
//
// Failure shape matches yfinance.js: a per-ticker VendorError (network, non-2xx,
// bad payload, an inconsistent bar) is collected into `errors` and never aborts
// the other tickers. A missing API key is different -- it can never work for any
// ticker, so it throws once, up front, and the job fails with that message.

import { PriceBar } from "../../schemas/index.js";
import { validatePriceBar } from "../market_data_validator.js";
import { VendorError } from "../../shared/errors.js";
import { createThrottle } from "../../shared/throttle.js";
import { fetchWithTimeout } from "../../shared/fetch_with_timeout.js";
import { withRetry } from "../../shared/retry.js";
import { toDayString, addDays } from "../date_windows.js";

const VENDOR = "tiingo";
const DEFAULT_API_BASE = "https://api.tiingo.com";
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Tickers served by Tiingo's Forex API instead of the stock/ETF End-of-Day API.
 * Spot gold, silver and platinum (the Forex product page lists them) plus the
 * major pairs. Only XAUUSD is wanted today; the rest are here so the forex
 * signals work can add a pair without touching this file. Add a ticker here only
 * after checking Tiingo actually quotes it under that symbol.
 */
export const TIINGO_FX_TICKERS = new Set(["XAUUSD", "XAGUSD", "XPTUSD", "EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF", "NZDUSD"]);

export function isTiingoFxTicker(ticker) {
  return TIINGO_FX_TICKERS.has(String(ticker).toUpperCase());
}

/** The calendar day after `day` (YYYY-MM-DD), in UTC. */
function nextDay(day) {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + 86400000).toISOString().slice(0, 10);
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

/** Fetches and parses ONE ticker's bars for [from, to]. Throws a VendorError on any failure. */
async function fetchTickerBars(config, ticker, { from, to }, { throttle } = {}) {
  const fx = isTiingoFxTicker(ticker);
  const base = String(config.tiingoApiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
  // One day past `to`, then filtered back to `to` below, so the result never depends on whether the vendor treats endDate as inclusive.
  const endDate = nextDay(to);
  const url = fx
    ? `${base}/tiingo/fx/${encodeURIComponent(ticker.toLowerCase())}/prices?${new URLSearchParams({ startDate: from, endDate, resampleFreq: "1day" })}`
    : `${base}/tiingo/daily/${encodeURIComponent(ticker)}/prices?${new URLSearchParams({ startDate: from, endDate })}`;

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
        throw new VendorError(VENDOR, `network failure fetching tiingo for ${ticker}: ${err.message}`, { transient: true });
      }

      if (!res.ok) {
        const detail = await readErrorDetail(res);
        const hint = res.status === 401 || res.status === 403 ? " -- check TIINGO_API_KEY" : "";
        // 5xx is worth a retry; 429 (hourly/daily allowance) and other 4xx are not.
        throw new VendorError(VENDOR, `tiingo returned ${res.status} for ${ticker}${detail ? `: ${detail}` : ""}${hint}`, { status: res.status, transient: res.status >= 500 });
      }
      return res;
    },
    { maxAttempts: config.retryMaxAttempts, baseDelayMs: config.retryBaseDelayMs },
  );

  let rows;
  try {
    rows = await response.json();
  } catch (err) {
    throw new VendorError(VENDOR, `tiingo returned unparseable JSON for ${ticker}: ${err.message}`);
  }
  if (!Array.isArray(rows)) {
    throw new VendorError(VENDOR, `tiingo returned an unexpected response shape for ${ticker} (expected an array of bars): ${JSON.stringify(rows).slice(0, 200)}`);
  }

  const source = fx ? "tiingo_fx" : "tiingo";
  const bars = [];
  for (const row of rows) {
    const date = String(row?.date ?? "").slice(0, 10);
    if (date < from || date > to) continue; // the day after `to` (see endDate above), or anything else outside the request

    // A null price field means the vendor could not compute the bar: skip it rather than store made-up numbers (same as yfinance.js).
    if (![row.open, row.high, row.low, row.close].every(isFiniteNumber)) continue;

    const bar = PriceBar.parse({
      ticker,
      date,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: isFiniteNumber(row.volume) ? row.volume : 0,
      source,
    });
    validatePriceBar(bar, { source: VENDOR });
    bars.push(bar);
  }
  return bars;
}

/**
 * Historical daily bars for `tickers` over [from, to] (YYYY-MM-DD, inclusive),
 * one request per ticker. Same contract as yfinance.js#fetchHistoricalBars, so
 * ingestion/ingest.js#backfillHistoricalPriceBars can use either:
 * `{ bars, errors: [{ ticker, error }], requests }`.
 *
 * `config.tiingoApiKey` (TIINGO_API_KEY, a secret on the `ingest` Worker) is
 * required; without it this throws before making any request.
 */
export async function fetchHistoricalBars(config, { tickers = config.watchlist.map((w) => w.ticker), from, to } = {}) {
  if (!from || !to) {
    throw new Error("fetchHistoricalBars requires an explicit {from, to} range");
  }
  if (!DAY_PATTERN.test(from) || !DAY_PATTERN.test(to) || Number.isNaN(Date.parse(`${from}T00:00:00.000Z`)) || Number.isNaN(Date.parse(`${to}T00:00:00.000Z`))) {
    throw new Error(`fetchHistoricalBars: invalid from/to (${from}, ${to}) -- expected YYYY-MM-DD`);
  }
  if (!config.tiingoApiKey) {
    throw new VendorError(VENDOR, "TIINGO_API_KEY is not set on the ingest Worker -- add it as a repo secret (the ingest deploy pushes it), or set PRICE_BACKFILL_SOURCE=yfinance to use Yahoo instead");
  }

  const bars = [];
  const errors = [];
  const throttle = createThrottle({ minIntervalMs: config.tiingoMinRequestIntervalMs ?? 0 });

  for (const ticker of tickers) {
    try {
      bars.push(...(await fetchTickerBars(config, ticker, { from, to }, { throttle })));
    } catch (err) {
      if (err instanceof VendorError) {
        errors.push({ ticker, error: err });
      } else {
        throw err;
      }
    }
  }

  return { bars, errors, requests: tickers.length };
}

/**
 * Live trailing-window daily bars for `tickers` (defaults to
 * config.watchlist) -- the Tiingo counterpart to yfinance.js#fetchDailyBars,
 * for ingestion/ingest.js#ingestPriceBars once config.priceLiveSource is
 * "tiingo" (see config.js's own comment on why this exists: the sustained
 * yfinance 429 documented in yfinance.js's header). Same
 * `{ bars, errors: [{ ticker, error }] }` contract as the yfinance version,
 * `kv` accepted-and-ignored for signature parity (yfinance's cooldown cache
 * has no Tiingo equivalent yet).
 *
 * There is no separate "recent bars" Tiingo endpoint, so this is just
 * fetchHistoricalBars over a computed [from, to] ending today
 * (config.tiingoLiveWindowDays calendar days back, see config.js) --
 * generous enough to still include the latest trading day across a weekend
 * or holiday, at no extra request cost (one request per ticker regardless of
 * how wide the range is). A missing TIINGO_API_KEY therefore throws upfront
 * here too (same as fetchHistoricalBars); ingestPriceBars is the one that
 * catches it and degrades to "no live bars this tick" rather than failing
 * the whole ingest_ticker job, same as any other VendorError from this file.
 */
export async function fetchDailyBars(config, { tickers = config.watchlist.map((w) => w.ticker) } = {}, { kv } = {}) {
  const to = toDayString(Date.now());
  const windowDays = Number(config.tiingoLiveWindowDays) > 0 ? Number(config.tiingoLiveWindowDays) : 7;
  const from = addDays(to, -(windowDays - 1));
  return fetchHistoricalBars(config, { tickers, from, to });
}
