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
// FakeDashboardDb/FakeNewsDb the way index_login.test.js/index_backfill.test.js
// used to.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/dashboard-worker.js";
import backendWorker from "../src/index.js";
import { renderShell } from "../src/dashboard/shell.js";

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
  return { BACKEND: makeBackend({ DB: new FakeDashboardDb() }), ...overrides };
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

/** Minimal fake of a Cloudflare Queue producer binding -- captures every enqueued message. Since plan.md Step 3, backend's POST /backfill never runs the backfill itself: it validates, enqueues onto JOBS and returns an immediate ack. (Since Step 6, POST /backtest/run does the same onto LLM_JOBS.) These two tests were written for the pre-Step-3 synchronous/waitUntil behavior and had been failing on main ever since -- backend's env had no JOBS binding, so the enqueue threw and the route returned 500. */
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
  const env = loginConfiguredEnv({ BACKEND: makeBackend({ DB: new FakeNewsDb(), JOBS: jobs }) });
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

test("POST /backfill accepts a form-encoded body -- checks the session, forwards to backend (which enqueues onto JOBS), and renders the accepted HTML page immediately", async () => {
  const jobs = new FakeQueue();
  const env = loginConfiguredEnv({ BACKEND: makeBackend({ DB: new FakeNewsDb(), JOBS: jobs }) });
  const cookie = await loggedInCookie(env);

  const body = new URLSearchParams({ from: "2024-01-01", to: "2024-01-31" });
  const request = new Request("https://dashboard.example/backfill", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", Cookie: cookie },
    body: body.toString(),
  });

  const response = await worker.fetch(request, env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  const html = await response.text();
  assert.match(html, /Backfill accepted/);
  assert.match(html, /2024-01-01/);
  assert.match(html, /2024-01-31/);

  // The route only enqueues (plan.md Step 3) -- the real backfill runs in
  // backend's queue() consumer, covered by test/queue_consumer.test.js.
  assert.equal(jobs.sent.length, 1);
  assert.equal(jobs.sent[0].type, "backfill");
  assert.equal(jobs.sent[0].from, "2024-01-01");
  assert.equal(jobs.sent[0].to, "2024-01-31");
});

test("POST /backtest/run succeeds on a valid session cookie -- forwarded to backend, which enqueues onto LLM_JOBS (not JOBS, plan.md Step 6)", async () => {
  const jobs = new FakeQueue();
  const llmJobs = new FakeQueue();
  const env = loginConfiguredEnv({ BACKEND: makeBackend({ DB: new FakeNewsDb(), JOBS: jobs, LLM_JOBS: llmJobs, WATCHLIST_TICKERS: "AAPL" }) });
  const cookie = await loggedInCookie(env);

  const response = await worker.fetch(
    new Request("https://dashboard.example/backtest/run?testStart=2024-01-01&testEnd=2024-01-31&tickers=AAPL", { method: "POST", headers: { Cookie: cookie } }),
    env,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.accepted, true);
  assert.match(body.id, /^backtest-/);
  assert.equal(jobs.sent.length, 0);
  assert.equal(llmJobs.sent.length, 1);
  assert.equal(llmJobs.sent[0].type, "backtest");
  assert.deepEqual(llmJobs.sent[0].tickers, ["AAPL"]);
});
