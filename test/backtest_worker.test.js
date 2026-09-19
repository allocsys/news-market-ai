// Covers the `backtest` Worker's (src/backtest-worker.js) `queue()` export
// as scaffolded in this commit -- see that file's own header for what's
// NOT yet wired in (the real runner). This pins down the pre-rewrite
// contract: a `backtest` message fails loudly under its OWN run id in
// SIM_DB (not 'live' -- this Worker has no LIVE_DB binding at all, unlike
// the `llm` Worker's equivalent M2-era rejection in test/llm_worker.test.js),
// runs no engine code, and acks (not retries).

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/backtest-worker.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { STATE_DIR, INPUTS_DIR, SIM_DIR } from "./helpers/engine_ctx.js";
import { RunStore } from "../src/storage/run_store.js";

/** Real sqlite SIM_DB (state + sim schema) + INPUTS_DB -- the two bindings backtest-worker.js builds its context from. */
function engineBindings() {
  return { SIM_DB: createTestD1([STATE_DIR, SIM_DIR]), INPUTS_DB: createTestD1([INPUTS_DIR]) };
}

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

test("fetch() returns a 200 status page naming this as the backtest worker", async () => {
  const response = await worker.fetch();
  assert.equal(response.status, 200);
  assert.match(await response.text(), /backtest worker/);
});

test("queue() rejects a backtest job (scaffolding, runner not yet wired in): marks THIS run's job failed, runs nothing, then acks", async (t) => {
  const bindings = engineBindings();
  const env = { ...bindings, WATCHLIST_TICKERS: "AAPL,MSFT" };
  const errorLogs = [];
  t.mock.method(console, "error", (...args) => errorLogs.push(args));

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
  assert.ok(errorLogs.some(([msg]) => msg.includes("backtest job rejected")));

  // The job row lands under the backtest's OWN run id in SIM_DB -- not
  // 'live', and there is no LIVE_DB binding here to have written to anyway.
  const job = await bindings.SIM_DB.prepare("SELECT run_id, type, status, error FROM job_progress WHERE id = ?").bind("backtest-1").first();
  assert.equal(job.run_id, "backtest-1");
  assert.equal(job.type, "backtest");
  assert.equal(job.status, "failed");
  assert.match(job.error, /runner not yet wired in/);
  assert.equal((await new RunStore(bindings.SIM_DB, "backtest-1").getJob("backtest-1")).status, "failed", "and is what GET /api/jobs/:id will read back once backend exposes it for sim runs");

  // Nothing ran: no engine state written for this run.
  for (const table of ["positions", "trade_decisions", "decision_memory", "pipeline_checkpoints"]) {
    const row = await bindings.SIM_DB.prepare(`SELECT COUNT(*) as n FROM ${table} WHERE run_id = ?`).bind("backtest-1").first();
    assert.equal(row.n, 0, `${table} should be untouched`);
  }
});

test("queue() acks (does not retry) an unrecognized message type without touching D1", async (t) => {
  const bindings = engineBindings();
  const env = { ...bindings };
  const errorLogs = [];
  t.mock.method(console, "error", (...args) => errorLogs.push(args));

  const message = new FakeMessage({ type: "something_else", id: "x-1" });
  await worker.queue(batchOf(message), env);

  assert.equal(message.acked, true);
  assert.equal(message.retried, false);
  assert.ok(errorLogs.some(([msg]) => msg.includes("unrecognized type")));
});

test("queue() retries (does not ack) when the handler itself throws unexpectedly", async (t) => {
  const errorLogs = [];
  t.mock.method(console, "error", (...args) => errorLogs.push(args));
  const bindings = engineBindings();
  const env = { ...bindings };

  // A `backtest` message with no `id` -- RunStore's own constructor throws
  // synchronously on a missing runId (see run_store.js), which is NOT one
  // of createJobReporter's swallowed best-effort D1 failures, so this is a
  // genuine unexpected crash inside the try block, not an ordinary
  // operational failure.
  const message = new FakeMessage({ type: "backtest", tickers: ["AAPL"], testStart: "2024-01-01", testEnd: "2024-01-02" });
  await worker.queue(batchOf(message), env);

  assert.equal(message.acked, false);
  assert.equal(message.retried, true);
  assert.ok(errorLogs.some(([msg]) => msg.includes("crashed unexpectedly")));
});
