// A job_progress row can stay 'queued'/'running' forever when its terminal
// write never lands (the reporter is best-effort, an isolate kill, a dropped
// queue message). getActiveJob already hides such an orphan after 15 minutes,
// but GET /api/jobs/:id returned it verbatim, so the progress panel polled a
// dead row for ever. This pins the fix: storage/jobs.js#isJobStale, the
// `stale` flag on GET /api/jobs/:id, and the panel script that acts on it.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { createSessionCookie } from "../src/auth/session.js";
import { loadConfig } from "../src/config.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { STATE_DIR, INPUTS_DIR, SIM_DIR } from "./helpers/engine_ctx.js";
import { RunStore } from "../src/storage/run_store.js";
import { isJobStale, ACTIVE_JOB_MAX_IDLE_MS } from "../src/storage/jobs.js";
import { renderRunAcceptedPage, renderActiveJobPanel } from "../src/dashboard/views/status.js";

const NOW_MS = Date.parse("2026-10-03T12:00:00.000Z");
const minutesAgo = (m) => new Date(NOW_MS - m * 60_000).toISOString();

test("isJobStale: an in-flight row idle past the 15-minute cutoff is stale, a fresh one is not", () => {
  assert.equal(isJobStale({ status: "running", updatedAt: minutesAgo(16) }, { now: NOW_MS }), true);
  assert.equal(isJobStale({ status: "queued", updatedAt: minutesAgo(16) }, { now: NOW_MS }), true);
  assert.equal(isJobStale({ status: "running", updatedAt: minutesAgo(14) }, { now: NOW_MS }), false);
  assert.equal(isJobStale({ status: "queued", updatedAt: minutesAgo(0) }, { now: NOW_MS }), false);
});

test("isJobStale: exactly at the cutoff is not stale (strictly greater), and a custom maxIdleMs is honoured", () => {
  assert.equal(ACTIVE_JOB_MAX_IDLE_MS, 15 * 60_000);
  assert.equal(isJobStale({ status: "running", updatedAt: minutesAgo(15) }, { now: NOW_MS }), false);
  assert.equal(isJobStale({ status: "running", updatedAt: minutesAgo(2) }, { now: NOW_MS, maxIdleMs: 60_000 }), true);
});

test("isJobStale: finished jobs are never stale, however old; missing/garbage input is not stale", () => {
  for (const status of ["complete", "failed", "cancelled"]) {
    assert.equal(isJobStale({ status, updatedAt: minutesAgo(600) }, { now: NOW_MS }), false, status);
  }
  assert.equal(isJobStale(null, { now: NOW_MS }), false);
  assert.equal(isJobStale(undefined, { now: NOW_MS }), false);
  assert.equal(isJobStale({ status: "running", updatedAt: "not a date" }, { now: NOW_MS }), false);
  assert.equal(isJobStale({ status: "running" }, { now: NOW_MS }), false);
});

// --------------------------------------------------------------------
// GET /api/jobs/:id
// --------------------------------------------------------------------

function loginConfiguredEnv(overrides = {}) {
  return {
    LIVE_DB: createTestD1([STATE_DIR]),
    INPUTS_DB: createTestD1([INPUTS_DIR]),
    SIM_DB: createTestD1([STATE_DIR, SIM_DIR]),
    DASHBOARD_USERNAME: "admin",
    DASHBOARD_PASSWORD: "correct-horse-battery-staple",
    JWT_SECRET: "test-jwt-signing-key",
    ...overrides,
  };
}

async function getJob(env, id) {
  const cookie = (await createSessionCookie("admin", loadConfig(env))).split(";")[0];
  const response = await worker.fetch(new Request(`https://worker.example/api/jobs/${id}`, { headers: { Cookie: cookie } }), env);
  assert.equal(response.status, 200);
  return response.json();
}

test("GET /api/jobs/:id marks a 'queued' row that never moved as stale (the stuck-queued case)", async () => {
  const db = createTestD1([STATE_DIR]);
  const store = new RunStore(db, "live");
  await store.insertQueuedJob({ id: "backfill-stuck", type: "backfill", params: { from: "2026-09-01", to: "2026-09-02" }, now: new Date(Date.now() - 30 * 60_000).toISOString() });
  const body = await getJob(loginConfiguredEnv({ LIVE_DB: db }), "backfill-stuck");
  assert.equal(body.status, "queued");
  assert.equal(body.stale, true);
});

test("GET /api/jobs/:id marks an orphaned 'running' row as stale, but a freshly ticking one is not", async () => {
  const db = createTestD1([STATE_DIR]);
  const store = new RunStore(db, "live");
  const old = new Date(Date.now() - 20 * 60_000).toISOString();
  await store.insertQueuedJob({ id: "backfill-orphan", type: "backfill", now: old });
  await store.markJobRunning({ id: "backfill-orphan", type: "backfill", now: old });
  await store.insertQueuedJob({ id: "backfill-live", type: "backfill" });
  await store.markJobRunning({ id: "backfill-live", type: "backfill" });

  const env = loginConfiguredEnv({ LIVE_DB: db });
  assert.equal((await getJob(env, "backfill-orphan")).stale, true);
  assert.equal((await getJob(env, "backfill-live")).stale, false);
});

test("GET /api/jobs/:id never flags a finished job as stale, however old", async () => {
  const db = createTestD1([STATE_DIR]);
  const store = new RunStore(db, "live");
  const old = new Date(Date.now() - 600 * 60_000).toISOString();
  await store.insertQueuedJob({ id: "backfill-done", type: "backfill", now: old });
  await store.completeJob({ id: "backfill-done", result: {}, detail: "done", now: old });
  const body = await getJob(loginConfiguredEnv({ LIVE_DB: db }), "backfill-done");
  assert.equal(body.status, "complete");
  assert.equal(body.stale, false);
});

// --------------------------------------------------------------------
// Panel script
// --------------------------------------------------------------------

test("the progress script stops polling and shows a stalled state when the job comes back stale", () => {
  const accepted = renderRunAcceptedPage({ title: "Backfill", detail: "Backfilling.", backLink: "/dashboard/backfill", backLabel: "Backfill", jobId: "backfill-1-abc", type: "backfill" });
  assert.ok(accepted.includes("if (job.stale) {"), "run-accepted page handles stale");
  assert.ok(accepted.includes('showNextSteps("stalled")'));
  assert.ok(accepted.includes("No progress for over 15 minutes"));

  const active = renderActiveJobPanel({ id: "backtest-1-abc", type: "backtest", params: {} });
  assert.ok(active.includes("if (job.stale) {"), "the active-job panel shares the same script");
});
