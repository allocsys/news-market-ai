// Gemini JSON handling: (1) geminiGenerateText can ask for JSON output (generationConfig.responseMimeType),
// (2) parseModelJson repairs a trailing comma before } or ] and nothing else, (3) callStructured uses both,
// so a reply like `{ "a": 1, }` no longer fails the parse stage (which made a backtest skip the news item).

import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { geminiGenerateText, parseModelJson, stripTrailingCommas } from "../src/llm/gemini/client.js";
import { callStructured } from "../src/agents/utils/structured.js";

const CONFIG = {
  geminiQuickModel: "test-model",
  geminiApiKeys: ["k"],
  geminiFallbackModels: [],
  geminiApiBase: "https://example.invalid",
  geminiRequestTimeoutMs: 1000,
};

function mockGemini(t, replyText) {
  const bodies = [];
  t.mock.method(global, "fetch", async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return { ok: true, text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: replyText }] } }] }) };
  });
  return bodies;
}

test("parseModelJson parses valid JSON and fenced JSON exactly as before", () => {
  assert.deepEqual(parseModelJson('{"a": 1, "b": [1, 2]}'), { a: 1, b: [1, 2] });
  assert.deepEqual(parseModelJson('```json\n{"a": 1}\n```'), { a: 1 });
});

test("parseModelJson repairs trailing commas in nested objects and arrays (multi-line)", () => {
  const text = '{\n  "summary": "up",\n  "detail": {\n    "x": 1,\n    "y": [1, 2, 3,],\n    },\n}';
  assert.deepEqual(parseModelJson(text), { summary: "up", detail: { x: 1, y: [1, 2, 3] } });
});

test("trailing-comma repair never touches commas inside strings", () => {
  const text = '{"a": "x,}", "b": "y,]", "c": [1,],}';
  assert.deepEqual(parseModelJson(text), { a: "x,}", b: "y,]", c: [1] });
  assert.equal(stripTrailingCommas('{"a": "q\\",}",}'), '{"a": "q\\",}"}');
});

test("parseModelJson still throws the ORIGINAL error for genuinely broken JSON", () => {
  assert.throws(() => parseModelJson('{"a": 1 "b": 2}'), SyntaxError);
  assert.throws(() => parseModelJson("not json at all"), SyntaxError);
  // Unquoted key: the comma repair cannot fix it, so the first error surfaces.
  assert.throws(() => parseModelJson("{a: 1,}"), /property name/i);
});

test("geminiGenerateText sends responseMimeType only when json is requested", async (t) => {
  const bodies = mockGemini(t, "{}");
  await geminiGenerateText({}, CONFIG, "p");
  await geminiGenerateText({}, CONFIG, "p", { json: true });
  await geminiGenerateText({}, CONFIG, "p", { json: true, maxOutputTokens: 50 });
  assert.equal(bodies[0].generationConfig, undefined);
  assert.deepEqual(bodies[1].generationConfig, { responseMimeType: "application/json" });
  assert.deepEqual(bodies[2].generationConfig, { maxOutputTokens: 50, responseMimeType: "application/json" });
});

test("callStructured requests JSON output and survives a trailing comma in the reply", async (t) => {
  const bodies = mockGemini(t, '{\n  "a": 1,\n  "nested": {\n    "b": 2,\n    },\n}');
  const schema = z.object({ a: z.number(), nested: z.object({ b: z.number() }) });
  const result = await callStructured({}, CONFIG, schema, "prompt", { label: "test" });
  assert.deepEqual(result, { a: 1, nested: { b: 2 } });
  assert.equal(bodies[0].generationConfig.responseMimeType, "application/json");
});

test("callStructured still reports a parse error for unrepairable output", async (t) => {
  mockGemini(t, "{a: 1}");
  const schema = z.object({ a: z.number() });
  await assert.rejects(() => callStructured({}, CONFIG, schema, "prompt", { label: "test" }), SyntaxError);
});
