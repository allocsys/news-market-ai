// Alpaca adapter -- intraday bars for AAPL, MSFT, TSLA and USO (USO is a
// US-listed equity ETF, not forex, so it goes through Alpaca with the
// equities -- see plan.md finding G, vendor decision 2026-09-23). Same
// contract shape as ingestion/sources/tiingo.js#fetchHistoricalBars so
// ingest.js/the step-6 backfill job can treat this like any other price
// source, but returns PriceBarIntraday rows (schemas/index.js), not PriceBar.
//
// API: Alpaca Data API v2, GET {base}/v2/stocks/{symbol}/bars
//   ?timeframe=5Min&start=<ISO8601>&end=<ISO8601>&feed=iex&limit=10000
// `feed=iex` is required on Alpaca's free tier -- the default (sip) 403s for
// unsubscribed accounts (Alpaca's own docs: free users get IEX, Algo Trader
// Plus gets SIP). Paginated via `next_page_token`: a response carrying one
// means there is more data in [start, end] than the page held, and the next
// request repeats the SAME start/end with `page_token` added.
// Auth: `APCA-API-KEY-ID` / `APCA-API-SECRET-KEY` headers (Alpaca's own
// docs) -- NOT the `Authorization: Token` scheme tiingo.js uses.
//
// UNVERIFIED (no adapter has called Alpaca's Data API from this codebase
// yet -- confirm after the first real run against a paper/live key):
//   1. that USO trades on IEX at all (Alpaca's IEX feed only covers IEX
//      itself, not every venue an ETF might mostly trade on) -- if USO comes
//      back consistently empty, that is the first thing to check, not a bug
//      here;
//   2. Alpaca free-tier rate limit in practice -- the published figure is
//      200 requests/minute per key across ALL Data API calls (trading +
//      market data share the limit), so alpacaMinRequestIntervalMs paces
//      conservatively under that;
//   3. whether free-tier historical data has a "recent data" embargo (some
//      vendors withhold the last N minutes) -- Alpaca's docs mention this
//      for real-time SIP, unclear if it also applies to free IEX bars.
//
// Failure shape matches tiingo.js: a per-ticker VendorError (network,
// non-2xx, bad payload) is collected into `errors`, never aborts the other
// tickers. A missing key pair throws once, up front (can never work for any
// ticker), same as tiingo.js's missing-TIINGO_API_KEY case.

import { PriceBarIntraday } from "../../schemas/index.js";
import { validatePriceBarIntraday } from "../market_data_validator.js";
import { VendorError } from "../../shared/errors.js";
import { createThrottle } from "../../shared/throttle.js";
import { fetchWithTimeout } from "../../shared/fetch_with_timeout.js";
import { withRetry } from "../../shared/retry.js";

const VENDOR = "alpaca";
const DEFAULT_API_BASE = "https://data.alpaca.markets";
const MAX_PAGES_PER_TICKER = 50; // guardrail against an infinite next_page_token loop on a malformed/adversarial response

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/** First 200 characters of an error response body, or "" -- never throws, never includes the request (so never the key/secret). */
async function readErrorDetail(res) {
  try {
    const text = await res.text();
    return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  } catch {
    return "";
  }
}

/** Fetches and parses ALL pages of ONE ticker's bars for [from, to] (ISO8601 UTC instants). Throws a VendorError on any failure. */
async function fetchTickerBars(config, ticker, { from, to }, { throttle } = {}) {
  const base = String(config.alpacaApiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
  const timeframe = config.alpacaIntradayTimeframe || "5Min";
  const feed = config.alpacaFeed || "iex";

  const bars = [];
  let pageToken;
  let pages = 0;

  do {
    pages += 1;
    if (pages > MAX_PAGES_PER_TICKER) {
      throw new VendorError(VENDOR, `alpaca returned more than ${MAX_PAGES_PER_TICKER} pages for ${ticker} in [${from}, ${to}] -- aborting rather than looping indefinitely`);
    }

    const params = new URLSearchParams({ timeframe, start: from, end: to, feed, limit: "10000" });
    if (pageToken) params.set("page_token", pageToken);
    const url = `${base}/v2/stocks/${encodeURIComponent(ticker)}/bars?${params}`;

    await throttle?.wait();

    const response = await withRetry(
      async () => {
        let res;
        try {
          res = await fetchWithTimeout(url, {
            timeoutMs: config.fetchTimeoutMs,
            headers: { "Content-Type": "application/json", "APCA-API-KEY-ID": config.alpacaApiKey, "APCA-API-SECRET-KEY": config.alpacaApiSecret },
          });
        } catch (err) {
          throw new VendorError(VENDOR, `network failure fetching alpaca for ${ticker}: ${err.message}`, { transient: true });
        }

        if (!res.ok) {
          const detail = await readErrorDetail(res);
          const hint = res.status === 401 || res.status === 403 ? " -- check ALPACA_API_KEY_ID/ALPACA_API_SECRET_KEY and that the feed is available on your plan" : "";
          // 5xx and 429 are worth a retry (429 here means Alpaca's per-minute request rate, not a daily allowance like Twelve Data's); other 4xx are not.
          throw new VendorError(VENDOR, `alpaca returned ${res.status} for ${ticker}${detail ? `: ${detail}` : ""}${hint}`, { status: res.status, transient: res.status >= 500 || res.status === 429 });
        }
        return res;
      },
      { maxAttempts: config.retryMaxAttempts, baseDelayMs: config.retryBaseDelayMs },
    );

    let payload;
    try {
      payload = await response.json();
    } catch (err) {
      throw new VendorError(VENDOR, `alpaca returned unparseable JSON for ${ticker}: ${err.message}`);
    }
    if (!payload || !Array.isArray(payload.bars)) {
      throw new VendorError(VENDOR, `alpaca returned an unexpected response shape for ${ticker} (expected {bars: [...]}): ${JSON.stringify(payload).slice(0, 200)}`);
    }

    for (const row of payload.bars) {
      const ts = String(row?.t ?? "");
      if (!ts) continue;
      // A null/missing OHLC field means the vendor could not compute the bar: skip it rather than store made-up numbers (same convention as tiingo.js).
      if (![row.o, row.h, row.l, row.c].every(isFiniteNumber)) continue;

      const bar = PriceBarIntraday.parse({
        ticker,
        ts,
        open: row.o,
        high: row.h,
        low: row.l,
        close: row.c,
        volume: isFiniteNumber(row.v) ? row.v : 0,
        source: VENDOR,
      });
      validatePriceBarIntraday(bar, { source: VENDOR });
      bars.push(bar);
    }

    pageToken = payload.next_page_token || undefined;
  } while (pageToken);

  return bars;
}

/**
 * Intraday bars for `tickers` over [from, to] (ISO8601 UTC instants,
 * inclusive), one or more requests per ticker (paginated). Same
 * `{ bars, errors: [{ ticker, error }], requests }` contract as
 * tiingo.js#fetchHistoricalBars, so ingest.js/the step-6 backfill job can use
 * this the same way, but `bars` are PriceBarIntraday rows.
 *
 * `config.alpacaApiKey`/`config.alpacaApiSecret` (ALPACA_API_KEY_ID /
 * ALPACA_API_SECRET_KEY, secrets on the `ingest` Worker) are required;
 * without both this throws before making any request -- same "can never
 * work for any ticker, fail once up front" convention as tiingo.js's missing
 * TIINGO_API_KEY.
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
  if (!config.alpacaApiKey || !config.alpacaApiSecret) {
    throw new VendorError(VENDOR, "ALPACA_API_KEY_ID/ALPACA_API_SECRET_KEY are not both set on the ingest Worker -- add them as repo secrets (the ingest deploy pushes them)");
  }

  const bars = [];
  const errors = [];
  let requests = 0;
  const throttle = createThrottle({ minIntervalMs: config.alpacaMinRequestIntervalMs ?? 0 });

  for (const ticker of tickers) {
    try {
      const before = bars.length;
      bars.push(...(await fetchTickerBars(config, ticker, { from, to }, { throttle })));
      requests += 1; // pagination detail (possibly >1 request) intentionally not surfaced per-ticker here, same coarse-count convention as tiingo.js
      void before;
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
