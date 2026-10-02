// Covers the daily quota guard end to end (plan.md #6, now pause/resume + the quota_usage ledger):
//   - sim_registry.js: addBacktestRunRowsWritten / getBacktestRowsWrittenToday
//   - quotaTrigger (backtest-worker.js): which daily share trips, at what percent
//   - backtest-worker.js: the refusal point before a continuation part starts now PARKS the run
//     (status 'paused', data + cursor kept, manual resume) instead of failing it; part 1 is never
//     refused; a part's counts land in today's ledger row; a paused run's redelivered continuation
//     saves its cursor and is acked.
// Real sqlite SIM_DB (state + sim schema) -- same convention as backtest_worker.test.js -- so
// migrations/sim/0002 and 0003 are exercised for real, not just the JS.

import test from "node:test";
import assert from "node:assert/strict";
import worker, { quotaTrigger } from "../src/backtest-worker.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { STATE_DIR, INPUTS_DIR, SIM_DIR, seedBar } from "./helpers/engine_ctx.js";
import { insertBacktestRun, addBacktestRunRowsWritten, getBacktestRowsWrittenToday, pauseBacktestRun } from "../src/storage/sim_registry.js";
import { getQuotaUsage, quotaUsageUpsertStatement, utcDay, nextUtcMidnightIso } from "../src/storage/quota_usage.js";

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

/** Pre-seeds today's quota_usage row, as earlier parts/runs of the day would have. */
async function seedLedger(db, counts) {
  await quotaUsageUpsertStatement(db, { day: utcDay(), ...counts }).run();
}

/** The registry row a continuation always has (backtest-worker.js: part > 1 with no row is treated as deleted). */
async function seedRunningRun(db) {
  await insertBacktestRun(db, { id: "bt-budget", tickers: ["AAPL"], testStart: OK_JOB.testStart, testEnd: OK_JOB.testEnd, trainDays: 0, testDays: 2, graceDays: 1, startedAt: new Date().toISOString() });
}

const PAUSE_COLUMNS = "status, error, paused_reason, paused_at, resume_after, cursor, rows_written";

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
// quotaTrigger
// ---------------------------------------------------------------------------

const TRIGGER_CONFIG = { quotaPausePct: 90, backtestDailyWriteBudget: 1000, backtestDailyReadBudget: 2000, backtestDailyKvWriteBudget: 500, backtestDailyKvReadBudget: 50000 };
const ZERO_USAGE = { d1Written: 0, d1Read: 0, kvReads: 0, kvWrites: 0 };

test("quotaTrigger: null below every threshold; trips AT quotaPausePct percent of a share, not before", () => {
  assert.equal(quotaTrigger(TRIGGER_CONFIG, ZERO_USAGE), null);
  assert.equal(quotaTrigger(TRIGGER_CONFIG, { ...ZERO_USAGE, d1Written: 899 }), null, "899 < 90% of 1000");
  const hit = quotaTrigger(TRIGGER_CONFIG, { ...ZERO_USAGE, d1Written: 900 });
  assert.equal(hit.reason, "d1_write_budget");
  assert.match(hit.detail, /D1 rows written today: 900 of our 1000\/day share \(pause at 90%\)/);
});

test("quotaTrigger: D1 writes report d1_write_budget; the other counters report quota_threshold", () => {
  assert.equal(quotaTrigger(TRIGGER_CONFIG, { ...ZERO_USAGE, d1Read: 1800 }).reason, "quota_threshold");
  assert.match(quotaTrigger(TRIGGER_CONFIG, { ...ZERO_USAGE, d1Read: 1800 }).detail, /D1 rows read/);
  assert.match(quotaTrigger(TRIGGER_CONFIG, { ...ZERO_USAGE, kvWrites: 450 }).detail, /KV writes/);
  assert.match(quotaTrigger(TRIGGER_CONFIG, { ...ZERO_USAGE, kvReads: 45000 }).detail, /KV reads/);
  assert.equal(quotaTrigger(TRIGGER_CONFIG, { ...ZERO_USAGE, kvReads: 45000 }).reason, "quota_threshold");
});

test("quotaTrigger: a share of 0 disables that counter", () => {
  const cfg = { ...TRIGGER_CONFIG, backtestDailyReadBudget: 0, backtestDailyKvReadBudget: 0 };
  assert.equal(quotaTrigger(cfg, { ...ZERO_USAGE, d1Read: 10 ** 9, kvReads: 10 ** 9 }), null);
  assert.equal(quotaTrigger({ ...cfg, backtestDailyWriteBudget: 0 }, { ...ZERO_USAGE, d1Written: 10 ** 9 }), null);
});

test("quotaTrigger: quotaPausePct 0 disables the percent checks, but the D1 write share still applies at 100%", () => {
  const cfg = { ...TRIGGER_CONFIG, quotaPausePct: 0 };
  assert.equal(quotaTrigger(cfg, { ...ZERO_USAGE, d1Written: 999 }), null);
  assert.equal(quotaTrigger(cfg, { ...ZERO_USAGE, d1Written: 1000 }).reason, "d1_write_budget");
  assert.equal(quotaTrigger(cfg, { ...ZERO_USAGE, d1Read: 10 ** 9, kvWrites: 10 ** 9, kvReads: 10 ** 9 }), null, "no percent -> no other counter is checked");
});

test("quotaTrigger: the first counter in D1-write, D1-read, KV-write, KV-read order wins when several are over", () => {
  const hit = quotaTrigger(TRIGGER_CONFIG, { d1Written: 5000, d1Read: 5000, kvWrites: 5000, kvReads: 500000 });
  assert.equal(hit.reason, "d1_write_budget");
});

// ---------------------------------------------------------------------------
// backtest-worker.js: ledger + enforcement
// ---------------------------------------------------------------------------

test("queue(): rows_written is persisted to the registry and the part's counts land in today's quota ledger, even when the daily write budget is disabled (0)", async (t) => {
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
  const ledger = await getQuotaUsage(bindings.SIM_DB);
  assert.ok(ledger.d1Written > 0, "today's ledger row was created and charged this part's D1 writes");
});

test("queue(): a CONTINUATION that would start over today's D1 write share PARKS the run -- status paused, cursor envelope kept, resume_after next UTC midnight, acked, no BACKTEST send, nothing deleted", async (t) => {
  const bindings = engineBindings();
  await seedOffSideBars(bindings.INPUTS_DB);
  const sent = [];
  const env = { ...bindings, BACKTEST_DAILY_WRITE_BUDGET: "10", BACKTEST: { send: async (msg, opts) => sent.push({ msg, opts }) } };
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});

  await seedRunningRun(bindings.SIM_DB);
  // Today's ledger is already at the share (10 of 10; the pause threshold is 90% of it).
  await seedLedger(bindings.SIM_DB, { d1Written: 10 });

  const message = new FakeMessage({ ...OK_JOB, part: 2, cursor: { dayIndex: 1 } });
  await worker.queue(batchOf(message), env);

  assert.equal(message.acked, true);
  assert.equal(message.retried, false);
  assert.equal(sent.length, 0, "no continuation is enqueued while parked");
  const run = await bindings.SIM_DB.prepare(`SELECT ${PAUSE_COLUMNS} FROM backtest_runs WHERE id = 'bt-budget'`).first();
  assert.equal(run.status, "paused", "paused, NOT failed (a failed run's data would be deleted)");
  assert.equal(run.error, null);
  assert.equal(run.paused_reason, "d1_write_budget");
  assert.ok(run.paused_at, "paused_at is stamped");
  assert.equal(run.resume_after, nextUtcMidnightIso());
  assert.deepEqual(JSON.parse(run.cursor), {
    part: 2,
    cursor: { dayIndex: 1 },
    job: { id: "bt-budget", tickers: ["AAPL"], testStart: OK_JOB.testStart, testEnd: OK_JOB.testEnd, graceDays: 1 },
  });
});

test("queue(): a part-2 continuation under the threshold is NOT parked by the ledger check (the other counters only trip at their own share)", async (t) => {
  const bindings = engineBindings();
  await seedOffSideBars(bindings.INPUTS_DB);
  const env = { ...bindings, BACKTEST_DAILY_WRITE_BUDGET: "1000000", BACKTEST: { send: async () => {} } };
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});

  await seedRunningRun(bindings.SIM_DB);
  await seedLedger(bindings.SIM_DB, { d1Written: 5 });

  const message = new FakeMessage({ ...OK_JOB, part: 2, cursor: null });
  await worker.queue(batchOf(message), env);

  const run = await bindings.SIM_DB.prepare(`SELECT ${PAUSE_COLUMNS} FROM backtest_runs WHERE id = 'bt-budget'`).first();
  assert.notEqual(run.status, "paused");
  assert.equal(run.paused_reason, null);
});

test("queue(): part 1 of a brand-new run is never parked by the daily quota, even if today's ledger is already far over (progress guarantee)", async (t) => {
  const bindings = engineBindings();
  await seedOffSideBars(bindings.INPUTS_DB);
  // The budget must be ENGAGED (BACKTEST bound) for the ledger to be consulted at all.
  const env = { ...bindings, BACKTEST_DAILY_WRITE_BUDGET: "1", BACKTEST: { send: async () => {} } };
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});

  await seedLedger(bindings.SIM_DB, { d1Written: 1000, d1Read: 10 ** 9, kvWrites: 10 ** 6, kvReads: 10 ** 9 });

  const message = new FakeMessage(OK_JOB); // part 1 (implicit)
  await worker.queue(batchOf(message), env);

  const run = await bindings.SIM_DB.prepare(`SELECT ${PAUSE_COLUMNS} FROM backtest_runs WHERE id = 'bt-budget'`).first();
  assert.equal(run.status, "complete", "part 1 ran to the end instead of parking");
  assert.equal(run.paused_reason, null);
});

// ---------------------------------------------------------------------------
// backtest-worker.js: an operator-paused run's in-flight continuation
// ---------------------------------------------------------------------------

test("queue(): a continuation arriving for an operator-PAUSED run saves its cursor into the envelope, keeps the original pause stamp, and is acked without running", async (t) => {
  const bindings = engineBindings();
  await seedOffSideBars(bindings.INPUTS_DB);
  const sent = [];
  const env = { ...bindings, BACKTEST: { send: async (msg, opts) => sent.push({ msg, opts }) } };
  t.mock.method(console, "log", () => {});

  await seedRunningRun(bindings.SIM_DB);
  // POST /backtest/:id/pause: flips the row but cannot know the in-flight message's cursor.
  const changed = await pauseBacktestRun(bindings.SIM_DB, { id: "bt-budget", reason: "operator", pausedAt: "2026-05-10T10:00:00.000Z" });
  assert.equal(changed, true);

  const message = new FakeMessage({ ...OK_JOB, part: 2, cursor: { dayIndex: 1 } });
  await worker.queue(batchOf(message), env);

  assert.equal(message.acked, true);
  assert.equal(message.retried, false);
  assert.equal(sent.length, 0);
  const run = await bindings.SIM_DB.prepare(`SELECT ${PAUSE_COLUMNS} FROM backtest_runs WHERE id = 'bt-budget'`).first();
  assert.equal(run.status, "paused");
  assert.equal(run.paused_reason, "operator");
  assert.equal(run.paused_at, "2026-05-10T10:00:00.000Z", "the original pause time is kept");
  assert.deepEqual(JSON.parse(run.cursor), {
    part: 2,
    cursor: { dayIndex: 1 },
    job: { id: "bt-budget", tickers: ["AAPL"], testStart: OK_JOB.testStart, testEnd: OK_JOB.testEnd, graceDays: 1 },
  });
  const ledger = await getQuotaUsage(bindings.SIM_DB);
  assert.equal(ledger.d1Written, 0, "a skipped part spends no quota and writes no ledger row");
});

test("queue(): a part-1 redelivery for a paused run (no cursor to save) is acked and leaves the row untouched", async (t) => {
  const bindings = engineBindings();
  const env = { ...bindings, BACKTEST: { send: async () => {} } };
  t.mock.method(console, "log", () => {});

  await seedRunningRun(bindings.SIM_DB);
  await pauseBacktestRun(bindings.SIM_DB, { id: "bt-budget", reason: "operator", pausedAt: "2026-05-10T10:00:00.000Z" });

  const message = new FakeMessage(OK_JOB);
  await worker.queue(batchOf(message), env);

  assert.equal(message.acked, true);
  const run = await bindings.SIM_DB.prepare(`SELECT ${PAUSE_COLUMNS} FROM backtest_runs WHERE id = 'bt-budget'`).first();
  assert.equal(run.status, "paused");
  assert.equal(run.cursor, null);
});
