// Round-robin starting-key rotation in geminiGenerateContent (issue: normal-
// load traffic all hit key #0 every time on the happy path, since the outer
// key loop always started at index 0 -- key 1+ was only ever reached once
// key 0 started erroring/cooling down. See client.js's `nextKeyStartIndex`
// header comment for the fix. This file only covers the ROTATION itself;
// gemini_cascade_exhaustion.test.js already covers cooldown/error/budget
// behavior in detail with a single key, where rotation is a no-op by
// construction (startIndex % 1 === 0 always) -- not repeated here.

import test from "node:test";
import assert from "node:assert/strict";
import { geminiGenerateContent, _resetKeyRotationForTests } from "../src/llm/gemini/client.js";

function cascadeConfig(overrides = {}) {
  return {
    geminiApiKeys: ["key-a", "key-b", "key-c"],
    geminiApiBase: "https://gemini.test/v1beta",
    geminiRequestTimeoutMs: 5000,
    geminiQuickModel: "m-quick",
    geminiFallbackModels: [],
    ...overrides,
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Records the `x-goog-api-key` header of every call; always succeeds unless `failingKeys` says otherwise. */
function mockFetch(t, { failingKeys = [] } = {}) {
  const original = globalThis.fetch;
  const keysSeen = [];
  globalThis.fetch = async (url, init) => {
    const key = init.headers["x-goog-api-key"];
    keysSeen.push(key);
    if (failingKeys.includes(key)) return jsonResponse(503, { error: { message: "high demand" } });
    return jsonResponse(200, { candidates: [{ content: { parts: [{ text: "ok" }] } }] });
  };
  t.after(() => { globalThis.fetch = original; });
  return keysSeen;
}

function fakeKv() {
  return { get: async () => null, put: async () => {} };
}

test.beforeEach(() => _resetKeyRotationForTests());

test("consecutive calls on the happy path rotate the starting key: key-a, key-b, key-c, key-a, ...", async (t) => {
  t.mock.method(console, "log", () => {});
  const keysSeen = mockFetch(t);
  const config = cascadeConfig();
  const env = { CACHE_KV: fakeKv() };

  for (let i = 0; i < 5; i++) {
    await geminiGenerateContent(env, config, { contents: [] });
  }

  // One fetch per call (no fallback models, first key attempted always succeeds).
  assert.deepEqual(keysSeen, ["key-a", "key-b", "key-c", "key-a", "key-b"]);
});

test("a mid-cascade failure still falls through to the NEXT key in rotation order, not back to key #0", async (t) => {
  t.mock.method(console, "log", () => {});
  // key-b fails, so the call that starts at key-b must fall through to key-c
  // (not wrap back to key-a) before succeeding.
  const keysSeen = mockFetch(t, { failingKeys: ["key-b"] });
  const config = cascadeConfig();
  const env = { CACHE_KV: fakeKv() };

  await geminiGenerateContent(env, config, { contents: [] }); // starts at key-a, succeeds immediately
  keysSeen.length = 0;
  await geminiGenerateContent(env, config, { contents: [] }); // starts at key-b (fails), falls through to key-c (succeeds)

  assert.deepEqual(keysSeen, ["key-b", "key-c"]);
});

test("rotation still starts at key #0 for a single-key config -- unchanged behavior when there's nothing to rotate", async (t) => {
  t.mock.method(console, "log", () => {});
  const keysSeen = mockFetch(t);
  const config = cascadeConfig({ geminiApiKeys: ["only-key"] });
  const env = { CACHE_KV: fakeKv() };

  await geminiGenerateContent(env, config, { contents: [] });
  await geminiGenerateContent(env, config, { contents: [] });

  assert.deepEqual(keysSeen, ["only-key", "only-key"]);
});

test("rotation index wraps and does not grow unbounded across many calls", async (t) => {
  t.mock.method(console, "log", () => {});
  const keysSeen = mockFetch(t);
  const config = cascadeConfig();
  const env = { CACHE_KV: fakeKv() };

  for (let i = 0; i < 7; i++) {
    await geminiGenerateContent(env, config, { contents: [] });
  }

  assert.deepEqual(keysSeen, ["key-a", "key-b", "key-c", "key-a", "key-b", "key-c", "key-a"]);
});
