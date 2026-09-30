// A Gemini free-tier 429 is either a per-minute (RPM) limit that clears within
// a minute or a per-day (RPD) one that lasts until midnight Pacific. The old
// check matched `free_tier_requests`, present in BOTH, so RPM 429s got a
// day-long cooldown. classifyRateLimit now separates them (quotaId first).

import test from "node:test";
import assert from "node:assert/strict";
import { classifyRateLimit, isDailyQuotaError, dailyQuotaCooldownSeconds } from "../src/shared/cooldown.js";
import { geminiGenerateContent } from "../src/llm/gemini/client.js";

const RPM_MSG = "You exceeded your current quota. * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 5, model: gemini-3.6-flash";
const RPD_MSG = "You exceeded your current quota. * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.6-flash";
const TPM_MSG = "Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 250000, model: gemini-3.6-flash";

test("quotaId is authoritative", () => {
  assert.equal(classifyRateLimit(RPM_MSG, "GenerateRequestsPerDayPerProjectPerModel-FreeTier"), "daily");
  assert.equal(classifyRateLimit(RPD_MSG, "GenerateRequestsPerMinutePerProjectPerModel-FreeTier"), "minute");
});

test("without a quotaId, free_tier_requests alone no longer means daily; `limit: N` decides", () => {
  assert.equal(classifyRateLimit(RPM_MSG), "minute");
  assert.equal(classifyRateLimit("... limit: 10, model: x"), "minute");
  assert.equal(classifyRateLimit("... limit: 15, model: x"), "minute");
  assert.equal(classifyRateLimit(RPD_MSG), "daily");
  assert.equal(classifyRateLimit("... limit: 500, model: x"), "daily");
});

test("PerDay / PerMinute named in the message is honored; token quotas and unknowns default to minute", () => {
  assert.equal(classifyRateLimit("quota GenerateRequestsPerDayPerProjectPerModel exceeded"), "daily");
  assert.equal(classifyRateLimit("quota GenerateRequestsPerMinutePerProjectPerModel exceeded"), "minute");
  assert.equal(classifyRateLimit(TPM_MSG), "minute", "a 250000 token limit is not a daily request quota");
  assert.equal(classifyRateLimit("Resource exhausted"), "minute");
  assert.equal(classifyRateLimit(undefined), "minute");
});

test("isDailyQuotaError keeps working as a boolean wrapper", () => {
  assert.equal(isDailyQuotaError(RPD_MSG), true);
  assert.equal(isDailyQuotaError(RPM_MSG), false);
  assert.equal(isDailyQuotaError(RPM_MSG, "GenerateRequestsPerDayPerProjectPerModel-FreeTier"), true);
});

function cascadeConfig() {
  return {
    geminiApiKeys: ["key-a"], geminiApiBase: "https://gemini.test/v1beta", geminiRequestTimeoutMs: 5000,
    geminiQuickModel: "m-quick", geminiDeepModel: "m-deep", geminiFallbackModels: ["m-fallback"],
  };
}

function fakeKv() {
  const puts = [];
  return { puts, get: async () => null, put: async (key, value, opts) => { puts.push([key, value, opts]); } };
}

function quota429(message, quotaId) {
  const error = { message };
  if (quotaId) error.details = [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaMetric: "m", quotaId }] }];
  return new Response(JSON.stringify({ error }), { status: 429, headers: { "content-type": "application/json" } });
}

async function runCascade(t, first) {
  t.mock.method(console, "log", () => {});
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => (String(url).includes("m-quick") ? first : new Response(JSON.stringify({ candidates: [] }), { status: 200 }));
  t.after(() => { globalThis.fetch = original; });
  const kv = fakeKv();
  await geminiGenerateContent({ CACHE_KV: kv }, cascadeConfig(), { contents: [] });
  return kv;
}

test("an RPM 429 (limit: 5, no quotaId) cools the model for 60s, NOT until midnight Pacific", async (t) => {
  const kv = await runCascade(t, quota429(RPM_MSG));
  assert.equal(kv.puts.length, 1);
  assert.equal(kv.puts[0][2].expirationTtl, 60);
});

test("an RPD 429 (quotaId PerDay) cools the model until the next Pacific midnight", async (t) => {
  const kv = await runCascade(t, quota429(RPM_MSG, "GenerateRequestsPerDayPerProjectPerModel-FreeTier"));
  assert.equal(kv.puts.length, 1);
  const ttl = kv.puts[0][2].expirationTtl;
  assert.ok(ttl > 60 && ttl <= dailyQuotaCooldownSeconds() + 1, `daily cooldown ttl was ${ttl}`);
});
