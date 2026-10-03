// shared/cooldown_map_kv.js: every Gemini cooldown lives in ONE KV key, so a part / live message
// costs one read however many model/key pairs the cascade walks (live incident 2026-10-03: ~29-38
// reads per backtest part while most pairs were cooling down, 26k of the 50k daily KV reads, and a
// part's 40-subrequest budget spent on reads alone). shared/cooldown.js and the cascade are
// unchanged; these tests drive them through the wrapper.

import test from "node:test";
import assert from "node:assert/strict";
import { cooldownMapKv, COOLDOWN_MAP_KEY } from "../src/shared/cooldown_map_kv.js";
import { setCooldown, getCooldown } from "../src/shared/cooldown.js";
import { geminiGenerateContent, _resetKeyRotationForTests } from "../src/llm/gemini/client.js";
import { VendorError } from "../src/shared/errors.js";

/** A KV that records every operation. */
function countingKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  const ops = { gets: [], puts: [] };
  return {
    store,
    ops,
    async get(key) {
      ops.gets.push(key);
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value, options) {
      ops.puts.push({ key, value, options });
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
    async list() {
      return { keys: [] };
    },
  };
}

const mapOf = (obj) => JSON.stringify(obj);
const K = (model, i) => `gemini:cooldown:${model}:${i}`;

test("many per-key cooldown reads cost exactly ONE underlying KV read, and report daily / per-minute remaining time", async () => {
  const t = 1_000_000;
  const kv = countingKv({
    [COOLDOWN_MAP_KEY]: mapOf({ [K("a", 0)]: ["daily:2000000", 2_000_000], [K("b", 1)]: ["1", t + 300_000] }),
  });
  const wrapped = cooldownMapKv(kv, { now: () => t });

  for (let i = 0; i < 20; i++) assert.equal(await getCooldown(wrapped, "other", i, t), null);
  assert.deepEqual(await getCooldown(wrapped, "a", 0, t), { daily: true, remainingSeconds: 1000 });
  assert.deepEqual(await getCooldown(wrapped, "b", 1, t), { daily: false, remainingSeconds: 300 }, "a per-minute cooldown now knows its real remaining time");
  assert.deepEqual(kv.ops.gets, [COOLDOWN_MAP_KEY], "one read of the map, nothing per model/key");
});

test("an expired entry never reads as cooling, however old the cached map is", async () => {
  let t = 1_000_000;
  const kv = countingKv({ [COOLDOWN_MAP_KEY]: mapOf({ [K("a", 0)]: ["1", 1_050_000], [K("b", 0)]: ["1", 999_999] }) });
  const wrapped = cooldownMapKv(kv, { now: () => t });

  assert.notEqual(await getCooldown(wrapped, "a", 0, t), null);
  assert.equal(await getCooldown(wrapped, "b", 0, t), null, "already expired when loaded");
  t = 1_050_001;
  assert.equal(await getCooldown(wrapped, "a", 0, t), null, "expired since it was cached");
  assert.equal(kv.ops.gets.length, 1, "and still no second read");
});

test("setCooldown writes the map back with one put; the TTL is the longest remaining entry; the entry is readable at once", async () => {
  const t = 1_000_000;
  const kv = countingKv();
  const wrapped = cooldownMapKv(kv, { now: () => t, exclusiveWriter: true });

  await setCooldown(wrapped, "m", 0, 90, { now: t });
  assert.equal(kv.ops.puts.length, 1);
  assert.equal(kv.ops.puts[0].key, COOLDOWN_MAP_KEY);
  assert.deepEqual(JSON.parse(kv.ops.puts[0].value), { [K("m", 0)]: ["1", t + 90_000] });
  assert.deepEqual(kv.ops.puts[0].options, { expirationTtl: 90 });
  assert.deepEqual(await getCooldown(wrapped, "m", 0, t), { daily: false, remainingSeconds: 90 });

  await setCooldown(wrapped, "d", 1, 3600, { daily: true, now: t });
  assert.deepEqual(kv.ops.puts[1].options, { expirationTtl: 3600 }, "the map key lives as long as its longest entry");
  assert.deepEqual(Object.keys(JSON.parse(kv.ops.puts[1].value)).sort(), [K("d", 1), K("m", 0)]);
  assert.deepEqual(await getCooldown(wrapped, "d", 1, t), { daily: true, remainingSeconds: 3600 });
  assert.equal(kv.ops.gets.length, 1, "an exclusive writer never re-reads before a put");
});

test("a shared-writer put RE-READS the map first, so it does not clobber a cooldown another invocation recorded", async () => {
  const t = 1_000_000;
  const kv = countingKv({ [COOLDOWN_MAP_KEY]: mapOf({ [K("x", 0)]: ["1", t + 100_000] }) });
  const wrapped = cooldownMapKv(kv, { now: () => t });

  assert.notEqual(await getCooldown(wrapped, "x", 0, t), null); // first load
  kv.store.set(COOLDOWN_MAP_KEY, mapOf({ [K("x", 0)]: ["1", t + 100_000], [K("y", 0)]: ["1", t + 100_000] })); // another invocation recorded y
  await setCooldown(wrapped, "z", 0, 60, { now: t });

  assert.deepEqual(Object.keys(JSON.parse(kv.store.get(COOLDOWN_MAP_KEY))).sort(), [K("x", 0), K("y", 0), K("z", 0)]);
  assert.equal(kv.ops.gets.length, 2);
});

test("refreshMs: the cached map is trusted for that long, then re-read", async () => {
  let t = 1_000_000;
  const kv = countingKv();
  const wrapped = cooldownMapKv(kv, { now: () => t, refreshMs: 15_000 });

  await wrapped.get(K("a", 0));
  t += 10_000;
  await wrapped.get(K("a", 0));
  assert.equal(kv.ops.gets.length, 1);
  t += 6_000;
  await wrapped.get(K("a", 0));
  assert.equal(kv.ops.gets.length, 2);
});

test("other keys and typed gets pass straight through and never touch the map", async () => {
  const kv = countingKv({ other: "v" });
  const wrapped = cooldownMapKv(kv);

  assert.equal(await wrapped.get("other"), "v");
  await wrapped.put("other2", "x", { expirationTtl: 5 });
  assert.deepEqual(kv.ops.puts, [{ key: "other2", value: "x", options: { expirationTtl: 5 } }]);
  assert.equal(await wrapped.get(K("a", 0), "json"), null);
  assert.deepEqual(kv.ops.gets, ["other", K("a", 0)], "the typed get went to the underlying per-key name, not the map");
  assert.deepEqual(await wrapped.list({ prefix: "x" }), { keys: [] });
});

test("a garbled map reads as empty (and the next put replaces it); a throwing KV fails open", async () => {
  const kv = countingKv({ [COOLDOWN_MAP_KEY]: "not json" });
  const wrapped = cooldownMapKv(kv, { exclusiveWriter: true });
  assert.equal(await getCooldown(wrapped, "a", 0), null);
  await setCooldown(wrapped, "a", 0, 60);
  assert.deepEqual(Object.keys(JSON.parse(kv.store.get(COOLDOWN_MAP_KEY))), [K("a", 0)]);

  const broken = cooldownMapKv({ async get() { throw new Error("kv down"); }, async put() { throw new Error("kv down"); } });
  assert.equal(await getCooldown(broken, "a", 0), null);
  await assert.doesNotReject(setCooldown(broken, "a", 0, 60, { daily: true }));
});

// ---------------------------------------------------------------------------
// Through the real cascade
// ---------------------------------------------------------------------------

function cascadeConfig(overrides = {}) {
  return {
    geminiApiKeys: ["key-a", "key-b"], geminiApiBase: "https://gemini.test/v1beta", geminiRequestTimeoutMs: 5000,
    geminiQuickModel: "m-quick", geminiDeepModel: "m-deep", geminiFallbackModels: ["m-fb"], ...overrides,
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

test("cascade: with EVERY model/key cooling, no call is made, ONE KV read is spent, and the retry hint is the SOONEST real expiry", async (t) => {
  t.mock.method(console, "log", () => {});
  const NOW = 5_000_000;
  t.mock.method(Date, "now", () => NOW);
  _resetKeyRotationForTests();
  const kv = countingKv({
    [COOLDOWN_MAP_KEY]: mapOf({
      [K("m-quick", 0)]: ["1", NOW + 300_000], [K("m-quick", 1)]: ["1", NOW + 300_000],
      [K("m-fb", 0)]: ["1", NOW + 200_000], [K("m-fb", 1)]: ["1", NOW + 240_000],
    }),
  });
  const calls = mockFetch(t, () => jsonResponse(200, {}));

  let err;
  try {
    await geminiGenerateContent({ CACHE_KV: cooldownMapKv(kv, { exclusiveWriter: true }) }, cascadeConfig(), { contents: [] });
  } catch (e) {
    err = e;
  }

  assert.ok(err instanceof VendorError, "the cascade must throw");
  assert.equal(calls.length, 0);
  assert.equal(err.transient, true);
  assert.equal(err.retryAfterSeconds, 200, "the shortest REAL remaining time, not the flat 60s default");
  assert.equal(err.dailyQuota, undefined, "per-minute cooldowns are not a daily-quota pause");
  assert.match(err.message, /every model\/key was in a recorded cooldown/);
  assert.deepEqual(kv.ops.gets, [COOLDOWN_MAP_KEY], "4 pairs walked, 1 KV read");
  assert.equal(kv.ops.puts.length, 0);
});

test("cascade: a healthy call spends one KV read and no write; a 429 spends one write that lands in the map", async (t) => {
  t.mock.method(console, "log", () => {});
  const NOW = 7_000_000;
  t.mock.method(Date, "now", () => NOW);
  _resetKeyRotationForTests();

  const healthyKv = countingKv();
  mockFetch(t, () => jsonResponse(200, { candidates: [] }));
  await geminiGenerateContent({ CACHE_KV: cooldownMapKv(healthyKv, { exclusiveWriter: true }) }, cascadeConfig({ geminiApiKeys: ["key-a"] }), { contents: [] });
  assert.deepEqual(healthyKv.ops.gets, [COOLDOWN_MAP_KEY]);
  assert.equal(healthyKv.ops.puts.length, 0);

  _resetKeyRotationForTests();
  const kv = countingKv();
  mockFetch(t, (url) => (url.includes("m-quick") ? jsonResponse(429, { error: { message: "Quota exceeded. Please retry in 70s." } }) : jsonResponse(200, { candidates: [] })));
  const data = await geminiGenerateContent({ CACHE_KV: cooldownMapKv(kv, { exclusiveWriter: true }) }, cascadeConfig({ geminiApiKeys: ["key-a"] }), { contents: [] });

  assert.equal(data._fallbackModelUsed, "m-fb");
  assert.deepEqual(kv.ops.gets, [COOLDOWN_MAP_KEY], "the 429's own cooldown write needs no extra read");
  assert.equal(kv.ops.puts.length, 1);
  assert.equal(kv.ops.puts[0].key, COOLDOWN_MAP_KEY);
  assert.deepEqual(JSON.parse(kv.ops.puts[0].value), { [K("m-quick", 0)]: ["1", NOW + 70_000] });
  assert.deepEqual(kv.ops.puts[0].options, { expirationTtl: 70 });
});
