// structured_fakemodel test -- covers the fake-model injection point added
// to agents/utils/structured.js#callStructured (plan.md open item, closed
// 2026-09-17: "structured.js has no fake-model injection point yet"). This
// is the piece that unblocks checkpoint_resume.test.js's full-pipeline test
// and memory_pointintime.test.js's recordAndReflect test below, neither of
// which could exercise a real LLM-call path before this existed.

import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { callStructured } from "../src/agents/utils/structured.js";

const Simple = z.object({ value: z.string() });

test("callStructured uses config.fakeModel instead of the real Gemini cascade when set", async (t) => {
  let fetchCalled = false;
  t.mock.method(global, "fetch", async () => {
    fetchCalled = true;
    throw new Error("fetch should never be called when config.fakeModel is set");
  });

  const config = {
    geminiQuickModel: "quick-model",
    fakeModel: async () => JSON.stringify({ value: "from fake model" }),
  };

  const result = await callStructured({}, config, Simple, "irrelevant prompt");

  assert.equal(fetchCalled, false);
  assert.equal(result.value, "from fake model");
});

test("callStructured passes prompt, model, schema, extraFields, env, and config through to fakeModel", async () => {
  let captured = null;
  const env = { CACHE_KV: "fake-kv-marker" };
  const config = {
    geminiQuickModel: "default-quick-model",
    fakeModel: async (prompt, opts) => {
      captured = { prompt, ...opts };
      return JSON.stringify({ value: "ok" });
    },
  };

  await callStructured(env, config, Simple, "the actual prompt text", {
    model: "explicit-model",
    extraFields: { ticker: "AAPL" },
  });

  assert.equal(captured.prompt, "the actual prompt text");
  assert.equal(captured.model, "explicit-model");
  assert.equal(captured.schema, Simple); // exact schema reference, so a test can dispatch on identity
  assert.deepEqual(captured.extraFields, { ticker: "AAPL" });
  assert.equal(captured.env, env);
  assert.equal(captured.config, config);
});

test("callStructured falls back to config.geminiQuickModel when no explicit model is passed to fakeModel", async () => {
  let capturedModel = null;
  const config = {
    geminiQuickModel: "the-default-model",
    fakeModel: async (prompt, opts) => {
      capturedModel = opts.model;
      return JSON.stringify({ value: "ok" });
    },
  };

  await callStructured({}, config, Simple, "prompt", {}); // no `model` in opts

  assert.equal(capturedModel, "the-default-model");
});

test("callStructured still strips a ```json fence from a fake model's output", async () => {
  const config = {
    geminiQuickModel: "m",
    fakeModel: async () => "```json\n" + JSON.stringify({ value: "fenced" }) + "\n```",
  };

  const result = await callStructured({}, config, Simple, "prompt");
  assert.equal(result.value, "fenced");
});

test("callStructured's parsed fake-model output takes precedence over extraFields when both define the same key (matches real-model precedence)", async () => {
  const config = {
    geminiQuickModel: "m",
    fakeModel: async () => JSON.stringify({ value: "from fake model" }),
  };

  // extraFields is meant for values the caller already knows and the model
  // doesn't need to echo back (e.g. newsItemId) -- but if the model DOES
  // return the same key, `{...extraFields, ...parsed}` means the model's
  // own answer wins, same as it would with a real Gemini response.
  const result = await callStructured({}, config, Simple, "prompt", { extraFields: { value: "from extra fields" } });
  assert.equal(result.value, "from fake model");
});

test("callStructured merges an extraFields key the fake model's output doesn't touch", async () => {
  const WithTwoFields = z.object({ value: z.string(), ticker: z.string() });
  const config = {
    geminiQuickModel: "m",
    fakeModel: async () => JSON.stringify({ value: "model-supplied" }), // no `ticker` here
  };

  const result = await callStructured({}, config, WithTwoFields, "prompt", { extraFields: { ticker: "AAPL" } });
  assert.equal(result.value, "model-supplied");
  assert.equal(result.ticker, "AAPL"); // came through from extraFields untouched
});

test("callStructured still enforces schema validation against a fake model's output -- a bad shape throws, same as a real prompt/schema mismatch would", async () => {
  const config = {
    geminiQuickModel: "m",
    fakeModel: async () => JSON.stringify({ wrongField: 123 }), // missing required `value: string`
  };

  await assert.rejects(() => callStructured({}, config, Simple, "prompt"));
});

test("callStructured falls through to the real Gemini cascade (global.fetch) when config.fakeModel is undefined -- unchanged production behavior", async (t) => {
  let fetchCalled = false;
  t.mock.method(global, "fetch", async (url, opts) => {
    fetchCalled = true;
    return {
      ok: true,
      text: async () =>
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify({ value: "real cascade" }) }] } }],
        }),
    };
  });

  const config = {
    geminiQuickModel: "test-model",
    geminiApiKeys: ["k"],
    geminiFallbackModels: [],
    geminiApiBase: "https://example.invalid",
    geminiRequestTimeoutMs: 1000,
    // fakeModel intentionally omitted
  };

  const result = await callStructured({}, config, Simple, "prompt");

  assert.equal(fetchCalled, true);
  assert.equal(result.value, "real cascade");
});
