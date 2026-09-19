// Covers backend's (src/index.js) `queue()` export -- the JOBS consumer
// added in plan.md Step 3. POST /backfill (test/index_backfill.test.js)
// enqueues onto JOBS and returns immediately; this is where the real work
// (backfillHistoricalNews) actually runs, in its own invocation, decoupled
// from the ctx.waitUntil ~30s-past-response cutoff that motivated Step 3.
//
// UPDATE (plan.md Step 6): JOBS carries `backfill` ONLY now. `backtest` and
// `exit_check` moved onto a new LLM_JOBS queue consumed by the `llm` Worker
// (src/llm-worker.js) -- both call Gemini -- and the `backtest` processing
// test that used to live here moved to test/llm_worker.test.js unchanged in
// behavior. What stays here: backfill success/failure, the generic
// unrecognized-type/crashed-handler paths, and a new test proving the moved
// message types are NOT handled by backend anymore (they must never
// silently re-spend Gemini quota from a Worker that no longer holds a key).
//
// FakeMessage below stands in for a Cloudflare Queues Message object --
// just enough of its shape (`body`, `ack()`, `retry()`) for these tests to
// observe which one queue() called, without needing the real Queues
// runtime.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

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

function mockFinnhubJson() {
  return [{ url: "https://finnhub.example.com/story", datetime: 1757941800, headline: "Story about Acme", summary: "A brief summary." }];
}

test("queue() processes a backfill job: runs the real backfill, then acks the message", async (t) => {
  const db = new FakeNewsDb();
  // M2: news writes go to INPUTS_DB; env.DB is only the (best-effort) job_progress reporter until M2b.
  const env = { DB: {}, INPUTS_DB: db, WATCHLIST_TICKERS: "AAPL", FINNHUB_API_KEY: "test-key" };
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
  const env = { DB: {}, INPUTS_DB: new ThrowingDb(), WATCHLIST_TICKERS: "AAPL", FINNHUB_API_KEY: "test-key" };
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, json: async () => mockFinnhubJson() }));

  const errorLogs = [];
  t.mock.method(console, "error", (...args) => errorLogs.push(args));

  const message = new FakeMessage({ type: "backfill", id: "backfill-2", from: "2024-01-01", to: "2024-01-31" });
  await worker.queue(batchOf(message), env);

  assert.equal(message.acked, true);
  assert.equal(message.retried, false);
  assert.ok(errorLogs.some(([msg]) => msg.includes("backfill job failed")));
});

test("queue() no longer handles the Gemini-calling message types (backtest, exit_check, analyze) -- acks them as unrecognized, does no work", async (t) => {
  // These moved to the `llm` Worker (plan.md Step 6). If one still reaches
  // backend (e.g. already sitting on JOBS at the moment of the Step 6
  // deploy), it must be dropped with a log line, NOT processed -- backend
  // holds no Gemini key anymore, so "processing" it would just fail deep
  // inside the cascade after touching D1. env.DB is a bare object with no
  // methods: any attempt to actually run one of these would throw on first
  // D1 access and land in the retry path instead of ack, failing the
  // assertions below.
  const env = { DB: {} };
  const errorLogs = [];
  t.mock.method(console, "error", (...args) => errorLogs.push(args));

  const backtest = new FakeMessage({ type: "backtest", id: "backtest-1", tickers: ["AAPL"], testStart: "2024-01-01T00:00:00.000Z", testEnd: "2024-01-02T00:00:00.000Z" });
  const exitCheck = new FakeMessage({ type: "exit_check", asOf: "2026-09-19T00:00:00.000Z" });
  const analyze = new FakeMessage({ type: "analyze", runId: "news-1", ticker: "AAPL", newsItem: { id: "news-1", tickers: ["AAPL"] }, asOf: "2026-09-19T00:00:00.000Z" });
  await worker.queue(batchOf(backtest, exitCheck, analyze), env);

  for (const message of [backtest, exitCheck, analyze]) {
    assert.equal(message.acked, true);
    assert.equal(message.retried, false);
  }
  assert.equal(errorLogs.filter(([msg]) => msg.includes("unrecognized type")).length, 3);
});

test("queue() acks (does not retry) an unrecognized job type, logging the anomaly", async (t) => {
  const env = { DB: {} };
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
  const env = { DB: {} };
  const errorLogs = [];
  t.mock.method(console, "error", (...args) => errorLogs.push(args));

  const message = new FakeMessage(null); // job.type on null throws inside queue()'s try block
  await worker.queue(batchOf(message), env);

  assert.equal(message.acked, false);
  assert.equal(message.retried, true);
  assert.ok(errorLogs.some(([msg]) => msg.includes("crashed unexpectedly")));
});
