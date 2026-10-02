// Covers the DAILY-quota cooldown encoding in shared/cooldown.js (`daily:<expiry epoch ms>`):
// setCooldown(..., {daily}), getCooldown, isCoolingDown compatibility with the legacy "1" value,
// and dailyQuotaCooldownSeconds. This is what lets a later cascade see "this key is out for the
// day, and for how long" from the single KV get() it already makes.

import test from "node:test";
import assert from "node:assert/strict";
import { setCooldown, getCooldown, isCoolingDown, dailyQuotaCooldownSeconds } from "../src/shared/cooldown.js";

function fakeKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  const puts = [];
  return {
    puts,
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value, options) { puts.push({ key, value, options }); store.set(key, value); },
  };
}

test("a plain setCooldown still stores '1' with the 60s-floored TTL (legacy shape unchanged)", async () => {
  const kv = fakeKv();
  await setCooldown(kv, "lite", 0, 5);
  assert.deepEqual(kv.puts, [{ key: "gemini:cooldown:lite:0", value: "1", options: { expirationTtl: 60 } }]);
});

test("a daily setCooldown stores daily:<now + ttl in ms> and the same TTL", async () => {
  const kv = fakeKv();
  await setCooldown(kv, "lite", 1, 3600, { daily: true, now: 1_000_000 });
  assert.deepEqual(kv.puts, [{ key: "gemini:cooldown:lite:1", value: `daily:${1_000_000 + 3600 * 1000}`, options: { expirationTtl: 3600 } }]);
});

test("getCooldown: null when absent, {daily:false} for a legacy '1', {daily:true, remainingSeconds} for a daily value", async () => {
  const kv = fakeKv();
  assert.equal(await getCooldown(kv, "lite", 0), null);

  await setCooldown(kv, "lite", 0, 90);
  assert.deepEqual(await getCooldown(kv, "lite", 0), { daily: false, remainingSeconds: null });

  await setCooldown(kv, "lite", 1, 3600, { daily: true, now: 1_000_000 });
  assert.deepEqual(await getCooldown(kv, "lite", 1, 1_000_000 + 600 * 1000), { daily: true, remainingSeconds: 3000 });
});

test("getCooldown floors remaining to the 60s KV minimum, rounds up, and reports null remaining for a garbled expiry", async () => {
  const kv = fakeKv({ "gemini:cooldown:a:0": "daily:1000000", "gemini:cooldown:b:0": "daily:not-a-number" });
  assert.equal((await getCooldown(kv, "a", 0, 1_000_000 + 1000)).remainingSeconds, 60, "already past expiry -> floor");
  assert.equal((await getCooldown(kv, "a", 0, 1_000_000 - 90_500)).remainingSeconds, 91, "90.5s left rounds up");
  assert.deepEqual(await getCooldown(kv, "b", 0), { daily: true, remainingSeconds: null });
});

test("isCoolingDown is true for both the legacy and the daily encodings, false when absent", async () => {
  const kv = fakeKv();
  assert.equal(await isCoolingDown(kv, "lite", 0), false);
  await setCooldown(kv, "lite", 0, 60);
  await setCooldown(kv, "lite", 1, 3600, { daily: true });
  assert.equal(await isCoolingDown(kv, "lite", 0), true);
  assert.equal(await isCoolingDown(kv, "lite", 1), true);
});

test("the cooldown helpers fail open: no KV, or a throwing KV, reads as 'not cooling down' and writes no-op", async () => {
  assert.equal(await getCooldown(undefined, "lite", 0), null);
  await setCooldown(undefined, "lite", 0, 60, { daily: true });
  const broken = { async get() { throw new Error("kv down"); }, async put() { throw new Error("kv down"); } };
  assert.equal(await getCooldown(broken, "lite", 0), null);
  assert.equal(await isCoolingDown(broken, "lite", 0), false);
  await assert.doesNotReject(setCooldown(broken, "lite", 0, 60, { daily: true }));
});

test("dailyQuotaCooldownSeconds is the time to the next Pacific midnight plus a 5 minute buffer", () => {
  // 2026-01-15T20:00:00Z is 12:00 PST (UTC-8): 12h to midnight.
  assert.equal(dailyQuotaCooldownSeconds(new Date("2026-01-15T20:00:00.000Z")), 12 * 3600 + 300);
  // 2026-07-15T19:00:00Z is 12:00 PDT (UTC-7): also 12h -- the DST shift is handled by Intl.
  assert.equal(dailyQuotaCooldownSeconds(new Date("2026-07-15T19:00:00.000Z")), 12 * 3600 + 300);
  // Just after Pacific midnight: nearly a full day.
  assert.equal(dailyQuotaCooldownSeconds(new Date("2026-01-15T08:00:01.000Z")), 24 * 3600 - 1 + 300);
});
