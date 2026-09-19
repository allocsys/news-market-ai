// Covers src/storage/jobs.js's read side: getJob and getActiveJob (the lookup
// behind the "job already in flight" progress panel on the backfill/backtest
// pages). The write side (createJobReporter etc.) is exercised through the
// consumers' own tests.

import test from "node:test";
import assert from "node:assert/strict";
import { getJob, getActiveJob, ACTIVE_JOB_MAX_IDLE_MS } from "../src/storage/jobs.js";

/** Records the SQL + binds of every query and answers .first() with `row`. */
function fakeDb(row) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const call = { sql, args: null };
      calls.push(call);
      return {
        bind(...args) {
          call.args = args;
          return this;
        },
        async first() {
          return row;
        },
      };
    },
  };
}

const ROW = {
  id: "backfill-1-abc",
  type: "backfill",
  status: "running",
  phase: "saving",
  percent: 60,
  done: 3,
  total: 5,
  detail: "Saved 3/5 articles",
  params: '{"from":"2024-01-01","to":"2024-01-31"}',
  result: null,
  error: null,
  created_at: "2026-09-19T11:58:00.000Z",
  started_at: "2026-09-19T11:58:05.000Z",
  updated_at: "2026-09-19T11:59:30.000Z",
  finished_at: null,
};

const NOW = "2026-09-19T12:00:00.000Z";

test("getActiveJob returns null when nothing is in flight", async () => {
  assert.equal(await getActiveJob(fakeDb(undefined), "backfill", { now: NOW }), null);
});

test("getActiveJob asks only for queued/running rows of the requested type, newest first, at most one", async () => {
  const db = fakeDb(undefined);
  await getActiveJob(db, "backtest", { now: NOW });

  assert.equal(db.calls.length, 1);
  const { sql, args } = db.calls[0];
  assert.match(sql, /FROM job_progress/);
  assert.match(sql, /type = \?/);
  assert.match(sql, /status IN \('queued', 'running'\)/);
  assert.match(sql, /ORDER BY created_at DESC LIMIT 1/);
  assert.equal(args[0], "backtest");
});

test("getActiveJob's idle cutoff is now minus 15 minutes by default -- rows orphaned by an isolate kill age out instead of showing a phantom bar forever", async () => {
  assert.equal(ACTIVE_JOB_MAX_IDLE_MS, 15 * 60 * 1000);

  const db = fakeDb(undefined);
  await getActiveJob(db, "backfill", { now: NOW });
  assert.match(db.calls[0].sql, /updated_at >= \?/);
  assert.equal(db.calls[0].args[1], "2026-09-19T11:45:00.000Z");
});

test("getActiveJob honours a custom maxIdleMs", async () => {
  const db = fakeDb(undefined);
  await getActiveJob(db, "backfill", { now: NOW, maxIdleMs: 60 * 1000 });
  assert.equal(db.calls[0].args[1], "2026-09-19T11:59:00.000Z");
});

test("getActiveJob returns the same camelCased, JSON-parsed shape as getJob", async () => {
  const active = await getActiveJob(fakeDb(ROW), "backfill", { now: NOW });
  const byId = await getJob(fakeDb(ROW), ROW.id);

  assert.deepEqual(active, byId);
  assert.equal(active.id, "backfill-1-abc");
  assert.equal(active.percent, 60);
  assert.deepEqual(active.params, { from: "2024-01-01", to: "2024-01-31" });
  assert.equal(active.updatedAt, "2026-09-19T11:59:30.000Z");
  assert.equal(active.finishedAt, null);
});

test("getJob still returns null for an unknown id", async () => {
  assert.equal(await getJob(fakeDb(undefined), "nope"), null);
});
