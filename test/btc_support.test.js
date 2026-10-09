// Covers the BTCUSD (24/7 crypto) support added in feat/btcusd-support:
//   - the three ticker sets that must stay equal (daily, intraday, sanity gate);
//   - intraday vendor routing (BTCUSD -> tiingo_crypto_intraday);
//   - no closed window for BTCUSD, weekend bars pass the write gate;
//   - the per-ticker hold calendar (BTCUSD counts all 7 days, others Mon-Fri);
//   - the daily and intraday Tiingo Crypto adapters' request shape and
//     nested-priceData parsing.
// Everything is mocked at global fetch: nothing here has touched the real
// Tiingo API (the adapters' headers list what is still unverified).
// Calendar used below (2026): Jan 15 Thu, Jan 16 Fri, Jan 17 Sat, Jan 18 Sun, Jan 19 Mon.

import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { CRYPTO_24X7_TICKERS, FX_24X5_TICKERS, gateIntradayBars, isInClosedWindow } from "../src/shared/intraday_sanity.js";
import { fetchIntradayBars, TIINGO_CRYPTO_INTRADAY_TICKERS, isTiingoCryptoIntradayTicker } from "../src/ingestion/sources/tiingo_crypto_intraday.js";
import { fetchHistoricalBars, TIINGO_CRYPTO_TICKERS, isTiingoCryptoTicker } from "../src/ingestion/sources/tiingo.js";
import { resolveIntradayVendor } from "../src/ingestion/intraday_backfill.js";
import { evaluateExit, isSevenDayTicker, timeExitDueAt, tradingDaysBetween } from "../src/agents/risk_mgmt/exit.js";

const KEY = "test-tiingo-key-123";
const config = { ...loadConfig({ TIINGO_API_KEY: KEY }), retryBaseDelayMs: 1, tiingoMinRequestIntervalMs: 0, tiingoCryptoIntradayMinRequestIntervalMs: 0 };
const FIVE_MIN_MS = 5 * 60_000;

function mockFetch(t, body, { status = 200 } = {}) {
  const calls = [];
  t.mock.method(global, "fetch", async (url, init) => {
    calls.push({ url: new URL(String(url)), headers: init?.headers });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
      json: async () => body,
    };
  });
  return calls;
}

function cryptoRows(startIso, count, base = 90000) {
  const start = Date.parse(startIso);
  return Array.from({ length: count }, (_, i) => ({
    date: new Date(start + i * FIVE_MIN_MS).toISOString(),
    open: base,
    high: base + 50,
    low: base - 50,
    close: base + 10,
    volume: 12.5,
  }));
}

const wrap = (priceData, ticker = "btcusd") => [{ ticker, baseCurrency: "btc", quoteCurrency: "usd", priceData }];

// ---------------------------------------------------------------------------
// ticker sets stay in step
// ---------------------------------------------------------------------------

test("daily, intraday and sanity-gate crypto ticker sets are equal", () => {
  assert.deepEqual([...TIINGO_CRYPTO_TICKERS].sort(), [...TIINGO_CRYPTO_INTRADAY_TICKERS].sort());
  assert.deepEqual([...CRYPTO_24X7_TICKERS].sort(), [...TIINGO_CRYPTO_INTRADAY_TICKERS].sort());
  assert.equal(isTiingoCryptoTicker("btcusd"), true);
  assert.equal(isTiingoCryptoIntradayTicker("btcusd"), true);
  assert.equal(isTiingoCryptoIntradayTicker("XAUUSD"), false);
  for (const t of CRYPTO_24X7_TICKERS) assert.equal(FX_24X5_TICKERS.has(t), false, `${t} must not also be a 24x5 FX ticker`);
});

// ---------------------------------------------------------------------------
// vendor routing
// ---------------------------------------------------------------------------

test("resolveIntradayVendor: BTCUSD -> tiingo_crypto_intraday, XAUUSD -> tiingo_fx_intraday, equities -> alpaca", () => {
  assert.equal(resolveIntradayVendor("BTCUSD"), "tiingo_crypto_intraday");
  assert.equal(resolveIntradayVendor("btcusd"), "tiingo_crypto_intraday");
  assert.equal(resolveIntradayVendor("XAUUSD"), "tiingo_fx_intraday");
  assert.equal(resolveIntradayVendor("AAPL"), "alpaca");
});

// ---------------------------------------------------------------------------
// 24/7 sanity gate
// ---------------------------------------------------------------------------

test("BTCUSD has no closed window: Saturday, Sunday and Monday-early instants are all open", () => {
  for (const ts of ["2026-01-16T22:00:00Z", "2026-01-17T12:00:00Z", "2026-01-18T03:00:00Z", "2026-01-19T03:00:00Z"]) {
    assert.equal(isInClosedWindow("BTCUSD", ts), false, ts);
  }
  // the equity rule is untouched
  assert.equal(isInClosedWindow("AAPL", "2026-01-17T12:00:00Z"), true);
});

test("gateIntradayBars accepts weekend BTCUSD bars (no closed_window) but still rejects them for an equity", () => {
  const mk = (ticker) => ({ ticker, ts: "2026-01-17T12:00:00Z", open: 100, high: 101, low: 99, close: 100, volume: 1, source: "test" });
  const btc = gateIntradayBars([mk("BTCUSD")]);
  assert.equal(btc.accepted.length, 1);
  assert.equal(btc.rejected.length, 0);
  const aapl = gateIntradayBars([mk("AAPL")]);
  assert.deepEqual(aapl.rejected.map((r) => r.code), ["closed_window"]);
});

// ---------------------------------------------------------------------------
// per-ticker hold calendar
// ---------------------------------------------------------------------------

test("isSevenDayTicker: BTCUSD yes (any case); XAUUSD, equities, undefined no", () => {
  assert.equal(isSevenDayTicker("BTCUSD"), true);
  assert.equal(isSevenDayTicker("btcusd"), true);
  assert.equal(isSevenDayTicker("XAUUSD"), false);
  assert.equal(isSevenDayTicker("AAPL"), false);
  assert.equal(isSevenDayTicker(undefined), false);
});

test("tradingDaysBetween: Fri -> Mon is 1 weekday but 3 days for BTCUSD; no ticker keeps the Mon-Fri rule", () => {
  const from = "2026-01-16T10:00:00Z";
  const to = "2026-01-19T10:00:00Z";
  assert.equal(tradingDaysBetween(from, to), 1);
  assert.equal(tradingDaysBetween(from, to, { ticker: "XAUUSD" }), 1);
  assert.equal(tradingDaysBetween(from, to, { ticker: "BTCUSD" }), 3);
  // Thu 01-01 -> Thu 01-15 is the documented 10 weekdays; 14 days for a 24/7 ticker
  assert.equal(tradingDaysBetween("2026-01-01T00:00:00Z", "2026-01-15T00:00:00Z"), 10);
  assert.equal(tradingDaysBetween("2026-01-01T00:00:00Z", "2026-01-15T00:00:00Z", { ticker: "BTCUSD" }), 14);
});

test("timeExitDueAt: 3-day hold opened Fri is due Mon 00:00Z for BTCUSD, Wed 00:00Z for a weekday ticker", () => {
  const openedAt = "2026-01-16T10:00:00Z";
  assert.equal(timeExitDueAt(openedAt, 3, { ticker: "BTCUSD" }), "2026-01-19T00:00:00.000Z");
  assert.equal(timeExitDueAt(openedAt, 3), "2026-01-21T00:00:00.000Z");
  assert.equal(timeExitDueAt(openedAt, 3, { ticker: "XAUUSD" }), "2026-01-21T00:00:00.000Z");
  assert.equal(timeExitDueAt(openedAt, 0, { ticker: "BTCUSD" }), null);
});

test("evaluateExit time rule follows position.ticker: BTCUSD exits at 3 calendar days, XAUUSD does not", () => {
  const base = { direction: "long", entryPrice: 100, stopLossPct: 0.05, takeProfitPct: 0.1, openedAt: "2026-01-16T10:00:00Z" };
  const args = { currentPrice: 100, asOf: "2026-01-19T00:00:00Z", maxHoldDays: 3 };
  assert.deepEqual(evaluateExit({ ...base, ticker: "BTCUSD" }, args), { reason: "time_based" });
  assert.equal(evaluateExit({ ...base, ticker: "XAUUSD" }, args), null);
  assert.equal(evaluateExit(base, args), null, "a position without a ticker keeps the weekday rule");
});

// ---------------------------------------------------------------------------
// daily Tiingo Crypto branch
// ---------------------------------------------------------------------------

test("daily BTCUSD: /tiingo/crypto/prices?tickers=btcusd&resampleFreq=1day, nested priceData parsed, volume kept, source tiingo_crypto, out-of-range day dropped", async (t) => {
  const calls = mockFetch(
    t,
    wrap([
      { date: "2026-01-16T00:00:00+00:00", open: 90000, high: 91000, low: 89000, close: 90500, volume: 1234.5 },
      { date: "2026-01-17T00:00:00+00:00", open: 90500, high: 92000, low: 90000, close: 91500, volume: 800 },
      { date: "2026-01-19T00:00:00+00:00", open: 91500, high: 92500, low: 91000, close: 92000, volume: 700 },
    ]),
  );

  const { bars, errors, requests } = await fetchHistoricalBars(config, { tickers: ["BTCUSD"], from: "2026-01-16", to: "2026-01-18" });

  assert.equal(errors.length, 0);
  assert.equal(requests, 1);
  assert.equal(calls.length, 1);
  const q = calls[0].url.searchParams;
  assert.equal(calls[0].url.pathname, "/tiingo/crypto/prices");
  assert.equal(q.get("tickers"), "btcusd");
  assert.equal(q.get("resampleFreq"), "1day");
  assert.equal(q.get("startDate"), "2026-01-16");
  assert.equal(q.get("endDate"), "2026-01-19");
  assert.equal(calls[0].headers.Authorization, `Token ${KEY}`);
  assert.deepEqual(bars.map((b) => b.date), ["2026-01-16", "2026-01-17"]);
  assert.equal(bars[0].volume, 1234.5);
  assert.equal(bars[0].source, "tiingo_crypto");
  assert.equal(bars[0].close, 90500);
});

test("daily BTCUSD: no entry in the payload means no bars (not an error); a non-array payload is a per-ticker VendorError", async (t) => {
  mockFetch(t, []);
  const empty = await fetchHistoricalBars(config, { tickers: ["BTCUSD"], from: "2026-01-16", to: "2026-01-18" });
  assert.equal(empty.bars.length, 0);
  assert.equal(empty.errors.length, 0);
  t.mock.restoreAll();

  mockFetch(t, { detail: "nope" });
  const bad = await fetchHistoricalBars(config, { tickers: ["BTCUSD"], from: "2026-01-16", to: "2026-01-18" });
  assert.equal(bad.bars.length, 0);
  assert.equal(bad.errors.length, 1);
  assert.equal(bad.errors[0].ticker, "BTCUSD");
});

// ---------------------------------------------------------------------------
// intraday Tiingo Crypto adapter
// ---------------------------------------------------------------------------

test("intraday BTCUSD: /tiingo/crypto/prices with resampleFreq=5min, weekend bars parsed from nested priceData, volume kept, one request", async (t) => {
  const FROM = "2026-01-17T00:00:00Z";
  const TO = "2026-01-18T00:00:00Z";
  const calls = mockFetch(t, wrap(cryptoRows("2026-01-17T12:00:00Z", 3)));

  const { bars, errors, requests } = await fetchIntradayBars(config, { tickers: ["BTCUSD"], from: FROM, to: TO });

  assert.equal(errors.length, 0);
  assert.equal(requests, 1);
  assert.equal(calls.length, 1);
  const q = calls[0].url.searchParams;
  assert.equal(calls[0].url.pathname, "/tiingo/crypto/prices");
  assert.equal(q.get("tickers"), "btcusd");
  assert.equal(q.get("startDate"), FROM);
  assert.equal(q.get("endDate"), TO);
  assert.equal(q.get("resampleFreq"), "5min");
  assert.equal(calls[0].headers.Authorization, `Token ${KEY}`);
  assert.equal(bars.length, 3);
  assert.equal(bars[0].ticker, "BTCUSD");
  assert.equal(bars[0].ts, "2026-01-17T12:00:00Z");
  assert.equal(bars[0].volume, 12.5);
  assert.equal(bars[0].source, "tiingo_crypto_intraday");
});

test("intraday BTCUSD: [from, to) window filter, +00:00 offsets canonicalised, null-price rows skipped", async (t) => {
  const FROM = "2026-01-17T00:00:00Z";
  const TO = "2026-01-18T00:00:00Z";
  mockFetch(
    t,
    wrap([
      { date: "2026-01-16T23:55:00+00:00", open: 1, high: 2, low: 1, close: 1, volume: 1 }, // before from
      { date: "2026-01-17T00:00:00+00:00", open: 90000, high: 90050, low: 89950, close: 90010, volume: 3 }, // on from: kept
      { date: "2026-01-17T00:05:00+00:00", open: null, high: 90050, low: 89950, close: 90010, volume: 3 }, // null price: skipped
      { date: "2026-01-18T00:00:00+00:00", open: 1, high: 2, low: 1, close: 1, volume: 1 }, // on to: excluded
    ]),
  );

  const { bars, errors } = await fetchIntradayBars(config, { tickers: ["BTCUSD"], from: FROM, to: TO });

  assert.equal(errors.length, 0);
  assert.deepEqual(bars.map((b) => b.ts), ["2026-01-17T00:00:00Z"]);
});

test("intraday BTCUSD: a 429 is collected per ticker (not thrown) and no key throws up front", async (t) => {
  mockFetch(t, { detail: "rate limited" }, { status: 429 });
  const res = await fetchIntradayBars(config, { tickers: ["BTCUSD"], from: "2026-01-17T00:00:00Z", to: "2026-01-18T00:00:00Z" });
  assert.equal(res.bars.length, 0);
  assert.equal(res.errors.length, 1);
  assert.equal(res.errors[0].ticker, "BTCUSD");
  t.mock.restoreAll();

  await assert.rejects(() => fetchIntradayBars({ ...config, tiingoApiKey: "" }, { tickers: ["BTCUSD"], from: "2026-01-17T00:00:00Z", to: "2026-01-18T00:00:00Z" }), /TIINGO_API_KEY/);
});
