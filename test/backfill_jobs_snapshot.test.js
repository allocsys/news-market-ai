// RunStore#getBackfillJobsSnapshot / GET /api/jobs/backfill: the Backfill page's progress card reads its three
// jobs (news, prices, macro) in ONE query instead of an active + latest read per type. Real SQL over
// migrations/state/ (test/helpers/sqlite_d1.js), like test/storage_jobs.test.js.

import test from "node:test";
import assert from "node:assert/strict";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { STATE_DIR } from "./helpers/engine_ctx.js";
import { RunStore } from "../src/storage/run_store.js";
import worker from "../src/index.js";
import { createSessionCookie } from "../src/auth/session.js";
import { loadConfig } from "../src/config.js";

const NOW = "2026-10-12T12:00:00.000Z";

function freshStore(runId = "live") {
  const db = createTestD1([STATE_DIR]);
  return { db, store: new RunStore(db, runId) };
}

test("snapshot is all null when no backfill has ever run", async () => {
  const { store } = freshStore();
  assert.deepEqual(await store.getBackfillJobsSnapshot({ now: NOW }), { news: null, prices: null, macro: null });
});

test("snapshot prefers the running job of a type over its last finished one", async () => {
  const { store } = freshStore();
  await store.insertQueuedJob({ id: "b-old", type: "backfill", now: "2026-10-12T09:00:00.000Z" });
  await store.completeJob({ id: "b-old", now: "2026-10-12T09:10:00.000Z" });
  await store.insertQueuedJob({ id: "b-run", type: "backfill", now: "2026-10-12T11:58:00.000Z" });
  await store.updateJobProgress({ id: "b-run", percent: 40, done: 4, total: 10, now: "2026-10-12T11:59:00.000Z" });

  const snap = await store.getBackfillJobsSnapshot({ now: NOW });

  assert.equal(snap.news.id, "b-run");
  assert.equal(snap.news.status, "running");
  assert.equal(snap.news.done, 4);
});

test("snapshot falls back to the most recently FINISHED job (by finished_at), complete or failed", async () => {
  const { store } = freshStore();
  await store.insertQueuedJob({ id: "p-1", type: "backfill_prices", now: "2026-10-12T08:00:00.000Z" });
  await store.completeJob({ id: "p-1", now: "2026-10-12T08:05:00.000Z" });
  await store.insertQueuedJob({ id: "p-2", type: "backfill_prices", now: "2026-10-12T09:00:00.000Z" });
  await store.failJob({ id: "p-2", error: "boom", now: "2026-10-12T09:01:00.000Z" });

  const snap = await store.getBackfillJobsSnapshot({ now: NOW });

  assert.equal(snap.prices.id, "p-2");
  assert.equal(snap.prices.status, "failed");
  assert.equal(snap.news, null);
});

test("snapshot ignores a job orphaned past the idle cutoff instead of showing a phantom running bar", async () => {
  const { store } = freshStore();
  await store.insertQueuedJob({ id: "m-orphan", type: "backfill_macro", now: "2026-10-12T11:00:00.000Z" }); // idle 60 min
  await store.insertQueuedJob({ id: "m-done", type: "backfill_macro", now: "2026-10-12T07:00:00.000Z" });
  await store.completeJob({ id: "m-done", now: "2026-10-12T07:05:00.000Z" });

  const snap = await store.getBackfillJobsSnapshot({ now: NOW });

  assert.equal(snap.macro.id, "m-done");
});

test("snapshot picks per type independently and never returns a backtest or another run's job", async () => {
  const { db, store } = freshStore();
  await store.insertQueuedJob({ id: "n-1", type: "backfill", now: "2026-10-12T11:59:00.000Z" });
  await store.insertQueuedJob({ id: "p-1", type: "backfill_prices", now: "2026-10-12T11:59:10.000Z" });
  await store.insertQueuedJob({ id: "bt-1", type: "backtest", now: "2026-10-12T11:59:20.000Z" });
  await new RunStore(db, "other-run").insertQueuedJob({ id: "m-other", type: "backfill_macro", now: "2026-10-12T11:59:30.000Z" });

  const snap = await store.getBackfillJobsSnapshot({ now: NOW });

  assert.equal(snap.news.id, "n-1");
  assert.equal(snap.prices.id, "p-1");
  assert.equal(snap.macro, null, "another run's macro job is not this environment's");
});

test("snapshot costs exactly one query, however many jobs exist", async () => {
  const { db, store } = freshStore();
  for (let i = 0; i < 50; i++) {
    const id = `n-${i}`;
    await store.insertQueuedJob({ id, type: "backfill", now: `2026-10-11T${String(i % 24).padStart(2, "0")}:00:00.000Z` });
    await store.completeJob({ id, now: `2026-10-11T${String(i % 24).padStart(2, "0")}:30:00.000Z` });
  }
  let prepares = 0;
  const realPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    prepares++;
    return realPrepare(sql);
  };

  const snap = await store.getBackfillJobsSnapshot({ now: NOW });

  assert.equal(prepares, 1);
  assert.ok(snap.news, "still finds the last finished job within the bounded window");
});

function loginConfiguredEnv(overrides = {}) {
  return {
    DASHBOARD_USERNAME: "admin",
    DASHBOARD_PASSWORD: "correct-horse-battery-staple",
    JWT_SECRET: "test-jwt-signing-key",
    ...overrides,
  };
}

test("GET /api/jobs/backfill returns 401 without a session cookie", async () => {
  const env = loginConfiguredEnv({ LIVE_DB: createTestD1([STATE_DIR]) });
  const response = await worker.fetch(new Request("https://worker.example/api/jobs/backfill"), env);
  assert.equal(response.status, 401);
});

test("GET /api/jobs/backfill answers { news, prices, macro } in one 200, and is not mistaken for a job id", async () => {
  const db = createTestD1([STATE_DIR]);
  const store = new RunStore(db, "live");
  await store.insertQueuedJob({ id: "backfill-1", type: "backfill", params: { from: "2026-10-01", to: "2026-10-10", tickers: ["BTCUSD"] }, now: new Date().toISOString() });
  const env = loginConfiguredEnv({ LIVE_DB: db });
  const cookie = (await createSessionCookie("admin", loadConfig(env))).split(";")[0];

  const response = await worker.fetch(new Request("https://worker.example/api/jobs/backfill", { headers: { Cookie: cookie } }), env);

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ["macro", "news", "prices"]);
  assert.equal(body.news.id, "backfill-1");
  assert.deepEqual(body.news.params.tickers, ["BTCUSD"]);
  assert.equal(body.prices, null);
  assert.equal(body.macro, null);
});
