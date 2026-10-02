// Pause / resume of a backtest run (migrations/sim/0003): the registry functions in
// storage/sim_registry.js (pauseBacktestRun, resumeBacktestRun, cancel of a paused run, the
// paused fields on read) and the worker's post-part quota park + manual-resume round trip.
// Real sqlite SIM_DB / INPUTS_DB, same convention as backtest_continuation.test.js.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/backtest-worker.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { STATE_DIR, INPUTS_DIR, SIM_DIR, seedBar } from "./helpers/engine_ctx.js";
import {
  insertBacktestRun,
  pauseBacktestRun,
  resumeBacktestRun,
  cancelBacktestRun,
  completeBacktestRun,
  failBacktestRun,
  getBacktestRun,
  getRecentBacktestRuns,
} from "../src/storage/sim_registry.js";
import { getQuotaUsage } from "../src/storage/quota_usage.js";

const simDb = () => createTestD1([STATE_DIR, SIM_DIR]);

async function seedRun(db, id = "r1", startedAt = "2026-05-10T00:00:00.000Z") {
  await insertBacktestRun(db, { id, tickers: ["AAPL"], testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-09T00:00:00.000Z", trainDays: 0, testDays: 8, graceDays: 1, startedAt });
}

const ENVELOPE = { part: 3, cursor: { clockNow: "2026-01-04T00:00:00.000Z", phase: "walk" }, job: { id: "r1", tickers: ["AAPL"], testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-09T00:00:00.000Z", graceDays: 1 } };

const rawRow = (db, id = "r1") => db.prepare("SELECT status, cursor, paused_reason, paused_at, resume_after, error, finished_at FROM backtest_runs WHERE id = ?").bind(id).first();

// ---------------------------------------------------------------------------
// pauseBacktestRun
// ---------------------------------------------------------------------------

test("pauseBacktestRun parks a running run: status paused, reason/time/resume_after stored, cursor serialized", async () => {
  const db = simDb();
  await seedRun(db);
  const changed = await pauseBacktestRun(db, { id: "r1", reason: "d1_write_budget", cursor: ENVELOPE, pausedAt: "2026-05-10T10:00:00.000Z", resumeAfter: "2026-05-11T00:00:00.000Z" });
  assert.equal(changed, true);
  const row = await rawRow(db);
  assert.equal(row.status, "paused");
  assert.equal(row.paused_reason, "d1_write_budget");
  assert.equal(row.paused_at, "2026-05-10T10:00:00.000Z");
  assert.equal(row.resume_after, "2026-05-11T00:00:00.000Z");
  assert.deepEqual(JSON.parse(row.cursor), ENVELOPE);
});

test("pauseBacktestRun without a cursor (the operator's button) stores NULL cursor", async () => {
  const db = simDb();
  await seedRun(db);
  assert.equal(await pauseBacktestRun(db, { id: "r1", reason: "operator", pausedAt: "2026-05-10T10:00:00.000Z" }), true);
  const row = await rawRow(db);
  assert.equal(row.status, "paused");
  assert.equal(row.cursor, null);
  assert.equal(row.resume_after, null);
});

test("re-pausing a paused run keeps its original reason/paused_at/resume_after but takes the new cursor; a null cursor never wipes a stored one", async () => {
  const db = simDb();
  await seedRun(db);
  await pauseBacktestRun(db, { id: "r1", reason: "operator", pausedAt: "2026-05-10T10:00:00.000Z" });
  assert.equal(await pauseBacktestRun(db, { id: "r1", reason: "gemini_daily_cap", cursor: ENVELOPE, pausedAt: "2026-05-10T11:00:00.000Z", resumeAfter: "2026-05-11T08:00:00.000Z" }), true);
  let row = await rawRow(db);
  assert.equal(row.paused_reason, "operator", "not relabelled");
  assert.equal(row.paused_at, "2026-05-10T10:00:00.000Z");
  assert.equal(row.resume_after, null);
  assert.deepEqual(JSON.parse(row.cursor), ENVELOPE);

  await pauseBacktestRun(db, { id: "r1", reason: "operator", pausedAt: "2026-05-10T12:00:00.000Z" });
  row = await rawRow(db);
  assert.deepEqual(JSON.parse(row.cursor), ENVELOPE, "COALESCE keeps the stored cursor");
});

test("pauseBacktestRun is a no-op (false) for terminal and unknown runs, and never resurrects them", async () => {
  const db = simDb();
  await seedRun(db, "done");
  await completeBacktestRun(db, { id: "done", result: { ok: true }, finishedAt: "2026-05-10T01:00:00.000Z" });
  await seedRun(db, "bad");
  await failBacktestRun(db, { id: "bad", error: "boom", finishedAt: "2026-05-10T01:00:00.000Z" });
  await seedRun(db, "gone");
  await cancelBacktestRun(db, { id: "gone", finishedAt: "2026-05-10T01:00:00.000Z" });

  for (const id of ["done", "bad", "gone", "missing"]) {
    assert.equal(await pauseBacktestRun(db, { id, reason: "operator", pausedAt: "2026-05-10T10:00:00.000Z" }), false, id);
  }
  assert.equal((await rawRow(db, "done")).status, "complete");
  assert.equal((await rawRow(db, "bad")).status, "failed");
  assert.equal((await rawRow(db, "gone")).status, "cancelled");
});

// ---------------------------------------------------------------------------
// resumeBacktestRun
// ---------------------------------------------------------------------------

test("resumeBacktestRun claims a parked run: returns the envelope + pause info, flips to running, clears every pause field and the cursor", async () => {
  const db = simDb();
  await seedRun(db);
  await pauseBacktestRun(db, { id: "r1", reason: "quota_threshold", cursor: ENVELOPE, pausedAt: "2026-05-10T10:00:00.000Z", resumeAfter: "2026-05-11T00:00:00.000Z" });

  const res = await resumeBacktestRun(db, { id: "r1" });
  assert.deepEqual(res, { ok: true, cursor: ENVELOPE, pausedReason: "quota_threshold", resumeAfter: "2026-05-11T00:00:00.000Z" });
  const row = await rawRow(db);
  assert.equal(row.status, "running");
  assert.equal(row.cursor, null, "a stale cursor must not survive into the next pause");
  assert.equal(row.paused_reason, null);
  assert.equal(row.paused_at, null);
  assert.equal(row.resume_after, null);
});

test("resumeBacktestRun is single-shot: a second claim finds the run no longer paused", async () => {
  const db = simDb();
  await seedRun(db);
  await pauseBacktestRun(db, { id: "r1", reason: "operator", cursor: ENVELOPE, pausedAt: "2026-05-10T10:00:00.000Z" });
  assert.equal((await resumeBacktestRun(db, { id: "r1" })).ok, true);
  assert.deepEqual(await resumeBacktestRun(db, { id: "r1" }), { ok: false, reason: "not_paused" });
});

test("resumeBacktestRun reports 'pausing' while the in-flight continuation has not saved its cursor yet, and leaves the row paused", async () => {
  const db = simDb();
  await seedRun(db);
  await pauseBacktestRun(db, { id: "r1", reason: "operator", pausedAt: "2026-05-10T10:00:00.000Z" }); // no cursor
  assert.deepEqual(await resumeBacktestRun(db, { id: "r1" }), { ok: false, reason: "pausing" });
  assert.equal((await rawRow(db)).status, "paused");
});

test("resumeBacktestRun: not_found for an unknown id, not_paused for a running or terminal run", async () => {
  const db = simDb();
  await seedRun(db, "running-run");
  await seedRun(db, "done");
  await completeBacktestRun(db, { id: "done", result: {}, finishedAt: "2026-05-10T01:00:00.000Z" });
  assert.deepEqual(await resumeBacktestRun(db, { id: "nope" }), { ok: false, reason: "not_found" });
  assert.deepEqual(await resumeBacktestRun(db, { id: "running-run" }), { ok: false, reason: "not_paused" });
  assert.deepEqual(await resumeBacktestRun(db, { id: "done" }), { ok: false, reason: "not_paused" });
});

test("a failed enqueue can hand the claimed cursor back through pauseBacktestRun to re-park the run", async () => {
  const db = simDb();
  await seedRun(db);
  await pauseBacktestRun(db, { id: "r1", reason: "d1_write_budget", cursor: ENVELOPE, pausedAt: "2026-05-10T10:00:00.000Z" });
  const claimed = await resumeBacktestRun(db, { id: "r1" });
  assert.equal(await pauseBacktestRun(db, { id: "r1", reason: claimed.pausedReason, cursor: claimed.cursor, pausedAt: "2026-05-10T10:05:00.000Z", resumeAfter: claimed.resumeAfter }), true);
  const row = await rawRow(db);
  assert.equal(row.status, "paused");
  assert.deepEqual(JSON.parse(row.cursor), ENVELOPE);
  assert.equal((await resumeBacktestRun(db, { id: "r1" })).ok, true, "and it can be resumed again");
});

// ---------------------------------------------------------------------------
// cancel of a paused run, and the paused fields on read
// ---------------------------------------------------------------------------

test("cancelBacktestRun cancels a PAUSED run and drops its parked cursor", async () => {
  const db = simDb();
  await seedRun(db);
  await pauseBacktestRun(db, { id: "r1", reason: "operator", cursor: ENVELOPE, pausedAt: "2026-05-10T10:00:00.000Z" });
  assert.equal(await cancelBacktestRun(db, { id: "r1", finishedAt: "2026-05-10T12:00:00.000Z" }), true);
  const row = await rawRow(db);
  assert.equal(row.status, "cancelled");
  assert.equal(row.cursor, null);
  assert.equal(row.error, "Cancelled by operator");
  assert.deepEqual(await resumeBacktestRun(db, { id: "r1" }), { ok: false, reason: "not_paused" });
});

test("getBacktestRun / getRecentBacktestRuns expose pausedReason, pausedAt and resumeAfter (null when not paused)", async () => {
  const db = simDb();
  await seedRun(db, "a", "2026-05-10T00:00:00.000Z");
  await seedRun(db, "b", "2026-05-11T00:00:00.000Z");
  await pauseBacktestRun(db, { id: "a", reason: "gemini_daily_cap", cursor: ENVELOPE, pausedAt: "2026-05-10T10:00:00.000Z", resumeAfter: "2026-05-11T08:00:00.000Z" });

  const a = await getBacktestRun(db, "a");
  assert.equal(a.status, "paused");
  assert.equal(a.pausedReason, "gemini_daily_cap");
  assert.equal(a.pausedAt, "2026-05-10T10:00:00.000Z");
  assert.equal(a.resumeAfter, "2026-05-11T08:00:00.000Z");
  assert.ok(!("cursor" in a), "the parked cursor is not exposed on the read model");

  const recent = await getRecentBacktestRuns(db, { limit: 10 });
  const b = recent.find((r) => r.id === "b");
  assert.equal(b.status, "running");
  assert.equal(b.pausedReason, null);
  assert.equal(b.pausedAt, null);
  assert.equal(b.resumeAfter, null);
  assert.equal(recent.find((r) => r.id === "a").pausedReason, "gemini_daily_cap");
});

// ---------------------------------------------------------------------------
// Worker: post-part park on a quota trigger + manual resume round trip
// ---------------------------------------------------------------------------

class FakeMessage {
  constructor(body) {
    this.body = body;
    this.acked = false;
    this.retried = false;
  }
  ack() { this.acked = true; }
  retry() { this.retried = true; }
}

const JOB = { type: "backtest", id: "bt-park", tickers: ["AAPL"], testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-09T00:00:00.000Z", graceDays: 1 };

async function bindings() {
  const b = { SIM_DB: simDb(), INPUTS_DB: createTestD1([INPUTS_DIR]) };
  for (const date of ["2025-12-31", "2026-01-01", "2026-01-03", "2026-01-05", "2026-01-08", "2026-01-09"]) await seedBar(b.INPUTS_DB, { ticker: "AAPL", date, close: 100 });
  return b;
}

function fakeQueue() {
  const sent = [];
  return { sent, async send(body, options) { sent.push({ body, options }); } };
}

const quiet = (t) => { t.mock.method(console, "log", () => {}); t.mock.method(console, "error", () => {}); };

test("a part that tips today's D1 write share over its threshold still finishes, then PARKS the run instead of enqueuing the next part; a manual resume (budget lifted) completes it", async (t) => {
  quiet(t);
  const b = await bindings();
  const queue = fakeQueue();
  // 16-op budget forces part 1 to end in a continuation; a write share of 1 row is over after any work.
  const tight = { ...b, BACKTEST: queue, BACKTEST_MAX_TOTAL_SUBREQUESTS: "16", BACKTEST_DAILY_WRITE_BUDGET: "1", WATCHLIST_TICKERS: "AAPL" };

  const m1 = new FakeMessage(JOB);
  await worker.queue({ messages: [m1] }, tight);

  assert.equal(m1.acked, true);
  assert.equal(m1.retried, false);
  assert.equal(queue.sent.length, 0, "parked: no continuation enqueued");
  const parked = await b.SIM_DB.prepare("SELECT status, error, paused_reason, resume_after, cursor FROM backtest_runs WHERE id = ?").bind(JOB.id).first();
  assert.equal(parked.status, "paused", "paused, not failed");
  assert.equal(parked.error, null);
  assert.equal(parked.paused_reason, "d1_write_budget");
  assert.ok(parked.resume_after, "resume_after = next UTC midnight");
  const envelope = JSON.parse(parked.cursor);
  assert.equal(envelope.part, 2, "the envelope holds the NEXT part");
  assert.ok(envelope.cursor && typeof envelope.cursor.clockNow === "string", "and the cursor pins the clock");
  assert.equal(envelope.job.id, JOB.id);
  assert.deepEqual(envelope.job.tickers, JOB.tickers);
  const ledger = await getQuotaUsage(b.SIM_DB);
  assert.ok(ledger.d1Written > 0, "the part's writes were charged to today's ledger before parking");

  // Manual resume, as POST /backtest/:id/resume does: claim the envelope, re-enqueue it.
  const claimed = await resumeBacktestRun(b.SIM_DB, { id: JOB.id });
  assert.equal(claimed.ok, true);
  assert.equal((await b.SIM_DB.prepare("SELECT status FROM backtest_runs WHERE id = ?").bind(JOB.id).first()).status, "running");

  // The day's share is lifted (0 = disabled) so the rest of the run is not re-parked.
  const open = { ...b, BACKTEST: queue, BACKTEST_MAX_TOTAL_SUBREQUESTS: "16", BACKTEST_DAILY_WRITE_BUDGET: "0", WATCHLIST_TICKERS: "AAPL" };
  const pending = [{ type: "backtest", ...claimed.cursor.job, part: claimed.cursor.part, cursor: claimed.cursor.cursor }];
  let deliveries = 0;
  while (pending.length) {
    assert.ok(deliveries++ < 60, "the resumed chain ends");
    const m = new FakeMessage(pending.shift());
    await worker.queue({ messages: [m] }, open);
    assert.equal(m.acked, true);
    while (queue.sent.length) pending.push(queue.sent.shift().body);
  }
  const done = await b.SIM_DB.prepare("SELECT status, error, paused_reason FROM backtest_runs WHERE id = ?").bind(JOB.id).first();
  assert.equal(done.status, "complete", done.error);
  assert.equal(done.paused_reason, null);
});

test("a manual resume on the SAME day while the ledger is still over its share re-parks at the start of the continuation (no quota spent), keeping the cursor", async (t) => {
  quiet(t);
  const b = await bindings();
  const queue = fakeQueue();
  const tight = { ...b, BACKTEST: queue, BACKTEST_MAX_TOTAL_SUBREQUESTS: "16", BACKTEST_DAILY_WRITE_BUDGET: "1", WATCHLIST_TICKERS: "AAPL" };
  await worker.queue({ messages: [new FakeMessage(JOB)] }, tight);
  const before = await getQuotaUsage(b.SIM_DB);

  const claimed = await resumeBacktestRun(b.SIM_DB, { id: JOB.id });
  assert.equal(claimed.ok, true);
  const m2 = new FakeMessage({ type: "backtest", ...claimed.cursor.job, part: claimed.cursor.part, cursor: claimed.cursor.cursor });
  await worker.queue({ messages: [m2] }, tight);

  assert.equal(m2.acked, true);
  assert.equal(queue.sent.length, 0);
  const row = await b.SIM_DB.prepare("SELECT status, paused_reason, cursor FROM backtest_runs WHERE id = ?").bind(JOB.id).first();
  assert.equal(row.status, "paused");
  assert.equal(row.paused_reason, "d1_write_budget");
  assert.deepEqual(JSON.parse(row.cursor), claimed.cursor, "same envelope parked again");
  const after = await getQuotaUsage(b.SIM_DB);
  assert.equal(after.d1Written, before.d1Written, "the refused part wrote nothing to the ledger");
});
