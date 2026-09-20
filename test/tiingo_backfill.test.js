// Covers the Tiingo price source for the historical price backfill (plan.md Next
// Steps step A2):
//   * ingestion/sources/tiingo.js#fetchHistoricalBars -- stocks/ETFs via the
//     End-of-Day API, spot gold and FX via the Forex API (no volume), the
//     Authorization header, the date-range handling, and per-ticker failure
//     isolation (429 is not retried, 5xx and network failures are);
//   * config.js's priceBackfillSource selection;
//   * ingestion/ingest.js#backfillHistoricalPriceBars using Tiingo, into a REAL
//     sqlite price_bars table, and overwriting a Yahoo bar for the same day;
//   * the `ingest` Worker's backfill_prices queue branch with a Tiingo key, and
//     with the source forced to Tiingo but no key.
// Everything is mocked at global fetch: nothing here has touched the real Tiingo
// API (see tiingo.js's header for what still needs a live check). The yfinance
// side is covered by test/backfill_prices.test.js, which is unchanged.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/ingest-worker.js";
import { loadConfig } from "../src/config.js";
import { fetchHistoricalBars, isTiingoFxTicker } from "../src/ingestion/sources/tiingo.js";
import { backfillHistoricalPriceBars } from "../src/ingestion/ingest.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { STATE_DIR, INPUTS_DIR } from "./helpers/engine_ctx.js";
import { RunStore } from "../src/storage/run_store.js";

const KEY = "test-tiingo-key-123";
// retryBaseDelayMs is 1 so the retry tests don't sleep for real.
const config = { ...loadConfig({ TIINGO_API_KEY: KEY, WATCHLIST_TICKERS: "AAPL,MSFT" }), retryBaseDelayMs: 1 };

function silenceLogs(t) {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "error", () => {});
}

/** Tiingo End-of-Day rows, one internally consistent bar per date (validatePriceBar passes). */
function eodRows(dates, base = 100) {
  return dates.map((d) => ({
    date: `${d}T00:00:00.000Z`,
    open: base,
    high: base + 2,
    low: base - 2,
    close: base + 1,
    volume: 1000000,
    adjOpen: base / 2,
    adjHigh: (base + 2) / 2,
    adjLow: (base - 2) / 2,
    adjClose: (base + 1) / 2,
    adjVolume: 2000000,
    divCash: 0,
    splitFactor: 1,
  }));
}

/** Tiingo Forex rows: open/high/low/close only, no volume field. */
function fxRows(dates, base = 3500) {
  return dates.map((d) => ({ date: `${d}T00:00:00.000Z`, ticker: "xauusd", open: base, high: base + 20, low: base - 10, close: base + 10 }));
}

/**
 * Tiingo as the adapter sees it. `byTicker[TICKER]` is an array of rows (a 200), a number (that HTTP status, with a JSON error body),
 * or any other object (a 200 with that body). Unlisted tickers get an empty 200. Returns the recorded calls.
 */
function mockTiingo(t, byTicker) {
  const calls = [];
  t.mock.method(global, "fetch", async (url, options) => {
    const u = new URL(String(url));
    calls.push({ url: u, headers: options?.headers ?? {} });
    const ticker = decodeURIComponent(u.pathname.split("/")[3]).toUpperCase();
    const spec = byTicker[ticker];
    if (typeof spec === "number") {
      return { ok: false, status: spec, text: async () => JSON.stringify({ detail: `simulated ${spec} for ${ticker}` }), json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => spec ?? [] };
  });
  return calls;
}

async function priceRows(db) {
  const { results } = await db.prepare("SELECT ticker, date, close, volume, source FROM price_bars ORDER BY ticker, date").all();
  return results;
}

// ---------------------------------------------------------------------------
// fetchHistoricalBars
// ---------------------------------------------------------------------------

test("a stock/ETF goes to the End-of-Day API with the token in the Authorization header (never the URL), and stores RAW prices", async (t) => {
  const calls = mockTiingo(t, { AAPL: eodRows(["2025-09-02", "2025-09-03"]) });

  const { bars, errors, requests } = await fetchHistoricalBars(config, { tickers: ["AAPL"], from: "2025-09-01", to: "2025-09-05" });

  assert.equal(requests, 1);
  assert.equal(errors.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, "/tiingo/daily/AAPL/prices");
  assert.equal(calls[0].url.searchParams.get("startDate"), "2025-09-01");
  assert.equal(calls[0].url.searchParams.get("endDate"), "2025-09-06", "asks for the day after `to`, then filters, so it does not depend on the vendor's endDate being inclusive");
  assert.equal(calls[0].url.searchParams.get("token"), null);
  assert.ok(!calls[0].url.href.includes(KEY), "the key never appears in the URL");
  assert.equal(calls[0].headers.Authorization, `Token ${KEY}`);

  assert.deepEqual(bars.map((b) => `${b.ticker} ${b.date}`), ["AAPL 2025-09-02", "AAPL 2025-09-03"]);
  assert.equal(bars[0].open, 100);
  assert.equal(bars[0].close, 101, "raw close, not adjClose (50.5)");
  assert.equal(bars[0].volume, 1000000);
  assert.equal(bars[0].source, "tiingo");
});

test("spot gold (XAUUSD) goes to the Forex API, daily bars, and is stored with volume 0 under source tiingo_fx", async (t) => {
  const calls = mockTiingo(t, { XAUUSD: fxRows(["2025-09-02", "2025-09-03"]) });

  const { bars, errors } = await fetchHistoricalBars(config, { tickers: ["XAUUSD"], from: "2025-09-01", to: "2025-09-05" });

  assert.equal(errors.length, 0);
  assert.equal(calls[0].url.pathname, "/tiingo/fx/xauusd/prices");
  assert.equal(calls[0].url.searchParams.get("resampleFreq"), "1day");
  assert.equal(calls[0].url.searchParams.get("startDate"), "2025-09-01");
  assert.equal(calls[0].url.searchParams.get("endDate"), "2025-09-06");
  assert.equal(calls[0].headers.Authorization, `Token ${KEY}`);

  assert.equal(bars.length, 2);
  assert.equal(bars[0].ticker, "XAUUSD");
  assert.equal(bars[0].close, 3510);
  assert.equal(bars[0].volume, 0, "no volume in the Forex API: stored as 0 because price_bars.volume is NOT NULL");
  assert.equal(bars[0].source, "tiingo_fx");
});

test("a mixed list is routed per ticker: stock and ETF to the EOD API, gold to the Forex API", async (t) => {
  const calls = mockTiingo(t, { AAPL: eodRows(["2025-09-02"]), USO: eodRows(["2025-09-02"], 70), XAUUSD: fxRows(["2025-09-02"]) });

  const { bars } = await fetchHistoricalBars(config, { tickers: ["AAPL", "XAUUSD", "USO"], from: "2025-09-01", to: "2025-09-05" });

  assert.deepEqual(calls.map((c) => c.url.pathname), ["/tiingo/daily/AAPL/prices", "/tiingo/fx/xauusd/prices", "/tiingo/daily/USO/prices"]);
  assert.deepEqual(bars.map((b) => `${b.ticker}:${b.source}`), ["AAPL:tiingo", "XAUUSD:tiingo_fx", "USO:tiingo"]);
});

test("isTiingoFxTicker: gold and the listed pairs are Forex, stocks and ETFs (incl. GLD, USO) are not", () => {
  assert.equal(isTiingoFxTicker("XAUUSD"), true);
  assert.equal(isTiingoFxTicker("xauusd"), true);
  assert.equal(isTiingoFxTicker("EURUSD"), true);
  for (const ticker of ["AAPL", "MSFT", "TSLA", "GLD", "USO", "BNO"]) assert.equal(isTiingoFxTicker(ticker), false, ticker);
});

test("bars outside [from, to] (the extra day requested, or anything else) are dropped; rows with a null price are skipped, not stored", async (t) => {
  const rows = [
    ...eodRows(["2025-08-31", "2025-09-02", "2025-09-05", "2025-09-06"]),
    { date: "2025-09-03T00:00:00.000Z", open: null, high: null, low: null, close: null, volume: 0 },
  ];
  mockTiingo(t, { AAPL: rows });

  const { bars, errors } = await fetchHistoricalBars(config, { tickers: ["AAPL"], from: "2025-09-01", to: "2025-09-05" });

  assert.equal(errors.length, 0);
  assert.deepEqual(bars.map((b) => b.date), ["2025-09-02", "2025-09-05"], "`to`'s own day is kept; the day after is not");
});

test("no API key: throws before making any request, naming TIINGO_API_KEY", async (t) => {
  const calls = mockTiingo(t, {});
  await assert.rejects(() => fetchHistoricalBars({ ...config, tiingoApiKey: "" }, { tickers: ["AAPL"], from: "2025-09-01", to: "2025-09-05" }), /TIINGO_API_KEY/);
  assert.equal(calls.length, 0);
});

test("an explicit valid {from, to} is required", async (t) => {
  mockTiingo(t, {});
  await assert.rejects(() => fetchHistoricalBars(config, {}), /requires an explicit/);
  await assert.rejects(() => fetchHistoricalBars(config, { from: "2025-09-01" }), /requires an explicit/);
  await assert.rejects(() => fetchHistoricalBars(config, { tickers: ["AAPL"], from: "yesterday", to: "2025-09-05" }), /invalid from\/to/);
});

test("a 429 is NOT retried, is collected against that ticker (with the vendor's detail, never the key), and the other tickers still run", async (t) => {
  const calls = mockTiingo(t, { AAPL: 429, MSFT: eodRows(["2025-09-02"]) });

  const { bars, errors } = await fetchHistoricalBars(config, { tickers: ["AAPL", "MSFT"], from: "2025-09-01", to: "2025-09-05" });

  assert.equal(calls.length, 2, "one request for AAPL (no retry), one for MSFT");
  assert.deepEqual(bars.map((b) => b.ticker), ["MSFT"]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].ticker, "AAPL");
  assert.equal(errors[0].error.status, 429);
  assert.match(errors[0].error.message, /tiingo returned 429 for AAPL: .*simulated 429/);
  assert.ok(!errors[0].error.message.includes(KEY));
});

test("a 401 points at the API key", async (t) => {
  mockTiingo(t, { AAPL: 401 });
  const { errors } = await fetchHistoricalBars(config, { tickers: ["AAPL"], from: "2025-09-01", to: "2025-09-05" });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].error.status, 401);
  assert.match(errors[0].error.message, /check TIINGO_API_KEY/);
});

test("a 404 (unknown symbol) is a per-ticker failure, not a crash", async (t) => {
  mockTiingo(t, { NOPE: 404, AAPL: eodRows(["2025-09-02"]) });
  const { bars, errors } = await fetchHistoricalBars(config, { tickers: ["NOPE", "AAPL"], from: "2025-09-01", to: "2025-09-05" });
  assert.deepEqual(bars.map((b) => b.ticker), ["AAPL"]);
  assert.deepEqual(errors.map((e) => e.ticker), ["NOPE"]);
  assert.equal(errors[0].error.status, 404);
});

test("a 5xx is retried and then succeeds", async (t) => {
  let n = 0;
  t.mock.method(global, "fetch", async () => {
    n++;
    if (n === 1) return { ok: false, status: 503, text: async () => "unavailable", json: async () => ({}) };
    return { ok: true, status: 200, json: async () => eodRows(["2025-09-02"]) };
  });

  const { bars, errors } = await fetchHistoricalBars(config, { tickers: ["AAPL"], from: "2025-09-01", to: "2025-09-05" });

  assert.equal(n, 2);
  assert.equal(errors.length, 0);
  assert.equal(bars.length, 1);
});

test("a network failure is retried up to retryMaxAttempts, then collected against the ticker", async (t) => {
  let n = 0;
  t.mock.method(global, "fetch", async () => {
    n++;
    throw new Error("boom");
  });

  const { bars, errors } = await fetchHistoricalBars(config, { tickers: ["AAPL"], from: "2025-09-01", to: "2025-09-05" });

  assert.equal(n, config.retryMaxAttempts);
  assert.equal(bars.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].error.message, /network failure fetching tiingo for AAPL: boom/);
});

test("a non-array payload (e.g. an error object with a 200) is a per-ticker failure", async (t) => {
  mockTiingo(t, { AAPL: { detail: "Error: something went wrong" }, MSFT: eodRows(["2025-09-02"]) });
  const { bars, errors } = await fetchHistoricalBars(config, { tickers: ["AAPL", "MSFT"], from: "2025-09-01", to: "2025-09-05" });
  assert.deepEqual(bars.map((b) => b.ticker), ["MSFT"]);
  assert.equal(errors[0].ticker, "AAPL");
  assert.match(errors[0].error.message, /unexpected response shape/);
});

test("an internally inconsistent bar (high below low) fails that ticker, and the others still run", async (t) => {
  const bad = eodRows(["2025-09-02"]);
  bad[0].high = 90;
  mockTiingo(t, { AAPL: bad, MSFT: eodRows(["2025-09-02"]) });

  const { bars, errors } = await fetchHistoricalBars(config, { tickers: ["AAPL", "MSFT"], from: "2025-09-01", to: "2025-09-05" });

  assert.deepEqual(bars.map((b) => b.ticker), ["MSFT"]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].ticker, "AAPL");
  assert.match(errors[0].error.message, /high/);
});

test("defaults to the watchlist when no tickers are given", async (t) => {
  const calls = mockTiingo(t, { AAPL: eodRows(["2025-09-02"]), MSFT: eodRows(["2025-09-02"]) });
  const { requests } = await fetchHistoricalBars(config, { from: "2025-09-01", to: "2025-09-05" });
  assert.equal(requests, 2);
  assert.deepEqual(calls.map((c) => c.url.pathname), ["/tiingo/daily/AAPL/prices", "/tiingo/daily/MSFT/prices"]);
});

// ---------------------------------------------------------------------------
// config.js: which source the backfill uses
// ---------------------------------------------------------------------------

test("priceBackfillSource: yfinance by default, tiingo once a key exists, and an explicit value always wins", () => {
  assert.equal(loadConfig({}).priceBackfillSource, "yfinance");
  assert.equal(loadConfig({ TIINGO_API_KEY: "k" }).priceBackfillSource, "tiingo");
  assert.equal(loadConfig({ TIINGO_API_KEY: "k", PRICE_BACKFILL_SOURCE: "yfinance" }).priceBackfillSource, "yfinance");
  assert.equal(loadConfig({ PRICE_BACKFILL_SOURCE: "tiingo" }).priceBackfillSource, "tiingo");
  assert.equal(loadConfig({ TIINGO_API_KEY: "k" }).tiingoApiKey, "k");
  assert.equal(loadConfig({}).tiingoApiBase, "https://api.tiingo.com");
});

// ---------------------------------------------------------------------------
// backfillHistoricalPriceBars with Tiingo
// ---------------------------------------------------------------------------

test("backfillHistoricalPriceBars stores Tiingo bars (stock, ETF and gold) in price_bars, and a rerun upserts instead of duplicating", async (t) => {
  const db = createTestD1([INPUTS_DIR]);
  mockTiingo(t, { AAPL: eodRows(["2025-09-02", "2025-09-03"]), USO: eodRows(["2025-09-02"], 70), XAUUSD: fxRows(["2025-09-02", "2025-09-03"]) });
  const progress = [];

  const result = await backfillHistoricalPriceBars(config, db, undefined, { tickers: ["AAPL", "USO", "XAUUSD"], from: "2025-09-01", to: "2025-09-05", onProgress: (p) => progress.push(p) });

  assert.equal(result.source, "tiingo");
  assert.equal(result.inserted, 5);
  assert.equal(result.tickers, 3);
  assert.equal(result.requests, 3);
  assert.deepEqual(result.failedTickers, []);
  assert.deepEqual(result.tickersWithNoBars, []);
  assert.match(progress[0].detail, /^Fetching tiingo daily bars for 3 tickers/);

  const rows = await priceRows(db);
  assert.deepEqual(rows.map((r) => `${r.ticker} ${r.date} ${r.source} vol=${r.volume}`), [
    "AAPL 2025-09-02 tiingo vol=1000000",
    "AAPL 2025-09-03 tiingo vol=1000000",
    "USO 2025-09-02 tiingo vol=1000000",
    "XAUUSD 2025-09-02 tiingo_fx vol=0",
    "XAUUSD 2025-09-03 tiingo_fx vol=0",
  ]);

  const again = await backfillHistoricalPriceBars(config, db, undefined, { tickers: ["AAPL", "USO", "XAUUSD"], from: "2025-09-01", to: "2025-09-05" });
  assert.equal(again.inserted, 5);
  assert.equal((await priceRows(db)).length, 5, "the rerun changed nothing");
});

test("a Tiingo bar replaces an existing Yahoo bar for the same ticker and day (values and source)", async (t) => {
  const db = createTestD1([INPUTS_DIR]);
  await db
    .prepare("INSERT INTO price_bars (ticker, date, open, high, low, close, volume, source, ingested_at) VALUES ('AAPL', '2025-09-02', 1, 2, 1, 1.5, 10, 'yfinance', '2025-09-03T00:00:00.000Z')")
    .run();
  mockTiingo(t, { AAPL: eodRows(["2025-09-02"]) });

  await backfillHistoricalPriceBars(config, db, undefined, { tickers: ["AAPL"], from: "2025-09-01", to: "2025-09-05" });

  const rows = await priceRows(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].close, 101);
  assert.equal(rows[0].source, "tiingo");
});

test("backfillHistoricalPriceBars reports a failed ticker and a ticker with no bars, and still saves the rest", async (t) => {
  silenceLogs(t);
  const db = createTestD1([INPUTS_DIR]);
  mockTiingo(t, { AAPL: eodRows(["2025-09-02"]), MSFT: 429, USO: [] });

  const result = await backfillHistoricalPriceBars(config, db, undefined, { tickers: ["AAPL", "MSFT", "USO"], from: "2025-09-01", to: "2025-09-05" });

  assert.equal(result.inserted, 1);
  assert.equal(result.failedTickers.length, 1);
  assert.equal(result.failedTickers[0].ticker, "MSFT");
  assert.match(result.failedTickers[0].message, /429/);
  assert.deepEqual(result.tickersWithNoBars, ["USO"]);
});

test("backfillHistoricalPriceBars rejects an unknown PRICE_BACKFILL_SOURCE instead of silently falling back", async () => {
  await assert.rejects(
    () => backfillHistoricalPriceBars({ ...config, priceBackfillSource: "tingo" }, createTestD1([INPUTS_DIR]), undefined, { tickers: ["AAPL"], from: "2025-09-01", to: "2025-09-05" }),
    /unknown PRICE_BACKFILL_SOURCE "tingo"/,
  );
});

// ---------------------------------------------------------------------------
// queue(): backfill_prices with Tiingo
// ---------------------------------------------------------------------------

class FakeMessage {
  constructor(body) {
    this.body = body;
    this.acked = false;
    this.retried = false;
  }
  ack() {
    this.acked = true;
  }
  retry() {
    this.retried = true;
  }
}

function workerEnv(overrides = {}) {
  return {
    LIVE_DB: createTestD1([STATE_DIR]),
    INPUTS_DB: createTestD1([INPUTS_DIR]),
    CACHE_KV: { get: async () => null, put: async () => {} },
    WATCHLIST_TICKERS: "AAPL,MSFT",
    TIINGO_API_KEY: KEY,
    ...overrides,
  };
}

test("queue() runs a backfill_prices job on Tiingo (key set, no PRICE_BACKFILL_SOURCE), saves the bars for an explicit ticker list incl. gold, and completes the job", async (t) => {
  silenceLogs(t);
  const env = workerEnv();
  const calls = mockTiingo(t, { AAPL: eodRows(["2025-09-02", "2025-09-03"]), XAUUSD: fxRows(["2025-09-02", "2025-09-03"]) });

  const message = new FakeMessage({ type: "backfill_prices", id: "backfill-prices-t1", from: "2025-09-01", to: "2025-09-05", tickers: ["AAPL", "XAUUSD"] });
  await worker.queue({ messages: [message] }, env);

  assert.equal(message.acked, true);
  assert.equal(message.retried, false);
  assert.deepEqual(calls.map((c) => c.url.hostname), ["api.tiingo.com", "api.tiingo.com"], "no request went to Yahoo");
  assert.equal((await priceRows(env.INPUTS_DB)).length, 4);

  const job = await new RunStore(env.LIVE_DB, "live").getJob("backfill-prices-t1");
  assert.equal(job.status, "complete");
  assert.equal(job.result.inserted, 4);
  assert.equal(job.result.tickers, 2);
  assert.equal(job.detail, "Saved 4 price bars for 2 of 2 tickers");
});

test("queue() backfill_prices FAILS the job, naming the tickers, when Tiingo rejects every ticker, and still acks", async (t) => {
  silenceLogs(t);
  const env = workerEnv();
  mockTiingo(t, { AAPL: 429, XAUUSD: 403 });

  const message = new FakeMessage({ type: "backfill_prices", id: "backfill-prices-t2", from: "2025-09-01", to: "2025-09-05", tickers: ["AAPL", "XAUUSD"] });
  await worker.queue({ messages: [message] }, env);

  assert.equal(message.acked, true);
  assert.equal(message.retried, false);
  assert.equal((await priceRows(env.INPUTS_DB)).length, 0);
  const job = await new RunStore(env.LIVE_DB, "live").getJob("backfill-prices-t2");
  assert.equal(job.status, "failed");
  assert.match(job.error, /^No price bars saved/);
  assert.match(job.error, /AAPL \(tiingo returned 429/);
  assert.match(job.error, /XAUUSD \(tiingo returned 403/);
  assert.ok(!job.error.includes(KEY));
});

test("queue() backfill_prices with the source forced to Tiingo but no key fails the job with a message naming the key, without any request", async (t) => {
  silenceLogs(t);
  const env = workerEnv({ TIINGO_API_KEY: undefined, PRICE_BACKFILL_SOURCE: "tiingo" });
  const calls = mockTiingo(t, {});

  const message = new FakeMessage({ type: "backfill_prices", id: "backfill-prices-t3", from: "2025-09-01", to: "2025-09-05" });
  await worker.queue({ messages: [message] }, env);

  assert.equal(calls.length, 0);
  assert.equal(message.acked, true);
  const job = await new RunStore(env.LIVE_DB, "live").getJob("backfill-prices-t3");
  assert.equal(job.status, "failed");
  assert.match(job.error, /TIINGO_API_KEY/);
});
