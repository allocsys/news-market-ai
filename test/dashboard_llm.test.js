// Covers the LLM-calls data path: query-param parsing (helpers.js) and the
// backend's /api/llm-calls[/:id] routes (src/index.js -> dashboard/api.js).
// The tests run the REAL backend Worker over a REAL sqlite state DB bound as
// LIVE_DB (M2b: llm_calls lives in the state schema, read through a read-only
// RunStore), so the filter/paging query strings travel the whole way to SQL.
// (The server-rendered /dashboard/llm pages were retired in favor of
// dashboard-next.)

import test from "node:test";
import assert from "node:assert/strict";
import backendWorker from "../src/index.js";
import { parseLlmParams } from "../src/dashboard/helpers.js";
import { RunStore } from "../src/storage/run_store.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { STATE_DIR, SIM_DIR } from "./helpers/engine_ctx.js";
import { BrokenDb } from "./helpers/broken_db.js";
import { insertBacktestRun, completeBacktestRun } from "../src/storage/sim_registry.js";

const qs = (obj) => new URLSearchParams(obj);
const DEFAULT_PARAMS = parseLlmParams(qs({}));

// ---------------------------------------------------------------------------
// params
// ---------------------------------------------------------------------------

test("parseLlmParams defaults, and validates every param", () => {
  assert.deepEqual(parseLlmParams(qs({})), { llmSource: "all", llmStatus: "all", llmLimit: 50, llmTicker: "", llmJob: "", llmRun: "", llmBefore: null, env: "live" });
  assert.deepEqual(
    parseLlmParams(qs({ llmSource: "backtest", llmStatus: "error", llmLimit: "100", llmTicker: " aapl ", llmJob: "backtest-1", llmRun: "n|1", llmBefore: "42" })),
    { llmSource: "backtest", llmStatus: "error", llmLimit: 100, llmTicker: "AAPL", llmJob: "backtest-1", llmRun: "n|1", llmBefore: 42, env: "live" }
  );
  // junk falls back to defaults instead of reaching the query
  const junk = parseLlmParams(qs({ llmSource: "drop table", llmStatus: "x", llmLimit: "9999", llmTicker: "AA PL;--", llmBefore: "-3", llmJob: "j".repeat(500) }));
  assert.deepEqual(junk, DEFAULT_PARAMS);
  assert.equal(parseLlmParams(qs({ llmTicker: "BRK.B" })).llmTicker, "BRK.B");
  assert.equal(parseLlmParams(qs({ llmBefore: "1.5" })).llmBefore, null);
  assert.deepEqual(parseLlmParams(null), DEFAULT_PARAMS);
});

// ---------------------------------------------------------------------------
// backend API
// ---------------------------------------------------------------------------

async function seededDb() {
  const db = createTestD1([STATE_DIR]);
  const store = new RunStore(db, "live");
  await store.insertLlmCall({ source: "pipeline", ticker: "AAPL", runId: "news-1", label: "trader", status: "ok", prompt: "PROMPT-ONE", response: '{"instrument":"equity"}' });
  await store.insertLlmCall({ source: "backtest", jobId: "backtest-1", ticker: "MSFT", runId: "w|MSFT|n2", label: "debate:judge", status: "error", errorStage: "parse", error: "not json", prompt: "PROMPT-TWO", response: "garbage" });
  return db;
}

const backendGet = (path, env) => backendWorker.fetch(new Request(`https://backend${path}`), env, { waitUntil() {} });

test("GET /api/llm-calls returns previews newest-first and honors the filter params", async () => {
  const env = { LIVE_DB: await seededDb() };

  const all = await (await backendGet("/api/llm-calls", env)).json();
  assert.deepEqual(all.calls.map((c) => c.id), [2, 1]);
  assert.equal(all.error, null);
  assert.equal("prompt" in all.calls[0], false);

  const backtestOnly = await (await backendGet("/api/llm-calls?llmSource=backtest", env)).json();
  assert.deepEqual(backtestOnly.calls.map((c) => c.id), [2]);
  assert.deepEqual((await (await backendGet("/api/llm-calls?llmJob=backtest-1", env)).json()).calls.map((c) => c.id), [2]);
  assert.deepEqual((await (await backendGet("/api/llm-calls?llmTicker=aapl", env)).json()).calls.map((c) => c.id), [1]);
  assert.deepEqual((await (await backendGet("/api/llm-calls?llmStatus=error", env)).json()).calls.map((c) => c.id), [2]);
});

test("GET /api/llm-calls reports a D1 failure in the body rather than a blank 200 (so the page can show it)", async (t) => {
  t.mock.method(console, "error", () => {});
  const body = await (await backendGet("/api/llm-calls", { LIVE_DB: new BrokenDb() })).json();
  assert.deepEqual(body.calls, []);
  assert.match(body.error, /D1 exploded/);
});

test("GET /api/llm-calls/:id returns the full call; 404 for an unknown id; 400 for a non-numeric one", async () => {
  const env = { LIVE_DB: await seededDb() };

  const res = await backendGet("/api/llm-calls/2", env);
  assert.equal(res.status, 200);
  const call = await res.json();
  assert.equal(call.prompt, "PROMPT-TWO");
  assert.equal(call.response, "garbage");
  assert.equal(call.errorStage, "parse");

  assert.equal((await backendGet("/api/llm-calls/999", env)).status, 404);
  assert.equal((await backendGet("/api/llm-calls/abc", env)).status, 400);
});

test("GET /api/llm-calls only shows the live environment (another run_id's rows in the same DB are invisible, including by id)", async () => {
  const db = await seededDb();
  await new RunStore(db, "bt-1").insertLlmCall({ source: "backtest", label: "trader", status: "ok", prompt: "OTHER-ENV", ticker: "AAPL" });
  const env = { LIVE_DB: db };

  const body = await (await backendGet("/api/llm-calls", env)).json();
  assert.deepEqual(body.calls.map((c) => c.id), [2, 1]);
  assert.equal((await backendGet("/api/llm-calls/3", env)).status, 404, "bt-1's row (id 3) is not visible through the live view");
});

test("the dashboard's LLM/job reads go through a read-only handle: a write method through it throws before reaching D1", async () => {
  const { liveReadStore } = await import("../src/dashboard/data.js");
  const store = liveReadStore({ LIVE_DB: createTestD1([STATE_DIR]) });
  await assert.rejects(store.insertLlmCall({ label: "x", status: "ok", prompt: "p" }), /refusing non-SELECT/);
  await assert.rejects(store.insertQueuedJob({ id: "j", type: "backfill" }), /refusing non-SELECT/);
  assert.deepEqual((await store.getRecentLlmCalls()).calls, [], "reads still work");
});

// ---------------------------------------------------------------------------
// M4b: /api/llm-calls/:id environment resolution (resolvedEnv/envError).
// ---------------------------------------------------------------------------

const BT = "backtest-1789000000000-abc123";

/** A SIM_DB with BT registered+complete, holding one LLM call under that run. */
async function seededSimDb() {
  const simDb = createTestD1([STATE_DIR, SIM_DIR]);
  await insertBacktestRun(simDb, { id: BT, tickers: ["AAPL"], testStart: "2024-01-01T00:00:00.000Z", testEnd: "2024-02-01T00:00:00.000Z", trainDays: 0, testDays: 30, startedAt: "2026-03-12T00:00:00.000Z" });
  await completeBacktestRun(simDb, { id: BT, result: { overall: {} }, finishedAt: "2026-03-12T01:00:00.000Z" });
  await new RunStore(simDb, BT).insertLlmCall({ source: "backtest", ticker: "AAPL", jobId: BT, runId: "w|AAPL|n1", label: "trader", status: "ok", prompt: "SIM-PROMPT", response: '{"instrument":"equity"}' });
  return simDb;
}

test("GET /api/llm-calls/:id?env=<registered backtest> returns the call scoped to that run, plus resolvedEnv and no envError", async () => {
  const env = { LIVE_DB: createTestD1([STATE_DIR]), SIM_DB: await seededSimDb() };
  const res = await backendGet(`/api/llm-calls/1?env=${BT}`, env);
  assert.equal(res.status, 200);
  const call = await res.json();
  assert.equal(call.prompt, "SIM-PROMPT");
  assert.equal(call.resolvedEnv, BT);
  assert.equal(call.envError, null);
});

test("GET /api/llm-calls/:id?env=<well-formed but unregistered> heals to live: returns live's call, resolvedEnv 'live', and an envError explaining why", async () => {
  const env = { LIVE_DB: await seededDb(), SIM_DB: createTestD1([STATE_DIR, SIM_DIR]) };
  const res = await backendGet(`/api/llm-calls/1?env=${BT}`, env);
  assert.equal(res.status, 200);
  const call = await res.json();
  assert.equal(call.prompt, "PROMPT-ONE");
  assert.equal(call.resolvedEnv, "live");
  assert.match(call.envError, /not found/);
});
