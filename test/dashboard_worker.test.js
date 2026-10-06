// Covers src/dashboard-worker.js (plan.md "Step 2 -- Dashboard Worker") as the
// API gateway for the Next.js dashboard (dashboard-next/): POST /login (JSON
// errors), GET /logout, 404 for the retired HTML routes (incl. GET /login), and
// the session-cookie
// authorization + forward-to-backend flow on every POST trigger route --
// including the JSON bodies the Next.js app sends. (GET /api/* passthrough:
// test/dashboard_api_passthrough.test.js.)
//
// Two kinds of backend here: the REAL backend Worker (src/index.js) wrapped
// as a service binding, which exercises the actual /backfill and
// /backtest/run contracts; and a recording fake, which checks exactly what
// the gateway forwards for each request shape.

import test from "node:test";
import assert from "node:assert/strict";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { STATE_DIR, INPUTS_DIR, SIM_DIR } from "./helpers/engine_ctx.js";
import worker from "../src/dashboard-worker.js";
import backendWorker from "../src/index.js";

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

/** Minimal fake of a Cloudflare Queue producer binding -- captures every enqueued message. backend's POST routes never run the work themselves: they validate, enqueue and return an immediate ack. */
class FakeQueue {
  constructor() {
    this.sent = [];
  }
  async send(body) {
    this.sent.push(body);
  }
}

/** Wraps the real backend Worker as a Cloudflare-service-binding-shaped object ({ fetch(url, init) }), the same interface env.BACKEND exposes in production. */
function makeBackend(backendEnv, backendCtx = { promises: [], waitUntil(p) { this.promises.push(p); } }) {
  return { fetch: (input, init) => backendWorker.fetch(new Request(input, init), backendEnv, backendCtx), _ctx: backendCtx };
}

/** A backend that records every call and answers `{ accepted: true }`. */
function recordingBackend(status = 200) {
  const calls = [];
  return {
    calls,
    fetch: async (input, init) => {
      calls.push({ url: new URL(typeof input === "string" ? input : input.url), method: init?.method ?? "GET" });
      return new Response(JSON.stringify({ accepted: true }), { status, headers: { "content-type": "application/json" } });
    },
  };
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

/** POSTs a JSON body to `path` with a valid session, against a recording backend. Returns { response, calls }. */
async function postJson(path, body, { cookie = true } = {}) {
  const backend = recordingBackend();
  const env = loginConfiguredEnv({ BACKEND: backend });
  const headers = { "content-type": "application/json" };
  if (cookie) headers.Cookie = await loggedInCookie(env);
  const response = await worker.fetch(new Request(`https://dashboard.example${path}`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }), env);
  return { response, calls: backend.calls };
}

// --------------------------------------------------------------------
// Retired HTML routes
// --------------------------------------------------------------------

test("the server-rendered /dashboard/* pages are gone: 404 JSON, even with a valid session", async () => {
  const env = loginConfiguredEnv();
  const cookie = await loggedInCookie(env);
  for (const path of ["/dashboard", "/dashboard/overview", "/dashboard/snapshot", "/dashboard/backtest", "/dashboard/jobs/x", "/dashboard/tickers"]) {
    const response = await worker.fetch(new Request(`https://dashboard.example${path}`, { headers: { Cookie: cookie } }), env);
    assert.equal(response.status, 404, `${path} should be retired`);
    assert.deepEqual(await response.json(), { error: "not found" });
  }
});

test("GET / answers 200 (liveness) without needing a session", async () => {
  const response = await worker.fetch(new Request("https://dashboard.example/"), loginConfiguredEnv());
  assert.equal(response.status, 200);
});

// --------------------------------------------------------------------
// POST /login (GET /login no longer serves a page)
// --------------------------------------------------------------------

test("GET /login is gone: 404 JSON whether or not login is configured or a session exists", async () => {
  for (const env of [baseEnv(), loginConfiguredEnv()]) {
    const response = await worker.fetch(new Request("https://dashboard.example/login"), env);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "not found" });
  }
  const env = loginConfiguredEnv();
  const cookie = await loggedInCookie(env);
  assert.equal((await worker.fetch(new Request("https://dashboard.example/login", { headers: { Cookie: cookie } }), env)).status, 404);
});

test("POST /login with correct credentials sets a session cookie (this is what the Next.js /api/login reads)", async () => {
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
  assert.equal(response.headers.get("Location"), "/");
  const setCookie = response.headers.get("Set-Cookie");
  assert.match(setCookie, /^nmai_session=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
});

test("POST /login with a wrong password returns 401 JSON, no cookie set", async () => {
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
  assert.deepEqual(await response.json(), { error: "Invalid username or password." });
});

test("POST /login with no body at all is a 401, not a crash", async () => {
  const response = await worker.fetch(new Request("https://dashboard.example/login", { method: "POST" }), loginConfiguredEnv());
  assert.equal(response.status, 401);
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
  assert.match((await response.json()).error, /not configured/);
});

// --------------------------------------------------------------------
// GET /logout
// --------------------------------------------------------------------

test("GET /logout clears the session cookie and redirects to /", async () => {
  const env = loginConfiguredEnv();
  const response = await worker.fetch(new Request("https://dashboard.example/logout"), env);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), "/");
  const setCookie = response.headers.get("Set-Cookie");
  assert.match(setCookie, /^nmai_session=;/);
  assert.match(setCookie, /Max-Age=0/);
});

// --------------------------------------------------------------------
// POST trigger routes -- session auth here, then forwarded to backend over
// the BACKEND service binding.
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

test("a JSON POST without a session is a 401 and never reaches backend", async () => {
  const { response, calls } = await postJson("/backfill", { from: "2024-01-01", to: "2024-01-31" }, { cookie: false });
  assert.equal(response.status, 401);
  assert.equal(calls.length, 0);
});

test("POST /backfill succeeds on a valid session cookie (query-string caller gets backend's enqueue ack forwarded verbatim)", async () => {
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

test("POST /backfill accepts a form-encoded body and answers JSON (no redirect to a page: there are no pages)", async () => {
  const jobs = new FakeQueue();
  // A real (empty) LIVE_DB: backend writes the 'queued' job_progress row via RunStore (best-effort).
  const env = loginConfiguredEnv({ BACKEND: makeBackend({ DB: new FakeNewsDb(), LIVE_DB: createTestD1([STATE_DIR]), BACKFILL: jobs }) });
  const cookie = await loggedInCookie(env);

  const response = await worker.fetch(
    new Request("https://dashboard.example/backfill", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", Cookie: cookie },
      body: new URLSearchParams({ from: "2024-01-01", to: "2024-01-31" }).toString(),
    }),
    env,
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).accepted, true);
  assert.equal(jobs.sent.length, 1);
  assert.equal(jobs.sent[0].type, "backfill");
  assert.equal(jobs.sent[0].from, "2024-01-01");
  assert.equal(jobs.sent[0].to, "2024-01-31");
});

test("POST /backfill accepts a JSON body (what the Next.js app sends) and the real backend enqueues it", async () => {
  const jobs = new FakeQueue();
  const env = loginConfiguredEnv({ BACKEND: makeBackend({ DB: new FakeNewsDb(), LIVE_DB: createTestD1([STATE_DIR]), BACKFILL: jobs }) });
  const cookie = await loggedInCookie(env);

  const response = await worker.fetch(
    new Request("https://dashboard.example/backfill", {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ from: "2024-01-01", to: "2024-01-31" }),
    }),
    env,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.accepted, true);
  assert.equal(jobs.sent.length, 1);
  assert.deepEqual(jobs.sent[0], { type: "backfill", id: body.id, from: "2024-01-01", to: "2024-01-31" });
});

test("a JSON body with missing or malformed dates is a 400 from the gateway and never reaches backend", async () => {
  for (const body of [{}, { from: "2024-01-01" }, { from: "yesterday", to: "today" }]) {
    const { response, calls } = await postJson("/backfill", body);
    assert.equal(response.status, 400);
    assert.equal(calls.length, 0);
  }
});

test("a JSON body that isn't an object (array, scalar, or broken JSON) is a 400, not a 500", async () => {
  for (const raw of ["[]", "42", "{not json"]) {
    const { response, calls } = await postJson("/backfill", raw);
    assert.equal(response.status, 400, `body ${raw}`);
    assert.equal(calls.length, 0);
  }
});

test("POST /backfill-prices forwards a JSON tickers array as a comma list, and omits tickers when the array is empty", async () => {
  const withTickers = await postJson("/backfill-prices", { from: "2024-01-01", to: "2024-01-31", tickers: ["AAPL", "MSFT"] });
  assert.equal(withTickers.response.status, 200);
  assert.equal(withTickers.calls[0].url.pathname, "/backfill-prices");
  assert.equal(withTickers.calls[0].method, "POST");
  assert.equal(withTickers.calls[0].url.searchParams.get("tickers"), "AAPL,MSFT");

  const empty = await postJson("/backfill-prices", { from: "2024-01-01", to: "2024-01-31", tickers: [] });
  assert.equal(empty.calls[0].url.searchParams.has("tickers"), false);
});

test("POST /backtest/run with a valid session cookie is forwarded to backend, which enqueues onto BACKTEST and returns an accepted ack", async () => {
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

async function postBacktest(contentType, fields) {
  const backtestQueue = new FakeQueue();
  const env = loginConfiguredEnv({
    BACKEND: makeBackend({ DB: new FakeNewsDb(), SIM_DB: createTestD1([STATE_DIR, SIM_DIR]), BACKTEST: backtestQueue, WATCHLIST_TICKERS: "AAPL" }),
  });
  const cookie = await loggedInCookie(env);
  const base = { testStart: "2024-01-01", testEnd: "2024-01-31", tickers: "AAPL", ...fields };
  const body = contentType === "json" ? JSON.stringify({ ...base, tickers: [base.tickers] }) : new URLSearchParams(base).toString();
  const response = await worker.fetch(
    new Request("https://dashboard.example/backtest/run", {
      method: "POST",
      headers: { "content-type": contentType === "json" ? "application/json" : "application/x-www-form-urlencoded", Cookie: cookie },
      body,
    }),
    env,
  );
  return { response, backtestQueue };
}

test("POST /backtest/run form with disableGate=1 queues the run with the price-impact gate off (skipNoPriceImpact override 0)", async () => {
  const { response, backtestQueue } = await postBacktest("form", { disableGate: "1" });
  assert.equal(response.status, 200);
  assert.equal(backtestQueue.sent.length, 1);
  assert.deepEqual(backtestQueue.sent[0].knobOverrides, { skipNoPriceImpact: 0 });
});

test("POST /backtest/run form without the flag sends no gate override (Worker default, gate on)", async () => {
  const { response, backtestQueue } = await postBacktest("form", {});
  assert.equal(response.status, 200);
  assert.equal(backtestQueue.sent.length, 1);
  assert.equal(backtestQueue.sent[0].knobOverrides?.skipNoPriceImpact, undefined);
});

test("POST /backtest/run JSON with tickers as an array queues the run; disableGate true turns the gate off, false leaves it on", async () => {
  const on = await postBacktest("json", { disableGate: true });
  assert.equal(on.response.status, 200);
  assert.deepEqual(on.backtestQueue.sent[0].tickers, ["AAPL"]);
  assert.deepEqual(on.backtestQueue.sent[0].knobOverrides, { skipNoPriceImpact: 0 });

  const off = await postBacktest("json", { disableGate: false });
  assert.equal(off.response.status, 200);
  assert.equal(off.backtestQueue.sent[0].knobOverrides?.skipNoPriceImpact, undefined);
});

test("POST /backtest/run JSON: enableLlmLog true is forwarded as 1, false is NOT forwarded (a JSON false must not read as 'checked')", async () => {
  const on = await postJson("/backtest/run", { testStart: "2024-01-01", testEnd: "2024-01-31", enableLlmLog: true });
  assert.equal(on.calls[0].url.searchParams.get("enableLlmLog"), "1");
  const off = await postJson("/backtest/run", { testStart: "2024-01-01", testEnd: "2024-01-31", enableLlmLog: false });
  assert.equal(off.calls[0].url.searchParams.has("enableLlmLog"), false);
});

test("POST /backtest/run JSON without valid dates is a 400 and never reaches backend", async () => {
  const { response, calls } = await postJson("/backtest/run", { testStart: "2024-01-01" });
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
});

test("POST /backtest/:id/{cancel,pause,resume} forward to the matching backend route with the id in the path", async () => {
  const id = "backtest-1789000000000-abc123";
  for (const action of ["cancel", "pause", "resume"]) {
    const { response, calls } = await postJson(`/backtest/${id}/${action}`, "");
    assert.equal(response.status, 200, action);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.pathname, `/backtest/${id}/${action}`);
    assert.equal(calls[0].method, "POST");
  }
});

test("POST /controls/set reads a JSON boolean: true -> paused=1, false -> paused=0, and the operator's username goes along as `by`", async () => {
  const pause = await postJson("/controls/set", { key: "all", paused: true });
  assert.equal(pause.response.status, 200);
  assert.equal(pause.calls[0].url.pathname, "/controls/set");
  assert.equal(pause.calls[0].url.searchParams.get("key"), "all");
  assert.equal(pause.calls[0].url.searchParams.get("paused"), "1");
  assert.equal(pause.calls[0].url.searchParams.get("by"), "admin");

  const resume = await postJson("/controls/set", { key: "all", paused: false });
  assert.equal(resume.calls[0].url.searchParams.get("paused"), "0");
});

test("POST /controls/set rejects an unknown key or a missing paused value with 400, without touching backend", async () => {
  for (const body of [{ key: "not-a-switch", paused: true }, { key: "all" }, { key: "all", paused: "maybe" }]) {
    const { response, calls } = await postJson("/controls/set", body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(calls.length, 0);
  }
});

test("POST /controls/tickers takes a JSON array (or comma list), upper-cases and dedupes it, and rejects an empty selection", async () => {
  const ok = await postJson("/controls/tickers", { tickers: ["aapl", "msft", "AAPL"] });
  assert.equal(ok.response.status, 200);
  assert.equal(ok.calls[0].url.searchParams.get("tickers"), "AAPL,MSFT");
  assert.equal(ok.calls[0].url.searchParams.get("by"), "admin");

  const comma = await postJson("/controls/tickers", { tickers: "aapl, msft" });
  assert.equal(comma.calls[0].url.searchParams.get("tickers"), "AAPL,MSFT");

  const none = await postJson("/controls/tickers", { tickers: [] });
  assert.equal(none.response.status, 400);
  assert.equal(none.calls.length, 0);
});

test("POST /backtest/replay/run takes ticker + a JSON newsItemIds array and forwards them as a comma list", async () => {
  const { response, calls } = await postJson("/backtest/replay/run", { ticker: "AAPL", newsItemIds: [11, 12] });
  assert.equal(response.status, 200);
  assert.equal(calls[0].url.pathname, "/backtest/replay/run");
  assert.equal(calls[0].url.searchParams.get("ticker"), "AAPL");
  assert.equal(calls[0].url.searchParams.get("newsItemIds"), "11,12");

  const missing = await postJson("/backtest/replay/run", { ticker: "AAPL", newsItemIds: [] });
  assert.equal(missing.response.status, 400);
});

test("GET /backtest/replay/news (the replay picker's item list, outside /api) is session-gated and forwarded with its query string", async () => {
  const backend = recordingBackend();
  const env = loginConfiguredEnv({ BACKEND: backend });
  const url = "https://dashboard.example/backtest/replay/news?ticker=AAPL&date=2024-01-15";

  const anonymous = await worker.fetch(new Request(url), env);
  assert.equal(anonymous.status, 401);
  assert.equal(backend.calls.length, 0);

  const cookie = await loggedInCookie(env);
  const response = await worker.fetch(new Request(url, { headers: { Cookie: cookie } }), env);
  assert.equal(response.status, 200);
  assert.equal(backend.calls.length, 1);
  assert.equal(backend.calls[0].method, "GET");
  assert.equal(backend.calls[0].url.pathname, "/backtest/replay/news");
  assert.equal(backend.calls[0].url.searchParams.get("ticker"), "AAPL");
  assert.equal(backend.calls[0].url.searchParams.get("date"), "2024-01-15");
});

test("GET /backtest/replay/news returns 503 when the dashboard login isn't configured", async () => {
  const backend = recordingBackend();
  const response = await worker.fetch(new Request("https://dashboard.example/backtest/replay/news?ticker=AAPL&date=2024-01-15"), baseEnv({ BACKEND: backend }));
  assert.equal(response.status, 503);
  assert.equal(backend.calls.length, 0);
});

test("backend's status and body pass through unchanged (a 4xx from backend stays a 4xx JSON error)", async () => {
  const backend = recordingBackend(409);
  const env = loginConfiguredEnv({ BACKEND: backend });
  const cookie = await loggedInCookie(env);
  const response = await worker.fetch(
    new Request("https://dashboard.example/backtest/purge", { method: "POST", headers: { Cookie: cookie } }),
    env,
  );
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { accepted: true });
});
