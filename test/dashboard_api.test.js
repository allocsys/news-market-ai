// Covers src/dashboard/api.js's 8 JSON /api/* routes (wired into
// src/index.js -- see that file's "JSON API layer" block).
//
// Two DB fakes are used, same split-purpose convention as
// test/dashboard_refresh.test.js vs. this file's own exposure test:
//   - FakeDashboardDb: a generic empty-result D1 stub (same shape as
//     dashboard_refresh.test.js/index_login.test.js's own copy) -- good
//     enough to prove each route authenticates correctly, returns 200,
//     JSON content-type, and the right top-level shape. Its prepare()
//     supports BOTH `.prepare(sql).all()` directly (getDecisionStats'
//     totals query does this, no .bind() call) and
//     `.prepare(sql).bind(...).all()` (every other query here), by having
//     bind() return the same object all()/first()/run() live on.
//   - FakeExposureDb: a positions-aware fake, purpose-built to regression-
//     test the actual bug Step 1 fixed -- total exposure must reflect
//     EVERY open position, not just the ones a Rows-limited fetch returned.

import test from "node:test";
import { jobStateDb } from "./helpers/job_db.js";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { createSessionCookie } from "../src/auth/session.js";
import { loadConfig } from "../src/config.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { SIM_DIR } from "./helpers/engine_ctx.js";
import { insertBacktestRun, completeBacktestRun } from "../src/storage/sim_registry.js";

function sessionCookieHeader(setCookieString) {
  return setCookieString.split(";")[0];
}

class FakeDashboardDb {
  prepare() {
    return {
      bind() {
        return this;
      },
      async all() {
        return { results: [] };
      },
      async first() {
        return undefined;
      },
      async run() {},
    };
  }
}

/**
 * Positions-aware fake for the exposure regression test. `positions` is a
 * flat array of `{ positionSizePct, closedAt }` (closedAt omitted/undefined
 * means still open). Dispatches on the SQL text the same way
 * storage/d1.js's real queries are shaped -- distinguishing the unbounded
 * SUM aggregate (getOpenPositionsExposureTotal) from the LIMIT-bound row
 * fetch (getAllOpenPositions) is the whole point of this fake.
 */
class FakeExposureDb {
  constructor(positions) {
    this.positions = positions;
  }
  prepare(sql) {
    const db = this;
    const handle = {
      _args: [],
      bind(...args) {
        handle._args = args;
        return handle;
      },
      async all() {
        if (/FROM positions WHERE closed_at IS NULL ORDER BY opened_at DESC LIMIT/.test(sql)) {
          const limit = handle._args[handle._args.length - 1];
          const open = db.positions.filter((p) => p.closedAt == null);
          const rows = (limit != null ? open.slice(0, limit) : open).map((p, i) => ({
            id: `pos-${i}`,
            ticker: p.ticker ?? "AAPL",
            trade_thesis_id: `thesis-${i}`,
            position_size_pct: p.positionSizePct,
            direction: p.direction ?? "long",
            entry_price: null,
            stop_loss_pct: null,
            take_profit_pct: null,
            opened_at: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
          }));
          return { results: rows };
        }
        if (/FROM positions WHERE closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT/.test(sql)) {
          return { results: [] };
        }
        // Anything else this test doesn't care about (e.g. getDecisionStats'
        // two queries, when this fake is reused for /api/snapshot) -- empty
        // is a valid, harmless result for all of them.
        return { results: [] };
      },
      async first() {
        if (/SUM\(position_size_pct\)/.test(sql)) {
          const open = db.positions.filter((p) => p.closedAt == null);
          const totalPct = open.reduce((sum, p) => sum + p.positionSizePct, 0);
          return { total_pct: totalPct, count: open.length };
        }
        return undefined;
      },
      async run() {},
    };
    return handle;
  }
}

function baseEnv(overrides = {}) {
  return { DB: new FakeDashboardDb(), ...overrides };
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
// without pinning to exact values, which the generic FakeDashboardDb can't
// meaningfully provide anyway.
const API_ROUTES = [
  { path: "/api/snapshot", keys: ["openPositions", "closedPositions", "decisionStats", "totalExposurePct", "error"] },
  { path: "/api/activity", keys: ["decisionStats", "error"] },
  { path: "/api/charts", keys: ["priceBarsByTicker", "error"] },
  { path: "/api/health", keys: ["health", "error"] },
  { path: "/api/decisions", keys: ["decisions", "error"] },
  { path: "/api/positions", keys: ["openPositions", "openPositionsError", "closedPositions", "closedPositionsError", "totalExposurePct"] },
  { path: "/api/pipeline", keys: ["checkpoints", "error"] },
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

function twentyOpenPositionsAtTwoPercentEach() {
  return Array.from({ length: 20 }, () => ({ positionSizePct: 0.02 }));
}

test("GET /api/positions?positionsLimit=10 reports total exposure across ALL open positions, not just the 10 fetched rows", async () => {
  const env = loginConfiguredEnv({ DB: new FakeExposureDb(twentyOpenPositionsAtTwoPercentEach()) });
  const cookie = await loggedInCookie(env);
  const response = await apiFetch("/api/positions?positionsLimit=10", env, { cookie });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.openPositions.length, 10, "openPositions itself IS still Rows-limited -- only the exposure total isn't");
  assert.equal(Number(body.totalExposurePct.toFixed(1)), 40, "20 positions x 2% = 40% total, not 10 x 2% = 20%");
  assert.equal(body.openPositionsError, null);
});

test("GET /api/snapshot?positionsLimit=10 reports the same full-book total exposure as /api/positions, not the Rows-limited sum", async () => {
  const env = loginConfiguredEnv({ DB: new FakeExposureDb(twentyOpenPositionsAtTwoPercentEach()) });
  const cookie = await loggedInCookie(env);
  const response = await apiFetch("/api/snapshot?positionsLimit=10", env, { cookie });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.openPositions.length, 10);
  assert.equal(Number(body.totalExposurePct.toFixed(1)), 40);
});

test("GET /api/positions with zero open positions reports 0% total exposure, not NaN or an error", async () => {
  const env = loginConfiguredEnv({ DB: new FakeExposureDb([]) });
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
