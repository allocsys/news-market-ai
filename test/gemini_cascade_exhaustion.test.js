// What geminiGenerateContent throws when its whole model/key cascade ends with
// nothing usable. It used to rethrow whatever the loop touched LAST -- often a
// synthetic "model X is in a recorded cooldown" from a skipped combination --
// which hid the timeouts / 503s / 429s that had really put every model in
// cooldown (a live backtest died blaming gemini-2.5-flash's cooldown). Now the
// error names every attempt and the last real error, keeps the status/transient
// of the error it stands in for, and carries a retryAfterSeconds hint that lets
// the backtest PAUSE instead of failing (see backtest_gemini_outage_pause.test.js).

import test from "node:test";
import assert from "node:assert/strict";
import { geminiGenerateContent } from "../src/llm/gemini/client.js";
import { VendorError } from "../src/shared/errors.js";

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

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A KV whose cooldown entries exist for every key naming one of `coolingModels`; writes are recorded, never applied. */
function fakeKv(coolingModels = []) {
  const puts = [];
  return {
    puts,
    get: async (key) => (coolingModels.some((m) => key.includes(`:${m}:`)) ? "1" : null),
    put: async (key, value, opts) => { puts.push([key, value, opts]); },
  };
}

async function captureError(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  assert.fail("expected the cascade to throw");
}

test("an all-503 cascade throws ONE VendorError naming every attempt and the last real error, transient, with the status it stands in for", async (t) => {
  t.mock.method(console, "log", () => {});
  mockFetch(t, () => jsonResponse(503, { error: { message: "high demand" } }));

  const err = await captureError(geminiGenerateContent({ CACHE_KV: fakeKv() }, cascadeConfig(), { contents: [] }));

  assert.ok(err instanceof VendorError);
  assert.equal(err.vendor, "gemini");
  assert.equal(err.transient, true);
  assert.equal(err.status, 503);
  assert.equal(err.retryAfterSeconds, 60, "503s cool down for the default 60s");
  assert.match(err.message, /^Gemini cascade exhausted after \d+ms with no usable model/);
  assert.match(err.message, /m-quick#0 error 503/);
  assert.match(err.message, /m-fallback#0 error 503/);
  assert.match(err.message, /last error: .*high demand/);
});

test("the retryAfterSeconds hint follows the 429s' own retry delay, and is the SHORTEST cooldown the cascade recorded", async (t) => {
  t.mock.method(console, "log", () => {});

  mockFetch(t, () => jsonResponse(429, { error: { message: "Quota exceeded. Please retry in 120s." } }));
  const allRateLimited = await captureError(geminiGenerateContent({ CACHE_KV: fakeKv() }, cascadeConfig(), { contents: [] }));
  assert.equal(allRateLimited.status, 429);
  assert.equal(allRateLimited.retryAfterSeconds, 120);

  globalThis.fetch = async (url) => (String(url).includes("m-quick") ? jsonResponse(429, { error: { message: "Please retry in 120s." } }) : jsonResponse(503, { error: { message: "high demand" } }));
  const mixed = await captureError(geminiGenerateContent({ CACHE_KV: fakeKv() }, cascadeConfig(), { contents: [] }));
  assert.equal(mixed.retryAfterSeconds, 60, "the 503's 60s cooldown ends before the 429's 120s one");
});

test("when EVERY model is already in cooldown no call is made, and the error says so (transient, with a hint)", async (t) => {
  t.mock.method(console, "log", () => {});
  const calls = mockFetch(t, () => jsonResponse(200, {}));

  const err = await captureError(geminiGenerateContent({ CACHE_KV: fakeKv(["m-quick", "m-fallback"]) }, cascadeConfig(), { contents: [] }));

  assert.equal(calls.length, 0);
  assert.ok(err instanceof VendorError);
  assert.equal(err.transient, true);
  assert.equal(err.status, 429);
  assert.equal(err.retryAfterSeconds, 60);
  assert.match(err.message, /every model\/key was in a recorded cooldown/);
  assert.match(err.message, /m-quick#0 skipped/);
  assert.match(err.message, /m-fallback#0 skipped/);
});

test("the REAL cause survives a trailing cooldown skip: the last model is skipped, yet the error still carries the earlier 503", async (t) => {
  t.mock.method(console, "log", () => {});
  mockFetch(t, () => jsonResponse(503, { error: { message: "high demand" } }));

  const err = await captureError(geminiGenerateContent({ CACHE_KV: fakeKv(["m-fallback"]) }, cascadeConfig(), { contents: [] }));

  assert.match(err.message, /high demand/, "not just 'model m-fallback is in a recorded cooldown'");
  assert.match(err.message, /m-quick#0 error 503; m-fallback#0 skipped/);
  assert.equal(err.status, 503, "the real error's status, not the skip's synthetic 429");
  assert.equal(err.transient, true);
});

test("a non-transient failure (bad key) stays non-transient and carries no retry hint", async (t) => {
  t.mock.method(console, "log", () => {});
  mockFetch(t, () => jsonResponse(401, { error: { message: "API key not valid" } }));

  const err = await captureError(geminiGenerateContent({ CACHE_KV: fakeKv() }, cascadeConfig({ geminiFallbackModels: [] }), { contents: [] }));

  assert.ok(err instanceof VendorError);
  assert.equal(err.transient, false);
  assert.equal(err.status, 401);
  assert.equal("retryAfterSeconds" in err, false);
  assert.match(err.message, /API key not valid/);
});

test("the cascade's wall-clock budget error also names the attempts and carries the retry hint", async (t) => {
  t.mock.method(console, "log", () => {});
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  mockFetch(t, () => {
    now += 95000; // one slow attempt eats the whole 90s cascade budget
    return jsonResponse(503, { error: { message: "high demand" } });
  });

  const err = await captureError(geminiGenerateContent({ CACHE_KV: fakeKv() }, cascadeConfig(), { contents: [] }));

  assert.equal(err.transient, true);
  assert.equal(err.retryAfterSeconds, 60);
  assert.match(err.message, /exceeded its 90000ms budget after 95000ms/);
  assert.match(err.message, /m-quick#0 error 503/);
  assert.match(err.message, /last error: .*high demand/);
});
