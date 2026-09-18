// Covers src/index.js's dashboard login flow -- GET/POST /login, GET
// /logout, the session-gated redirect on GET /dashboard, and the new
// "a valid session cookie authorizes POST /backfill and POST /backtest/run
// as an alternative to the shared secret" behavior added alongside it (see
// src/config.js#dashboardUsername's header for why this exists: replaces
// typing BACKFILL_API_SECRET/BACKTEST_API_SECRET into the dashboard form on
// every trigger with a one-time login).
//
// FakeDashboardDb below is a generic empty-result D1 stub (every SELECT
// this route's renderDashboardHtml call issues comes back empty) -- good
// enough to prove the route renders/redirects correctly without needing a
// full data fixture; the dashboard's own content rendering isn't this
// file's concern (see index_backfill.test.js's header for the same
// "out of scope" note about GET /dashboard).

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

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

/** Extracts the session cookie's own name=value pair from a Set-Cookie response header, dropping the trailing attributes (Path/HttpOnly/etc.) so it can be replayed as a plain request Cookie header. */
function cookieValueFrom(setCookieHeader) {
  return setCookieHeader.split(";")[0];
}

// --------------------------------------------------------------------
// GET /dashboard -- session gate
// --------------------------------------------------------------------

test("GET /dashboard renders unauthenticated when the login isn't configured (unchanged legacy behavior)", async () => {
  const env = baseEnv(); // no DASHBOARD_USERNAME/PASSWORD/JWT_SECRET
  const response = await worker.fetch(new Request("https://worker.example/dashboard"), env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
});

test("GET /dashboard redirects to /login when the login IS configured and there's no session cookie", async () => {
  const env = loginConfiguredEnv();
  const response = await worker.fetch(new Request("https://worker.example/dashboard"), env);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), "/login");
});

test("GET /dashboard renders (not a redirect) with a valid session cookie", async () => {
  const env = loginConfiguredEnv();
  const loginResponse = await worker.fetch(
    new Request("https://worker.example/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "admin", password: "correct-horse-battery-staple" }).toString(),
    }),
    env,
  );
  const cookie = cookieValueFrom(loginResponse.headers.get("Set-Cookie"));

  const dashboardResponse = await worker.fetch(
    new Request("https://worker.example/dashboard", { headers: { Cookie: cookie } }),
    env,
  );
  assert.equal(dashboardResponse.status, 200);
  const html = await dashboardResponse.text();
  assert.match(html, /logged in as admin/);
  assert.match(html, /\/logout/);
});

// --------------------------------------------------------------------
// GET/POST /login
// --------------------------------------------------------------------

test("GET /login returns 503 with the disabled notice when the login isn't configured", async () => {
  const env = baseEnv();
  const response = await worker.fetch(new Request("https://worker.example/login"), env);
  assert.equal(response.status, 503);
  const html = await response.text();
  assert.match(html, /not configured/i);
});

test("GET /login renders the form when configured and there's no session yet", async () => {
  const env = loginConfiguredEnv();
  const response = await worker.fetch(new Request("https://worker.example/login"), env);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<form method="post" action="\/login">/);
});

test("GET /login redirects straight to /dashboard when already logged in", async () => {
  const env = loginConfiguredEnv();
  const loginResponse = await worker.fetch(
    new Request("https://worker.example/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "admin", password: "correct-horse-battery-staple" }).toString(),
    }),
    env,
  );
  const cookie = cookieValueFrom(loginResponse.headers.get("Set-Cookie"));

  const response = await worker.fetch(new Request("https://worker.example/login", { headers: { Cookie: cookie } }), env);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), "/dashboard");
});

test("POST /login with correct credentials redirects to /dashboard and sets a session cookie", async () => {
  const env = loginConfiguredEnv();
  const response = await worker.fetch(
    new Request("https://worker.example/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "admin", password: "correct-horse-battery-staple" }).toString(),
    }),
    env,
  );
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), "/dashboard");
  const setCookie = response.headers.get("Set-Cookie");
  assert.match(setCookie, /^nmai_session=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
});

test("POST /login with a wrong password returns 401 and re-renders the form with an error, no cookie set", async () => {
  const env = loginConfiguredEnv();
  const response = await worker.fetch(
    new Request("https://worker.example/login", {
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
    new Request("https://worker.example/login", {
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
  const response = await worker.fetch(new Request("https://worker.example/logout"), env);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), "/login");
  const setCookie = response.headers.get("Set-Cookie");
  assert.match(setCookie, /^nmai_session=;/);
  assert.match(setCookie, /Max-Age=0/);
});

// --------------------------------------------------------------------
// Session cookie as an alternative to the shared secret on
// POST /backfill and POST /backtest/run
// --------------------------------------------------------------------

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

async function loggedInCookie(env) {
  const response = await worker.fetch(
    new Request("https://worker.example/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "admin", password: "correct-horse-battery-staple" }).toString(),
    }),
    env,
  );
  return cookieValueFrom(response.headers.get("Set-Cookie"));
}

test("POST /backfill succeeds on a valid session cookie alone, even with BACKFILL_API_SECRET unset", async (t) => {
  const env = loginConfiguredEnv({ DB: new FakeNewsDb(), WATCHLIST_TICKERS: "AAPL", FINNHUB_API_KEY: "test-key" });
  t.mock.method(global, "fetch", async () => ({
    ok: true,
    status: 200,
    json: async () => [{ url: "https://finnhub.example.com/story", datetime: 1757941800, headline: "Story about Acme", summary: "A brief summary." }],
  }));
  const cookie = await loggedInCookie(env);

  const response = await worker.fetch(
    new Request("https://worker.example/backfill?from=2024-01-01&to=2024-01-31", { method: "POST", headers: { Cookie: cookie } }),
    env,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.inserted, 1);
});

test("POST /backfill returns 401 (reachable, just unauthorized) with no session and no secret when the login IS configured -- 503 is reserved for when NEITHER auth path is set up at all", async () => {
  const env = loginConfiguredEnv({ DB: new FakeNewsDb() }); // no BACKFILL_API_SECRET, no session cookie sent
  const response = await worker.fetch(new Request("https://worker.example/backfill?from=2024-01-01&to=2024-01-31", { method: "POST" }), env);
  assert.equal(response.status, 401);
});

test("POST /backfill returns 503 when NEITHER the secret NOR the dashboard login is configured", async () => {
  const env = baseEnv({ DB: new FakeNewsDb() }); // no BACKFILL_API_SECRET, no DASHBOARD_*/JWT_SECRET at all
  const response = await worker.fetch(new Request("https://worker.example/backfill?from=2024-01-01&to=2024-01-31", { method: "POST" }), env);
  assert.equal(response.status, 503);
});

test("POST /backtest/run returns 401 with a stale/forged cookie (bad signature) and no secret -- a cookie alone isn't a free pass", async () => {
  const env = loginConfiguredEnv({ DB: new FakeNewsDb() });
  const response = await worker.fetch(
    new Request("https://worker.example/backtest/run?testStart=2024-01-01&testEnd=2024-01-31", {
      method: "POST",
      headers: { Cookie: "nmai_session=not.a.valid.jwt" },
    }),
    env,
  );
  assert.equal(response.status, 401);
});
