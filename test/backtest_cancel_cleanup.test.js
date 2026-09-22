// Covers the "Terminate" + "Clean up old runs" backtest controls:
//   - src/storage/sim_registry.js#cancelBacktestRun / getStaleTerminalBacktestRuns
//   - src/storage/run_store.js#RunStore.cancelJob
//   - src/backtest/cleanup.js#cleanupCancelledRun / cleanupOldRuns
// Mirrors test/backtest_cleanup.test.js's fixture conventions (real sqlite
// via createTestD1([STATE_DIR, SIM_DIR])).

import test from "node:test";
import assert from "node:assert/strict";
import { cleanupCancelledRun, cleanupOldRuns } from "../src/backtest/cleanup.js";
import { RunStore } from "../src/storage/run_store.js";
import {
  insertBacktestRun,
  cancelBacktestRun,
  failBacktestRun,
  completeBacktestRun,
  getStaleTerminalBacktestRuns,
  getBacktestRun,
} from "../src/storage/sim_registry.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { STATE_DIR, SIM_DIR } from "./helpers/engine_ctx.js";

function thesisArgs(id, ticker, asOf) {
  return {
    id, ticker, tradeThesisId: id, positionSizePct: 0.05, direction: "long", entryPrice: 100, stopLossPct: 0.03, takeProfitPct: 0.06, asOf,
    thesis: { ticker, asOf, direction: "long" }, riskDecision: { approved: true, positionSizePct: 0.05 }, createdAt: asOf,
  };
}

async function registryRow(db, id, status, { startedAt = "2026-01-04T00:00:00.000Z" } = {}) {
  await insertBacktestRun(db, { id, tickers: ["AAPL"], testStart: "2026-01-01", testEnd: "2026-01-03", trainDays: 0, testDays: 2, startedAt });
  if (status === "failed") await failBacktestRun(db, { id, error: "boom", finishedAt: "2026-01-04T00:01:00.000Z" });
  if (status === "complete") await completeBacktestRun(db, { id, result: { ok: true }, finishedAt: "2026-01-04T00:01:00.000Z" });
  if (status === "cancelled") await cancelBacktestRun(db, { id, finishedAt: "2026-01-04T00:01:00.000Z" });
  // status === "running": insertBacktestRun already leaves it 'running'.
}

/** Data + error trail for one run: `positions` positions, one ok + one errored llm_call, one job_progress row. */
async function seedRun(db, id, { positions = 1 } = {}) {
  const store = new RunStore(db, id);
  for (let i = 0; i < positions; i++) await store.commitThesis(thesisArgs(`T${i}|t1`, `T${i}`, "t1"));
  await db.prepare(`INSERT INTO llm_calls (env_run_id, created_at, source, label, status) VALUES (?, 't1', 'backtest', 'trader', 'ok')`).bind(id).run();
  await db.prepare(`INSERT INTO llm_calls (env_run_id, created_at, source, label, status, error) VALUES (?, 't2', 'backtest', 'trader', 'error', 'boom')`).bind(id).run();
  await db.prepare(`INSERT INTO job_progress (run_id, id, type, status, created_at, updated_at) VALUES (?, ?, 'backtest', 'running', 't1', 't2')`).bind(id, id).run();
  return store;
}

async function count(db, table, id, col = "run_id") {
  return (await db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${col} = ?`).bind(id).first()).c;
}

const DATA_TABLES = ["positions", "trade_decisions", "decision_memory", "pipeline_checkpoints"];

// ---------------------------------------------------------------------------
// sim_registry.js#cancelBacktestRun
// ---------------------------------------------------------------------------

test("cancelBacktestRun atomically flips a running row to cancelled and returns true", async () => {
  const db = createTestD1([STATE_DIR, SIM_DIR]);
  await registryRow(db, "bt-1", "running");

  const changed = await cancelBacktestRun(db, { id: "bt-1", finishedAt: "2026-01-04T00:05:00.000Z" });
  assert.equal(changed, true);

  const row = await getBacktestRun(db, "bt-1");
  assert.equal(row.status, "cancelled");
  assert.equal(row.error, "Cancelled by operator");
  assert.equal(row.finishedAt, "2026-01-04T00:05:00.000Z");
});

test("cancelBacktestRun accepts a custom error message", async () => {
  const db = createTestD1([STATE_DIR, SIM_DIR]);
  await registryRow(db, "bt-1", "running");

  await cancelBacktestRun(db, { id: "bt-1", finishedAt: "2026-01-04T00:05:00.000Z", error: "Terminated: disk quota exceeded" });

  const row = await getBacktestRun(db, "bt-1");
  assert.equal(row.error, "Terminated: disk quota exceeded");
});

test("cancelBacktestRun is a no-op (returns false, leaves the row alone) once a run is already terminal", async () => {
  const db = createTestD1([STATE_DIR, SIM_DIR]);
  await registryRow(db, "done", "complete");
  await registryRow(db, "dead", "failed");
  await registryRow(db, "gone", "cancelled");

  for (const id of ["done", "dead", "gone"]) {
    const before = await getBacktestRun(db, id);
    const changed = await cancelBacktestRun(db, { id, finishedAt: "2026-01-05T00:00:00.000Z" });
    assert.equal(changed, false, id);
    const after = await getBacktestRun(db, id);
    assert.deepEqual(after, before, `${id}: row untouched`);
  }
});

test("cancelBacktestRun racing completion: only one of two concurrent calls wins (WHERE status='running' in the same statement)", async () => {
  const db = createTestD1([STATE_DIR, SIM_DIR]);
  await registryRow(db, "bt-1", "running");

  // Simulate the run completing normally, then a cancel arriving just after.
  await completeBacktestRun(db, { id: "bt-1", result: { ok: true }, finishedAt: "2026-01-04T00:02:00.000Z" });
  const changed = await cancelBacktestRun(db, { id: "bt-1", finishedAt: "2026-01-04T00:02:01.000Z" });

  assert.equal(changed, false, "cancel must not resurrect or overwrite an already-completed row");
  const row = await getBacktestRun(db, "bt-1");
  assert.equal(row.status, "complete");
  assert.deepEqual(row.result, { ok: true });
});

test("cancelBacktestRun on an unknown id is a no-op", async () => {
  const db = createTestD1([STATE_DIR, SIM_DIR]);
  const changed = await cancelBacktestRun(db, { id: "ghost", finishedAt: "2026-01-04T00:00:00.000Z" });
  assert.equal(changed, false);
  assert.equal(await getBacktestRun(db, "ghost"), null);
});

// ---------------------------------------------------------------------------
// sim_registry.js#getStaleTerminalBacktestRuns
// ---------------------------------------------------------------------------

test("getStaleTerminalBacktestRuns returns only terminal runs older than the cutoff, oldest first, and never a running one", async () => {
  const db = createTestD1([STATE_DIR, SIM_DIR]);
  const now = Date.now();
  const daysAgo = (n) => new Date(now - n * 24 * 3600 * 1000).toISOString();

  await registryRow(db, "old-failed", "failed", { startedAt: daysAgo(60) });
  await registryRow(db, "old-complete", "complete", { startedAt: daysAgo(45) });
  await registryRow(db, "old-cancelled", "cancelled", { startedAt: daysAgo(40) });
  await registryRow(db, "recent-failed", "failed", { startedAt: daysAgo(5) });
  await registryRow(db, "old-running", "running", { startedAt: daysAgo(90) });

  const stale = await getStaleTerminalBacktestRuns(db, { olderThanDays: 30, limit: 10 });

  assert.deepEqual(
    stale.map((r) => r.id),
    ["old-failed", "old-complete", "old-cancelled"],
    "oldest first, only terminal statuses, nothing inside the 30-day cutoff, running excluded"
  );
  assert.deepEqual(stale.map((r) => r.status), ["failed", "complete", "cancelled"]);
});

test("getStaleTerminalBacktestRuns respects limit", async () => {
  const db = createTestD1([STATE_DIR, SIM_DIR]);
  const now = Date.now();
  const daysAgo = (n) => new Date(now - n * 24 * 3600 * 1000).toISOString();

  await registryRow(db, "a", "failed", { startedAt: daysAgo(60) });
  await registryRow(db, "b", "failed", { startedAt: daysAgo(50) });
  await registryRow(db, "c", "failed", { startedAt: daysAgo(40) });

  const stale = await getStaleTerminalBacktestRuns(db, { olderThanDays: 30, limit: 2 });
  assert.equal(stale.length, 2);
  assert.deepEqual(stale.map((r) => r.id), ["a", "b"]);
});

test("getStaleTerminalBacktestRuns returns nothing when no run is old enough", async () => {
  const db = createTestD1([STATE_DIR, SIM_DIR]);
  await registryRow(db, "bt-1", "failed", { startedAt: "2026-01-04T00:00:00.000Z" });
  const stale = await getStaleTerminalBacktestRuns(db, { olderThanDays: 30, limit: 10 });
  assert.deepEqual(stale, []);
});

// ---------------------------------------------------------------------------
// run_store.js#RunStore.cancelJob
// ---------------------------------------------------------------------------

test("RunStore#cancelJob marks the job cancelled, keeps the last-reported detail, unguarded by prior status", async () => {
  const db = createTestD1([STATE_DIR, SIM_DIR]);
  const store = new RunStore(db, "bt-1");
  await store.insertQueuedJob({ id: "bt-1", type: "backtest" });
  await store.updateJobProgress({ id: "bt-1", phase: "trading", percent: 42, done: 21, total: 50, detail: "AAPL 2026-01-15" });

  await store.cancelJob({ id: "bt-1", detail: "Cancelled by operator", now: "2026-01-04T00:05:00.000Z" });

  const job = await store.getJob("bt-1");
  assert.equal(job.status, "cancelled");
  assert.equal(job.detail, "Cancelled by operator");
  assert.equal(job.percent, 42, "last-reported percent is preserved, same as failJob");
  assert.equal(job.phase, "trading");
  assert.equal(job.finishedAt, "2026-01-04T00:05:00.000Z");
});

test("RunStore#cancelJob works even on a job already in a terminal state (unguarded UPDATE, unlike updateJobProgress)", async () => {
  const db = createTestD1([STATE_DIR, SIM_DIR]);
  const store = new RunStore(db, "bt-1");
  await store.insertQueuedJob({ id: "bt-1", type: "backtest" });
  await store.completeJob({ id: "bt-1", result: { ok: true } });

  await store.cancelJob({ id: "bt-1", detail: "late cancel", now: "2026-01-04T00:05:00.000Z" });

  const job = await store.getJob("bt-1");
  assert.equal(job.status, "cancelled", "cancelJob has no status guard -- the caller (index.js) already knows via cancelBacktestRun's atomic transition");
});

// ---------------------------------------------------------------------------
// backtest/cleanup.js#cleanupCancelledRun
// ---------------------------------------------------------------------------

test("cleanupCancelledRun deletes a cancelled run's data AND its errored llm_calls (unlike cleanupFailedRun), keeps the registry row and job_progress", async () => {
  const db = createTestD1([STATE_DIR, SIM_DIR]);
  await registryRow(db, "bt-1", "cancelled");
  await registryRow(db, "bt-2", "cancelled");
  const store = await seedRun(db, "bt-1", { positions: 3 });
  await seedRun(db, "bt-2", { positions: 2 });

  const out = await cleanupCancelledRun(db, store, "bt-1");
  assert.equal(out.complete, true);
  assert.ok(out.deleted > 0);

  for (const t of DATA_TABLES) assert.equal(await count(db, t, "bt-1"), 0, `${t} deleted`);
  assert.equal(await count(db, "llm_calls", "bt-1", "env_run_id"), 0, "errored llm_calls are NOT kept -- a cancellation isn't a bug to investigate");
  assert.equal(await count(db, "job_progress", "bt-1"), 1, "job_progress is kept -- the dashboard job view reads it");
  const reg = await db.prepare(`SELECT status FROM backtest_runs WHERE id = 'bt-1'`).first();
  assert.equal(reg.status, "cancelled");

  // bt-2 untouched.
  assert.equal(await count(db, "positions", "bt-2"), 2);
  assert.equal(await count(db, "llm_calls", "bt-2", "env_run_id"), 2);
});

test("cleanupCancelledRun NEVER touches a run that isn't cancelled (running/complete/failed/missing), or 'live'", async () => {
  const db = createTestD1([STATE_DIR, SIM_DIR]);
  await registryRow(db, "done", "complete");
  await registryRow(db, "dead", "failed");
  await registryRow(db, "going", "running");
  const done = await seedRun(db, "done");
  const dead = await seedRun(db, "dead");
  const going = await seedRun(db, "going");
  const ghost = await seedRun(db, "ghost");

  for (const [store, id] of [[done, "done"], [dead, "dead"], [going, "going"], [ghost, "ghost"]]) {
    const out = await cleanupCancelledRun(db, store, id);
    assert.equal(out.deleted, 0, id);
    assert.equal(out.complete, false, id);
    assert.ok(out.skipped, id);
    assert.equal(await count(db, "positions", id), 1, `${id}: data intact`);
  }

  await registryRow(db, "live-ish", "cancelled");
  const live = new RunStore(db, "live");
  const out = await cleanupCancelledRun(db, live, "live");
  assert.equal(out.deleted, 0);
  assert.match(out.skipped, /live/);
});

test("cleanupCancelledRun refuses a store/id mismatch", async () => {
  const db = createTestD1([STATE_DIR, SIM_DIR]);
  await registryRow(db, "bt-1", "cancelled");
  await registryRow(db, "bt-2", "cancelled");
  const other = await seedRun(db, "bt-2");

  const out = await cleanupCancelledRun(db, other, "bt-1"); // store scoped to bt-2, asked to clean bt-1
  assert.equal(out.deleted, 0);
  assert.equal(await count(db, "positions", "bt-2"), 1);
});

test("cleanupCancelledRun reports complete:false when maxChunks cuts it short, and a later call finishes the job", async (t) => {
  const db = createTestD1([STATE_DIR, SIM_DIR]);
  await registryRow(db, "bt-1", "cancelled");
  const store = await seedRun(db, "bt-1", { positions: 5 });
  const warn = t.mock.method(console, "warn", () => {});

  const cut = await cleanupCancelledRun(db, store, "bt-1", { limit: 1, maxChunks: 2 });
  assert.equal(cut.complete, false);
  assert.ok(cut.deleted > 0);
  assert.ok((await count(db, "positions", "bt-1")) > 0, "leftover rows remain");
  assert.equal(warn.mock.callCount(), 1);

  const finish = await cleanupCancelledRun(db, store, "bt-1", { limit: 500 });
  assert.equal(finish.complete, true);
  assert.equal(await count(db, "positions", "bt-1"), 0);
});

test("cleanupCancelledRun never throws: a DB error mid-cleanup is logged and reported, with the partial count", async (t) => {
  const db = createTestD1([STATE_DIR, SIM_DIR]);
  await registryRow(db, "bt-1", "cancelled");
  const store = await seedRun(db, "bt-1");
  const warn = t.mock.method(console, "warn", () => {});
  let calls = 0;
  const real = store.deleteRun.bind(store);
  store.deleteRun = async (opts) => {
    if (++calls === 2) throw new Error("simulated D1 outage");
    return real(opts);
  };

  const out = await cleanupCancelledRun(db, store, "bt-1");
  assert.equal(out.complete, false);
  assert.ok(out.deleted > 0, "the first chunk's count is kept");
  assert.match(out.skipped, /simulated D1 outage/);
  assert.equal(warn.mock.callCount(), 1);

  const broken = { prepare() { throw new Error("registry down"); } };
  await assert.doesNotReject(() => cleanupCancelledRun(broken, store, "bt-1"));
});

// ---------------------------------------------------------------------------
// backtest/cleanup.js#cleanupOldRuns
// ---------------------------------------------------------------------------

test("cleanupOldRuns sweeps stale terminal runs, deletes their state-table data, but keeps every registry row and result JSON", async () => {
  const db = createTestD1([STATE_DIR, SIM_DIR]);
  const now = Date.now();
  const daysAgo = (n) => new Date(now - n * 24 * 3600 * 1000).toISOString();

  await registryRow(db, "old-failed", "failed", { startedAt: daysAgo(60) });
  await registryRow(db, "old-complete", "complete", { startedAt: daysAgo(45) });
  await registryRow(db, "old-cancelled", "cancelled", { startedAt: daysAgo(40) });
  await registryRow(db, "recent-failed", "failed", { startedAt: daysAgo(5) });
  await seedRun(db, "old-failed", { positions: 2 });
  await seedRun(db, "old-complete", { positions: 2 });
  await seedRun(db, "old-cancelled", { positions: 2 });
  await seedRun(db, "recent-failed", { positions: 2 });

  const out = await cleanupOldRuns(db, { olderThanDays: 30, maxRuns: 10 });

  assert.equal(out.scanned, 3);
  assert.equal(out.processed.length, 3);
  assert.ok(out.processed.every((p) => p.complete && p.deleted > 0));
  assert.ok(out.totalDeleted > 0);

  for (const id of ["old-failed", "old-complete", "old-cancelled"]) {
    for (const t of DATA_TABLES) assert.equal(await count(db, t, id), 0, `${id}.${t} deleted`);
    const reg = await getBacktestRun(db, id);
    assert.ok(reg, `${id}: registry row kept`);
  }
  const completeReg = await getBacktestRun(db, "old-complete");
  assert.deepEqual(completeReg.result, { ok: true }, "result JSON survives so Recent-runs summary metrics still render");

  // The recent run was never a candidate -- untouched.
  assert.equal(await count(db, "positions", "recent-failed"), 2);
});

test("cleanupOldRuns respects maxRuns per call and is safe to re-call to finish a larger backlog", async () => {
  const db = createTestD1([STATE_DIR, SIM_DIR]);
  const now = Date.now();
  const daysAgo = (n) => new Date(now - n * 24 * 3600 * 1000).toISOString();

  for (const [id, offset] of [["a", 60], ["b", 55], ["c", 50], ["d", 45]]) {
    await registryRow(db, id, "failed", { startedAt: daysAgo(offset) });
    await seedRun(db, id, { positions: 1 });
  }

  const first = await cleanupOldRuns(db, { olderThanDays: 30, maxRuns: 2 });
  assert.equal(first.scanned, 2);
  assert.deepEqual(first.processed.map((p) => p.id), ["a", "b"], "oldest first");
  assert.equal(await count(db, "positions", "a"), 0);
  assert.equal(await count(db, "positions", "b"), 0);
  assert.equal(await count(db, "positions", "c"), 1, "not yet touched");

  const second = await cleanupOldRuns(db, { olderThanDays: 30, maxRuns: 2 });
  assert.deepEqual(second.processed.map((p) => p.id), ["c", "d"]);
  assert.equal(await count(db, "positions", "c"), 0);
  assert.equal(await count(db, "positions", "d"), 0);
});

test("cleanupOldRuns never includes a still-running run as a candidate, regardless of age", async () => {
  const db = createTestD1([STATE_DIR, SIM_DIR]);
  const now = Date.now();
  const daysAgo = (n) => new Date(now - n * 24 * 3600 * 1000).toISOString();
  await registryRow(db, "ancient-running", "running", { startedAt: daysAgo(365) });
  await seedRun(db, "ancient-running", { positions: 1 });

  const out = await cleanupOldRuns(db, { olderThanDays: 30, maxRuns: 10 });
  assert.equal(out.scanned, 0);
  assert.equal(await count(db, "positions", "ancient-running"), 1);
});

test("cleanupOldRuns re-callable per-run when a single run's cleanup is cut short by maxChunksPerRun", async () => {
  const db = createTestD1([STATE_DIR, SIM_DIR]);
  const now = Date.now();
  const daysAgo = (n) => new Date(now - n * 24 * 3600 * 1000).toISOString();
  await registryRow(db, "big", "failed", { startedAt: daysAgo(60) });
  await seedRun(db, "big", { positions: 5 });

  const first = await cleanupOldRuns(db, { olderThanDays: 30, maxRuns: 10, limit: 1, maxChunksPerRun: 2 });
  assert.equal(first.processed[0].id, "big");
  assert.equal(first.processed[0].complete, false, "cut short");
  assert.ok((await count(db, "positions", "big")) > 0, "leftovers remain");

  const second = await cleanupOldRuns(db, { olderThanDays: 30, maxRuns: 10, limit: 500 });
  assert.equal(second.processed[0].complete, true);
  assert.equal(await count(db, "positions", "big"), 0);
});

test("cleanupOldRuns never throws: one run's failure doesn't stop the rest of the sweep, and a listing failure returns a safe empty result", async (t) => {
  const db = createTestD1([STATE_DIR, SIM_DIR]);
  const now = Date.now();
  const daysAgo = (n) => new Date(now - n * 24 * 3600 * 1000).toISOString();
  await registryRow(db, "ok-1", "failed", { startedAt: daysAgo(60) });
  await registryRow(db, "ok-2", "failed", { startedAt: daysAgo(55) });
  await seedRun(db, "ok-1", { positions: 1 });
  await seedRun(db, "ok-2", { positions: 1 });
  const warn = t.mock.method(console, "warn", () => {});

  // Force the first candidate's RunStore.deleteRun to blow up once.
  const RealRunStore = RunStore;
  const origDeleteRun = RealRunStore.prototype.deleteRun;
  let poisoned = false;
  RealRunStore.prototype.deleteRun = async function (opts) {
    if (this.runId === "ok-1" && !poisoned) {
      poisoned = true;
      throw new Error("simulated D1 outage");
    }
    return origDeleteRun.call(this, opts);
  };
  try {
    const out = await cleanupOldRuns(db, { olderThanDays: 30, maxRuns: 10 });
    assert.equal(out.processed.length, 2);
    const ok1 = out.processed.find((p) => p.id === "ok-1");
    const ok2 = out.processed.find((p) => p.id === "ok-2");
    assert.equal(ok1.deleted, 0);
    assert.match(ok1.skipped, /simulated D1 outage/);
    assert.ok(ok2.deleted > 0, "the rest of the sweep still ran");
    assert.ok(warn.mock.callCount() >= 1);
  } finally {
    RealRunStore.prototype.deleteRun = origDeleteRun;
  }

  const broken = { prepare() { throw new Error("registry down"); } };
  const out = await cleanupOldRuns(broken, { olderThanDays: 30 });
  assert.deepEqual(out.processed, []);
  assert.equal(out.totalDeleted, 0);
  assert.equal(out.scanned, 0);
  assert.match(out.error, /registry down/);
});
