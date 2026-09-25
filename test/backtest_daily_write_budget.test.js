// Covers BACKTEST_DAILY_WRITE_BUDGET end to end (plan.md #6):
//   - sim_registry.js: addBacktestRunRowsWritten / getBacktestRowsWrittenToday
//   - backtest-worker.js: the two refusal points (before a continuation part
//     starts, and right after a part's own writes land) and that a run's
//     rows_written is persisted every part regardless of outcome.
// Real sqlite SIM_DB (state + sim schema) -- same convention as
// backtest_worker.test.js -- so migrations/sim/0002_add_rows_written.sql is
// exercised for real, not just the JS.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/backtest-worker.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { STATE_DIR, INPUTS_DIR, SIM_DIR, seedBar } from "./helpers/engine_ctx.js";
import { insertBacktestRun, addBacktestRunRowsWritten, getBacktestRowsWrittenToday } from "../src/storage/sim_registry.js";

function engineBindings() {
  return { SIM_DB: createTestD1([STATE_DIR, SIM_DIR]), INPUTS_DB: createTestD1([INPUTS_DIR]) };
}

class FakeMessage {
  constructor(body) {
    this.body = body;
    this.acked = false;
    this.retried = false;
  }
  ack() { this.acked = true; }
  retry() { this.retried = true; }
}

const batchOf = (...messages) => ({ messages });

const OK_JOB = { type: "backtest", id: "bt-budget", tickers: ["AAPL"], testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-03T00:00:00.000Z", graceDays: 1 };

async function seedOffSideBars(inputsDb) {
  await seedBar(inputsDb, { ticker: "AAPL", date: "2026-01-01", close: 100 });
  await seedBar(inputsDb, { ticker: "AAPL", date: "2026-01-03", close: 110 });
}

// ---------------------------------------------------------------------------
// sim_registry.js
// ---------------------------------------------------------------------------

test("addBacktestRunRowsWritten accumulates onto rows_written; a non-positive amount is a no-op", async () => {
  const db = createTestD1([STATE_DIR, SIM_DIR]);
  await insertBacktestRun(db, { id: "r1", tickers: ["AAPL"], testStart: "a", testEnd: "b", trainDays: 0, testDays: 1, startedAt: "2026-05-01T00:00:00.000Z" });

  await addBacktestRunRowsWritten(db, { id: "r1", rows: 100 });
  await addBacktestRunRowsWritten(db, { id: "r1", rows: 50 });
  await addBacktestRunRowsWritten(db, { id: "r1", rows: 0 });
  await addBacktestRunRowsWritten(db, { id: "r1", rows: -5 });

  const row = await db.prepare("SELECT rows_written FROM backtest_runs WHERE id = 'r1'").first();
  assert.equal(row.rows_written, 150);
});

test("getBacktestRowsWrittenToday sums rows_written across every run STARTED today (any status), excludes other days", async () => {
  const db = createTestD1([STATE_DIR, SIM_DIR]);
  const today = new Date("2026-05-10T12:00:00.000Z");
  await insertBacktestRun(db, { id: "today-running", tickers: ["AAPL"], testStart: "a", testEnd: "b", trainDays: 0, testDays: 1, startedAt: "2026-05-10T01:00:00.000Z" });
  await insertBacktestRun(db, { id: "today-failed", tickers: ["AAPL"], testStart: "a", testEnd: "b", trainDays: 0, testDays: 1, startedAt: "2026-05-10T23:00:00.000Z" });
  await insertBacktestRun(db, { id: "yesterday", tickers: ["AAPL"], testStart: "a", testEnd: "b", trainDays: 0, testDays: 1, startedAt: "2026-05-09T23:59:00.000Z" });
  await addBacktestRunRowsWritten(db, { id: "today-running", rows: 1000 });
  await addBacktestRunRowsWritten(db, { id: "today-failed", rows: 2000 });
  await addBacktestRunRowsWritten(db, { id: "yesterday", rows: 999999 });

  const total = await getBacktestRowsWrittenToday(db, { now: today });
  assert.equal(total, 3000, "only today's two runs count, regardless of status");
});

test("getBacktestRowsWrittenToday returns 0 when nothing was written today", async () => {
  const db = createTestD1([STATE_DIR, SIM_DIR]);
  const total = await getBacktestRowsWrittenToday(db, { now: new Date("2026-05-10T12:00:00.000Z") });
  assert.equal(total, 0);
});

// ---------------------------------------------------------------------------
// backtest-worker.js: enforcement
// ---------------------------------------------------------------------------

test("queue(): rows_written is persisted to the registry after a part completes, even when the daily budget is disabled (0)", async (t) => {
  const bindings = engineBindings();
  await seedOffSideBars(bindings.INPUTS_DB);
  // rows_written only accumulates when the per-invocation SubrequestBudget is
  // engaged (buildBudgetedEnv requires env.BACKTEST + both limits > 0) -- it's
  // that budget's countedD1 wrapper that observes meta.changes per write.
  const env = { ...bindings, BACKTEST_DAILY_WRITE_BUDGET: "0", BACKTEST: { send: async () => {} } };
  t.mock.method(console, "log", () => {});

  const message = new FakeMessage(OK_JOB);
  await worker.queue(batchOf(message), env);

  const run = await bindings.SIM_DB.prepare("SELECT status, rows_written FROM backtest_runs WHERE id = 'bt-budget'").first();
  assert.equal(run.status, "complete");
  assert.ok(run.rows_written > 0, "a completed run should have written at least some rows");
});

test("queue(): a CONTINUATION is refused once today's cross-run total is already at/over the budget -- run fails, message still acks, no BACKTEST send", async (t) => {
  const bindings = engineBindings();
  await seedOffSideBars(bindings.INPUTS_DB);
  const sent = [];
  const env = { ...bindings, BACKTEST_DAILY_WRITE_BUDGET: "10", BACKTEST: { send: async (msg, opts) => sent.push({ msg, opts }) } };
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});

  // Pre-seed the run's registry row (a continuation always has one, per
  // backtest-worker.js's own comment) already over budget from an earlier part.
  await insertBacktestRun(bindings.SIM_DB, { id: "bt-budget", tickers: ["AAPL"], testStart: OK_JOB.testStart, testEnd: OK_JOB.testEnd, trainDays: 0, testDays: 2, graceDays: 1, startedAt: new Date().toISOString() });
  await addBacktestRunRowsWritten(bindings.SIM_DB, { id: "bt-budget", rows: 10 });

  const message = new FakeMessage({ ...OK_JOB, part: 2, cursor: { dayIndex: 1 } });
  await worker.queue(batchOf(message), env);

  assert.equal(message.acked, true);
  assert.equal(message.retried, false);
  assert.equal(sent.length, 0, "no continuation should be enqueued once the daily budget is exhausted");
  const run = await bindings.SIM_DB.prepare("SELECT status, error FROM backtest_runs WHERE id = 'bt-budget'").first();
  assert.equal(run.status, "failed");
  assert.match(run.error, /Daily backtest write budget exhausted/);
  assert.match(run.error, /BACKTEST_DAILY_WRITE_BUDGET=10/);
});

test("queue(): part 1 of a brand-new run is never refused by the daily budget, even if the budget is already exhausted by other runs (progress guarantee)", async (t) => {
  const bindings = engineBindings();
  await seedOffSideBars(bindings.INPUTS_DB);
  const env = { ...bindings, BACKTEST_DAILY_WRITE_BUDGET: "1" };
  t.mock.method(console, "log", () => {});

  // A different run already blew the tiny budget today.
  await insertBacktestRun(bindings.SIM_DB, { id: "bt-other", tickers: ["AAPL"], testStart: "a", testEnd: "b", trainDays: 0, testDays: 1, startedAt: new Date().toISOString() });
  await addBacktestRunRowsWritten(bindings.SIM_DB, { id: "bt-other", rows: 1000 });

  const message = new FakeMessage(OK_JOB); // part 1 (implicit)
  await worker.queue(batchOf(message), env);

  const run = await bindings.SIM_DB.prepare("SELECT status FROM backtest_runs WHERE id = 'bt-budget'").first();
  assert.notEqual(run.status, undefined, "part 1 must have been allowed to run and create/finish its own registry row");
  assert.notEqual(run.error, "Daily backtest write budget exhausted", "part 1 is never refused by the daily cap");
});
