// Covers src/dashboard-worker.js (plan.md "Step 2 -- Dashboard Worker"):
// GET/POST /login, GET /logout, the session-gated redirect on GET
// /dashboard/*, the Refresh-link/Loaded-time toolbar per section, and the
// session-cookie authorization + forward-to-backend flow on POST /backfill
// and POST /backtest/run. Replaces the former test/index_login.test.js +
// test/dashboard_refresh.test.js, which covered the same behavior back
// when it lived directly in src/index.js.
//
// FakeBackend wraps the REAL backend Worker (src/index.js) with a fake env,
// rather than hand-building JSON fixtures -- this exercises the actual
// /api/* and /backfill//backtest/run contracts dashboard-worker.js depends
// on, not a guessed shape of them, at the cost of this file also owning a
// FakeNewsDb (and real empty sqlite DBs for the panels) the way index_login.test.js/index_backfill.test.js
// used to.

import test from "node:test";
import { jobStateDb } from "./helpers/job_db.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { STATE_DIR, INPUTS_DIR, SIM_DIR } from "./helpers/engine_ctx.js";
import assert from "node:assert/strict";
import worker from "../src/dashboard-worker.js";
import backendWorker from "../src/index.js";
import { renderShell } from "../src/dashboard/shell.js";
import { insertBacktestRun, completeBacktestRun } from "../src/storage/sim_registry.js";
import { RunStore } from "../src/storage/run_store.js";
import { ENV_SECTIONS } from "../src/dashboard/helpers.js";

class FakeNewsDb {
  constructor() {
    this.newsItems = [];
  }
  prepare(sql) {
    const db = this;
    return {
      bind(...args) {
        return {
          async run() {
            if (/INSERT INTO news_items/.test(sql)) db.newsItems.push({ id: args[0] });
          },
        };
      },
    };
  }
}

/** Wraps the real backend Worker as a Cloudflare-service-binding-shaped
 * object ({ fetch(url, init) }), the same interface env.BACKEND exposes in
 * production. `backendCtx.waitUntil` promises are collected so a test can
 * await them (same pattern index_backfill.test.js used directly). */
function makeBackend(backendEnv, backendCtx = { promises: [], waitUntil(p) { this.promises.push(p); } }) {
  return { fetch: (input, init) => backendWorker.fetch(new Request(input, init), backendEnv, backendCtx), _ctx: backendCtx };
}

function baseEnv(overrides = {}) {
  return { BACKEND: makeBackend({ LIVE_DB: createTestD1([STATE_DIR]), INPUTS_DB: createTestD1([INPUTS_DIR]), SIM_DB: createTestD1([STATE_DIR, SIM_DIR]) }), ...overrides };
}

function loginConfiguredEnv(overrides = {}) {
  return baseEnv({
    DASHBOARD_USERNAME: "admin",
    DASHBOARD_PASSWORD: "correct-horse-battery-staple",
    JWT_SECRET: "test-jwt-signing-key",
    ...overrides,
  });
}

/** Extracts the session cookie's own name=value pair from a Set-Cookie response header, dropping the trailing attributes (Path/HttpOnly/etc.) so it can be replayed as a plain request Cookie header. */
function cookieValueFrom(setCookieHeader) {
  return setCookieHeader.split(";")[0];
}

async function loggedInCookie(env) {
  const response = await worker.fetch(
    new Request("https://dashboard.example/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "admin", password: "correct-horse-battery-staple" }).toString(),
    }),
    env,
  );
  return cookieValueFrom(response.headers.get("Set-Cookie"));
}

// --------------------------------------------------------------------
// GET /dashboard -- session gate
// --------------------------------------------------------------------

test("GET /dashboard always redirects to /dashboard/snapshot", async () => {
  const env = loginConfiguredEnv();
  const response = await worker.fetch(new Request("https://dashboard.example/dashboard"), env);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), "/dashboard/snapshot");
});

test("GET /dashboard/snapshot returns 503 (disabled) when the login isn't configured -- Step 2 fails closed, unlike backend's old unauthenticated fallback", async () => {
  const env = baseEnv(); // no DASHBOARD_USERNAME/PASSWORD/JWT_SECRET
  const response = await worker.fetch(new Request("https://dashboard.example/dashboard/snapshot"), env);
  assert.equal(response.status, 503);
  const html = await response.text();
  assert.match(html, /not configured/i);
});

test("GET /dashboard/snapshot redirects to /login when the login IS configured and there's no session cookie", async () => {
  const env = loginConfiguredEnv();
  const response = await worker.fetch(new Request("https://dashboard.example/dashboard/snapshot"), env);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), "/login");
});

test("GET /dashboard/snapshot renders (not a redirect) with a valid session cookie", async () => {
  const env = loginConfiguredEnv();
  const cookie = await loggedInCookie(env);
  const response = await worker.fetch(new Request("https://dashboard.example/dashboard/snapshot", { headers: { Cookie: cookie } }), env);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /logged in as admin/);
  assert.match(html, /\/logout/);
});

// --------------------------------------------------------------------
// GET/POST /login
// --------------------------------------------------------------------

test("GET /login returns 503 with the disabled notice when the login isn't configured", async () => {
  const env = baseEnv();
  const response = await worker.fetch(new Request("https://dashboard.example/login"), env);
  assert.equal(response.status, 503);
  const html = await response.text();
  assert.match(html, /not configured/i);
});

test("GET /login renders the form when configured and there's no session yet", async () => {
  const env = loginConfiguredEnv();
  const response = await worker.fetch(new Request("https://dashboard.example/login"), env);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<form method="post" action="\/login">/);
});

test("GET /login redirects straight to /dashboard/snapshot when already logged in", async () => {
  const env = loginConfiguredEnv();
  const cookie = await loggedInCookie(env);
  const response = await worker.fetch(new Request("https://dashboard.example/login", { headers: { Cookie: cookie } }), env);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), "/dashboard/snapshot");
});

test("POST /login with correct credentials redirects to /dashboard/snapshot and sets a session cookie", async () => {
  const env = loginConfiguredEnv();
  const response = await worker.fetch(
    new Request("https://dashboard.example/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "admin", password: "correct-horse-battery-staple" }).toString(),
    }),
    env,
  );
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), "/dashboard/snapshot");
  const setCookie = response.headers.get("Set-Cookie");
  assert.match(setCookie, /^nmai_session=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
});

test("POST /login with a wrong password returns 401 and re-renders the form with an error, no cookie set", async () => {
  const env = loginConfiguredEnv();
  const response = await worker.fetch(
    new Request("https://dashboard.example/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "admin", password: "wrong-password" }).toString(),
    }),
    env,
  );
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("Set-Cookie"), null);
  const html = await response.text();
  assert.match(html, /Invalid username or password/);
});

test("POST /login returns 503 (disabled) rather than checking credentials at all when the login isn't configured", async () => {
  const env = baseEnv();
  const response = await worker.fetch(
    new Request("https://dashboard.example/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "admin", password: "anything" }).toString(),
    }),
    env,
  );
  assert.equal(response.status, 503);
});

// --------------------------------------------------------------------
// GET /logout
// --------------------------------------------------------------------

test("GET /logout clears the session cookie and redirects to /login", async () => {
  const env = loginConfiguredEnv();
  const response = await worker.fetch(new Request("https://dashboard.example/logout"), env);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), "/login");
  const setCookie = response.headers.get("Set-Cookie");
  assert.match(setCookie, /^nmai_session=;/);
  assert.match(setCookie, /Max-Age=0/);
});

// --------------------------------------------------------------------
// Refresh link + Loaded-time toolbar (per section) -- ported from the
// former test/dashboard_refresh.test.js.
// --------------------------------------------------------------------

async function getHtml(pathAndQuery) {
  const env = loginConfiguredEnv();
  const cookie = await loggedInCookie(env);
  const response = await worker.fetch(new Request(`https://dashboard.example${pathAndQuery}`, { headers: { Cookie: cookie } }), env);
  assert.equal(response.status, 200, `${pathAndQuery} should render`);
  return response.text();
}

function refreshHrefIn(html) {
  const match = html.match(/<a href="([^"]*)" class="btn btn-secondary" title="[^"]*"><span aria-hidden="true">[^<]*<\/span> Refresh<\/a>/);
  return match ? match[1] : null;
}

const REFRESHABLE_SECTIONS = ["snapshot", "activity", "charts", "health", "decisions", "positions", "pipeline", "backtest"];

for (const section of REFRESHABLE_SECTIONS) {
  test(`GET /dashboard/${section} renders a Refresh link back to itself, plus a Loaded time`, async () => {
    const html = await getHtml(`/dashboard/${section}`);
    assert.equal(refreshHrefIn(html), `/dashboard/${section}`);
    assert.match(html, /<span class="page-toolbar-updated">Loaded \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC<\/span>/);
  });
}

const NON_REFRESHABLE_PAGES = [
  "/dashboard/backfill",
  "/dashboard/more",
  "/dashboard/backfill/confirm?from=2024-01-01&to=2024-01-31",
  "/dashboard/backtest/confirm?testStart=2024-01-01&testEnd=2024-01-31&tickers=AAPL&graceDays=5",
];

for (const path of NON_REFRESHABLE_PAGES) {
  test(`GET ${path} has no Refresh link -- nothing on it goes stale`, async () => {
    const html = await getHtml(path);
    assert.equal(refreshHrefIn(html), null);
    assert.doesNotMatch(html, /page-toolbar"/);
  });
}

test("Refresh link keeps the page's active filters (query string), HTML-escaped", async () => {
  const html = await getHtml("/dashboard/decisions?decisionStatus=approved&decisionLimit=50");
  assert.equal(refreshHrefIn(html), "/dashboard/decisions?decisionStatus=approved&amp;decisionLimit=50");
});

test("renderShell without refreshHref renders no toolbar (e.g. the POST run-accepted status page)", () => {
  const html = renderShell({ activeSection: "backfill", sessionUsername: null, bodyHtml: "<p>body</p>" });
  assert.equal(refreshHrefIn(html), null);
  assert.doesNotMatch(html, /page-toolbar"/);
  assert.match(html, /<p>body<\/p>/);
});

// --------------------------------------------------------------------
// POST /backfill and POST /backtest/run -- session auth here, then
// forwarded to backend over the BACKEND service binding.
// --------------------------------------------------------------------

test("POST /backfill returns 503 when dashboard login is not configured", async () => {
  const env = baseEnv({ BACKEND: makeBackend({ DB: new FakeNewsDb() }) });
  const response = await worker.fetch(new Request("https://dashboard.example/backfill?from=2024-01-01&to=2024-01-31", { method: "POST" }), env);
  assert.equal(response.status, 503);
});

test("POST /backfill returns 401 when there is no session and login IS configured", async () => {
  const env = loginConfiguredEnv({ BACKEND: makeBackend({ DB: new FakeNewsDb() }) });
  const response = await worker.fetch(new Request("https://dashboard.example/backfill?from=2024-01-01&to=2024-01-31", { method: "POST" }), env);
  assert.equal(response.status, 401);
});

test("POST /backtest/run returns 401 with a stale/forged cookie (bad signature) -- a cookie alone isn't a free pass", async () => {
  const env = loginConfiguredEnv({ BACKEND: makeBackend({ DB: new FakeNewsDb() }) });
  const response = await worker.fetch(
    new Request("https://dashboard.example/backtest/run?testStart=2024-01-01&testEnd=2024-01-31", {
      method: "POST",
      headers: { Cookie: "nmai_session=not.a.valid.jwt" },
    }),
    env,
  );
  assert.equal(response.status, 401);
});

/** Minimal fake of a Cloudflare Queue producer binding -- captures every enqueued message. Since plan.md Step 3, backend's POST /backfill never runs the backfill itself: it validates, enqueues onto BACKFILL (renamed from JOBS in a Step 5 follow-up, 2026-09-20, when its consumer moved from `backend` to `ingest`) and returns an immediate ack. POST /backtest/run followed the same shape onto LLM_JOBS (Step 6), was disabled with a 503 during M2 pending the backtest Worker, and (M3) is re-enabled onto its own new BACKTEST queue -- see the test below. These tests were originally written for the pre-Step-3 synchronous/waitUntil behavior and had been failing on main ever since -- backend's env had no JOBS binding, so the enqueue threw and the route returned 500. */
class FakeQueue {
  constructor() {
    this.sent = [];
  }
  async send(body) {
    this.sent.push(body);
  }
}

test("POST /backfill succeeds on a valid session cookie (scripted/non-form caller gets backend's enqueue ack forwarded verbatim)", async () => {
  const jobs = new FakeQueue();
  const env = loginConfiguredEnv({ BACKEND: makeBackend({ DB: new FakeNewsDb(), BACKFILL: jobs }) });
  const cookie = await loggedInCookie(env);

  const response = await worker.fetch(
    new Request("https://dashboard.example/backfill?from=2024-01-01&to=2024-01-31", { method: "POST", headers: { Cookie: cookie } }),
    env,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.accepted, true);
  assert.equal(body.from, "2024-01-01");
  assert.equal(body.to, "2024-01-31");
  assert.match(body.id, /^backfill-/);
  assert.equal(jobs.sent.length, 1);
  assert.deepEqual(jobs.sent[0], { type: "backfill", id: body.id, from: "2024-01-01", to: "2024-01-31" });
});

test("POST /backfill accepts a form-encoded body -- checks the session, forwards to backend (which enqueues onto BACKFILL), and 303-redirects to /dashboard/backfill (Post/Redirect/Get -- part 1 of the dashboard backfill-completion UX fix) instead of rendering the accepted HTML directly", async () => {
  const jobs = new FakeQueue();
  // A real (empty) LIVE_DB, not just DB+BACKFILL: backend's POST /backfill
  // writes the 'queued' job_progress row via RunStore(env.LIVE_DB, "live")
  // (best-effort -- see createJobReporter), and the follow-through check
  // below needs that row to actually exist for GET /api/jobs/active to find.
  const env = loginConfiguredEnv({ BACKEND: makeBackend({ DB: new FakeNewsDb(), LIVE_DB: createTestD1([STATE_DIR]), BACKFILL: jobs }) });
  const cookie = await loggedInCookie(env);

  const body = new URLSearchParams({ from: "2024-01-01", to: "2024-01-31" });
  const request = new Request("https://dashboard.example/backfill", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", Cookie: cookie },
    body: body.toString(),
  });

  const response = await worker.fetch(request, env);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("Location"), "/dashboard/backfill");
  assert.equal(await response.text(), "", "a 303 has no body to accidentally re-show/re-submit");

  // The route only enqueues (plan.md Step 3) -- the real backfill now runs
  // in the `ingest` Worker's queue() consumer (Step 5 follow-up,
  // 2026-09-20), covered by test/ingest_worker.test.js.
  assert.equal(jobs.sent.length, 1);
  assert.equal(jobs.sent[0].type, "backfill");
  assert.equal(jobs.sent[0].from, "2024-01-01");
  assert.equal(jobs.sent[0].to, "2024-01-31");

  // Following the redirect (a plain GET, as any browser/user agent does on a
  // 303) lands on /dashboard/backfill and shows the just-queued job via the
  // ordinary active-job panel wiring -- confirming the redirect target
  // actually closes the "had to refresh or go back to Backfill" gap, not
  // just that a redirect happens. Uses backend's real GET /api/jobs/active,
  // same as the "prepends the active-job panel" tests below.
  const followed = await worker.fetch(new Request(`https://dashboard.example${response.headers.get("Location")}`, { headers: { Cookie: cookie } }), env);
  assert.equal(followed.status, 200);
  const followedHtml = await followed.text();
  assert.match(followedHtml, /id="active-job"/);
  assert.match(followedHtml, /2024-01-01/);
  assert.match(followedHtml, /2024-01-31/);
});

test("POST /backtest/run with a valid session cookie is forwarded to backend, which (M3) enqueues onto BACKTEST and returns an accepted ack", async () => {
  const { createTestD1 } = await import("./helpers/sqlite_d1.js");
  const { STATE_DIR, SIM_DIR } = await import("./helpers/engine_ctx.js");
  const backtestQueue = new FakeQueue();
  const env = loginConfiguredEnv({
    BACKEND: makeBackend({ DB: new FakeNewsDb(), SIM_DB: createTestD1([STATE_DIR, SIM_DIR]), BACKTEST: backtestQueue, WATCHLIST_TICKERS: "AAPL" }),
  });
  const cookie = await loggedInCookie(env);

  const response = await worker.fetch(
    new Request("https://dashboard.example/backtest/run?testStart=2024-01-01&testEnd=2024-01-31&tickers=AAPL", { method: "POST", headers: { Cookie: cookie } }),
    env,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.accepted, true);
  assert.equal(backtestQueue.sent.length, 1);
  assert.equal(backtestQueue.sent[0].type, "backtest");
  assert.deepEqual(backtestQueue.sent[0].tickers, ["AAPL"]);
});

// --------------------------------------------------------------------
// Active-job panel wiring: GET /dashboard/backfill and GET /dashboard/backtest
// prepend a live progress panel (src/dashboard/views/status.js's
// renderActiveJobPanel) when backend's GET /api/jobs/active reports a job
// already in flight -- see dashboard-worker.js's activeJobPanelFor. Uses the
// real backend Worker (via makeBackend), so this exercises the actual
// /api/jobs/active contract, not a guessed shape of it.
// --------------------------------------------------------------------

const RUNNING_BACKFILL = {
  id: "backfill-1789783849291-cx0mfj",
  type: "backfill",
  phase: "saving",
  percent: 60,
  done: 200,
  total: 733,
  detail: "Saved 200/733 articles",
  params: { from: "2024-01-01", to: "2024-01-31" },
};

test("GET /dashboard/backfill shows no active-job panel when nothing is in flight", async () => {
  const env = loginConfiguredEnv({ BACKEND: makeBackend({ LIVE_DB: (await jobStateDb()).db }) });
  const cookie = await loggedInCookie(env);
  const html = await (await worker.fetch(new Request("https://dashboard.example/dashboard/backfill", { headers: { Cookie: cookie } }), env)).text();
  assert.doesNotMatch(html, /id="active-job"/);
});

test("GET /dashboard/backfill prepends the active-job panel ahead of the form when backend reports a running backfill", async () => {
  const env = loginConfiguredEnv({ BACKEND: makeBackend({ LIVE_DB: (await jobStateDb([RUNNING_BACKFILL])).db }) });
  const cookie = await loggedInCookie(env);
  const html = await (await worker.fetch(new Request("https://dashboard.example/dashboard/backfill", { headers: { Cookie: cookie } }), env)).text();

  assert.match(html, /id="active-job" data-job-id="backfill-1789783849291-cx0mfj"/);
  assert.match(html, /Backfill in progress/);
  // Panel comes BEFORE the ordinary backfill form/view in the body (activeJobPanelFor's
  // result is prepended: `activePanel + renderBackfillView()` in dashboard-worker.js).
  assert.match(html, /id="active-job"[\s\S]*<form/);
});

test("GET /dashboard/backfill renders normally (no active-job panel, no crash) when the backend lookup itself fails -- best-effort, per activeJobPanelFor's own contract", async () => {
  const brokenBackend = { fetch: async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 }) };
  const env = loginConfiguredEnv({ BACKEND: brokenBackend });
  const cookie = await loggedInCookie(env);
  const response = await worker.fetch(new Request("https://dashboard.example/dashboard/backfill", { headers: { Cookie: cookie } }), env);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.doesNotMatch(html, /id="active-job"/);
});

test("GET /dashboard/backtest shows no active-job panel when nothing is in flight", async () => {
  const env = loginConfiguredEnv({ BACKEND: makeBackend({ LIVE_DB: (await jobStateDb()).db }) });
  const cookie = await loggedInCookie(env);
  const html = await (await worker.fetch(new Request("https://dashboard.example/dashboard/backtest", { headers: { Cookie: cookie } }), env)).text();
  assert.doesNotMatch(html, /id="active-job"/);
});

test("GET /dashboard/backtest prepends the active-job panel when backend reports a running backtest", async () => {
  const runningBacktest = { ...RUNNING_BACKFILL, id: "backtest-1-abc", type: "backtest", params: { tickers: ["AAPL"] } };
  const env = loginConfiguredEnv({ BACKEND: makeBackend({ LIVE_DB: (await jobStateDb([runningBacktest])).db }) });
  const cookie = await loggedInCookie(env);
  const html = await (await worker.fetch(new Request("https://dashboard.example/dashboard/backtest", { headers: { Cookie: cookie } }), env)).text();

  assert.match(html, /id="active-job" data-job-id="backtest-1-abc"/);
  assert.match(html, /Backtest in progress/);
});

test("GET /dashboard/snapshot never shows an active-job panel -- only backfill/backtest pages look one up", async () => {
  const env = loginConfiguredEnv({ BACKEND: makeBackend({ LIVE_DB: (await jobStateDb([RUNNING_BACKFILL])).db }) });
  const cookie = await loggedInCookie(env);
  const html = await (await worker.fetch(new Request("https://dashboard.example/dashboard/snapshot", { headers: { Cookie: cookie } }), env)).text();
  assert.doesNotMatch(html, /id="active-job"/);
});

// --------------------------------------------------------------------
// "Last run" panel wiring (dashboard backfill-completion UX, part 3): GET
// /dashboard/backfill also prepends how the most recently FINISHED backfill
// job ended (backend's GET /api/jobs/latest?type=backfill via
// dashboard-worker.js's lastFinishedBackfillJob, rendered by
// backfill.js#renderLastRunPanel), so the page shows something once the
// active-job panel above has aged out or the operator just navigates back.
// --------------------------------------------------------------------

async function liveDbWithFinishedBackfill(overrides = {}) {
  const db = (await jobStateDb()).db;
  const store = new RunStore(db, "live");
  await store.insertQueuedJob({ id: "backfill-done-1", type: "backfill", params: { from: "2024-01-01", to: "2024-01-31" }, now: "2026-01-01T00:00:00.000Z" });
  await store.markJobRunning({ id: "backfill-done-1", type: "backfill", now: "2026-01-01T00:00:01.000Z" });
  if (overrides.status === "failed") {
    await store.failJob({ id: "backfill-done-1", error: overrides.error ?? "boom", detail: overrides.detail ?? null, now: "2026-01-01T00:05:00.000Z" });
  } else {
    await store.completeJob({ id: "backfill-done-1", result: overrides.result ?? { inserted: 146, errorCount: 0, parts: 1 }, detail: overrides.detail ?? "Inserted 146 articles", now: "2026-01-01T00:05:00.000Z" });
  }
  return db;
}

test("GET /dashboard/backfill shows no Last-run panel when nothing has ever finished", async () => {
  const env = loginConfiguredEnv({ BACKEND: makeBackend({ LIVE_DB: (await jobStateDb()).db }) });
  const cookie = await loggedInCookie(env);
  const html = await (await worker.fetch(new Request("https://dashboard.example/dashboard/backfill", { headers: { Cookie: cookie } }), env)).text();
  assert.doesNotMatch(html, /Last run/);
});

test("GET /dashboard/backfill shows the Last-run panel for a completed job, with its detail and range", async () => {
  const env = loginConfiguredEnv({ BACKEND: makeBackend({ LIVE_DB: await liveDbWithFinishedBackfill() }) });
  const cookie = await loggedInCookie(env);
  const html = await (await worker.fetch(new Request("https://dashboard.example/dashboard/backfill", { headers: { Cookie: cookie } }), env)).text();
  assert.match(html, /Last run/);
  assert.match(html, /Complete/);
  assert.match(html, /2024-01-01 to 2024-01-31/);
  assert.match(html, /Inserted 146 articles/);
});

test("GET /dashboard/backfill shows the Last-run panel for a failed job, with its error", async () => {
  const env = loginConfiguredEnv({
    BACKEND: makeBackend({ LIVE_DB: await liveDbWithFinishedBackfill({ status: "failed", error: "Too many API requests by single Worker invocation", detail: "Saved 325/733 articles" }) }),
  });
  const cookie = await loggedInCookie(env);
  const html = await (await worker.fetch(new Request("https://dashboard.example/dashboard/backfill", { headers: { Cookie: cookie } }), env)).text();
  assert.match(html, /Last run/);
  assert.match(html, /Failed/);
  assert.match(html, /Saved 325\/733 articles/);
  assert.match(html, /Too many API requests by single Worker invocation/);
});

test("GET /dashboard/backfill renders normally (no Last-run panel, no crash) when the /api/jobs/latest lookup itself fails -- best-effort", async () => {
  const brokenBackend = { fetch: async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 }) };
  const env = loginConfiguredEnv({ BACKEND: brokenBackend });
  const cookie = await loggedInCookie(env);
  const response = await worker.fetch(new Request("https://dashboard.example/dashboard/backfill", { headers: { Cookie: cookie } }), env);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.doesNotMatch(html, /Last run/);
});

// --------------------------------------------------------------------
// M4b environment selector -- the bar itself (rendering, healing, and
// best-effort fallback) on renderSection pages. Backend plumbing is
// already covered by test/dashboard_env.test.js; the view-only pieces
// (pill rendering, escaping) by test/dashboard_env_selector.test.js. This
// block covers the actual wiring: does the bar show up on the right pages,
// does it reflect what backend resolved (not just the raw query param),
// do links heal after a bad ?env=, and does the rest of the page survive
// when the (best-effort) run-list lookup itself fails.
// --------------------------------------------------------------------

const BT = "backtest-1789000000000-abc123";

async function registerCompleteRun(simDb, id) {
  await insertBacktestRun(simDb, {
    id, tickers: ["AAPL"], testStart: "2024-01-01T00:00:00.000Z", testEnd: "2024-02-01T00:00:00.000Z",
    trainDays: 0, testDays: 30, startedAt: "2026-03-12T00:00:00.000Z",
  });
  await completeBacktestRun(simDb, { id, result: { overall: {} }, finishedAt: "2026-03-12T01:00:00.000Z" });
}

// Same shape as baseEnv()/loginConfiguredEnv() above, but keeps a handle on
// the backend's own env object so a test can register a backtest run
// against its SIM_DB before issuing requests through the dashboard Worker.
function envAwareEnv() {
  const backendEnv = { LIVE_DB: createTestD1([STATE_DIR]), INPUTS_DB: createTestD1([INPUTS_DIR]), SIM_DB: createTestD1([STATE_DIR, SIM_DIR]) };
  const env = loginConfiguredEnv({ BACKEND: makeBackend(backendEnv) });
  return { env, backendEnv };
}

for (const section of ENV_SECTIONS) {
  test(`GET /dashboard/${section} shows the environment selector bar`, async () => {
    const html = await getHtml(`/dashboard/${section}`);
    assert.match(html, /id="env-selector"/);
  });
}

for (const section of ["charts", "health"]) {
  test(`GET /dashboard/${section} does NOT show the environment selector -- env-unaware section`, async () => {
    const html = await getHtml(`/dashboard/${section}`);
    assert.doesNotMatch(html, /id="env-selector"/);
  });
}

test("the environment selector highlights a registered backtest run when ?env= selects it, and env-aware nav links carry it forward while env-unaware ones don't", async () => {
  const { env, backendEnv } = envAwareEnv();
  await registerCompleteRun(backendEnv.SIM_DB, BT);
  const cookie = await loggedInCookie(env);
  const html = await (await worker.fetch(new Request(`https://dashboard.example/dashboard/snapshot?env=${BT}`, { headers: { Cookie: cookie } }), env)).text();

  assert.match(html, /class="pill pill-active"[^>]*>AAPL/, "the run's own pill is active, not Live");
  assert.ok(html.includes(`href="/dashboard/decisions?env=${BT}"`), "nav link to another env-aware section carries the chosen env");
  assert.ok(html.includes('href="/dashboard/charts"') && !html.includes(`href="/dashboard/charts?env=${BT}"`), "nav link to an env-unaware section does NOT carry env");
});

test("a well-formed but unregistered ?env= heals to live: the Live pill is active and an envError note explains why", async () => {
  const env = loginConfiguredEnv();
  const cookie = await loggedInCookie(env);
  const html = await (await worker.fetch(new Request(`https://dashboard.example/dashboard/decisions?env=${BT}`, { headers: { Cookie: cookie } }), env)).text();
  assert.match(html, /class="pill pill-active"[^>]*>Live<\/a>/);
  assert.match(html, /not found/);
});

test("filter links on decisions carry the resolved env (?env=) so switching a filter never silently drops back to live", async () => {
  const { env, backendEnv } = envAwareEnv();
  await registerCompleteRun(backendEnv.SIM_DB, BT);
  const cookie = await loggedInCookie(env);
  const html = await (await worker.fetch(new Request(`https://dashboard.example/dashboard/decisions?env=${BT}`, { headers: { Cookie: cookie } }), env)).text();

  const approvedHrefMatch = html.match(/href="([^"]*decisionStatus=approved[^"]*)"/);
  assert.ok(approvedHrefMatch, "found the Approved status pill link");
  assert.match(approvedHrefMatch[1], new RegExp(`env=${BT}`), "the filter link carries env forward");
});

test("GET /dashboard/snapshot renders fine (Live-only selector, no crash) when the best-effort /api/backtest-runs lookup itself fails", async () => {
  const realBackend = makeBackend({ LIVE_DB: createTestD1([STATE_DIR]), INPUTS_DB: createTestD1([INPUTS_DIR]), SIM_DB: createTestD1([STATE_DIR, SIM_DIR]) });
  const flakyBackend = {
    fetch: (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("/api/backtest-runs")) return Promise.resolve(new Response(JSON.stringify({ error: "boom" }), { status: 500 }));
      return realBackend.fetch(input, init);
    },
  };
  const env = loginConfiguredEnv({ BACKEND: flakyBackend });
  const cookie = await loggedInCookie(env);
  const response = await worker.fetch(new Request("https://dashboard.example/dashboard/snapshot", { headers: { Cookie: cookie } }), env);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /id="env-selector"/);
  assert.match(html, /class="pill pill-active"[^>]*>Live<\/a>/);
});
