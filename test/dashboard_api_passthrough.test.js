// Covers GET /api/* on src/dashboard-worker.js: the session-gated, read-only
// passthrough to the private backend Worker that the Next.js dashboard
// (dashboard-next/, its own Worker bound to this one) uses for its data.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/dashboard-worker.js";

function fakeBackend(handler) {
  const calls = [];
  return {
    calls,
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      calls.push({ url, method: init?.method ?? "GET" });
      return handler(url);
    },
  };
}

function configuredEnv(backend) {
  return {
    BACKEND: backend,
    DASHBOARD_USERNAME: "admin",
    DASHBOARD_PASSWORD: "correct-horse-battery-staple",
    JWT_SECRET: "test-jwt-signing-key",
  };
}

async function sessionCookie(env) {
  const res = await worker.fetch(
    new Request("https://dashboard.example/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "admin", password: "correct-horse-battery-staple" }).toString(),
    }),
    env,
  );
  return res.headers.get("Set-Cookie").split(";")[0];
}

test("GET /api/* returns 503 when the dashboard login isn't configured, without touching backend", async () => {
  const backend = fakeBackend(() => new Response("{}"));
  const res = await worker.fetch(new Request("https://dashboard.example/api/overview"), { BACKEND: backend });
  assert.equal(res.status, 503);
  assert.equal(backend.calls.length, 0);
});

test("GET /api/* returns 401 JSON (not a redirect) with no session cookie, without touching backend", async () => {
  const backend = fakeBackend(() => new Response("{}"));
  const res = await worker.fetch(new Request("https://dashboard.example/api/overview"), configuredEnv(backend));
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "unauthorized" });
  assert.equal(backend.calls.length, 0);
});

test("GET /api/* returns 401 for a forged cookie", async () => {
  const backend = fakeBackend(() => new Response("{}"));
  const res = await worker.fetch(
    new Request("https://dashboard.example/api/overview", { headers: { Cookie: "nmai_session=not.a.valid.jwt" } }),
    configuredEnv(backend),
  );
  assert.equal(res.status, 401);
  assert.equal(backend.calls.length, 0);
});

test("GET /api/* with a valid session forwards path + query to backend and returns its status and body", async () => {
  const backend = fakeBackend(() => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }));
  const env = configuredEnv(backend);
  const cookie = await sessionCookie(env);
  const res = await worker.fetch(new Request("https://dashboard.example/api/llm-calls?llmLimit=25&env=live", { headers: { Cookie: cookie } }), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(backend.calls.length, 1);
  assert.equal(backend.calls[0].url, "https://backend/api/llm-calls?llmLimit=25&env=live");
  assert.equal(backend.calls[0].method, "GET");
});

test("GET /api/* passes a backend error status through (e.g. 404)", async () => {
  const backend = fakeBackend(() => new Response(JSON.stringify({ error: "nope" }), { status: 404, headers: { "content-type": "application/json" } }));
  const env = configuredEnv(backend);
  const cookie = await sessionCookie(env);
  const res = await worker.fetch(new Request("https://dashboard.example/api/llm-calls/999", { headers: { Cookie: cookie } }), env);
  assert.equal(res.status, 404);
});

test("GET /api/* returns 502 when the backend call itself throws", async () => {
  const backend = { fetch: async () => { throw new Error("binding down"); } };
  const env = configuredEnv(backend);
  const cookie = await sessionCookie(env);
  const res = await worker.fetch(new Request("https://dashboard.example/api/overview", { headers: { Cookie: cookie } }), env);
  assert.equal(res.status, 502);
});

test("non-GET /api/* is NOT forwarded (writes only go through the explicit POST routes)", async () => {
  const backend = fakeBackend(() => new Response("{}"));
  const env = configuredEnv(backend);
  const cookie = await sessionCookie(env);
  const res = await worker.fetch(new Request("https://dashboard.example/api/overview", { method: "POST", headers: { Cookie: cookie } }), env);
  assert.equal(res.status, 200); // falls through to the default "dashboard is running" response
  assert.match(await res.text(), /dashboard is running/);
  assert.equal(backend.calls.length, 0);
});
