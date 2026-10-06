// Covers POST /backfill-prices (plan.md Next Steps step A) in
// src/dashboard-worker.js: the session gate, the scripted (query-string) and
// form/JSON body shapes, and date validation before backend is called. The
// confirm page and the progress/last-run panels were server-rendered HTML,
// retired with the old UI (the Next.js app in dashboard-next/ owns them).
// Same harness as test/dashboard_worker.test.js: the real backend Worker
// behind a service-binding-shaped wrapper.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/dashboard-worker.js";
import backendWorker from "../src/index.js";
import { jobStateDb } from "./helpers/job_db.js";

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

test("POST /backfill-prices with a form body is queued and answered with JSON (no redirect: there is no page to redirect to)", async () => {
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

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.accepted, true);
  assert.equal(queue.sent.length, 1);
  assert.equal(queue.sent[0].type, "backfill_prices");
  assert.equal(queue.sent[0].from, "2025-09-21");
  assert.equal(queue.sent[0].to, "2026-09-21");
});

test("POST /backfill-prices with a JSON body (what the Next.js app sends), tickers as an array, queues the job and its progress row shows up in /api/jobs/active", async () => {
  const queue = new FakeQueue();
  const env = loginConfiguredEnv({ BACKEND: makeBackend({ LIVE_DB: (await jobStateDb()).db, BACKFILL: queue, WATCHLIST_TICKERS: "AAPL,MSFT" }) });
  const cookie = await loggedInCookie(env);

  const response = await worker.fetch(
    new Request("https://dashboard.example/backfill-prices", {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ from: "2025-09-21", to: "2026-09-21", tickers: ["AAPL", "MSFT"] }),
    }),
    env,
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.accepted, true);
  assert.deepEqual(body.tickers, ["AAPL", "MSFT"]);
  assert.equal(queue.sent.length, 1);
  assert.deepEqual(queue.sent[0].tickers, ["AAPL", "MSFT"]);

  // The new app polls this to draw the progress card for the job it just queued.
  const active = await worker.fetch(new Request("https://dashboard.example/api/jobs/active?type=backfill_prices", { headers: { Cookie: cookie } }), env);
  assert.equal(active.status, 200);
  assert.equal((await active.json()).job?.id, body.id);
});

test("POST /backfill-prices with a malformed date is a 400 from the dashboard, before backend is called", async () => {
  const queue = new FakeQueue();
  const env = loginConfiguredEnv({ BACKEND: makeBackend({ LIVE_DB: (await jobStateDb()).db, BACKFILL: queue }) });
  const cookie = await loggedInCookie(env);

  const response = await worker.fetch(new Request("https://dashboard.example/backfill-prices?from=nope&to=2026-09-21", { method: "POST", headers: { Cookie: cookie } }), env);

  assert.equal(response.status, 400);
  assert.equal(queue.sent.length, 0);
});
