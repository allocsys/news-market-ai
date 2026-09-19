// Covers backend's (src/index.js) POST /backtest/run route after M2: the
// route is DISABLED (503) until the backtest Worker exists (M3). The engine
// now needs a SIM_DB-backed RunStore + SimClock that only that Worker will
// have, and the `llm` Worker rejects `backtest` messages outright (see
// test/llm_worker.test.js), so accepting a request here would only create a
// job that can never run. The contract this file pins down:
//   - a clear 503 JSON error naming M3, for valid AND invalid requests
//   - NOTHING enqueued (neither JOBS nor LLM_JOBS)
//   - NO job_progress row written (no phantom 'queued' job on the dashboard)
// The old enqueue behavior (LLM_JOBS message shape, 400 validation, 500 on
// enqueue failure) is in git history for the M3 hand-off.

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

/** A DB that records every statement prepared against it (a job row would be an INSERT INTO job_progress). */
class RecordingDb {
  constructor() {
    this.prepared = [];
  }
  prepare(sql) {
    this.prepared.push(sql);
    return { bind: () => ({ run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) }) };
  }
}

function baseEnv() {
  return {
    DB: new RecordingDb(),
    LIVE_DB: new RecordingDb(), // M2b: job_progress lives here now
    JOBS: new FakeQueue(),
    LLM_JOBS: new FakeQueue(),
    WATCHLIST_TICKERS: "AAPL,MSFT",
  };
}

test("POST /backtest/run returns 503 naming M3, and enqueues nothing / writes no job row, for a valid request", async () => {
  const env = baseEnv();

  const response = await worker.fetch(
    new Request("https://worker.example/backtest/run?testStart=2024-01-01&testEnd=2024-01-31&tickers=AAPL,%20MSFT&graceDays=5", { method: "POST" }),
    env
  );

  assert.equal(response.status, 503);
  assert.match(response.headers.get("content-type"), /application\/json/);
  const body = await response.json();
  assert.match(body.error, /backtest Worker in M3/);
  assert.equal(body.accepted, undefined);

  assert.equal(env.JOBS.sent.length, 0);
  assert.equal(env.LLM_JOBS.sent.length, 0);
  assert.equal(env.DB.prepared.length, 0, "no job_progress row may be created for a disabled route");
  assert.equal(env.LIVE_DB.prepared.length, 0, "...in LIVE_DB (where job_progress lives since M2b) either");
});

test("POST /backtest/run returns the same 503 for a malformed request (disabled before validation), still touching nothing", async () => {
  const env = baseEnv();

  const response = await worker.fetch(new Request("https://worker.example/backtest/run?testStart=nope", { method: "POST" }), env);

  assert.equal(response.status, 503);
  assert.equal(env.JOBS.sent.length, 0);
  assert.equal(env.LLM_JOBS.sent.length, 0);
  assert.equal(env.DB.prepared.length, 0);
  assert.equal(env.LIVE_DB.prepared.length, 0);
});
