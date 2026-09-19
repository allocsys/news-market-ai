// Covers the M4b environment selector's backend plumbing: `?env=` parsing
// (helpers.js#parseEnvParam), the registry lookup that vets an id
// (sim_registry.js#getBacktestRun), the resolver that turns it into a scoped
// RunStore or a safe fallback to live (data.js#resolveEnv), the anchored
// activity window (RunStore#getDecisionStats), and the env-aware data
// functions/job route built on them.
//
// Everything runs on REAL sqlite-backed D1s (test/helpers/sqlite_d1.js): the
// state schema (LIVE_DB), the inputs schema, and SIM_DB (state + sim
// schemas), same as dashboard_api.test.js. The one hand-written double is
// BrokenDb, used only to prove a failing registry lookup degrades to live.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { parseEnvParam, parseDashboardParams, parseLlmParams } from "../src/dashboard/helpers.js";
import { resolveEnv, getDecisionsData, getPositionsData, getSnapshotData } from "../src/dashboard/data.js";
import { RunStore } from "../src/storage/run_store.js";
import { insertBacktestRun, completeBacktestRun, getBacktestRun } from "../src/storage/sim_registry.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { BrokenDb } from "./helpers/broken_db.js";
import { STATE_DIR, INPUTS_DIR, SIM_DIR } from "./helpers/engine_ctx.js";

const BT = "backtest-1789000000000-abc123";
const BT_OTHER = "backtest-1789000000001-def456";

const qs = (obj) => new URLSearchParams(obj);

function baseEnv(overrides = {}) {
  return {
    LIVE_DB: createTestD1([STATE_DIR]),
    INPUTS_DB: createTestD1([INPUTS_DIR]),
    SIM_DB: createTestD1([STATE_DIR, SIM_DIR]),
    ...overrides,
  };
}

async function registerRun(simDb, id, { startedAt = "2026-03-12T00:00:00.000Z", finishedAt = "2026-03-12T01:00:00.000Z" } = {}) {
  await insertBacktestRun(simDb, { id, tickers: ["AAPL"], testStart: "2024-01-01T00:00:00.000Z", testEnd: "2024-02-01T00:00:00.000Z", trainDays: 0, testDays: 30, startedAt });
  if (finishedAt) await completeBacktestRun(simDb, { id, result: { overall: {} }, finishedAt });
}

async function decision(store, { id, ticker = "AAPL", status = "approved", createdAt }) {
  await store.insertTradeDecision({ id, ticker, asOf: createdAt, thesis: { ticker, direction: "long" }, riskDecision: { approved: true }, portfolioDecision: null, status, createdAt });
}

async function openPos(store, ticker, openedAt = "2026-01-01T00:00:00.000Z") {
  await store.openPosition({ id: `${ticker}|${openedAt}`, ticker, tradeThesisId: `${ticker}|${openedAt}`, positionSizePct: 0.05, direction: "long", entryPrice: 100, stopLossPct: 0.03, takeProfitPct: 0.06, openedAt });
}

// ---------------------------------------------------------------------------
// parseEnvParam / params
// ---------------------------------------------------------------------------

test("parseEnvParam: 'live', empty and missing all mean live", () => {
  assert.equal(parseEnvParam(qs({ env: "live" })), "live");
  assert.equal(parseEnvParam(qs({ env: "" })), "live");
  assert.equal(parseEnvParam(qs({ env: "   " })), "live");
  assert.equal(parseEnvParam(qs({})), "live");
  assert.equal(parseEnvParam(null), "live");
  assert.equal(parseEnvParam(undefined), "live");
});

test("parseEnvParam: a well-formed backtest id passes through (trimmed)", () => {
  assert.equal(parseEnvParam(qs({ env: BT })), BT);
  assert.equal(parseEnvParam(qs({ env: `  ${BT}  ` })), BT);
});

test("parseEnvParam: malformed ids fall back to live instead of reaching a query", () => {
  for (const bad of ["backtest-1", "backtest-abc-def", "BACKTEST-1-abc", "bt-1", "live2", `${BT}; DROP TABLE positions`, `${BT}%`, "backtest-1-ab c", "../live", "j".repeat(500)]) {
    assert.equal(parseEnvParam(qs({ env: bad })), "live", `expected ${JSON.stringify(bad)} to fall back to live`);
  }
});

test("parseDashboardParams and parseLlmParams both carry env, defaulting to live", () => {
  assert.equal(parseDashboardParams(qs({})).env, "live");
  assert.equal(parseDashboardParams(qs({ env: BT })).env, BT);
  assert.equal(parseDashboardParams(qs({ env: "junk" })).env, "live");
  assert.equal(parseLlmParams(qs({})).env, "live");
  assert.equal(parseLlmParams(qs({ env: BT })).env, BT);
  assert.equal(parseLlmParams(qs({ env: "junk" })).env, "live");
});

// ---------------------------------------------------------------------------
// getBacktestRun
// ---------------------------------------------------------------------------

test("getBacktestRun returns the one row by id (camelCased, JSON-parsed) and null for an unknown id", async () => {
  const simDb = createTestD1([STATE_DIR, SIM_DIR]);
  await registerRun(simDb, BT);
  await registerRun(simDb, BT_OTHER);

  const run = await getBacktestRun(simDb, BT);
  assert.equal(run.id, BT);
  assert.deepEqual(run.tickers, ["AAPL"]);
  assert.equal(run.status, "complete");
  assert.equal(run.finishedAt, "2026-03-12T01:00:00.000Z");

  assert.equal(await getBacktestRun(simDb, "backtest-1-nope"), null);
});

// ---------------------------------------------------------------------------
// resolveEnv
// ---------------------------------------------------------------------------

test("resolveEnv: no param / 'live' -> live store, no anchor, no error", async () => {
  const env = baseEnv();
  for (const param of [undefined, null, "", "live"]) {
    const r = await resolveEnv(env, param);
    assert.equal(r.resolvedEnv, "live");
    assert.equal(r.anchor, null);
    assert.equal(r.envError, null);
    assert.equal(r.store.runId, "live");
  }
});

test("resolveEnv: a registered backtest -> store scoped to that run, anchored at finishedAt", async () => {
  const env = baseEnv();
  await registerRun(env.SIM_DB, BT, { finishedAt: "2026-03-12T01:00:00.000Z" });

  const r = await resolveEnv(env, BT);
  assert.equal(r.resolvedEnv, BT);
  assert.equal(r.store.runId, BT);
  assert.equal(r.anchor, "2026-03-12T01:00:00.000Z");
  assert.equal(r.envError, null);
});

test("resolveEnv: a still-running backtest (no finishedAt) anchors at startedAt so the window isn't empty", async () => {
  const env = baseEnv();
  await registerRun(env.SIM_DB, BT, { startedAt: "2026-03-12T00:00:00.000Z", finishedAt: null });

  const r = await resolveEnv(env, BT);
  assert.equal(r.resolvedEnv, BT);
  assert.equal(r.anchor, "2026-03-12T00:00:00.000Z");
  assert.equal(r.envError, null);
});

test("resolveEnv: a malformed id falls back to live with an envError", async () => {
  const r = await resolveEnv(baseEnv(), "not-a-run; DROP TABLE x");
  assert.equal(r.resolvedEnv, "live");
  assert.equal(r.store.runId, "live");
  assert.equal(r.anchor, null);
  assert.match(r.envError, /unknown environment/);
});

test("resolveEnv: a well-formed but unregistered id falls back to live with an envError", async () => {
  const env = baseEnv();
  await registerRun(env.SIM_DB, BT);

  const r = await resolveEnv(env, BT_OTHER);
  assert.equal(r.resolvedEnv, "live");
  assert.equal(r.store.runId, "live");
  assert.equal(r.anchor, null);
  assert.match(r.envError, /not found/);
});

test("resolveEnv: a throwing SIM_DB lookup falls back to live with an envError, never rejects", async () => {
  const env = baseEnv({ SIM_DB: new BrokenDb() });

  const r = await resolveEnv(env, BT);
  assert.equal(r.resolvedEnv, "live");
  assert.equal(r.store.runId, "live");
  assert.equal(r.anchor, null);
  assert.match(r.envError, /couldn't verify/);
  assert.match(r.envError, /D1 exploded/);
});

test("resolveEnv: a resolved backtest store sees only that run's rows -- never live's or another backtest's", async () => {
  const env = baseEnv();
  await registerRun(env.SIM_DB, BT);
  await registerRun(env.SIM_DB, BT_OTHER);
  await decision(new RunStore(env.LIVE_DB, "live"), { id: "live-d", createdAt: "2026-03-12T00:30:00.000Z" });
  await decision(new RunStore(env.SIM_DB, BT), { id: "bt-d", createdAt: "2026-03-12T00:30:00.000Z" });
  await decision(new RunStore(env.SIM_DB, BT_OTHER), { id: "other-d", createdAt: "2026-03-12T00:30:00.000Z" });

  const { store } = await resolveEnv(env, BT);
  assert.deepEqual((await store.listRecentTradeDecisions({ limit: 10 })).map((d) => d.id), ["bt-d"]);
});

// ---------------------------------------------------------------------------
// RunStore#getDecisionStats anchor
// ---------------------------------------------------------------------------

test("getDecisionStats: an anchor replaces wall-clock now, catching decisions a now-relative window never would", async () => {
  const db = createTestD1([STATE_DIR]);
  const store = new RunStore(db, "run-1");
  // Months before the (real) present: far outside any now-relative window.
  await decision(store, { id: "old-1", status: "approved", createdAt: "2026-03-10T12:00:00.000Z" });
  await decision(store, { id: "old-2", status: "rejected", createdAt: "2026-03-11T12:00:00.000Z" });

  const nowRelative = await store.getDecisionStats({ days: 14 });
  assert.deepEqual(nowRelative.daily, [], "no anchor -> wall-clock window, which misses months-old decisions");
  assert.deepEqual(nowRelative.totals, { approved: 1, rejected: 1 }, "totals are all-time, unaffected by the window");

  const anchored = await store.getDecisionStats({ days: 14, anchor: "2026-03-12T00:00:00.000Z" });
  assert.deepEqual(anchored.daily.map((d) => [d.day, d.status, d.count]), [["2026-03-10", "approved", 1], ["2026-03-11", "rejected", 1]]);
  assert.equal(anchored.days, 14);
});

test("getDecisionStats: the anchored window still honors `days` (older decisions fall out)", async () => {
  const db = createTestD1([STATE_DIR]);
  const store = new RunStore(db, "run-1");
  await decision(store, { id: "in", createdAt: "2026-03-10T12:00:00.000Z" });
  await decision(store, { id: "out", createdAt: "2026-02-01T12:00:00.000Z" });

  const stats = await store.getDecisionStats({ days: 7, anchor: "2026-03-12T00:00:00.000Z" });
  assert.deepEqual(stats.daily.map((d) => d.day), ["2026-03-10"]);
});

test("getDecisionStats: omitting the anchor is the unchanged live behavior (recent decisions counted)", async () => {
  const db = createTestD1([STATE_DIR]);
  const store = new RunStore(db, "live");
  await decision(store, { id: "fresh", createdAt: new Date().toISOString() });

  const stats = await store.getDecisionStats({ days: 14 });
  assert.equal(stats.daily.reduce((n, d) => n + d.count, 0), 1);
});

// ---------------------------------------------------------------------------
// env-aware data functions
// ---------------------------------------------------------------------------

test("getDecisionsData / getPositionsData: env=<backtest> returns that run's rows and reports resolvedEnv; live is unaffected", async () => {
  const env = baseEnv();
  await registerRun(env.SIM_DB, BT);
  const live = new RunStore(env.LIVE_DB, "live");
  const bt = new RunStore(env.SIM_DB, BT);
  await decision(live, { id: "live-d", ticker: "MSFT", createdAt: "2026-03-12T00:30:00.000Z" });
  await decision(bt, { id: "bt-d", ticker: "AAPL", createdAt: "2026-03-12T00:30:00.000Z" });
  await openPos(live, "MSFT");
  await openPos(bt, "AAPL");

  const btParams = parseDashboardParams(qs({ env: BT }));
  const liveParams = parseDashboardParams(qs({}));

  const btDecisions = await getDecisionsData(env, btParams);
  assert.deepEqual(btDecisions.decisions.map((d) => d.id), ["bt-d"]);
  assert.equal(btDecisions.resolvedEnv, BT);
  assert.equal(btDecisions.envError, null);

  const btPositions = await getPositionsData(env, btParams);
  assert.deepEqual(btPositions.openPositions.map((p) => p.ticker), ["AAPL"]);
  assert.equal(btPositions.resolvedEnv, BT);

  const liveDecisions = await getDecisionsData(env, liveParams);
  assert.deepEqual(liveDecisions.decisions.map((d) => d.id), ["live-d"]);
  assert.equal(liveDecisions.resolvedEnv, "live");
  assert.equal(liveDecisions.envError, null);
});

test("getSnapshotData: a backtest env anchors its activity stats at the run's finishedAt (not today)", async () => {
  const env = baseEnv();
  await registerRun(env.SIM_DB, BT, { finishedAt: "2026-03-12T01:00:00.000Z" });
  await decision(new RunStore(env.SIM_DB, BT), { id: "bt-d", createdAt: "2026-03-11T12:00:00.000Z" });

  const snap = await getSnapshotData(env, parseDashboardParams(qs({ env: BT })));
  assert.equal(snap.resolvedEnv, BT);
  assert.deepEqual(snap.decisionStats.daily.map((d) => d.day), ["2026-03-11"]);
});

test("getDecisionsData: an unknown backtest id shows live, and says why", async () => {
  const env = baseEnv();
  await decision(new RunStore(env.LIVE_DB, "live"), { id: "live-d", createdAt: "2026-03-12T00:30:00.000Z" });

  const data = await getDecisionsData(env, parseDashboardParams(qs({ env: BT })));
  assert.equal(data.resolvedEnv, "live");
  assert.match(data.envError, /not found/);
  assert.deepEqual(data.decisions.map((d) => d.id), ["live-d"], "the page still renders, from live");
});

// ---------------------------------------------------------------------------
// GET /api/jobs/:id?env= -- a backtest's job_progress row lives under its OWN
// id as run_id on SIM_DB, never under 'live'.
// ---------------------------------------------------------------------------

async function seedBacktestJob(env, id) {
  const store = new RunStore(env.SIM_DB, id);
  const now = new Date().toISOString();
  await store.insertQueuedJob({ id, type: "backtest", params: { tickers: ["AAPL"] }, now });
  await store.markJobRunning({ id, type: "backtest", now });
  await store.updateJobProgress({ id, phase: "running", percent: 42, done: 21, total: 50, now });
}

const fetchJob = (env, path) => worker.fetch(new Request(`https://worker.example${path}`), env);

test("GET /api/jobs/:id?env=<backtest id> finds the job on SIM_DB; without ?env it 404s (the row isn't under 'live')", async () => {
  const env = baseEnv();
  await registerRun(env.SIM_DB, BT, { finishedAt: null });
  await seedBacktestJob(env, BT);

  const found = await fetchJob(env, `/api/jobs/${BT}?env=${BT}`);
  assert.equal(found.status, 200);
  const job = await found.json();
  assert.equal(job.percent, 42);
  assert.equal(job.type, "backtest");

  const noEnv = await fetchJob(env, `/api/jobs/${BT}`);
  assert.equal(noEnv.status, 404);
});

test("GET /api/jobs/:id?env=<unregistered id> falls back to live rather than erroring (404 for a job that isn't there)", async () => {
  const env = baseEnv();
  await registerRun(env.SIM_DB, BT, { finishedAt: null });
  await seedBacktestJob(env, BT);

  const res = await fetchJob(env, `/api/jobs/${BT}?env=${BT_OTHER}`);
  assert.equal(res.status, 404);
});
