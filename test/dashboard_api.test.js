// Covers src/dashboard/api.js's 8 JSON /api/* routes (wired into
// src/index.js -- see that file's "JSON API layer" block).
//
// Every panel runs against REAL sqlite-backed D1s (test/helpers/sqlite_d1.js):
// LIVE_DB (state schema, run_id 'live'), INPUTS_DB (inputs schema) and SIM_DB
// (state + sim schemas). Since M4 no route reads the old `DB` binding, and the
// hand-written DB fakes this file used to carry are gone -- a fake that
// returns [] for any SQL can't tell a working query from a broken one, whereas
// these run the real migrations, so a wrong column or table name fails here.

import test from "node:test";
import { jobStateDb } from "./helpers/job_db.js";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { createSessionCookie } from "../src/auth/session.js";
import { loadConfig } from "../src/config.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { STATE_DIR, INPUTS_DIR, SIM_DIR } from "./helpers/engine_ctx.js";
import { RunStore } from "../src/storage/run_store.js";
import { insertBacktestRun, completeBacktestRun } from "../src/storage/sim_registry.js";

function sessionCookieHeader(setCookieString) {
  return setCookieString.split(";")[0];
}

/** Empty but real databases: the state schema (LIVE_DB), the inputs schema, and the sim schema (SIM_DB). */
function baseEnv(overrides = {}) {
  return {
    LIVE_DB: createTestD1([STATE_DIR]),
    INPUTS_DB: createTestD1([INPUTS_DIR]),
    SIM_DB: createTestD1([STATE_DIR, SIM_DIR]),
    ...overrides,
  };
}

function loginConfiguredEnv(overrides = {}) {
  return baseEnv({
    DASHBOARD_USERNAME: "admin",
    DASHBOARD_PASSWORD: "correct-horse-battery-staple",
    JWT_SECRET: "test-jwt-signing-key",
    ...overrides,
  });
}

async function loggedInCookie(env) {
  const config = loadConfig(env);
  return sessionCookieHeader(await createSessionCookie("admin", config));
}

async function apiFetch(path, env, { cookie } = {}) {
  const headers = cookie ? { Cookie: cookie } : {};
  return worker.fetch(new Request(`https://worker.example${path}`, { headers }), env);
}

// One entry per /api/* route, with the top-level keys its data.js function
// returns (see src/dashboard/data.js) -- used to assert response shape
// without pinning to exact values, which an empty database can't
// meaningfully provide anyway.
const API_ROUTES = [
  { path: "/api/snapshot", keys: ["openPositions", "closedPositions", "decisionStats", "totalExposurePct", "error", "resolvedEnv", "envError"] },
  { path: "/api/activity", keys: ["decisionStats", "error", "resolvedEnv", "envError"] },
  { path: "/api/charts", keys: ["priceBarsByTicker", "error", "resolvedEnv", "envError"] },
  { path: "/api/health", keys: ["health", "error"] },
  { path: "/api/decisions", keys: ["decisions", "error", "resolvedEnv", "envError"] },
  { path: "/api/positions", keys: ["openPositions", "openPositionsError", "closedPositions", "closedPositionsError", "totalExposurePct", "resolvedEnv", "envError"] },
  { path: "/api/pipeline", keys: ["checkpoints", "error", "resolvedEnv", "envError"] },
  { path: "/api/backtest-runs", keys: ["backtestRuns", "error"] },
];

// --------------------------------------------------------------------
// Auth gating -- reuses routes.js's own checkAuth, so this pins the
// JSON-specific behavior on top of it (401 JSON, not a redirect).
// --------------------------------------------------------------------

for (const { path } of API_ROUTES) {
  test(`GET ${path} returns 401 JSON when login is configured and there's no session cookie`, async () => {
    const response = await apiFetch(path, loginConfiguredEnv());
    assert.equal(response.status, 401);
    assert.match(response.headers.get("content-type"), /application\/json/);
    const body = await response.json();
    assert.equal(body.error, "unauthorized");
  });

  test(`GET ${path} renders (200 JSON) when login isn't configured at all -- matches the SSR dashboard's own unauthenticated-when-unconfigured behavior`, async () => {
    const response = await apiFetch(path, baseEnv());
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /application\/json/);
  });

  test(`GET ${path} returns 200 JSON with the expected top-level shape given a valid session cookie`, async () => {
    const env = loginConfiguredEnv();
    const cookie = await loggedInCookie(env);
    const response = await apiFetch(path, env, { cookie });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /application\/json/);
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), API_ROUTES.find((r) => r.path === path).keys.sort());
    // Empty real DBs: every panel's query must actually RUN (a wrong table or
    // column would surface as that panel's error, not as an empty list).
    for (const [key, value] of Object.entries(body)) {
      if (/error$/i.test(key)) assert.equal(value, null, `${path}: ${key} should be null on empty real databases`);
    }
  });
}

test("GET /api/snapshot returns 401 with a stale/forged session cookie (bad signature) -- a cookie alone isn't a free pass", async () => {
  const response = await apiFetch("/api/snapshot", loginConfiguredEnv(), { cookie: "nmai_session=not.a.valid.jwt" });
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error, "unauthorized");
});

// --------------------------------------------------------------------
// Exposure regression test (the actual bug Step 1 fixed): total exposure
// must reflect EVERY open position, not just the Rows-limited page of
// them a plain array fetch returns. 20 open positions at 2% each = 40%
// true total; the old (buggy) behavior -- summing only the 10 rows a
// positionsLimit=10 fetch returns -- would report 20% instead.
// --------------------------------------------------------------------

/** A LIVE_DB holding `count` open positions at `pct` each -- distinct tickers, because the state schema allows one open position per ticker. */
async function liveDbWithOpenPositions(count, pct = 0.02) {
  const db = createTestD1([STATE_DIR]);
  const store = new RunStore(db, "live");
  for (let i = 0; i < count; i++) {
    await store.openPosition({ id: `T${i}|t1`, ticker: `T${i}`, tradeThesisId: `T${i}|t1`, positionSizePct: pct, direction: "long", openedAt: new Date(Date.UTC(2026, 0, i + 1)).toISOString() });
  }
  return db;
}

test("GET /api/positions?positionsLimit=10 reports total exposure across ALL open positions, not just the 10 fetched rows", async () => {
  const env = loginConfiguredEnv({ LIVE_DB: await liveDbWithOpenPositions(20) });
  const cookie = await loggedInCookie(env);
  const response = await apiFetch("/api/positions?positionsLimit=10", env, { cookie });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.openPositions.length, 10, "openPositions itself IS still Rows-limited -- only the exposure total isn't");
  assert.equal(Number(body.totalExposurePct.toFixed(1)), 40, "20 positions x 2% = 40% total, not 10 x 2% = 20%");
  assert.equal(body.openPositionsError, null);
});

test("GET /api/snapshot?positionsLimit=10 reports the same full-book total exposure as /api/positions, not the Rows-limited sum", async () => {
  const env = loginConfiguredEnv({ LIVE_DB: await liveDbWithOpenPositions(20) });
  const cookie = await loggedInCookie(env);
  const response = await apiFetch("/api/snapshot?positionsLimit=10", env, { cookie });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.openPositions.length, 10);
  assert.equal(Number(body.totalExposurePct.toFixed(1)), 40);
});

test("GET /api/positions with zero open positions reports 0% total exposure, not NaN or an error", async () => {
  const env = loginConfiguredEnv({ LIVE_DB: await liveDbWithOpenPositions(0) });
  const cookie = await loggedInCookie(env);
  const response = await apiFetch("/api/positions", env, { cookie });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.openPositions.length, 0);
  assert.equal(body.totalExposurePct, 0);
});

// --------------------------------------------------------------------
// GET /api/jobs/active -- lets the backfill/backtest pages show progress
// for a job submitted earlier (RunStore#getActiveJob over LIVE_DB's job_progress, run_id 'live'), rather
// than only the by-id lookup GET /api/jobs/:id supports.
// --------------------------------------------------------------------

const ACTIVE_BACKTEST = {
  id: "backtest-1789783849291-cx0mfj",
  type: "backtest",
  phase: "simulating",
  percent: 42,
  done: 12,
  total: 30,
  detail: "Simulating day 12/30",
  params: { tickers: ["AAPL"], testStart: "2024-01-01", testEnd: "2024-03-31" },
};

test("GET /api/jobs/active returns 401 JSON when login is configured and there's no session cookie", async () => {
  const response = await apiFetch("/api/jobs/active?type=backfill", loginConfiguredEnv());
  assert.equal(response.status, 401);
  assert.match(response.headers.get("content-type"), /application\/json/);
  const body = await response.json();
  assert.equal(body.error, "unauthorized");
});

test("GET /api/jobs/active renders (200 JSON) when login isn't configured at all -- same as every other /api/* route", async () => {
  const response = await apiFetch("/api/jobs/active?type=backfill", baseEnv({ LIVE_DB: (await jobStateDb()).db }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/json/);
});

test("GET /api/jobs/active without a type query param returns 400, not a lookup with type=null", async () => {
  const env = loginConfiguredEnv({ LIVE_DB: (await jobStateDb()).db });
  const cookie = await loggedInCookie(env);
  const response = await apiFetch("/api/jobs/active", env, { cookie });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error, /type must be one of/);
});

test("GET /api/jobs/active?type=exit_check (not backfill/backtest) returns 400", async () => {
  const env = loginConfiguredEnv({ LIVE_DB: (await jobStateDb()).db });
  const cookie = await loggedInCookie(env);
  const response = await apiFetch("/api/jobs/active?type=exit_check", env, { cookie });
  assert.equal(response.status, 400);
});

test("GET /api/jobs/active?type=backfill returns { job: null } (200, not 404) when nothing is in flight -- 'nothing running' is an ordinary answer", async () => {
  const env = loginConfiguredEnv({ LIVE_DB: (await jobStateDb()).db });
  const cookie = await loggedInCookie(env);
  const response = await apiFetch("/api/jobs/active?type=backfill", env, { cookie });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, { job: null });
});

test("GET /api/jobs/active?type=backtest returns the newest in-flight job, camelCased and JSON-parsed, when the store has one", async () => {
  const { db, updatedAt } = await jobStateDb([ACTIVE_BACKTEST, { id: "backfill-1-abc", type: "backfill" }]);
  const env = loginConfiguredEnv({ LIVE_DB: db });
  const cookie = await loggedInCookie(env);
  const response = await apiFetch("/api/jobs/active?type=backtest", env, { cookie });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.job.id, "backtest-1789783849291-cx0mfj");
  assert.equal(body.job.type, "backtest", "the route asks for THIS type, not any type");
  assert.equal(body.job.percent, 42);
  assert.deepEqual(body.job.params, { tickers: ["AAPL"], testStart: "2024-01-01", testEnd: "2024-03-31" });
  assert.equal(body.job.updatedAt, updatedAt);
});

test("GET /api/jobs/:id returns the job by id from LIVE_DB, and 404 for an unknown one", async () => {
  const { db } = await jobStateDb([ACTIVE_BACKTEST]);
  const env = loginConfiguredEnv({ LIVE_DB: db });
  const cookie = await loggedInCookie(env);

  const found = await apiFetch(`/api/jobs/${ACTIVE_BACKTEST.id}`, env, { cookie });
  assert.equal(found.status, 200);
  assert.equal((await found.json()).percent, 42);

  const missing = await apiFetch("/api/jobs/nope", env, { cookie });
  assert.equal(missing.status, 404);
});

// --------------------------------------------------------------------
// GET /api/backtest-runs reads the sim registry on SIM_DB (M3), not the old DB.
// --------------------------------------------------------------------

test("GET /api/backtest-runs lists registry rows from SIM_DB, newest first, JSON-parsed", async () => {
  const simDb = createTestD1([SIM_DIR]);
  await insertBacktestRun(simDb, { id: "bt-old", tickers: ["AAPL"], testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-06T00:00:00.000Z", trainDays: 0, testDays: 5, startedAt: "2026-02-01T00:00:00.000Z" });
  await insertBacktestRun(simDb, { id: "bt-new", tickers: ["AAPL", "MSFT"], testStart: "2026-03-01T00:00:00.000Z", testEnd: "2026-03-06T00:00:00.000Z", trainDays: 0, testDays: 5, graceDays: 3, startedAt: "2026-04-01T00:00:00.000Z" });
  await completeBacktestRun(simDb, { id: "bt-new", result: { overall: { on: 1 } }, finishedAt: "2026-04-01T01:00:00.000Z" });
  const env = loginConfiguredEnv({ SIM_DB: simDb });
  const cookie = await loggedInCookie(env);

  const response = await apiFetch("/api/backtest-runs", env, { cookie });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.error, null);
  assert.deepEqual(body.backtestRuns.map((r) => r.id), ["bt-new", "bt-old"]);
  assert.deepEqual(body.backtestRuns[0].tickers, ["AAPL", "MSFT"]);
  assert.deepEqual(body.backtestRuns[0].result, { overall: { on: 1 } });
  assert.equal(body.backtestRuns[1].status, "running");
});

test("GET /api/backtest-runs goes through a read-only SIM_DB handle: a write attempt can't happen from the dashboard path", async () => {
  // readOnly() refuses non-SELECT; this pins that the route only ever SELECTs by
  // handing it a SIM_DB whose prepare() records every SQL string it sees.
  const seen = [];
  const simDb = { prepare(sql) { seen.push(sql); return { bind: () => ({ all: async () => ({ results: [] }) }) }; } };
  const env = loginConfiguredEnv({ SIM_DB: simDb });
  const cookie = await loggedInCookie(env);

  const response = await apiFetch("/api/backtest-runs", env, { cookie });
  assert.equal(response.status, 200);
  assert.ok(seen.length > 0 && seen.every((sql) => /^\s*select\b/i.test(sql)));
});

// --------------------------------------------------------------------
// M4: the state/inputs panels read LIVE_DB (run_id 'live') and INPUTS_DB, never
// the old `DB` binding, and never another run_id's rows.
// --------------------------------------------------------------------

/** Live + inputs + sim DBs with a little of everything seeded; a decoy run 'bt-decoy' shares LIVE_DB to prove run scoping through the API. */
async function seededEnv(extra = {}) {
  const env = loginConfiguredEnv(extra);
  const live = new RunStore(env.LIVE_DB, "live");
  const decoy = new RunStore(env.LIVE_DB, "bt-decoy");
  await live.openPosition({ id: "AAPL|1", ticker: "AAPL", tradeThesisId: "AAPL|1", positionSizePct: 0.1, direction: "long", entryPrice: 100, openedAt: "2026-01-01T00:00:00.000Z" });
  await live.openPosition({ id: "MSFT|1", ticker: "MSFT", tradeThesisId: "MSFT|1", positionSizePct: 0.05, direction: "long", entryPrice: 200, openedAt: "2026-01-02T00:00:00.000Z" });
  await decoy.openPosition({ id: "NVDA|1", ticker: "NVDA", tradeThesisId: "NVDA|1", positionSizePct: 0.9, direction: "long", entryPrice: 1, openedAt: "2026-01-03T00:00:00.000Z" });
  const createdAt = new Date().toISOString();
  await live.insertTradeDecision({ id: "AAPL|1", ticker: "AAPL", asOf: "2026-01-01T00:00:00.000Z", thesis: { direction: "long" }, riskDecision: { approved: true }, portfolioDecision: null, status: "approved", createdAt });
  await live.insertTradeDecision({ id: "MSFT|1", ticker: "MSFT", asOf: "2026-01-02T00:00:00.000Z", thesis: { direction: "long" }, riskDecision: { approved: false }, portfolioDecision: null, status: "rejected", createdAt });
  await decoy.insertTradeDecision({ id: "NVDA|1", ticker: "NVDA", asOf: "2026-01-03T00:00:00.000Z", thesis: { direction: "long" }, riskDecision: { approved: true }, portfolioDecision: null, status: "approved", createdAt });
  await live.saveCheckpoint({ pipelineRunId: "pipe-live", ticker: "AAPL", stage: "trader", state: null });
  await decoy.saveCheckpoint({ pipelineRunId: "pipe-decoy", ticker: "NVDA", stage: "trader", state: null });
  await env.INPUTS_DB.prepare(`INSERT INTO price_bars (ticker, date, open, high, low, close, volume, source, ingested_at) VALUES ('AAPL', '2026-01-01', 1, 1, 1, 101, 0, 't', '2026-01-01T00:00:00.000Z')`).run();
  await env.INPUTS_DB.prepare(`INSERT INTO price_bars (ticker, date, open, high, low, close, volume, source, ingested_at) VALUES ('MSFT', '2026-01-01', 1, 1, 1, 202, 0, 't', '2026-01-01T00:00:00.000Z')`).run();
  return env;
}

async function getJson(path, env) {
  const response = await apiFetch(path, env, { cookie: await loggedInCookie(env) });
  assert.equal(response.status, 200, path);
  return response.json();
}

test("state panels serve LIVE_DB's own run_id only -- a second run in the same DB never appears in any route", async () => {
  const env = await seededEnv();

  const positions = await getJson("/api/positions", env);
  assert.deepEqual(positions.openPositions.map((p) => p.ticker), ["MSFT", "AAPL"]);
  assert.equal(Number(positions.totalExposurePct.toFixed(1)), 15, "0.10 + 0.05 -- the decoy's 0.9 is not counted");

  const decisions = await getJson("/api/decisions", env);
  assert.deepEqual(decisions.decisions.map((d) => d.ticker).sort(), ["AAPL", "MSFT"]);
  const approved = await getJson("/api/decisions?decisionStatus=approved", env);
  assert.deepEqual(approved.decisions.map((d) => d.ticker), ["AAPL"]);

  const pipeline = await getJson("/api/pipeline", env);
  assert.deepEqual(pipeline.checkpoints.map((c) => c.run_id), ["pipe-live"]);

  const snapshot = await getJson("/api/snapshot", env);
  assert.equal(snapshot.openPositions.length, 2);
  assert.deepEqual(snapshot.decisionStats.totals, { approved: 1, rejected: 1 });
  assert.equal(snapshot.error, null);

  const activity = await getJson("/api/activity", env);
  assert.deepEqual(activity.decisionStats.totals, { approved: 1, rejected: 1 });
});

test("inputs panels read INPUTS_DB: /api/health counts ingestion tables, /api/charts pulls bars for the open positions' tickers", async () => {
  const env = await seededEnv();

  const health = await getJson("/api/health", env);
  assert.equal(health.error, null);
  assert.equal(health.health.priceBars.count, 2);
  assert.equal(health.health.news.count, 0);

  const charts = await getJson("/api/charts", env);
  assert.equal(charts.error, null);
  assert.deepEqual(Object.keys(charts.priceBarsByTicker).sort(), ["AAPL", "MSFT"], "NVDA (the decoy run's position) gets no chart");
  assert.deepEqual(charts.priceBarsByTicker.AAPL.map((b) => ({ ...b })), [{ date: "2026-01-01", close: 101 }]);
});

test("no dashboard route touches the old `DB` binding: a DB that throws on any use changes nothing", async () => {
  const poisoned = { prepare() { throw new Error("the old DB binding must not be used by the dashboard"); }, batch() { throw new Error("old DB used"); } };
  const env = await seededEnv({ DB: poisoned });

  for (const { path } of API_ROUTES) {
    const body = await getJson(path, env);
    for (const [key, value] of Object.entries(body)) {
      if (/error$/i.test(key)) assert.equal(value, null, `${path}: ${key} (a non-null error here means something read env.DB)`);
    }
  }
});

test("a failing LIVE_DB shows as that panel's inline error (200), not a 500 -- and the inputs panels are unaffected", async () => {
  const broken = { prepare() { throw new Error("LIVE_DB unavailable"); } };
  const env = await seededEnv();
  env.LIVE_DB = broken; // seeded first, then taken down

  const positions = await getJson("/api/positions", env);
  assert.match(positions.openPositionsError, /LIVE_DB unavailable/);
  assert.match(positions.closedPositionsError, /LIVE_DB unavailable/);
  assert.deepEqual(positions.openPositions, []);

  const health = await getJson("/api/health", env);
  assert.equal(health.error, null);
  assert.equal(health.health.priceBars.count, 2);
});
