// Covers POST /backfill-macro on dashboard-next/src/server/gateway.mjs: the session gate,
// the scripted (query-string), form and JSON body shapes, `from` validation before backend
// is called, that only `from` is forwarded (FRED has no end bound), and that backend's own
// rejections pass through. Same harness as test/dashboard_gateway_price_backfill.test.js:
// the real backend Worker behind a service-binding-shaped wrapper.

import test from "node:test";
import assert from "node:assert/strict";
import { worker, loginConfigured, sessionCookieFor } from "./helpers/dashboard_gateway.js";
import { toGatewayPath } from "../dashboard-next/src/server/gateway.mjs";
import backendWorker from "../src/index.js";
import { jobStateDb } from "./helpers/job_db.js";

function makeBackend(backendEnv) {
  return { fetch: (input, init) => backendWorker.fetch(new Request(input, init), backendEnv, { waitUntil() {} }) };
}

const loginConfiguredEnv = loginConfigured;
const loggedInCookie = sessionCookieFor;

class FakeQueue {
  constructor() {
    this.sent = [];
  }
  async send(body) {
    this.sent.push(body);
  }
}

test("toGatewayPath keeps /backfill-macro un-prefixed (a backend write route, not an /api read)", () => {
  assert.equal(toGatewayPath("/backfill-macro"), "/backfill-macro");
});

test("POST /backfill-macro returns 401 with no session cookie, and 503 when the login isn't configured", async () => {
  const queue = new FakeQueue();
  const backend = makeBackend({ LIVE_DB: (await jobStateDb()).db, BACKFILL: queue });

  const unauthorised = await worker.fetch(new Request("https://dashboard.example/backfill-macro?from=2025-01-01", { method: "POST" }), loginConfiguredEnv({ BACKEND: backend }));
  assert.equal(unauthorised.status, 401);

  const disabled = await worker.fetch(new Request("https://dashboard.example/backfill-macro?from=2025-01-01", { method: "POST" }), { BACKEND: backend });
  assert.equal(disabled.status, 503);

  assert.equal(queue.sent.length, 0);
});

test("POST /backfill-macro with a session cookie (scripted caller) forwards to backend and returns its enqueue ack", async () => {
  const queue = new FakeQueue();
  const env = loginConfiguredEnv({ BACKEND: makeBackend({ LIVE_DB: (await jobStateDb()).db, BACKFILL: queue }) });
  const cookie = await loggedInCookie(env);

  const response = await worker.fetch(new Request("https://dashboard.example/backfill-macro?from=2024-01-01", { method: "POST", headers: { Cookie: cookie } }), env);

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.accepted, true);
  assert.equal(body.from, "2024-01-01");
  assert.match(body.id, /^backfill-macro-/);
  assert.equal(queue.sent.length, 1);
  assert.deepEqual(queue.sent[0], { type: "backfill_macro", id: body.id, from: "2024-01-01" });
});

test("POST /backfill-macro with a form body is queued and answered with JSON (no redirect: there is no page to redirect to)", async () => {
  const queue = new FakeQueue();
  const env = loginConfiguredEnv({ BACKEND: makeBackend({ LIVE_DB: (await jobStateDb()).db, BACKFILL: queue }) });
  const cookie = await loggedInCookie(env);

  const response = await worker.fetch(
    new Request("https://dashboard.example/backfill-macro", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", Cookie: cookie },
      body: new URLSearchParams({ from: "2025-06-01" }).toString(),
    }),
    env,
  );

  assert.equal(response.status, 200);
  assert.equal((await response.json()).accepted, true);
  assert.equal(queue.sent.length, 1);
  assert.equal(queue.sent[0].type, "backfill_macro");
  assert.equal(queue.sent[0].from, "2025-06-01");
});

test("POST /backfill-macro with a JSON body (what the Next.js app sends) queues the job and its progress row shows up in /api/jobs/active", async () => {
  const queue = new FakeQueue();
  const env = loginConfiguredEnv({ BACKEND: makeBackend({ LIVE_DB: (await jobStateDb()).db, BACKFILL: queue }) });
  const cookie = await loggedInCookie(env);

  const response = await worker.fetch(
    new Request("https://dashboard.example/backfill-macro", {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ from: "2024-10-07" }),
    }),
    env,
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.accepted, true);
  assert.equal(queue.sent.length, 1);
  assert.deepEqual(queue.sent[0], { type: "backfill_macro", id: body.id, from: "2024-10-07" });

  // The app polls this to draw the progress card for the job it just queued.
  const active = await worker.fetch(new Request("https://dashboard.example/api/jobs/active?type=backfill_macro", { headers: { Cookie: cookie } }), env);
  assert.equal(active.status, 200);
  assert.equal((await active.json()).job?.id, body.id);
});

test("POST /backfill-macro forwards only `from`: a stray `to` or `tickers` is dropped, not passed to backend", async () => {
  const queue = new FakeQueue();
  const env = loginConfiguredEnv({ BACKEND: makeBackend({ LIVE_DB: (await jobStateDb()).db, BACKFILL: queue }) });
  const cookie = await loggedInCookie(env);

  const response = await worker.fetch(
    new Request("https://dashboard.example/backfill-macro?from=2025-01-01&to=2025-06-01&tickers=AAPL", { method: "POST", headers: { Cookie: cookie } }),
    env,
  );

  assert.equal(response.status, 200);
  assert.equal(queue.sent.length, 1);
  assert.deepEqual(Object.keys(queue.sent[0]).sort(), ["from", "id", "type"]);
});

for (const [label, request] of [
  ["a missing `from`", { query: "" }],
  ["an empty `from`", { query: "?from=" }],
  ["a malformed `from`", { query: "?from=nope" }],
  ["a non-ISO `from`", { query: "?from=2025-1-1" }],
  ["a JSON body without `from`", { body: {} }],
]) {
  test(`POST /backfill-macro with ${label} is a 400 from the gateway, before backend is called`, async () => {
    const queue = new FakeQueue();
    const env = loginConfiguredEnv({ BACKEND: makeBackend({ LIVE_DB: (await jobStateDb()).db, BACKFILL: queue }) });
    const cookie = await loggedInCookie(env);

    const init = request.body
      ? { method: "POST", headers: { "content-type": "application/json", Cookie: cookie }, body: JSON.stringify(request.body) }
      : { method: "POST", headers: { Cookie: cookie } };
    const response = await worker.fetch(new Request(`https://dashboard.example/backfill-macro${request.query ?? ""}`, init), env);

    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /from is required/);
    assert.equal(queue.sent.length, 0);
  });
}

test("POST /backfill-macro passes backend's own rejection through (a well-formed date before the 2000-01-01 sanity bound is backend's 400)", async () => {
  const queue = new FakeQueue();
  const env = loginConfiguredEnv({ BACKEND: makeBackend({ LIVE_DB: (await jobStateDb()).db, BACKFILL: queue }) });
  const cookie = await loggedInCookie(env);

  const response = await worker.fetch(new Request("https://dashboard.example/backfill-macro?from=1999-12-31", { method: "POST", headers: { Cookie: cookie } }), env);

  assert.equal(response.status, 400);
  assert.ok((await response.json()).error, "backend's explanation reaches the caller");
  assert.equal(queue.sent.length, 0);
});
