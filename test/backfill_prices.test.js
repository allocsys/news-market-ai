// Covers the historical price-bar backfill (plan.md Next Steps step A):
//   * ingestion/sources/yfinance.js#fetchHistoricalBars -- explicit period1/period2, one
//     request per ticker, ignores the shared 429 cooldown but still records a fresh one;
//   * fetchDailyBars (the */15 cron path) is unchanged by the fetchTickerChart refactor:
//     still `range=5d`, still honours the cooldown;
//   * ingestion/ingest.js#backfillHistoricalPriceBars -- writes through insertPriceBars into
//     a REAL sqlite price_bars table (migrations/inputs), idempotently, in chunks;
//   * the `ingest` Worker's backfill_prices queue branch and summarizePriceBackfill --
//     nothing saved is a FAILED job, a partial fill names the missing tickers.
// The route half is in test/index_backfill_prices.test.js.

import test from "node:test";
import assert from "node:assert/strict";
import worker, { summarizePriceBackfill } from "../src/ingest-worker.js";
import { loadConfig } from "../src/config.js";
import { fetchDailyBars, fetchHistoricalBars } from "../src/ingestion/sources/yfinance.js";
import { backfillHistoricalPriceBars } from "../src/ingestion/ingest.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { STATE_DIR, INPUTS_DIR } from "./helpers/engine_ctx.js";
import { BrokenDb } from "./helpers/broken_db.js";
import { RunStore } from "../src/storage/run_store.js";

const config = loadConfig({ WATCHLIST_TICKERS: "AAPL,MSFT" });

/** `n` consecutive calendar days starting at `start` (YYYY-MM-DD). Yahoo's weekday gaps don't matter to these tests. */
function days(start, n) {
  return Array.from({ length: n }, (_, i) => new Date(Date.parse(`${start}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10));
}

/** A Yahoo v8 chart response with one internally consistent OHLC bar per date (validatePriceBar passes). */
function chartBody(dates, base = 100) {
  return {
    chart: {
      result: [
        {
          timestamp: dates.map((d) => Date.parse(`${d}T14:30:00Z`) / 1000),
          indicators: {
            quote: [
              {
                open: dates.map(() => base),
                high: dates.map(() => base + 2),
                low: dates.map(() => base - 2),
                close: dates.map(() => base + 1),
                volume: dates.map(() => 1000000),
              },
            ],
          },
        },
      ],
    },
  };
}

/**
 * Yahoo as the adapter sees it. `byTicker[ticker]` is an array of YYYY-MM-DD dates (an empty array is a 200 with no bars) or the number 429.
 * Returns the list of requested URLs so a test can assert on the query string.
 */
function mockYahoo(t, byTicker) {
  const requests = [];
  t.mock.method(global, "fetch", async (url) => {
    const u = new URL(String(url));
    requests.push(u);
    const ticker = decodeURIComponent(u.pathname.split("/").pop());
    const spec = byTicker[ticker];
    if (spec === 429) return { ok: false, status: 429, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => chartBody(spec ?? []) };
  });
  return requests;
}

/** Just enough of a KV namespace for shared/cooldown.js: get/put, with every put recorded. */
class FakeKv {
  constructor() {
    this.store = new Map();
    this.puts = [];
  }
  async get(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }
  async put(key, value, options) {
    this.store.set(key, value);
    this.puts.push({ key, value, options });
  }
}

async function priceRows(db) {
  const { results } = await db.prepare("SELECT ticker, date, close, source FROM price_bars ORDER BY ticker, date").all();
  return results;
}

function silenceLogs(t) {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "error", () => {});
}

// ---------------------------------------------------------------------------
// fetchHistoricalBars / fetchDailyBars
// ---------------------------------------------------------------------------

test("fetchHistoricalBars asks Yahoo for an explicit period1/period2 range (not the live range=5d), one request per ticker", async (t) => {
  const requests = mockYahoo(t, { AAPL: ["2025-09-02", "2025-09-03"], MSFT: ["2025-09-02"] });

  const { bars, errors, requests: requestCount } = await fetchHistoricalBars(config, { from: "2025-09-01", to: "2025-09-05" }, {});

  assert.equal(requestCount, 2);
  assert.equal(requests.length, 2);
  assert.equal(errors.length, 0);
  assert.deepEqual(bars.map((b) => `${b.ticker} ${b.date}`), ["AAPL 2025-09-02", "AAPL 2025-09-03", "MSFT 2025-09-02"]);
  for (const u of requests) {
    assert.equal(u.searchParams.get("period1"), String(Date.parse("2025-09-01T00:00:00.000Z") / 1000));
    assert.equal(u.searchParams.get("period2"), String(Date.parse("2025-09-05T23:59:59.000Z") / 1000), "period2 reaches the end of `to`'s own day");
    assert.equal(u.searchParams.get("range"), null);
    assert.equal(u.searchParams.get("interval"), "1d");
  }
});

test("fetchHistoricalBars refuses to run without an explicit {from, to} -- no silent trailing-window default", async () => {
  await assert.rejects(() => fetchHistoricalBars(config, {}, {}), /requires an explicit/);
  await assert.rejects(() => fetchHistoricalBars(config, { from: "2025-09-01" }, {}), /requires an explicit/);
});

test("fetchHistoricalBars ignores a standing 429 cooldown (it would otherwise never reach Yahoo) and records a fresh cooldown when it gets a 429", async (t) => {
  const kv = new FakeKv();
  kv.store.set("yfinance:cooldown:AAPL", "1");
  const requests = mockYahoo(t, { AAPL: 429 });

  const { bars, errors } = await fetchHistoricalBars(config, { tickers: ["AAPL"], from: "2025-09-01", to: "2025-09-05" }, { kv });

  assert.equal(requests.length, 1, "it asked Yahoo despite the cooldown, and did not retry the 429 in-process");
  assert.equal(bars.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].ticker, "AAPL");
  assert.equal(errors[0].error.status, 429);
  const put = kv.puts.find((p) => p.key === "yfinance:cooldown:AAPL");
  assert.ok(put, "the live path is told to back off");
  assert.equal(put.options.expirationTtl, 900);
});

test("fetchHistoricalBars keeps going after one ticker fails", async (t) => {
  mockYahoo(t, { AAPL: 429, MSFT: ["2025-09-02"] });

  const { bars, errors } = await fetchHistoricalBars(config, { from: "2025-09-01", to: "2025-09-05" }, {});

  assert.deepEqual(bars.map((b) => b.ticker), ["MSFT"]);
  assert.deepEqual(errors.map((e) => e.ticker), ["AAPL"]);
});

test("fetchDailyBars (the */15 cron path) is unchanged by the refactor: still range=5d, still honours the cooldown", async (t) => {
  const kv = new FakeKv();
  kv.store.set("yfinance:cooldown:MSFT", "1");
  const requests = mockYahoo(t, { AAPL: ["2025-09-02"], MSFT: ["2025-09-02"] });

  const { bars, errors } = await fetchDailyBars(config, { tickers: ["AAPL", "MSFT"] }, { kv });

  assert.equal(requests.length, 1, "MSFT was skipped without a request");
  assert.equal(requests[0].searchParams.get("range"), "5d");
  assert.equal(requests[0].searchParams.get("period1"), null);
  assert.deepEqual(bars.map((b) => b.ticker), ["AAPL"]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].ticker, "MSFT");
  assert.equal(errors[0].error.status, 429);
  assert.match(errors[0].error.message, /cooling down/);
});

test("fetchDailyBars still records the cooldown when it gets a 429", async (t) => {
  const kv = new FakeKv();
  mockYahoo(t, { AAPL: 429 });

  const { bars, errors } = await fetchDailyBars(config, { tickers: ["AAPL"] }, { kv });

  assert.equal(bars.length, 0);
  assert.equal(errors.length, 1);
  assert.ok(kv.puts.some((p) => p.key === "yfinance:cooldown:AAPL"));
});

// ---------------------------------------------------------------------------
// backfillHistoricalPriceBars
// ---------------------------------------------------------------------------

test("backfillHistoricalPriceBars stores every bar in price_bars, and a rerun upserts instead of duplicating", async (t) => {
  const db = createTestD1([INPUTS_DIR]);
  mockYahoo(t, { AAPL: ["2025-09-02", "2025-09-03", "2025-09-04"], MSFT: ["2025-09-02", "2025-09-03"] });
  const progress = [];

  const result = await backfillHistoricalPriceBars(config, db, undefined, { from: "2025-09-01", to: "2025-09-05", onProgress: (p) => progress.push(p) });

  assert.equal(result.inserted, 5);
  assert.equal(result.tickers, 2);
  assert.equal(result.requests, 2);
  assert.deepEqual(result.failedTickers, []);
  assert.deepEqual(result.tickersWithNoBars, []);
  assert.deepEqual(progress.map((p) => p.phase), ["fetching", "saving", "saving"]);
  assert.equal(progress.at(-1).percent, 100);

  const rows = await priceRows(db);
  assert.equal(rows.length, 5);
  assert.equal(rows[0].ticker, "AAPL");
  assert.equal(rows[0].date, "2025-09-02");
  assert.equal(rows[0].close, 101);
  assert.equal(rows[0].source, "yfinance");

  const again = await backfillHistoricalPriceBars(config, db, undefined, { from: "2025-09-01", to: "2025-09-05" });
  assert.equal(again.inserted, 5, "'inserted' counts bars written (upserts), not net-new rows");
  assert.equal((await priceRows(db)).length, 5, "the rerun changed nothing");
});

test("backfillHistoricalPriceBars writes a year-sized range (more rows than one batch chunk) without losing any", async (t) => {
  const db = createTestD1([INPUTS_DIR]);
  mockYahoo(t, { AAPL: days("2024-01-01", 450) });

  const result = await backfillHistoricalPriceBars(config, db, undefined, { tickers: ["AAPL"], from: "2024-01-01", to: "2025-03-25" });

  assert.equal(result.inserted, 450);
  assert.equal((await priceRows(db)).length, 450);
});

test("backfillHistoricalPriceBars reports a failed ticker and a ticker that returned no bars, and still saves the rest", async (t) => {
  silenceLogs(t);
  const db = createTestD1([INPUTS_DIR]);
  mockYahoo(t, { AAPL: ["2025-09-02"], MSFT: 429, TSLA: [] });

  const result = await backfillHistoricalPriceBars(config, db, undefined, { tickers: ["AAPL", "MSFT", "TSLA"], from: "2025-09-01", to: "2025-09-05" });

  assert.equal(result.inserted, 1);
  assert.equal(result.failedTickers.length, 1);
  assert.equal(result.failedTickers[0].ticker, "MSFT");
  assert.match(result.failedTickers[0].message, /429/);
  assert.deepEqual(result.tickersWithNoBars, ["TSLA"], "an empty 200 is its own signal, not a vendor error");
  assert.deepEqual((await priceRows(db)).map((r) => r.ticker), ["AAPL"]);
});

test("backfillHistoricalPriceBars requires an explicit range", async () => {
  await assert.rejects(() => backfillHistoricalPriceBars(config, createTestD1([INPUTS_DIR]), undefined, {}), /requires an explicit/);
});

// ---------------------------------------------------------------------------
// summarizePriceBackfill (pure)
// ---------------------------------------------------------------------------

test("summarizePriceBackfill: nothing saved is a failure that names every ticker and why", () => {
  const summary = summarizePriceBackfill({
    inserted: 0,
    tickers: 2,
    failedTickers: [
      { ticker: "AAPL", message: "yfinance chart API returned 429 for AAPL" },
      { ticker: "MSFT", message: "yfinance chart API returned 429 for MSFT" },
    ],
    tickersWithNoBars: [],
  });
  assert.equal(summary.ok, false);
  assert.match(summary.error, /^No price bars saved/);
  assert.match(summary.error, /AAPL \(yfinance chart API returned 429 for AAPL\)/);
  assert.match(summary.error, /MSFT \(yfinance chart API returned 429 for MSFT\)/);
});

test("summarizePriceBackfill: nothing saved and no reasons still fails, with a plain message", () => {
  const summary = summarizePriceBackfill({ inserted: 0, tickers: 1, failedTickers: [], tickersWithNoBars: [] });
  assert.equal(summary.ok, false);
  assert.equal(summary.error, "No price bars saved");
});

test("summarizePriceBackfill: a full fill is a plain success", () => {
  const summary = summarizePriceBackfill({ inserted: 5, tickers: 2, failedTickers: [], tickersWithNoBars: [] });
  assert.deepEqual(summary, { ok: true, detail: "Saved 5 price bars for 2 of 2 tickers" });
});

test("summarizePriceBackfill: singular wording", () => {
  const summary = summarizePriceBackfill({ inserted: 1, tickers: 1, failedTickers: [], tickersWithNoBars: [] });
  assert.equal(summary.detail, "Saved 1 price bar for 1 of 1 ticker");
});

test("summarizePriceBackfill: a partial fill succeeds but names each missing ticker and its reason", () => {
  const summary = summarizePriceBackfill({
    inserted: 2,
    tickers: 3,
    failedTickers: [{ ticker: "MSFT", message: "yfinance chart API returned 429 for MSFT" }],
    tickersWithNoBars: ["TSLA"],
  });
  assert.equal(summary.ok, true);
  assert.match(summary.detail, /^Saved 2 price bars for 1 of 3 tickers; no bars for /);
  assert.match(summary.detail, /MSFT \(yfinance chart API returned 429 for MSFT\)/);
  assert.match(summary.detail, /TSLA \(returned no bars for this range\)/);
});

// ---------------------------------------------------------------------------
// queue(): backfill_prices
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
    CACHE_KV: new FakeKv(),
    WATCHLIST_TICKERS: "AAPL,MSFT",
    ...overrides,
  };
}

test("queue() runs a backfill_prices job over the watchlist, saves the bars, completes the job with the real counts and acks", async (t) => {
  silenceLogs(t);
  const env = workerEnv();
  mockYahoo(t, { AAPL: ["2025-09-02", "2025-09-03"], MSFT: ["2025-09-02", "2025-09-03"] });

  const message = new FakeMessage({ type: "backfill_prices", id: "backfill-prices-1", from: "2025-09-01", to: "2025-09-05" });
  await worker.queue({ messages: [message] }, env);

  assert.equal(message.acked, true);
  assert.equal(message.retried, false);
  assert.equal((await priceRows(env.INPUTS_DB)).length, 4);

  const job = await new RunStore(env.LIVE_DB, "live").getJob("backfill-prices-1");
  assert.equal(job.status, "complete");
  assert.equal(job.type, "backfill_prices");
  assert.equal(job.percent, 100);
  assert.equal(job.params.from, "2025-09-01");
  assert.equal(job.params.to, "2025-09-05");
  assert.equal(job.result.inserted, 4);
  assert.equal(job.result.tickers, 2);
  assert.deepEqual(job.result.failedTickers, []);
  assert.equal(job.detail, "Saved 4 price bars for 2 of 2 tickers");
});

test("queue() backfill_prices honours an explicit ticker list instead of the watchlist", async (t) => {
  silenceLogs(t);
  const env = workerEnv();
  const requests = mockYahoo(t, { AAPL: ["2025-09-02"], MSFT: ["2025-09-02"] });

  const message = new FakeMessage({ type: "backfill_prices", id: "backfill-prices-2", from: "2025-09-01", to: "2025-09-05", tickers: ["MSFT"] });
  await worker.queue({ messages: [message] }, env);

  assert.equal(requests.length, 1);
  assert.deepEqual((await priceRows(env.INPUTS_DB)).map((r) => r.ticker), ["MSFT"]);
  assert.equal((await new RunStore(env.LIVE_DB, "live").getJob("backfill-prices-2")).status, "complete");
});

test("queue() backfill_prices FAILS the job (not 'complete, 0 bars') when Yahoo 429s every ticker, names them, and still acks", async (t) => {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "warn", () => {});
  const errorLogs = [];
  t.mock.method(console, "error", (...args) => errorLogs.push(args));
  const env = workerEnv();
  mockYahoo(t, { AAPL: 429, MSFT: 429 });

  const message = new FakeMessage({ type: "backfill_prices", id: "backfill-prices-3", from: "2025-09-01", to: "2025-09-05" });
  await worker.queue({ messages: [message] }, env);

  assert.equal(message.acked, true, "no lasting state to retry into, and a retry would only 429 again");
  assert.equal(message.retried, false);
  assert.equal((await priceRows(env.INPUTS_DB)).length, 0);
  const job = await new RunStore(env.LIVE_DB, "live").getJob("backfill-prices-3");
  assert.equal(job.status, "failed");
  assert.match(job.error, /^No price bars saved/);
  assert.match(job.error, /AAPL/);
  assert.match(job.error, /MSFT/);
  assert.ok(errorLogs.some(([msg]) => msg.includes("backfill_prices job failed")));
});

test("queue() backfill_prices completes a partial fill and names the ticker that is missing", async (t) => {
  silenceLogs(t);
  const env = workerEnv();
  mockYahoo(t, { AAPL: ["2025-09-02", "2025-09-03"], MSFT: 429 });

  const message = new FakeMessage({ type: "backfill_prices", id: "backfill-prices-4", from: "2025-09-01", to: "2025-09-05" });
  await worker.queue({ messages: [message] }, env);

  assert.equal(message.acked, true);
  const job = await new RunStore(env.LIVE_DB, "live").getJob("backfill-prices-4");
  assert.equal(job.status, "complete");
  assert.equal(job.result.inserted, 2);
  assert.deepEqual(job.result.failedTickers, ["MSFT"]);
  assert.match(job.detail, /^Saved 2 price bars for 1 of 2 tickers; no bars for MSFT \(/);
});

test("queue() backfill_prices is not blocked by a cooldown the */15 cron set minutes ago", async (t) => {
  silenceLogs(t);
  const kv = new FakeKv();
  kv.store.set("yfinance:cooldown:AAPL", "1");
  const env = workerEnv({ CACHE_KV: kv });
  const requests = mockYahoo(t, { AAPL: ["2025-09-02"] });

  const message = new FakeMessage({ type: "backfill_prices", id: "backfill-prices-5", from: "2025-09-01", to: "2025-09-05", tickers: ["AAPL"] });
  await worker.queue({ messages: [message] }, env);

  assert.equal(requests.length, 1);
  assert.equal((await new RunStore(env.LIVE_DB, "live").getJob("backfill-prices-5")).status, "complete");
});

test("queue() backfill_prices still saves the bars and acks when LIVE_DB (the progress store) is down -- progress is best-effort", async (t) => {
  silenceLogs(t);
  const env = workerEnv({ LIVE_DB: new BrokenDb() });
  mockYahoo(t, { AAPL: ["2025-09-02"], MSFT: ["2025-09-02"] });

  const message = new FakeMessage({ type: "backfill_prices", id: "backfill-prices-6", from: "2025-09-01", to: "2025-09-05" });
  await worker.queue({ messages: [message] }, env);

  assert.equal((await priceRows(env.INPUTS_DB)).length, 2, "the backfill itself is unaffected");
  assert.equal(message.acked, true);
  assert.equal(message.retried, false);
});
