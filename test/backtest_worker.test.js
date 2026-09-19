// Covers the `backtest` Worker's (src/backtest-worker.js) `queue()` export:
// a `backtest` message runs through the real runManualBacktest, entirely
// SIM-side. Real sqlite SIM_DB (state + sim schema) and INPUTS_DB, and the
// env deliberately has NO LIVE_DB -- this Worker holds no such binding
// (wrangler.backtest.toml), so every passing test here also proves nothing on
// the queue() path reaches for it. Windows are in the past, so SimClock's
// real "now" never interferes; the on side sees no news (loadConfig can't
// supply config.fakeModel), so no LLM call is made -- the pipeline-through-
// runManualBacktest coverage lives in test/backtest_run.test.js.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/backtest-worker.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { STATE_DIR, INPUTS_DIR, SIM_DIR, seedBar } from "./helpers/engine_ctx.js";
import { RunStore } from "../src/storage/run_store.js";
import { createJobReporter } from "../src/storage/jobs.js";
import { insertBacktestRun } from "../src/storage/sim_registry.js";

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

const OK_JOB = {
  type: "backtest",
  id: "backtest-1",
  tickers: ["AAPL"],
  testStart: "2026-01-01T00:00:00.000Z",
  testEnd: "2026-01-03T00:00:00.000Z",
  graceDays: 1,
};

async function seedOffSideBars(inputsDb) {
  await seedBar(inputsDb, { ticker: "AAPL", date: "2026-01-01", close: 100 });
  await seedBar(inputsDb, { ticker: "AAPL", date: "2026-01-03", close: 110 });
}

test("queue() runs a backtest job end to end: registry row 'complete', job_progress 'complete' with the result, all under the run's OWN id in SIM_DB, then acks", async (t) => {
  const bindings = engineBindings();
  await seedOffSideBars(bindings.INPUTS_DB);
  const env = { ...bindings, WATCHLIST_TICKERS: "AAPL,MSFT" };
  t.mock.method(console, "log", () => {});

  const message = new FakeMessage(OK_JOB);
  await worker.queue(batchOf(message), env);

  assert.equal(message.acked, true);
  assert.equal(message.retried, false);

  const run = await bindings.SIM_DB.prepare("SELECT status, result, error, finished_at, grace_days FROM backtest_runs WHERE id = ?").bind("backtest-1").first();
  assert.equal(run.status, "complete");
  assert.equal(run.error, null);
  assert.ok(run.finished_at);
  assert.equal(run.grace_days, 1);
  const result = JSON.parse(run.result);
  assert.ok(result.overall && Array.isArray(result.perWindow));

  const job = await new RunStore(bindings.SIM_DB, "backtest-1").getJob("backtest-1");
  assert.equal(job.status, "complete");
  assert.equal(job.type, "backtest");
  assert.equal(job.percent, 100);
  assert.deepEqual(job.result, result, "the dashboard's job view carries the same result the registry stored");
});

test("queue() records a run that can't be run (future testEnd) as failed in BOTH the registry and job_progress, and still acks -- retrying a deterministic failure would fail identically", async (t) => {
  const bindings = engineBindings();
  const env = { ...bindings };
  t.mock.method(console, "log", () => {});

  const message = new FakeMessage({ ...OK_JOB, id: "backtest-future", testStart: "2099-01-01T00:00:00.000Z", testEnd: "2099-01-05T00:00:00.000Z" });
  await worker.queue(batchOf(message), env);

  assert.equal(message.acked, true);
  assert.equal(message.retried, false);
  const run = await bindings.SIM_DB.prepare("SELECT status, error, result FROM backtest_runs WHERE id = ?").bind("backtest-future").first();
  assert.equal(run.status, "failed");
  assert.match(run.error, /testEnd/);
  assert.match(run.error, /future/);
  assert.equal(run.result, null);
  const job = await new RunStore(bindings.SIM_DB, "backtest-future").getJob("backtest-future");
  assert.equal(job.status, "failed");
  assert.match(job.error, /future/);
  for (const table of ["positions", "trade_decisions", "decision_memory", "pipeline_checkpoints"]) {
    const row = await bindings.SIM_DB.prepare(`SELECT COUNT(*) as n FROM ${table} WHERE run_id = ?`).bind("backtest-future").first();
    assert.equal(row.n, 0, `${table} should be untouched`);
  }
});

test("queue() handles a REDELIVERED message (first attempt died after writing the 'running' registry row): continues to 'complete' instead of dying on a primary-key conflict", async (t) => {
  const bindings = engineBindings();
  await seedOffSideBars(bindings.INPUTS_DB);
  const env = { ...bindings };
  t.mock.method(console, "log", () => {});
  // What the dead first attempt left behind: a 'running' registry row and a 'running' job.
  await insertBacktestRun(bindings.SIM_DB, { id: "backtest-1", tickers: ["AAPL"], testStart: OK_JOB.testStart, testEnd: OK_JOB.testEnd, trainDays: 0, testDays: 2, graceDays: 1, startedAt: "2026-01-04T00:00:00.000Z" });
  await createJobReporter(new RunStore(bindings.SIM_DB, "backtest-1"), { id: "backtest-1", type: "backtest" }).start();

  const message = new FakeMessage(OK_JOB);
  await worker.queue(batchOf(message), env);

  assert.equal(message.acked, true);
  assert.equal(message.retried, false);
  const { n } = await bindings.SIM_DB.prepare("SELECT COUNT(*) as n FROM backtest_runs WHERE id = ?").bind("backtest-1").first();
  assert.equal(n, 1, "still exactly one registry row");
  const run = await bindings.SIM_DB.prepare("SELECT status, started_at FROM backtest_runs WHERE id = ?").bind("backtest-1").first();
  assert.equal(run.status, "complete");
  assert.equal(run.started_at, "2026-01-04T00:00:00.000Z", "the first attempt's row stands");
  assert.equal((await new RunStore(bindings.SIM_DB, "backtest-1").getJob("backtest-1")).status, "complete");
});

test("queue() retries (does not ack) when the registry write itself fails -- an infrastructure failure, not a run failure", async (t) => {
  const bindings = engineBindings();
  const realSim = bindings.SIM_DB;
  // SIM_DB is up for job_progress writes (best-effort anyway) but the registry INSERT throws.
  const env = { ...bindings, SIM_DB: { prepare(sql) { if (/INSERT INTO backtest_runs/.test(sql)) throw new Error("simulated SIM_DB outage"); return realSim.prepare(sql); }, batch: (...a) => realSim.batch(...a) } };
  const errorLogs = [];
  t.mock.method(console, "error", (...args) => errorLogs.push(args));

  const message = new FakeMessage(OK_JOB);
  await worker.queue(batchOf(message), env);

  assert.equal(message.acked, false);
  assert.equal(message.retried, true);
  assert.ok(errorLogs.some(([msg]) => msg.includes("crashed unexpectedly")));
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
