// Covers the dashboard side of the historical price backfill (plan.md Next
// Steps step A), in src/dashboard-worker.js:
//   * GET /dashboard/backfill-prices/confirm -- the page the price form on
//     /dashboard/backfill submits to (it used to fall through to the plain-text
//     "dashboard is running" response, so the form went nowhere);
//   * /dashboard/backfill shows an in-flight price job's live-progress panel and
//     the last FINISHED price job ("Last price backfill"), alongside the news ones;
//   * POST /backfill-prices: session gate, form POST -> 303 back to the page.
// Same harness as test/dashboard_worker.test.js: the real backend Worker behind
// a service-binding-shaped wrapper.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/dashboard-worker.js";
import backendWorker from "../src/index.js";
import { jobStateDb } from "./helpers/job_db.js";
import { RunStore } from "../src/storage/run_store.js";

function makeBackend(backendEnv) {
  return { fetch: (input, init) => backendWorker.fetch(new Request(input, init), backendEnv, { waitUntil() {} }) };
}

function loginConfiguredEnv(overrides = {}) {
  return {
    DASHBOARD_USERNAME: "admin",
    DASHBOARD_PASSWORD: "correct-horse-battery-staple",
    JWT_SECRET: "test-jwt-signing-key",
    ...overrides,
  };
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
  return response.headers.get("Set-Cookie").split(";")[0];
}

class FakeQueue {
  constructor() {
    this.sent = [];
  }
  async send(body) {
    this.sent.push(body);
  }
}

async function getBackfillPage(env, cookie) {
  const response = await worker.fetch(new Request("https://dashboard.example/dashboard/backfill", { headers: { Cookie: cookie } }), env);
  assert.equal(response.status, 200);
  return response.text();
}

const RUNNING_PRICE_JOB = {
  id: "backfill-prices-1789783849291-abc123",
  type: "backfill_prices",
  phase: "saving",
  percent: 50,
  detail: "Saving 500 bars",
  params: { from: "2025-09-21", to: "2026-09-21" },
};

const RUNNING_NEWS_JOB = {
  id: "backfill-1789783849291-cx0mfj",
  type: "backfill",
  phase: "saving",
  percent: 60,
  done: 200,
  total: 733,
  detail: "Saved 200/733 articles",
  params: { from: "2024-01-01", to: "2024-01-31" },
};

/** A live state DB holding one FINISHED price-backfill job. */
async function liveDbWithFinishedPriceBackfill({ status = "complete", error = null, detail = null } = {}) {
  const db = (await jobStateDb()).db;
  const store = new RunStore(db, "live");
  const id = "backfill-prices-done-1";
  const params = { from: "2025-09-21", to: "2026-09-21" };
  await store.insertQueuedJob({ id, type: "backfill_prices", params, now: "2026-01-01T00:00:00.000Z" });
  await store.markJobRunning({ id, type: "backfill_prices", now: "2026-01-01T00:00:01.000Z" });
  if (status === "failed") {
    await store.failJob({ id, error, detail, now: "2026-01-01T00:05:00.000Z" });
  } else {
    await store.completeJob({ id, result: { inserted: 502, tickers: 2 }, detail, now: "2026-01-01T00:05:00.000Z" });
  }
  return db;
}

// --------------------------------------------------------------------
// GET /dashboard/backfill-prices/confirm
// --------------------------------------------------------------------

test("GET /dashboard/backfill-prices/confirm renders the confirm page (not the plain-text fallback) and posts to /backfill-prices", async () => {
  const env = loginConfiguredEnv();
  const cookie = await loggedInCookie(env);

  const response = await worker.fetch(
    new Request("https://dashboard.example/dashboard/backfill-prices/confirm?from=2025-09-21&to=2026-09-21", { headers: { Cookie: cookie } }),
    env,
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  const html = await response.text();
  assert.match(html, /Confirm historical price backfill/);
  assert.match(html, /2025-09-21/);
  assert.match(html, /2026-09-21/);
  assert.match(html, /<form method="post" action="\/backfill-prices"/);
  assert.match(html, /name="from" value="2025-09-21"/);
  assert.match(html, /name="to" value="2026-09-21"/);
  assert.match(html, /logged in as admin/, "wrapped in the shell, like the news confirm page");
});

test("GET /dashboard/backfill-prices/confirm redirects to /login without a session, and 503s when the login isn't configured", async () => {
  const configured = loginConfiguredEnv();
  const noSession = await worker.fetch(new Request("https://dashboard.example/dashboard/backfill-prices/confirm?from=2025-09-21&to=2026-09-21"), configured);
  assert.equal(noSession.status, 302);
  assert.equal(noSession.headers.get("Location"), "/login");

  const disabled = await worker.fetch(new Request("https://dashboard.example/dashboard/backfill-prices/confirm?from=2025-09-21&to=2026-09-21"), {});
  assert.equal(disabled.status, 503);
});

test("GET /dashboard/backfill-prices/confirm HTML-escapes the dates it echoes", async () => {
  const env = loginConfiguredEnv();
  const cookie = await loggedInCookie(env);
  const response = await worker.fetch(
    new Request(`https://dashboard.example/dashboard/backfill-prices/confirm?from=${encodeURIComponent('"><script>alert(1)</script>')}&to=2026-09-21`, { headers: { Cookie: cookie } }),
    env,
  );
  const html = await response.text();
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
});

test("the price form on /dashboard/backfill submits to the confirm route that now exists", async () => {
  const env = loginConfiguredEnv({ BACKEND: makeBackend({ LIVE_DB: (await jobStateDb()).db }) });
  const cookie = await loggedInCookie(env);
  const html = await getBackfillPage(env, cookie);
  assert.match(html, /<form method="get" action="\/dashboard\/backfill-prices\/confirm"/);
});

// --------------------------------------------------------------------
// /dashboard/backfill: active price job
// --------------------------------------------------------------------

test("GET /dashboard/backfill shows the live-progress panel for an in-flight price backfill", async () => {
  const env = loginConfiguredEnv({ BACKEND: makeBackend({ LIVE_DB: (await jobStateDb([RUNNING_PRICE_JOB])).db }) });
  const cookie = await loggedInCookie(env);
  const html = await getBackfillPage(env, cookie);

  assert.match(html, /id="active-job" data-job-id="backfill-prices-1789783849291-abc123"/);
  assert.match(html, /Price backfill in progress/);
  assert.match(html, /Backfilling historical price bars for the whole watchlist from 2025-09-21 to 2026-09-21/);
});

test("GET /dashboard/backfill shows exactly one progress panel -- the news one -- when both a news and a price backfill are in flight (the panel's element ids are fixed)", async () => {
  const env = loginConfiguredEnv({ BACKEND: makeBackend({ LIVE_DB: (await jobStateDb([RUNNING_NEWS_JOB, RUNNING_PRICE_JOB])).db }) });
  const cookie = await loggedInCookie(env);
  const html = await getBackfillPage(env, cookie);

  assert.equal(html.match(/id="active-job"/g).length, 1);
  assert.match(html, /data-job-id="backfill-1789783849291-cx0mfj"/);
  assert.doesNotMatch(html, /data-job-id="backfill-prices-/);
});

test("GET /dashboard/backfill shows no progress panel when nothing is in flight", async () => {
  const env = loginConfiguredEnv({ BACKEND: makeBackend({ LIVE_DB: (await jobStateDb()).db }) });
  const cookie = await loggedInCookie(env);
  assert.doesNotMatch(await getBackfillPage(env, cookie), /id="active-job"/);
});

// --------------------------------------------------------------------
// /dashboard/backfill: last finished price job
// --------------------------------------------------------------------

test("GET /dashboard/backfill shows no 'Last price backfill' panel when no price job has ever finished", async () => {
  const env = loginConfiguredEnv({ BACKEND: makeBackend({ LIVE_DB: (await jobStateDb()).db }) });
  const cookie = await loggedInCookie(env);
  assert.doesNotMatch(await getBackfillPage(env, cookie), /Last price backfill/);
});

test("GET /dashboard/backfill shows 'Last price backfill' for a completed price job, with its range and detail -- and not the news 'Last run' panel", async () => {
  const env = loginConfiguredEnv({ BACKEND: makeBackend({ LIVE_DB: await liveDbWithFinishedPriceBackfill({ detail: "Saved 502 price bars for 2 of 2 tickers" }) }) });
  const cookie = await loggedInCookie(env);
  const html = await getBackfillPage(env, cookie);

  assert.match(html, /Last price backfill/);
  assert.match(html, /Complete/);
  assert.match(html, /2025-09-21 to 2026-09-21/);
  assert.match(html, /Saved 502 price bars for 2 of 2 tickers/);
  assert.doesNotMatch(html, /Last run/, "a price job must not show up as the news backfill's last run");
});

test("GET /dashboard/backfill shows 'Last price backfill' for a failed price job, with the error that names the tickers", async () => {
  const error = "No price bars saved -- AAPL (yfinance chart API returned 429 for AAPL); MSFT (yfinance chart API returned 429 for MSFT)";
  const env = loginConfiguredEnv({ BACKEND: makeBackend({ LIVE_DB: await liveDbWithFinishedPriceBackfill({ status: "failed", error, detail: null }) }) });
  const cookie = await loggedInCookie(env);
  const html = await getBackfillPage(env, cookie);

  assert.match(html, /Last price backfill/);
  assert.match(html, /Failed/);
  assert.match(html, /No price bars saved/);
  assert.match(html, /AAPL/);
  assert.match(html, /MSFT/);
});

test("GET /dashboard/backfill renders normally when the price-job lookups fail -- best-effort", async () => {
  const brokenBackend = { fetch: async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 }) };
  const env = loginConfiguredEnv({ BACKEND: brokenBackend });
  const cookie = await loggedInCookie(env);
  const response = await worker.fetch(new Request("https://dashboard.example/dashboard/backfill", { headers: { Cookie: cookie } }), env);

  assert.equal(response.status, 200);
  const html = await response.text();
  assert.doesNotMatch(html, /id="active-job"/);
  assert.doesNotMatch(html, /Last price backfill/);
  assert.match(html, /Historical price bars/, "the form is still there");
});

// --------------------------------------------------------------------
// POST /backfill-prices
// --------------------------------------------------------------------

test("POST /backfill-prices returns 401 with no session cookie, and 503 when the login isn't configured", async () => {
  const backend = makeBackend({ LIVE_DB: (await jobStateDb()).db, BACKFILL: new FakeQueue() });

  const unauthorised = await worker.fetch(
    new Request("https://dashboard.example/backfill-prices?from=2025-09-21&to=2026-09-21", { method: "POST" }),
    loginConfiguredEnv({ BACKEND: backend }),
  );
  assert.equal(unauthorised.status, 401);

  const disabled = await worker.fetch(new Request("https://dashboard.example/backfill-prices?from=2025-09-21&to=2026-09-21", { method: "POST" }), { BACKEND: backend });
  assert.equal(disabled.status, 503);
});

test("POST /backfill-prices with a session cookie (scripted caller) forwards to backend and returns its enqueue ack", async () => {
  const queue = new FakeQueue();
  const env = loginConfiguredEnv({ BACKEND: makeBackend({ LIVE_DB: (await jobStateDb()).db, BACKFILL: queue, WATCHLIST_TICKERS: "AAPL" }) });
  const cookie = await loggedInCookie(env);

  const response = await worker.fetch(
    new Request("https://dashboard.example/backfill-prices?from=2025-09-21&to=2026-09-21&tickers=msft", { method: "POST", headers: { Cookie: cookie } }),
    env,
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.accepted, true);
  assert.match(body.id, /^backfill-prices-/);
  assert.deepEqual(body.tickers, ["MSFT"]);
  assert.equal(queue.sent.length, 1);
  assert.equal(queue.sent[0].type, "backfill_prices");
  assert.deepEqual(queue.sent[0].tickers, ["MSFT"]);
});

test("POST /backfill-prices with a form body 303-redirects to /dashboard/backfill, where the just-queued job's progress panel shows", async () => {
  const queue = new FakeQueue();
  const env = loginConfiguredEnv({ BACKEND: makeBackend({ LIVE_DB: (await jobStateDb()).db, BACKFILL: queue, WATCHLIST_TICKERS: "AAPL" }) });
  const cookie = await loggedInCookie(env);

  const response = await worker.fetch(
    new Request("https://dashboard.example/backfill-prices", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", Cookie: cookie },
      body: new URLSearchParams({ from: "2025-09-21", to: "2026-09-21" }).toString(),
    }),
    env,
  );

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("Location"), "/dashboard/backfill");
  assert.equal(await response.text(), "");
  assert.equal(queue.sent.length, 1);
  assert.equal(queue.sent[0].type, "backfill_prices");
  assert.equal(queue.sent[0].from, "2025-09-21");
  assert.equal(queue.sent[0].to, "2026-09-21");

  const html = await getBackfillPage(env, cookie);
  assert.match(html, /id="active-job"/);
  assert.match(html, /Price backfill in progress/);
  assert.match(html, /from 2025-09-21 to 2026-09-21/);
});

test("POST /backfill-prices with a malformed date is a 400 from the dashboard, before backend is called", async () => {
  const queue = new FakeQueue();
  const env = loginConfiguredEnv({ BACKEND: makeBackend({ LIVE_DB: (await jobStateDb()).db, BACKFILL: queue }) });
  const cookie = await loggedInCookie(env);

  const response = await worker.fetch(new Request("https://dashboard.example/backfill-prices?from=nope&to=2026-09-21", { method: "POST", headers: { Cookie: cookie } }), env);

  assert.equal(response.status, 400);
  assert.equal(queue.sent.length, 0);
});
