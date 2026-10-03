// A Gemini model that 404s (retired / unavailable to this project) used to be
// re-discovered by EVERY call that reached it: one wasted attempt each time
// (a backtest call only gets MAX_ATTEMPTS_UNDER_BUDGET) and no loud signal.
// Now the first 404 is logged at error level and remembered in the cooldown
// store for DEAD_MODEL_COOLDOWN_SECONDS; later calls skip the model up front.
// If the marks would leave NO model, they are ignored so a false 404 cannot
// take the cascade down for hours. (The in-call 404 handling itself is covered
// in llm_call_log.test.js.)

import test from "node:test";
import assert from "node:assert/strict";
import { geminiGenerateContent, DEAD_MODEL_COOLDOWN_SECONDS } from "../src/llm/gemini/client.js";
import { cooldownMapKv, COOLDOWN_MAP_KEY } from "../src/shared/cooldown_map_kv.js";

const DEAD_KEY = (model) => `gemini:cooldown:dead-${model}:0`;

function cascadeConfig(overrides = {}) {
  return {
    geminiApiKeys: ["key-a"], geminiApiBase: "https://gemini.test/v1beta", geminiRequestTimeoutMs: 5000,
    geminiQuickModel: "m-quick", geminiDeepModel: "m-deep", geminiFallbackModels: ["m-fallback"], ...overrides,
  };
}

function mockFetch(t, handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    return handler(String(url), init);
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ok = () => jsonResponse(200, { candidates: [{ content: { parts: [{ text: "hi" }] } }] });
const retired = () => jsonResponse(404, { error: { message: "no longer available to new users" } });

/** In-memory KV that applies writes (TTL ignored) and records them. */
function memoryKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  const puts = [];
  const gets = [];
  return {
    store, puts, gets,
    get: async (key) => { gets.push(key); return store.has(key) ? store.get(key) : null; },
    put: async (key, value, opts) => { puts.push([key, value, opts]); store.set(key, value); },
  };
}

test("the first 404 is logged at error level, names the model, and is remembered for 6h", async (t) => {
  t.mock.method(console, "log", () => {});
  const errors = t.mock.method(console, "error", () => {});
  mockFetch(t, (url) => (url.includes("m-quick") ? retired() : ok()));
  const kv = memoryKv();

  const data = await geminiGenerateContent({ CACHE_KV: kv }, cascadeConfig(), { contents: [] });

  assert.equal(data._fallbackModelUsed, "m-fallback");
  assert.equal(errors.mock.callCount(), 1);
  const message = String(errors.mock.calls[0].arguments[0]);
  assert.match(message, /MODEL UNAVAILABLE \(404\)/);
  assert.match(message, /"m-quick"/);
  assert.match(message, /GEMINI_FALLBACK_MODELS/);
  assert.equal(DEAD_MODEL_COOLDOWN_SECONDS, 6 * 3600);
  assert.deepEqual(kv.puts, [[DEAD_KEY("m-quick"), "1", { expirationTtl: DEAD_MODEL_COOLDOWN_SECONDS }]]);
});

test("a LATER call skips the remembered model up front: no request, no attempt, no second error line", async (t) => {
  t.mock.method(console, "log", () => {});
  const errors = t.mock.method(console, "error", () => {});
  const calls = mockFetch(t, (url) => (url.includes("m-quick") ? retired() : ok()));
  const kv = memoryKv();

  await geminiGenerateContent({ CACHE_KV: kv }, cascadeConfig(), { contents: [] }); // discovers + records
  calls.length = 0;
  errors.mock.resetCalls();

  const trace = {};
  await geminiGenerateContent({ CACHE_KV: kv }, cascadeConfig(), { contents: [] }, { trace });

  assert.equal(calls.filter((u) => u.includes("m-quick")).length, 0, "the retired model is not requested again");
  assert.deepEqual(trace.attempts.map((a) => [a.model, a.outcome]), [["m-fallback", "ok"]], "and it does not consume an attempt");
  assert.equal(errors.mock.callCount(), 0, "the loud line fires once per window, not per call");
});

test("if the marks would leave NO model, they are ignored and the cascade tries for real (a false 404 heals itself)", async (t) => {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
  const calls = mockFetch(t, () => ok());
  const kv = memoryKv({ [DEAD_KEY("m-quick")]: "1", [DEAD_KEY("m-fallback")]: "1" });

  const data = await geminiGenerateContent({ CACHE_KV: kv }, cascadeConfig(), { contents: [] });

  assert.ok(data.candidates, "the call went through");
  assert.equal(calls.filter((u) => u.includes("m-quick")).length, 1, "the primary was actually tried");
});

test("a 404 on the only model NOT already marked dead is surfaced (nothing live is left)", async (t) => {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
  mockFetch(t, () => retired());
  const kv = memoryKv({ [DEAD_KEY("m-quick")]: "1" });

  await assert.rejects(geminiGenerateContent({ CACHE_KV: kv }, cascadeConfig(), { contents: [] }), /no longer available/);
});

test("marks do not collide with real cooldowns: a rate-limited model is still a cooldown skip, not a dead model", async (t) => {
  t.mock.method(console, "log", () => {});
  const errors = t.mock.method(console, "error", () => {});
  mockFetch(t, (url) => (url.includes("m-quick") ? jsonResponse(429, { error: { message: "Quota exceeded. Please retry in 70s." } }) : ok()));
  const kv = memoryKv();

  await geminiGenerateContent({ CACHE_KV: kv }, cascadeConfig(), { contents: [] });

  assert.equal(errors.mock.callCount(), 0);
  assert.deepEqual(kv.puts.map((p) => p[0]), ["gemini:cooldown:m-quick:0"], "only the real cooldown key was written");
});

test("through the single-map store the dead marker costs no extra KV read", async (t) => {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
  mockFetch(t, (url) => (url.includes("m-quick") ? retired() : ok()));
  const kv = memoryKv();
  const wrapped = cooldownMapKv(kv, { exclusiveWriter: true });

  await geminiGenerateContent({ CACHE_KV: wrapped }, cascadeConfig({ geminiApiKeys: ["key-a", "key-b"] }), { contents: [] });

  assert.deepEqual(kv.gets, [COOLDOWN_MAP_KEY], "markers for every model + the per-key cooldown checks: ONE underlying read");
  assert.equal(kv.puts.length, 1);
  assert.equal(kv.puts[0][0], COOLDOWN_MAP_KEY);
  assert.deepEqual(Object.keys(JSON.parse(kv.puts[0][1])), [DEAD_KEY("m-quick")]);

  // A second call through a fresh wrapper over the same KV skips the model.
  const calls = mockFetch(t, (url) => (url.includes("m-quick") ? retired() : ok()));
  await geminiGenerateContent({ CACHE_KV: cooldownMapKv(kv, { exclusiveWriter: true }) }, cascadeConfig(), { contents: [] });
  assert.equal(calls.filter((u) => u.includes("m-quick")).length, 0);
});
