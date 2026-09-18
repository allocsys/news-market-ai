// Covers src/index.js's POST /backfill route -- the operational entry
// point wired onto graph/pipeline.js#backfillHistoricalNews.
//
// Auth/validation branches are tested against a minimal fake env (no real
// D1/KV) since they return before ever touching backfillHistoricalNews.
// The success/failure-passthrough branches use a FakeDb shaped like
// storage/d1.js#insertNewsItem expects (same convention as
// test/ingestion_wiring.test.js's FakeNewsDb) plus a mocked global.fetch
// for Finnhub, since backfillHistoricalNews itself is exercised elsewhere
// (test/ingestion_wiring.test.js) and doesn't need re-testing here -- this
// file's job is just "does the route wire it correctly."

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { createSessionCookie } from "../src/auth/session.js";
import { loadConfig } from "../src/config.js";

/**
 * createSessionCookie returns the FULL Set-Cookie header string ("nmai_session=<token>;
 * Path=/; HttpOnly; ..."), not just the token -- this pulls out just the
 * "nmai_session=<token>" pair so it can be sent as-is in a request's Cookie
 * header. Passing the raw createSessionCookie() return straight into a
 * `Cookie: nmai_session=${cookie}` template (as an earlier version of this
 * file did) double-prefixes the cookie name and produces a Cookie value
 * getSessionUsername can never verify -- every session-authenticated test
 * below depends on going through this helper instead.
 */
function sessionCookieHeader(setCookieString) {
  return setCookieString.split(";")[0];
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
            if (/INSERT INTO news_items/.test(sql)) {
              db.newsItems.push({ id: args[0] });
            }
          },
        };
      },
    };
  }
}

function mockFinnhubJson() {
  return [{ url: "https://finnhub.example.com/story", datetime: 1757941800, headline: "Story about Acme", summary: "A brief summary." }];
}

function baseEnv(overrides = {}) {
  return {
    DB: new FakeNewsDb(),
    WATCHLIST_TICKERS: "AAPL",
    FINNHUB_API_KEY: "test-key",
    FINNHUB_API_BASE: "https://fake.test/finnhub",
    ...overrides,
  };
}

test("POST /backfill returns 503 when dashboard login isn't configured", async () => {
  const env = baseEnv(); // no DASHBOARD_USERNAME/PASSWORD/JWT_SECRET
  const request = new Request("https://worker.example/backfill?from=2024-01-01&to=2024-01-31", { method: "POST" });

  const response = await worker.fetch(request, env);
  assert.equal(response.status, 503);
});

test("POST /backfill returns 401 when there's no session cookie, or an invalid/forged one", async () => {
  const env = baseEnv({ DASHBOARD_USERNAME: "admin", DASHBOARD_PASSWORD: "pw", JWT_SECRET: "secret" });
  
  const noCookie = await worker.fetch(
    new Request("https://worker.example/backfill?from=2024-01-01&to=2024-01-31", { method: "POST" }),
    env
  );
  assert.equal(noCookie.status, 401);

  const invalidCookie = await worker.fetch(
    new Request("https://worker.example/backfill?from=2024-01-01&to=2024-01-31", {
      method: "POST",
      headers: { Cookie: "nmai_session=forged-cookie" }
    }),
    env
  );
  assert.equal(invalidCookie.status, 401);
});

test("POST /backfill returns 400 for a missing or malformed from/to", async (t) => {
  const env = baseEnv({ DASHBOARD_USERNAME: "admin", DASHBOARD_PASSWORD: "pw", JWT_SECRET: "secret" });
  const config = loadConfig(env);
  const cookie = sessionCookieHeader(await createSessionCookie("admin", config));

  const missing = await worker.fetch(
    new Request("https://worker.example/backfill?from=2024-01-01", { 
        method: "POST", 
        headers: { Cookie: cookie } 
    }),
    env,
  );
  assert.equal(missing.status, 400);

  const malformed = await worker.fetch(
    new Request("https://worker.example/backfill?from=not-a-date&to=2024-01-31", { 
        method: "POST", 
        headers: { Cookie: cookie } 
    }),
    env,
  );
  assert.equal(malformed.status, 400);
});

test("POST /backfill with a valid session cookie and valid range calls backfillHistoricalNews and reports counts", async (t) => {
  const env = baseEnv({ DASHBOARD_USERNAME: "admin", DASHBOARD_PASSWORD: "pw", JWT_SECRET: "secret" });
  const config = loadConfig(env);
  const cookie = sessionCookieHeader(await createSessionCookie("admin", config));
  
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, json: async () => mockFinnhubJson() }));

  const request = new Request("https://worker.example/backfill?from=2024-01-01&to=2024-01-31", {
    method: "POST",
    headers: { Cookie: cookie },
  });

  const response = await worker.fetch(request, env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.inserted, 1);
  assert.equal(body.errorCount, 0);
  assert.equal(env.DB.newsItems.length, 1);
});

test("POST /backfill accepts a form-encoded body (no secret field) -- dashboard's backfillTriggerForm submits this way, gets the in-progress status page immediately, and the actual backfill runs via ctx.waitUntil in the background", async (t) => {
  const env = baseEnv({ DASHBOARD_USERNAME: "admin", DASHBOARD_PASSWORD: "pw", JWT_SECRET: "secret" });
  const config = loadConfig(env);
  const cookie = sessionCookieHeader(await createSessionCookie("admin", config));
  
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, json: async () => mockFinnhubJson() }));

  const body = new URLSearchParams({ from: "2024-01-01", to: "2024-01-31" });
  const request = new Request("https://worker.example/backfill", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", Cookie: cookie },
    body: body.toString(),
  });

  // Minimal ExecutionContext stand-in -- captures the promise passed to
  // ctx.waitUntil() so the test can await it itself instead of racing it.
  const ctx = { promises: [], waitUntil(p) { this.promises.push(p); } };

  const response = await worker.fetch(request, env, ctx);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  const html = await response.text();
  assert.match(html, /Backfill accepted/);
  assert.match(html, /2024-01-01/);
  assert.match(html, /2024-01-31/);

  // The response above returns before the real backfill finishes -- it only
  // completes inside ctx.waitUntil, in the background.
  await Promise.all(ctx.promises);
  assert.equal(env.DB.newsItems.length, 1);
});

test("POST /backfill's query string still wins over a form field when both are present", async (t) => {
  const env = baseEnv({ DASHBOARD_USERNAME: "admin", DASHBOARD_PASSWORD: "pw", JWT_SECRET: "secret" });
  const config = loadConfig(env);
  const cookie = sessionCookieHeader(await createSessionCookie("admin", config));
  
  t.mock.method(global, "fetch", async (fetchUrl) => {
    assert.match(String(fetchUrl), /from=2024-02-01/);
    return { ok: true, status: 200, json: async () => mockFinnhubJson() };
  });

  const body = new URLSearchParams({ from: "2024-01-01", to: "2024-01-31" });
  const request = new Request("https://worker.example/backfill?from=2024-02-01&to=2024-02-28", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", Cookie: cookie },
    body: body.toString(),
  });

  const ctx = { promises: [], waitUntil(p) { this.promises.push(p); } };
  const response = await worker.fetch(request, env, ctx);
  assert.equal(response.status, 200);

  // The from/to precedence assertion lives inside the mocked global.fetch,
  // which only runs once the background backfill (ctx.waitUntil) executes.
  await Promise.all(ctx.promises);
});

test("POST /backfill returns 500 with the failure message on a real (non-vendor) bug, e.g. a DB write failure", async (t) => {
  class ThrowingDb extends FakeNewsDb {
    prepare() {
      throw new Error("simulated D1 write failure");
    }
  }
  const env = baseEnv({ DASHBOARD_USERNAME: "admin", DASHBOARD_PASSWORD: "pw", JWT_SECRET: "secret", DB: new ThrowingDb() });
  const config = loadConfig(env);
  const cookie = sessionCookieHeader(await createSessionCookie("admin", config));
  
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, json: async () => mockFinnhubJson() }));

  const errorLogs = [];
  t.mock.method(console, "error", (...args) => errorLogs.push(args));

  const request = new Request("https://worker.example/backfill?from=2024-01-01&to=2024-01-31", {
    method: "POST",
    headers: { Cookie: cookie },
  });

  const response = await worker.fetch(request, env);
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.match(body.message, /simulated D1 write failure/);
  assert.ok(errorLogs.some(([msg]) => msg.includes("backfill run failed")));
});
