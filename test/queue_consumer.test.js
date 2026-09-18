// Covers backend's (src/index.js) `queue()` export -- the JOBS consumer
// added in plan.md Step 3. POST /backfill and POST /backtest/run
// (test/index_backfill.test.js, and the corresponding backtest route)
// enqueue onto JOBS and return immediately; this is where the real work
// (backfillHistoricalNews / runManualBacktest) actually runs, in its own
// invocation, decoupled from the ctx.waitUntil ~30s-past-response cutoff
// that motivated this step.
//
// FakeMessage below stands in for a Cloudflare Queues Message object --
// just enough of its shape (`body`, `ack()`, `retry()`) for these tests to
// observe which one queue() called, without needing the real Queues
// runtime.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { getRecentBacktestRuns } from "../src/storage/d1.js";

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

function batchOf(...messages) {
  return { messages };
}

class FakeNewsDb {
  constructor() {
    this.newsItems = [];
  }
  prepare(sql) {
    const db = this;
    return {
      bind(...args) {
        return {
          async run() {
            if (/INSERT INTO news_items/.test(sql)) db.newsItems.push({ id: args[0] });
          },
        };
      },
    };
  }
}

// Same narrow in-memory fake as test/storage_backtest_runs.test.js -- this
// file needs the real insert/complete/fail/list SQL shapes runManualBacktest
// actually issues, not a hand-guessed one.
class FakeBacktestRunsDb {
  constructor() {
    this.rows = new Map();
  }
  prepare(sql) {
    const db = this;
    return {
      bind(...args) {
        return {
          async run() {
            if (/INSERT INTO backtest_runs/.test(sql)) {
              const [id, tickers, testStart, testEnd, trainDays, testDays, graceDays, startedAt] = args;
              db.rows.set(id, {
                id, tickers, test_start: testStart, test_end: testEnd, train_days: trainDays, test_days: testDays,
                grace_days: graceDays, status: "running", result: null, error: null, started_at: startedAt, finished_at: null,
              });
              return;
            }
            if (/UPDATE backtest_runs SET status = 'complete'/.test(sql)) {
              const [result, finishedAt, id] = args;
              const row = db.rows.get(id);
              if (row) { row.status = "complete"; row.result = result; row.finished_at = finishedAt; }
              return;
            }
            if (/UPDATE backtest_runs SET status = 'failed'/.test(sql)) {
              const [error, finishedAt, id] = args;
              const row = db.rows.get(id);
              if (row) { row.status = "failed"; row.error = error; row.finished_at = finishedAt; }
              return;
            }
            throw new Error(`FakeBacktestRunsDb: unsupported run() query: ${sql}`);
          },
          async all() {
            if (/FROM backtest_runs/.test(sql)) {
              const [limit] = args;
              const results = [...db.rows.values()].sort((a, b) => (a.started_at < b.started_at ? 1 : -1)).slice(0, limit);
              return { results };
            }
            throw new Error(`FakeBacktestRunsDb: unsupported all() query: ${sql}`);
          },
        };
      },
    };
  }
}

function mockFinnhubJson() {
  return [{ url: "https://finnhub.example.com/story", datetime: 1757941800, headline: "Story about Acme", summary: "A brief summary." }];
}

test("queue() processes a backfill job: runs the real backfill, then acks the message", async (t) => {
  const db = new FakeNewsDb();
  const env = { DB: db, WATCHLIST_TICKERS: "AAPL", FINNHUB_API_KEY: "test-key" };
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, json: async () => mockFinnhubJson() }));

  const message = new FakeMessage({ type: "backfill", id: "backfill-1", from: "2024-01-01", to: "2024-01-31" });
  await worker.queue(batchOf(message), env);

  assert.equal(db.newsItems.length, 1);
  assert.equal(message.acked, true);
  assert.equal(message.retried, false);
});

test("queue() catches a backfill failure (e.g. a D1 write error), logs it, and still acks -- no lasting state to retry into", async (t) => {
  class ThrowingDb extends FakeNewsDb {
    prepare() {
      throw new Error("simulated D1 write failure");
    }
  }
  const env = { DB: new ThrowingDb(), WATCHLIST_TICKERS: "AAPL", FINNHUB_API_KEY: "test-key" };
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, json: async () => mockFinnhubJson() }));

  const errorLogs = [];
  t.mock.method(console, "error", (...args) => errorLogs.push(args));

  const message = new FakeMessage({ type: "backfill", id: "backfill-2", from: "2024-01-01", to: "2024-01-31" });
  await worker.queue(batchOf(message), env);

  assert.equal(message.acked, true);
  assert.equal(message.retried, false);
  assert.ok(errorLogs.some(([msg]) => msg.includes("backfill job failed")));
});

test("queue() processes a backtest job: runs runManualBacktest, persists a completed backtest_runs row, then acks", async (t) => {
  const db = new FakeBacktestRunsDb();
  const env = { DB: db };
  // structured.js's config.fakeModel isn't wired through queue() -- this
  // test only needs runManualBacktest to be CALLED and to persist a row;
  // it doesn't need the "on signal" side's real Gemini path to succeed, so
  // a window with no backfilled news (onSignalRunner reads nothing, no LLM
  // calls) is enough to exercise the whole plumbing without live traffic.
  const message = new FakeMessage({
    type: "backtest",
    id: "backtest-1",
    tickers: ["AAPL"],
    testStart: "2024-01-01T00:00:00.000Z",
    testEnd: "2024-01-02T00:00:00.000Z",
    graceDays: 0,
  });

  await worker.queue(batchOf(message), env);

  assert.equal(message.acked, true);
  assert.equal(message.retried, false);
  const [run] = await getRecentBacktestRuns(db, { limit: 10 });
  assert.equal(run.id, "backtest-1");
  assert.ok(run.status === "complete" || run.status === "failed"); // runManualBacktest never throws -- see its own header
});

test("queue() acks (does not retry) an unrecognized job type, logging the anomaly", async (t) => {
  const env = { DB: new FakeBacktestRunsDb() };
  const errorLogs = [];
  t.mock.method(console, "error", (...args) => errorLogs.push(args));

  const message = new FakeMessage({ type: "something-unexpected", id: "mystery-1" });
  await worker.queue(batchOf(message), env);

  assert.equal(message.acked, true);
  assert.equal(message.retried, false);
  assert.ok(errorLogs.some(([msg]) => msg.includes("unrecognized type")));
});

test("queue() retries (does not ack) a message when the handler itself crashes unexpectedly", async (t) => {
  // A message with no `.type` at all reaches the `else` branch fine (that's
  // the "unrecognized type" case above) -- to actually exercise the retry
  // path we need queue()'s own try/catch to see a real thrown error, e.g.
  // a completely malformed message body that isn't even an object.
  const env = { DB: new FakeBacktestRunsDb() };
  const errorLogs = [];
  t.mock.method(console, "error", (...args) => errorLogs.push(args));

  const message = new FakeMessage(null); // job.type on null throws inside queue()'s try block
  await worker.queue(batchOf(message), env);

  assert.equal(message.acked, false);
  assert.equal(message.retried, true);
  assert.ok(errorLogs.some(([msg]) => msg.includes("crashed unexpectedly")));
});
