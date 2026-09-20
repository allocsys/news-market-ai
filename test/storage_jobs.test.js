// Covers job progress after M2b: the SQL lives in RunStore (job_progress in the
// state schema, scoped by run_id) and the best-effort reporter in
// storage/jobs.js wraps a store. Runs against REAL SQL (test/helpers/
// sqlite_d1.js over migrations/state/), so the WHERE predicates -- the status
// guard on ticks, the run_id scope, the idle cutoff -- are the ones production
// runs, not a regex fake's idea of them.

import test from "node:test";
import assert from "node:assert/strict";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { STATE_DIR, stateRows } from "./helpers/engine_ctx.js";
import { RunStore } from "../src/storage/run_store.js";
import { createJobReporter, ACTIVE_JOB_MAX_IDLE_MS } from "../src/storage/jobs.js";

const NOW = "2026-09-19T12:00:00.000Z";

function freshStore(runId = "live") {
  const db = createTestD1([STATE_DIR]);
  return { db, store: new RunStore(db, runId) };
}

async function seedRunning(store, id = "backfill-1-abc", type = "backfill", overrides = {}) {
  await store.insertQueuedJob({ id, type, params: { from: "2024-01-01", to: "2024-01-31" }, now: "2026-09-19T11:58:00.000Z" });
  await store.markJobRunning({ id, type, now: "2026-09-19T11:58:05.000Z" });
  await store.updateJobProgress({ id, phase: "saving", percent: 60, done: 3, total: 5, detail: "Saved 3/5 articles", now: "2026-09-19T11:59:30.000Z", ...overrides });
}

test("getActiveJob returns null when nothing is in flight", async () => {
  const { store } = freshStore();
  assert.equal(await store.getActiveJob("backfill", { now: NOW }), null);
});

test("getActiveJob returns only queued/running rows of the requested type, newest first", async () => {
  const { store } = freshStore();
  await store.insertQueuedJob({ id: "b-old", type: "backfill", now: "2026-09-19T11:50:00.000Z" });
  await store.insertQueuedJob({ id: "b-new", type: "backfill", now: "2026-09-19T11:55:00.000Z" });
  await store.insertQueuedJob({ id: "t-1", type: "backtest", now: "2026-09-19T11:59:00.000Z" });
  await store.insertQueuedJob({ id: "b-done", type: "backfill", now: "2026-09-19T11:59:30.000Z" });
  await store.completeJob({ id: "b-done", now: "2026-09-19T11:59:40.000Z" });

  assert.equal((await store.getActiveJob("backfill", { now: NOW })).id, "b-new");
  assert.equal((await store.getActiveJob("backtest", { now: NOW })).id, "t-1");
});

test("getActiveJob's idle cutoff is now minus 15 minutes by default -- rows orphaned by an isolate kill age out instead of showing a phantom bar forever", async () => {
  assert.equal(ACTIVE_JOB_MAX_IDLE_MS, 15 * 60 * 1000);
  const { store } = freshStore();
  // updated_at 14:59 before NOW is inside the window; 15:01 before is outside.
  await store.insertQueuedJob({ id: "fresh", type: "backfill", now: "2026-09-19T11:45:01.000Z" });
  assert.equal((await store.getActiveJob("backfill", { now: NOW })).id, "fresh");

  const { store: stale } = freshStore();
  await stale.insertQueuedJob({ id: "orphan", type: "backfill", now: "2026-09-19T11:44:59.000Z" });
  assert.equal(await stale.getActiveJob("backfill", { now: NOW }), null);
});

test("getActiveJob honours a custom maxIdleMs", async () => {
  const { store } = freshStore();
  await store.insertQueuedJob({ id: "j", type: "backfill", now: "2026-09-19T11:58:30.000Z" });
  assert.equal(await store.getActiveJob("backfill", { now: NOW, maxIdleMs: 60 * 1000 }), null);
  assert.equal((await store.getActiveJob("backfill", { now: NOW, maxIdleMs: 120 * 1000 })).id, "j");
});

test("getActiveJob returns the same camelCased, JSON-parsed shape as getJob", async () => {
  const { store } = freshStore();
  await seedRunning(store);

  const active = await store.getActiveJob("backfill", { now: NOW });
  const byId = await store.getJob("backfill-1-abc");

  assert.deepEqual(active, byId);
  assert.equal(active.id, "backfill-1-abc");
  assert.equal(active.status, "running");
  assert.equal(active.percent, 60);
  assert.deepEqual(active.params, { from: "2024-01-01", to: "2024-01-31" });
  assert.equal(active.updatedAt, "2026-09-19T11:59:30.000Z");
  assert.equal(active.startedAt, "2026-09-19T11:58:05.000Z");
  assert.equal(active.finishedAt, null);
});

test("getJob returns null for an unknown id", async () => {
  const { store } = freshStore();
  assert.equal(await store.getJob("nope"), null);
});

test("job lifecycle: queued -> running -> complete keeps started_at, stamps finished_at, sets percent 100", async () => {
  const { store } = freshStore();
  await store.insertQueuedJob({ id: "j1", type: "backfill", params: { from: "a", to: "b" }, now: "2026-09-19T11:00:00.000Z" });
  assert.equal((await store.getJob("j1")).status, "queued");

  await store.markJobRunning({ id: "j1", type: "backfill", now: "2026-09-19T11:00:05.000Z" });
  // A redelivered message re-marks running: started_at keeps its FIRST value.
  await store.markJobRunning({ id: "j1", type: "backfill", now: "2026-09-19T11:05:00.000Z" });
  await store.completeJob({ id: "j1", result: { inserted: 7 }, detail: "Inserted 7 articles", now: "2026-09-19T11:06:00.000Z" });

  const job = await store.getJob("j1");
  assert.equal(job.status, "complete");
  assert.equal(job.percent, 100);
  assert.equal(job.phase, "done");
  assert.deepEqual(job.result, { inserted: 7 });
  assert.equal(job.startedAt, "2026-09-19T11:00:05.000Z");
  assert.equal(job.finishedAt, "2026-09-19T11:06:00.000Z");
  assert.deepEqual(job.params, { from: "a", to: "b" }, "the queued row's params survive the running upsert");
});

test("markJobRunning works when the 'queued' row was never written (upsert)", async () => {
  const { store } = freshStore();
  await store.markJobRunning({ id: "late", type: "backtest", params: { tickers: ["AAPL"] }, now: NOW });
  const job = await store.getJob("late");
  assert.equal(job.status, "running");
  assert.equal(job.type, "backtest");
  assert.deepEqual(job.params, { tickers: ["AAPL"] });
});

test("insertQueuedJob is a no-op when the id already exists (never resets a running job)", async () => {
  const { store } = freshStore();
  await seedRunning(store);
  await store.insertQueuedJob({ id: "backfill-1-abc", type: "backfill", now: NOW });
  const job = await store.getJob("backfill-1-abc");
  assert.equal(job.status, "running");
  assert.equal(job.percent, 60);
});

test("a late progress tick can never overwrite a finished job", async () => {
  const { store } = freshStore();
  await seedRunning(store);
  await store.failJob({ id: "backfill-1-abc", error: "boom", now: "2026-09-19T11:59:45.000Z" });
  await store.updateJobProgress({ id: "backfill-1-abc", phase: "saving", percent: 99, now: NOW });

  const job = await store.getJob("backfill-1-abc");
  assert.equal(job.status, "failed");
  assert.equal(job.percent, 60, "failJob keeps the last reported percent, the late tick didn't move it");
  assert.equal(job.error, "boom");
});

test("failJob truncates a long error to 500 chars; updateJobProgress clamps percent and truncates detail", async () => {
  const { store } = freshStore();
  await store.insertQueuedJob({ id: "j", type: "backfill", now: NOW });
  await store.updateJobProgress({ id: "j", percent: 250, done: -3, total: 5.6, detail: "d".repeat(500), now: NOW });
  const ticked = await store.getJob("j");
  assert.equal(ticked.percent, 100);
  assert.equal(ticked.done, 0);
  assert.equal(ticked.total, 6);
  assert.equal(ticked.detail.length, 200);

  await store.failJob({ id: "j", error: "e".repeat(900), now: NOW });
  assert.equal((await store.getJob("j")).error.length, 500);
});

test("job rows are scoped by run_id: same job id in two runs is two rows, and neither store sees the other's", async () => {
  const db = createTestD1([STATE_DIR]);
  const live = new RunStore(db, "live");
  const other = new RunStore(db, "bt-1");
  await live.insertQueuedJob({ id: "shared-id", type: "backfill", params: { who: "live" }, now: NOW });
  await other.insertQueuedJob({ id: "shared-id", type: "backfill", params: { who: "bt-1" }, now: NOW });

  assert.deepEqual((await live.getJob("shared-id")).params, { who: "live" });
  assert.deepEqual((await other.getJob("shared-id")).params, { who: "bt-1" });

  await other.failJob({ id: "shared-id", error: "x", now: NOW });
  assert.equal((await live.getJob("shared-id")).status, "queued", "failing bt-1's row leaves live's untouched");
  assert.equal((await live.getActiveJob("backfill", { now: NOW })).id, "shared-id");
  assert.equal(await other.getActiveJob("backfill", { now: NOW }), null);

  const rows = await stateRows(db, "job_progress", "run_id");
  assert.deepEqual(rows.map((r) => r.run_id), ["bt-1", "live"]);
});

// ---- getLatestFinishedJob: how the last run ended, for the Backfill page ----

test("getLatestFinishedJob returns null when no job of the type has finished", async () => {
  const { store } = freshStore();
  assert.equal(await store.getLatestFinishedJob("backfill"), null);

  await seedRunning(store);
  assert.equal(await store.getLatestFinishedJob("backfill"), null, "an in-flight job is not a finished one");
});

test("getLatestFinishedJob returns the job that finished most recently, complete or failed, and ignores in-flight rows and other types", async () => {
  const { store } = freshStore();
  await store.insertQueuedJob({ id: "b-old", type: "backfill", now: "2026-09-19T10:00:00.000Z" });
  await store.completeJob({ id: "b-old", result: { inserted: 1 }, now: "2026-09-19T10:05:00.000Z" });
  await store.insertQueuedJob({ id: "b-failed", type: "backfill", now: "2026-09-19T11:00:00.000Z" });
  await store.failJob({ id: "b-failed", error: "boom", now: "2026-09-19T11:05:00.000Z" });
  // Newer than both, but still running -> must not win.
  await store.insertQueuedJob({ id: "b-running", type: "backfill", now: "2026-09-19T11:50:00.000Z" });
  // Finished later than everything above, but a different type -> must not win.
  await store.insertQueuedJob({ id: "t-done", type: "backtest", now: "2026-09-19T11:55:00.000Z" });
  await store.completeJob({ id: "t-done", now: "2026-09-19T11:56:00.000Z" });

  const latest = await store.getLatestFinishedJob("backfill");
  assert.equal(latest.id, "b-failed");
  assert.equal(latest.status, "failed");
  assert.equal(latest.error, "boom");

  // Once a later job completes, that one is the latest.
  await store.completeJob({ id: "b-running", result: { inserted: 9 }, now: "2026-09-19T11:58:00.000Z" });
  assert.equal((await store.getLatestFinishedJob("backfill")).id, "b-running");
  assert.equal((await store.getLatestFinishedJob("backtest")).id, "t-done");
});

test("getLatestFinishedJob returns the same camelCased, JSON-parsed shape as getJob", async () => {
  const { store } = freshStore();
  await store.insertQueuedJob({ id: "j", type: "backfill", params: { from: "2024-01-01", to: "2024-01-31" }, now: "2026-09-19T11:00:00.000Z" });
  await store.completeJob({ id: "j", result: { inserted: 146, errorCount: 0, parts: 1 }, detail: "Inserted 146 articles", now: "2026-09-19T11:05:00.000Z" });

  const latest = await store.getLatestFinishedJob("backfill");
  assert.deepEqual(latest, await store.getJob("j"));
  assert.deepEqual(latest.params, { from: "2024-01-01", to: "2024-01-31" });
  assert.deepEqual(latest.result, { inserted: 146, errorCount: 0, parts: 1 });
  assert.equal(latest.finishedAt, "2026-09-19T11:05:00.000Z");
});

test("getLatestFinishedJob is scoped by run_id: another run's finished job is invisible", async () => {
  const db = createTestD1([STATE_DIR]);
  const live = new RunStore(db, "live");
  const other = new RunStore(db, "bt-1");
  await other.insertQueuedJob({ id: "other-job", type: "backfill", now: "2026-09-19T11:00:00.000Z" });
  await other.completeJob({ id: "other-job", now: "2026-09-19T11:05:00.000Z" });

  assert.equal(await live.getLatestFinishedJob("backfill"), null);
  assert.equal((await other.getLatestFinishedJob("backfill")).id, "other-job");
});

// ---- the best-effort reporter over a store --------------------------------

test("createJobReporter drives the full lifecycle through the store (queued, start, forced update, complete)", async () => {
  const { store } = freshStore();
  const reporter = createJobReporter(store, { id: "r1", type: "backfill", params: { from: "a", to: "b" } });
  assert.equal(reporter.enabled, true);

  await reporter.queued();
  assert.equal((await store.getJob("r1")).status, "queued");
  await reporter.start();
  assert.equal((await store.getJob("r1")).status, "running");
  await reporter.update({ force: true, phase: "fetching", percent: 30, done: 1, total: 3, detail: "AAPL" });
  const mid = await store.getJob("r1");
  assert.equal(mid.phase, "fetching");
  assert.equal(mid.percent, 30);
  await reporter.complete({ inserted: 2 }, "Inserted 2 articles");
  const done = await store.getJob("r1");
  assert.equal(done.status, "complete");
  assert.deepEqual(done.result, { inserted: 2 });
});

test("createJobReporter.update is throttled to one write per minIntervalMs unless forced", async () => {
  const { store } = freshStore();
  let t = 1000;
  const reporter = createJobReporter(store, { id: "r2", type: "backfill", minIntervalMs: 1500, nowMs: () => t });
  await reporter.start(); // lastWriteAt = 1000
  t = 1500;
  await reporter.update({ phase: "fetching", percent: 10 }); // inside window -> skipped
  assert.equal((await store.getJob("r2")).percent, 0);
  t = 2600;
  await reporter.update({ phase: "fetching", percent: 20 }); // outside window -> written
  assert.equal((await store.getJob("r2")).percent, 20);
  t = 2700;
  await reporter.update({ phase: "saving", percent: 55, force: true }); // forced inside window -> written
  assert.equal((await store.getJob("r2")).percent, 55);
});

test("createJobReporter swallows a failing store write (best-effort) and stays a no-op with no usable store", async () => {
  const boom = { insertQueuedJob: async () => { throw new Error("d1 down"); }, markJobRunning: async () => { throw new Error("d1 down"); } };
  const warn = console.warn;
  const warnings = [];
  console.warn = (...a) => warnings.push(a);
  try {
    const reporter = createJobReporter(boom, { id: "r3", type: "backfill" });
    await reporter.queued();
    await reporter.start();
    assert.equal(warnings.length, 2);
    assert.match(warnings[0][0], /job progress write failed/);

    for (const bad of [undefined, null, {}]) {
      const r = createJobReporter(bad, { id: "r4", type: "backfill" });
      assert.equal(r.enabled, false);
      await r.queued();
      await r.start();
      await r.update({ force: true });
      await r.complete();
      await r.fail("x");
    }
    assert.equal(createJobReporter(boom, { type: "backfill" }).enabled, false, "no id -> disabled");
  } finally {
    console.warn = warn;
  }
});
