// Covers the LLM call log after M2b: RunStore's llm_calls methods (write, clip,
// redact, read, prune, env_run_id scoping) over REAL SQL on the state schema,
// storage/llm_calls.js's pure helpers, the logging inside
// agents/utils/structured.js#callStructured (every
// outcome -- ok, vendor failure, unparseable JSON, schema mismatch -- and that
// logging can never change what a call returns or throws), and the cascade
// trace geminiGenerateContent fills in so a call that only succeeded after
// falling back is visible in the log.

import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { callStructured } from "../src/agents/utils/structured.js";
import { geminiGenerateContent } from "../src/llm/gemini/client.js";
import { recordLlmCall, withLlmLogContext, redactSecrets } from "../src/storage/llm_calls.js";
import { RunStore } from "../src/storage/run_store.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { STATE_DIR, stateRows } from "./helpers/engine_ctx.js";
import { BrokenDb } from "./helpers/broken_db.js";

const Answer = z.object({ verdict: z.string() });

function silenceWarn(t) {
  const original = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  t.after(() => { console.warn = original; });
  return warnings;
}

function loggingConfig(overrides = {}) {
  return { geminiQuickModel: "quick", geminiDeepModel: "deep", llmLogEnabled: true, llmLogMaxChars: 60000, ...overrides };
}

/** Fresh state DB + a RunStore over it; `rows()` reads llm_calls back raw. */
function makeLog(runId = "live") {
  const db = createTestD1([STATE_DIR]);
  const store = new RunStore(db, runId);
  return { db, store, rows: () => stateRows(db, "llm_calls", "id") };
}

/** A config whose log context points at `store` -- what runPipelineForTicker / checkOpenPositionExits do in production. */
function withStore(config, store, ctx = {}) {
  return withLlmLogContext(config, { store, ...ctx });
}

// ---------------------------------------------------------------------------
// insertLlmCall / recordLlmCall
// ---------------------------------------------------------------------------

test("insertLlmCall stores the full prompt and response verbatim, with true sizes, no truncation flag, and this store's env_run_id", async () => {
  const { store, rows } = makeLog("live");
  await store.insertLlmCall({
    source: "backtest", jobId: "backtest-1", runId: "2024-01-01|AAPL|n1", ticker: "AAPL", label: "trader",
    requestedModel: "deep", modelUsed: "fallback", keyIndex: 1, status: "ok", durationMs: 1234.6,
    attempts: [{ model: "deep", keyIndex: 0, outcome: "error", status: 503, detail: "overloaded" }, { model: "fallback", keyIndex: 1, outcome: "ok" }],
    prompt: "PROMPT TEXT", response: '{"a":1}',
  }, { now: "2026-09-19T10:00:00.000Z" });

  const [row] = await rows();
  assert.equal(row.env_run_id, "live", "the environment comes from the store, never from the entry");
  assert.equal(row.created_at, "2026-09-19T10:00:00.000Z");
  assert.equal(row.source, "backtest");
  assert.equal(row.job_id, "backtest-1");
  assert.equal(row.run_id, "2024-01-01|AAPL|n1", "run_id stays the PIPELINE run");
  assert.equal(row.model_used, "fallback");
  assert.equal(row.key_index, 1);
  assert.equal(row.duration_ms, 1235);
  assert.equal(row.prompt, "PROMPT TEXT");
  assert.equal(row.response, '{"a":1}');
  assert.equal(row.prompt_chars, 11);
  assert.equal(row.response_chars, 7);
  assert.equal(row.truncated, 0);
  assert.deepEqual(JSON.parse(row.attempts).map((a) => a.outcome), ["error", "ok"]);
});

test("insertLlmCall clips prompt and response at maxChars, keeps the true lengths, and flags truncated", async () => {
  const { store, rows } = makeLog();
  await store.insertLlmCall({ label: "x", status: "ok", prompt: "p".repeat(50), response: "r".repeat(30) }, { maxChars: 20 });

  const [row] = await rows();
  assert.equal(row.prompt.length, 20);
  assert.equal(row.response.length, 20);
  assert.equal(row.prompt_chars, 50);
  assert.equal(row.response_chars, 30);
  assert.equal(row.truncated, 1);
});

test("insertLlmCall scrubs API-key-shaped strings out of stored errors and attempt details", async () => {
  const { store, rows } = makeLog();
  const key = "AIzaSyA1234567890abcdefghijklmnopqrstuv";
  await store.insertLlmCall({
    label: "x", status: "error", errorStage: "vendor", error: `bad key ${key} rejected`,
    attempts: [{ model: "m", keyIndex: 0, outcome: "error", detail: `key=${key}` }], prompt: "p",
  });

  const [row] = await rows();
  assert.ok(!row.error.includes(key));
  assert.ok(row.error.includes("[redacted-key]"));
  assert.ok(!row.attempts.includes(key));
  assert.equal(redactSecrets("nothing secret here"), "nothing secret here");
});

test("insertLlmCall defaults source to 'pipeline' and label to 'unlabeled', and stores nulls for absent context", async () => {
  const { store, rows } = makeLog();
  await store.insertLlmCall({ status: "ok", prompt: "p", response: "r" });

  const [row] = await rows();
  assert.equal(row.source, "pipeline");
  assert.equal(row.label, "unlabeled");
  assert.equal(row.job_id, null);
  assert.equal(row.run_id, null);
  assert.equal(row.ticker, null);
  assert.equal(row.attempts, null);
});

test("recordLlmCall is a silent no-op unless config.llmLogEnabled is exactly true AND a store is on the context", async () => {
  const { store, rows } = makeLog();
  const entry = { label: "x", status: "ok", prompt: "p" };
  await recordLlmCall({ llmLog: { store } }, entry); // no llmLogEnabled
  await recordLlmCall({ llmLogEnabled: false, llmLog: { store } }, entry);
  await recordLlmCall({ llmLogEnabled: "true", llmLog: { store } }, entry);
  await recordLlmCall(loggingConfig(), entry); // enabled but no store on the context
  await recordLlmCall(loggingConfig({ llmLog: { source: "backtest" } }), entry); // context, still no store
  await recordLlmCall(undefined, entry);
  assert.equal((await rows()).length, 0);
});

test("recordLlmCall merges config.llmLog context into the row; an explicit entry ticker wins over the context ticker", async () => {
  const { store, rows } = makeLog();
  const config = withStore(loggingConfig(), store, { source: "backtest", jobId: "bt-9", runId: "run-1", ticker: "AAPL" });

  await recordLlmCall(config, { label: "analyst:news_event", status: "ok", prompt: "p" });
  await recordLlmCall(config, { label: "reflection", ticker: "MSFT", status: "ok", prompt: "p" });

  assert.deepEqual((await rows()).map((r) => [r.env_run_id, r.source, r.job_id, r.run_id, r.ticker]), [
    ["live", "backtest", "bt-9", "run-1", "AAPL"],
    ["live", "backtest", "bt-9", "run-1", "MSFT"],
  ]);
});

test("recordLlmCall swallows a D1 failure (warns, never throws) -- a log write must not fail the call it describes", async (t) => {
  const warnings = silenceWarn(t);
  const config = withStore(loggingConfig(), new RunStore(new BrokenDb(), "live"));
  await assert.doesNotReject(recordLlmCall(config, { label: "x", status: "ok", prompt: "p" }));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /llm call log write failed/);
});

test("withLlmLogContext composes without mutating the original, and undefined/null never blank an outer field (store included)", () => {
  const base = loggingConfig();
  const store = new RunStore(createTestD1([STATE_DIR]), "live");
  const outer = withLlmLogContext(base, { source: "backtest", jobId: "bt-1", store });
  const inner = withLlmLogContext(outer, { source: undefined, jobId: null, store: undefined, runId: "r1", ticker: "AAPL" });

  assert.equal(base.llmLog, undefined);
  assert.deepEqual(Object.keys(outer.llmLog).sort(), ["jobId", "source", "store"]);
  assert.equal(inner.llmLog.store, store, "an inner context without a store keeps the outer one");
  assert.deepEqual({ ...inner.llmLog, store: undefined }, { source: "backtest", jobId: "bt-1", store: undefined, runId: "r1", ticker: "AAPL" });
});

test("two environments sharing one state DB never see each other's log rows (env_run_id scope on write, list, get and prune)", async () => {
  const db = createTestD1([STATE_DIR]);
  const live = new RunStore(db, "live");
  const bt = new RunStore(db, "bt-1");
  const old = "2026-08-01T00:00:00.000Z";
  await live.insertLlmCall({ label: "live-a", status: "ok", prompt: "p", ticker: "AAPL" }, { now: old });
  await bt.insertLlmCall({ label: "bt-a", status: "ok", prompt: "p", ticker: "AAPL" }, { now: old });
  await bt.insertLlmCall({ label: "bt-b", status: "ok", prompt: "p", ticker: "AAPL" });

  assert.deepEqual((await live.getRecentLlmCalls()).calls.map((c) => c.label), ["live-a"]);
  assert.deepEqual((await bt.getRecentLlmCalls()).calls.map((c) => c.label), ["bt-b", "bt-a"]);

  const liveId = (await live.getRecentLlmCalls()).calls[0].id;
  assert.equal((await live.getLlmCall(liveId)).label, "live-a");
  assert.equal(await bt.getLlmCall(liveId), null, "another environment's id is 'not found', not a leak");

  await live.pruneLlmCalls({ days: 14, now: Date.parse("2026-09-19T12:00:00.000Z") });
  assert.deepEqual((await live.getRecentLlmCalls()).calls, [], "live's old row is pruned");
  assert.equal((await bt.getRecentLlmCalls()).calls.length, 2, "pruning live never touches bt-1's old row");
});

// ---------------------------------------------------------------------------
// callStructured logging
// ---------------------------------------------------------------------------

test("callStructured logs the exact prompt sent and the RAW response text (fences and all), with label, requested model and context", async () => {
  const { store, rows } = makeLog();
  const raw = '```json\n{"verdict":"long"}\n```';
  const config = withStore(loggingConfig({ fakeModel: async () => raw }), store, { runId: "news-1", ticker: "AAPL" });

  const result = await callStructured({}, config, Answer, "What is your verdict?", { model: "deep", label: "debate:judge" });

  assert.deepEqual(result, { verdict: "long" });
  const [row] = await rows();
  assert.equal(row.env_run_id, "live");
  assert.equal(row.status, "ok");
  assert.equal(row.label, "debate:judge");
  assert.equal(row.prompt, "What is your verdict?");
  assert.equal(row.response, raw);
  assert.equal(row.requested_model, "deep");
  assert.equal(row.run_id, "news-1");
  assert.equal(row.ticker, "AAPL");
  assert.equal(row.error, null);
  assert.ok(row.duration_ms >= 0);
});

test("callStructured defaults the requested model to the quick model when none is given", async () => {
  const { store, rows } = makeLog();
  await callStructured({}, withStore(loggingConfig({ fakeModel: async () => '{"verdict":"x"}' }), store), Answer, "p", { label: "l" });
  assert.equal((await rows())[0].requested_model, "quick");
});

test("callStructured logs an unparseable response as error_stage 'parse', keeps the raw text, and still throws the original error", async () => {
  const { store, rows } = makeLog();
  const config = withStore(loggingConfig({ fakeModel: async () => "Sure! Here is my answer: long" }), store);

  await assert.rejects(callStructured({}, config, Answer, "p", { label: "trader" }), SyntaxError);

  const [row] = await rows();
  assert.equal(row.status, "error");
  assert.equal(row.error_stage, "parse");
  assert.equal(row.response, "Sure! Here is my answer: long");
});

test("callStructured logs schema-mismatched JSON as error_stage 'validation' with the raw response", async () => {
  const { store, rows } = makeLog();
  const config = withStore(loggingConfig({ fakeModel: async () => '{"nope":1}' }), store);

  await assert.rejects(callStructured({}, config, Answer, "p", { label: "trader" }), (err) => err.name === "ZodError");

  const [row] = await rows();
  assert.equal(row.error_stage, "validation");
  assert.equal(row.response, '{"nope":1}');
});

test("callStructured logs a vendor failure as error_stage 'vendor' with a null response, and rethrows the same error object", async () => {
  const { store, rows } = makeLog();
  const boom = new Error("Gemini API error (503, model: quick, key #0): high demand");
  const config = withStore(loggingConfig({ fakeModel: async () => { throw boom; } }), store);

  await assert.rejects(callStructured({}, config, Answer, "p", { label: "analyst:sentiment" }), (err) => err === boom);

  const [row] = await rows();
  assert.equal(row.status, "error");
  assert.equal(row.error_stage, "vendor");
  assert.match(row.error, /high demand/);
  assert.equal(row.response, null);
  assert.equal(row.response_chars, 0);
});

test("callStructured returns the parsed result even when the log write fails", async (t) => {
  silenceWarn(t);
  const config = withStore(loggingConfig({ fakeModel: async () => '{"verdict":"long"}' }), new RunStore(new BrokenDb(), "live"));
  assert.deepEqual(await callStructured({}, config, Answer, "p", { label: "l" }), { verdict: "long" });
});

test("callStructured writes nothing when logging is disabled", async () => {
  const { store, rows } = makeLog();
  await callStructured({}, withStore(loggingConfig({ llmLogEnabled: false, fakeModel: async () => '{"verdict":"x"}' }), store), Answer, "p", { label: "l" });
  assert.equal((await rows()).length, 0);
});

test("callStructured writes nothing when no store is on the log context (a hand-built config that never mentions logging)", async () => {
  const { rows } = makeLog();
  assert.deepEqual(await callStructured({}, loggingConfig({ fakeModel: async () => '{"verdict":"x"}' }), Answer, "p", { label: "l" }), { verdict: "x" });
  assert.equal((await rows()).length, 0);
});

// ---------------------------------------------------------------------------
// cascade trace
// ---------------------------------------------------------------------------

function geminiEnvelope(text) {
  return { candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] };
}

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

test("geminiGenerateContent fills opts.trace with every attempt in order, and the model that finally answered", async (t) => {
  t.mock.method(console, "log", () => {});
  mockFetch(t, (url) => (url.includes("m-quick") ? jsonResponse(503, { error: { message: "high demand" } }) : jsonResponse(200, geminiEnvelope("hi"))));

  const trace = {};
  await geminiGenerateContent({}, cascadeConfig(), { contents: [] }, { trace });

  assert.deepEqual(trace.attempts.map((a) => [a.model, a.keyIndex, a.outcome, a.status ?? null]), [
    ["m-quick", 0, "error", 503],
    ["m-fallback", 0, "ok", null],
  ]);
  assert.equal(trace.modelUsed, "m-fallback");
  assert.equal(trace.keyIndex, 0);
});

test("geminiGenerateContent's trace is populated even when the whole cascade fails, and an absent trace changes nothing", async (t) => {
  t.mock.method(console, "log", () => {});
  mockFetch(t, () => jsonResponse(503, { error: { message: "high demand" } }));

  const trace = {};
  await assert.rejects(geminiGenerateContent({}, cascadeConfig(), { contents: [] }, { trace }), /high demand/);
  assert.equal(trace.attempts.length, 2);
  assert.ok(trace.attempts.every((a) => a.outcome === "error"));
  assert.equal(trace.modelUsed, undefined);

  await assert.rejects(geminiGenerateContent({}, cascadeConfig(), { contents: [] }), /high demand/); // no trace opt: still fine
});

test("a call that only succeeded via fallback is visible in the log: model_used differs from requested_model and the attempts show the 503", async (t) => {
  t.mock.method(console, "log", () => {});
  mockFetch(t, (url) =>
    url.includes("m-quick") ? jsonResponse(503, { error: { message: "high demand" } }) : jsonResponse(200, geminiEnvelope('{"verdict":"long"}'))
  );
  const { store, rows } = makeLog();
  const config = withStore({ ...cascadeConfig(), llmLogEnabled: true }, store, { runId: "news-1", ticker: "AAPL" });

  const result = await callStructured({}, config, Answer, "p", { model: "m-quick", label: "analyst:news_event" });

  assert.deepEqual(result, { verdict: "long" });
  const [row] = await rows();
  assert.equal(row.requested_model, "m-quick");
  assert.equal(row.model_used, "m-fallback");
  assert.deepEqual(JSON.parse(row.attempts).map((a) => [a.model, a.outcome]), [["m-quick", "error"], ["m-fallback", "ok"]]);
});

test("a call whose whole cascade failed is logged with the attempts that were tried and no model_used", async (t) => {
  t.mock.method(console, "log", () => {});
  mockFetch(t, () => jsonResponse(503, { error: { message: "high demand" } }));
  const { store, rows } = makeLog();
  const config = withStore({ ...cascadeConfig(), llmLogEnabled: true }, store);

  await assert.rejects(callStructured({}, config, Answer, "p", { model: "m-quick", label: "trader" }), /high demand/);

  const [row] = await rows();
  assert.equal(row.error_stage, "vendor");
  assert.equal(row.model_used, null);
  assert.equal(JSON.parse(row.attempts).length, 2);
});

// ---------------------------------------------------------------------------
// reads + retention
// ---------------------------------------------------------------------------

async function seed(store) {
  const base = { label: "x", status: "ok", prompt: "p".repeat(500), response: "r".repeat(500) };
  await store.insertLlmCall({ ...base, source: "pipeline", ticker: "AAPL", runId: "run-1" });
  await store.insertLlmCall({ ...base, source: "backtest", ticker: "AAPL", jobId: "bt-1", runId: "w|AAPL|n1" });
  await store.insertLlmCall({ ...base, source: "backtest", ticker: "MSFT", jobId: "bt-1", runId: "w|MSFT|n2", status: "error", errorStage: "vendor", error: "boom", response: null });
  await store.insertLlmCall({ ...base, source: "exit_check", ticker: "TSLA" });
}

test("getRecentLlmCalls returns newest first, previews only, camelCased", async () => {
  const { store } = makeLog();
  await seed(store);

  const { calls, nextBeforeId } = await store.getRecentLlmCalls({ limit: 50 });

  assert.deepEqual(calls.map((c) => c.id), [4, 3, 2, 1]);
  assert.equal(nextBeforeId, null);
  assert.equal(calls[0].source, "exit_check");
  assert.equal(calls[0].promptPreview.length, 240);
  assert.equal(calls[0].promptChars, 500);
  assert.equal(calls[1].jobId, "bt-1");
  assert.equal(calls[1].errorStage, "vendor");
  assert.equal("prompt" in calls[0], false, "the list must never carry the full prompt");
});

test("getRecentLlmCalls filters by source, status, ticker, job and pipeline run -- all AND-ed", async () => {
  const { store } = makeLog();
  await seed(store);
  const ids = async (filters) => (await store.getRecentLlmCalls(filters)).calls.map((c) => c.id);

  assert.deepEqual(await ids({ source: "backtest" }), [3, 2]);
  assert.deepEqual(await ids({ status: "error" }), [3]);
  assert.deepEqual(await ids({ ticker: "AAPL" }), [2, 1]);
  assert.deepEqual(await ids({ jobId: "bt-1" }), [3, 2]);
  assert.deepEqual(await ids({ runId: "run-1" }), [1]);
  assert.deepEqual(await ids({ source: "backtest", ticker: "MSFT", status: "error" }), [3]);
  assert.deepEqual(await ids({ source: "pipeline", jobId: "bt-1" }), []);
});

test("getRecentLlmCalls pages by id: limit+1 rows tell it whether more exist, and nextBeforeId continues from the last row shown", async () => {
  const { store } = makeLog();
  await seed(store);

  const first = await store.getRecentLlmCalls({ limit: 3 });
  assert.deepEqual(first.calls.map((c) => c.id), [4, 3, 2]);
  assert.equal(first.nextBeforeId, 2);

  const second = await store.getRecentLlmCalls({ limit: 3, beforeId: first.nextBeforeId });
  assert.deepEqual(second.calls.map((c) => c.id), [1]);
  assert.equal(second.nextBeforeId, null);
});

test("getLlmCall returns the full prompt/response and parsed attempts; null for an unknown id", async () => {
  const { store } = makeLog();
  await store.insertLlmCall({ label: "trader", status: "ok", prompt: "FULL PROMPT ".repeat(100), response: "FULL RESPONSE", attempts: [{ model: "m", keyIndex: 0, outcome: "ok" }] });

  const call = await store.getLlmCall(1);
  assert.equal(call.prompt, "FULL PROMPT ".repeat(100));
  assert.equal(call.response, "FULL RESPONSE");
  assert.deepEqual(call.attempts, [{ model: "m", keyIndex: 0, outcome: "ok" }]);
  assert.equal(await store.getLlmCall(999), null);
});

test("pruneLlmCalls deletes only rows older than the retention window", async () => {
  const { store, rows } = makeLog();
  const now = Date.parse("2026-09-19T12:00:00.000Z");
  await store.insertLlmCall({ label: "old", status: "ok", prompt: "p" }, { now: "2026-09-01T12:00:00.000Z" });
  await store.insertLlmCall({ label: "edge-in", status: "ok", prompt: "p" }, { now: "2026-09-06T12:00:01.000Z" });
  await store.insertLlmCall({ label: "new", status: "ok", prompt: "p" }, { now: "2026-09-19T11:00:00.000Z" });

  await store.pruneLlmCalls({ days: 14, now });

  assert.deepEqual((await rows()).map((r) => r.label), ["edge-in", "new"]);
});
