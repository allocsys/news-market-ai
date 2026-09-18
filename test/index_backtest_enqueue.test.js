// Covers backend's (src/index.js) POST /backtest/run route -- the operational
// entry point wired onto backtest/runBacktest.js. Same shape as
// test/index_backfill.test.js's coverage of POST /backfill: validate, enqueue,
// return an immediate ack.
//
// The point of this file (plan.md Step 6): the message goes onto LLM_JOBS,
// NOT JOBS. A backtest's "signal on" side runs the real Gemini-backed
// pipeline, so its consumer is the `llm` Worker (src/llm-worker.js) -- see
// test/llm_worker.test.js for that half of the contract. JOBS stays
// backfill-only so backend never has a reason to hold a Gemini key.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

class FakeQueue {
  constructor() {
    this.sent = [];
  }
  async send(body) {
    this.sent.push(body);
  }
}

class ThrowingQueue {
  async send() {
    throw new Error("simulated queue send failure");
  }
}

function baseEnv(overrides = {}) {
  return {
    DB: {},
    JOBS: new FakeQueue(),
    LLM_JOBS: new FakeQueue(),
    WATCHLIST_TICKERS: "AAPL,MSFT",
    ...overrides,
  };
}

test("POST /backtest/run returns 400 for a missing or malformed testStart/testEnd, without touching either queue", async () => {
  const env = baseEnv();

  const missing = await worker.fetch(new Request("https://worker.example/backtest/run?testStart=2024-01-01", { method: "POST" }), env);
  assert.equal(missing.status, 400);

  const malformed = await worker.fetch(new Request("https://worker.example/backtest/run?testStart=nope&testEnd=2024-01-31", { method: "POST" }), env);
  assert.equal(malformed.status, 400);

  assert.equal(env.LLM_JOBS.sent.length, 0);
  assert.equal(env.JOBS.sent.length, 0);
});

test("POST /backtest/run with a valid range enqueues a backtest job onto LLM_JOBS (not JOBS) and returns an immediate accepted ack", async () => {
  const env = baseEnv();

  const request = new Request("https://worker.example/backtest/run?testStart=2024-01-01&testEnd=2024-01-31&tickers=AAPL,%20MSFT&graceDays=5", { method: "POST" });
  const response = await worker.fetch(request, env);

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/json/);
  const body = await response.json();
  assert.equal(body.accepted, true);
  assert.match(body.id, /^backtest-/);
  assert.deepEqual(body.tickers, ["AAPL", "MSFT"]);

  assert.equal(env.JOBS.sent.length, 0);
  assert.equal(env.LLM_JOBS.sent.length, 1);
  assert.deepEqual(env.LLM_JOBS.sent[0], {
    type: "backtest",
    id: body.id,
    tickers: ["AAPL", "MSFT"],
    testStart: "2024-01-01T00:00:00.000Z",
    testEnd: "2024-01-31T00:00:00.000Z",
    graceDays: 5,
  });
});

test("POST /backtest/run defaults to the configured watchlist when no tickers param is given", async () => {
  const env = baseEnv();

  const request = new Request("https://worker.example/backtest/run?testStart=2024-01-01&testEnd=2024-01-31", { method: "POST" });
  const response = await worker.fetch(request, env);

  assert.equal(response.status, 200);
  assert.equal(env.LLM_JOBS.sent.length, 1);
  assert.deepEqual(env.LLM_JOBS.sent[0].tickers, ["AAPL", "MSFT"]);
});

test("POST /backtest/run returns 500 with the failure message if enqueueing itself fails (e.g. LLM_JOBS unavailable)", async (t) => {
  const env = baseEnv({ LLM_JOBS: new ThrowingQueue() });

  const errorLogs = [];
  t.mock.method(console, "error", (...args) => errorLogs.push(args));

  const request = new Request("https://worker.example/backtest/run?testStart=2024-01-01&testEnd=2024-01-31", { method: "POST" });
  const response = await worker.fetch(request, env);

  assert.equal(response.status, 500);
  const body = await response.json();
  assert.match(body.message, /simulated queue send failure/);
  assert.ok(errorLogs.some(([msg]) => msg.includes("backtest enqueue failed")));
});
