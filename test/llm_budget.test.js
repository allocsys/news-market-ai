// Per-run LLM-call budget (src/llm/budget.js, plan.md "Decided 2026-09-19":
// BACKTEST_MAX_LLM_CALLS, "the run fails when exceeded"). Unit tests for the
// counter, for the single charge point (callStructured), and end-to-end through
// runManualBacktest -- including the one place that used to swallow errors
// (graph/settle.js's reflection), which is exactly why the last-call case exists.

import test from "node:test";
import assert from "node:assert/strict";
import { createLlmBudget, chargeLlmCall } from "../src/llm/budget.js";
import { LlmBudgetExceededError } from "../src/shared/errors.js";
import { callStructured } from "../src/agents/utils/structured.js";
import { runManualBacktest } from "../src/backtest/runBacktest.js";
import { loadConfig } from "../src/config.js";
import { withLlmLogContext } from "../src/storage/llm_calls.js";
import { z } from "zod";
import { AnalystOpinion, DebateSide, DebateVerdict, TradeThesis } from "../src/schemas/index.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { makeCtx, seedNews, seedBar, stateRows, SIM_DIR } from "./helpers/engine_ctx.js";

// The happy-path scenario below makes exactly 8 LLM calls: 3 analysts + bull +
// bear + judge + trader = 7 in the pipeline, then 1 reflection when the
// position closes (the LAST call, made inside settle.js's try/catch).
const HAPPY_PATH_CALLS = 8;

// Same shape as agents/utils/memory.js's (unexported) reflection schema.
const Reflection = z.object({ reflection: z.string() });

test("createLlmBudget: unset/blank is uncapped, a positive integer (string or number) is a cap, anything else throws", () => {
  for (const unset of [undefined, null, "", "  "]) assert.equal(createLlmBudget(unset), null);
  assert.deepEqual(createLlmBudget("3"), { max: 3, used: 0 });
  assert.deepEqual(createLlmBudget(500), { max: 500, used: 0 });
  for (const bad of ["abc", "0", "-1", "1.5", 0, -2, NaN]) {
    assert.throws(() => createLlmBudget(bad), /BACKTEST_MAX_LLM_CALLS must be a positive integer/, `${bad} must not silently mean "no cap"`);
  }
});

test("chargeLlmCall: no-op without a budget; allows exactly `max` calls, throws on max+1, and a refused call isn't counted", () => {
  assert.doesNotThrow(() => chargeLlmCall({}));
  assert.doesNotThrow(() => chargeLlmCall(undefined));
  const config = { llmBudget: createLlmBudget(2) };
  chargeLlmCall(config);
  chargeLlmCall(config);
  assert.throws(() => chargeLlmCall(config), (err) => err instanceof LlmBudgetExceededError && err.limit === 2 && /capped at 2 calls/.test(err.message));
  assert.throws(() => chargeLlmCall(config), LlmBudgetExceededError);
  assert.equal(config.llmBudget.used, 2);
});

test("the counter survives withLlmLogContext's shallow copy (every agent shares one count)", () => {
  const config = { llmBudget: createLlmBudget(5) };
  const inner = withLlmLogContext(withLlmLogContext(config, { source: "backtest" }), { runId: "r1" });
  chargeLlmCall(inner);
  chargeLlmCall(config);
  assert.equal(config.llmBudget.used, 2);
  assert.equal(inner.llmBudget, config.llmBudget);
});

test("callStructured charges the budget before the model: an over-budget call never reaches the model and is not logged as a vendor error", async () => {
  let modelCalls = 0;
  const fakeModel = async () => {
    modelCalls++;
    return JSON.stringify({ reflection: "ok" });
  };
  const ctx = makeCtx({ runId: "bt-unit" });
  const config = withLlmLogContext({ geminiQuickModel: "quick", llmLogEnabled: true, fakeModel, llmBudget: createLlmBudget(1) }, { source: "backtest", store: ctx.store });

  await callStructured({}, config, Reflection, "first", { label: "reflection" });
  await assert.rejects(callStructured({}, config, Reflection, "second", { label: "reflection" }), LlmBudgetExceededError);

  assert.equal(modelCalls, 1);
  const rows = await stateRows(ctx.stateDb, "llm_calls");
  assert.equal(rows.length, 1, "only the call that was actually made is logged");
  assert.equal(rows[0].status, "ok");
});

test("loadConfig passes BACKTEST_MAX_LLM_CALLS through raw (unset stays undefined, so unset means no cap)", () => {
  assert.equal(loadConfig({}).backtestMaxLlmCalls, undefined);
  assert.equal(loadConfig({ BACKTEST_MAX_LLM_CALLS: "250" }).backtestMaxLlmCalls, "250");
});

// ---- end to end through runManualBacktest ----

function makeFakeModel(counter) {
  return async (prompt, opts) => {
    counter.n++;
    if (prompt.startsWith("A trade decision for")) return JSON.stringify({ reflection: "the thesis played out as expected" });
    if (opts.schema === AnalystOpinion) {
      if (opts.extraFields.agent === "news_event") return JSON.stringify({ eventType: "earnings_beat", entities: [], summary: "beat on EPS", justification: "guidance raised" });
      if (opts.extraFields.agent === "sentiment") return JSON.stringify({ sentiment: "positive", summary: "positive reaction", justification: "beat + raised guidance" });
      return JSON.stringify({ summary: "flat, single data point", justification: "not enough bars for a real trend read" });
    }
    if (opts.schema === DebateSide) return JSON.stringify({ argument: "an argument", justification: "a reason" });
    if (opts.schema === DebateVerdict) return JSON.stringify({ direction: "long", confidence: 0.8, timeHorizon: "days", justification: "bull case outweighs bear case" });
    if (opts.schema === TradeThesis) return JSON.stringify({ instrument: "equity", rationale: "ride the post-earnings momentum" });
    throw new Error(`unexpected schema/prompt in test fake model: ${prompt.slice(0, 60)}`);
  };
}

async function setup() {
  const ctx = { ...makeCtx({ runId: "bt-test" }), registryDb: createTestD1([SIM_DIR]) };
  await seedNews(ctx.inputs, { id: "news-1", tickers: ["AAPL"], publishedAt: "2026-01-01T00:00:00.000Z", title: "AAPL beats earnings", body: "Apple reported EPS above estimates." });
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2025-12-31", close: 100 });
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-05", close: 110 });
  return ctx;
}

function run(ctx, config, id) {
  const counter = { n: 0 };
  const full = { geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, maxPositionHoldDays: 2, fakeModel: makeFakeModel(counter), ...config };
  const promise = runManualBacktest({}, full, ctx, { id, tickers: ["AAPL"], testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-06T00:00:00.000Z", graceDays: 3 });
  return { counter, promise };
}

const getRun = (ctx, id) => ctx.registryDb.prepare("SELECT * FROM backtest_runs WHERE id = ?").bind(id).first();

test("a backtest with no cap configured completes and makes the full 8 calls (the fixture's call count the other tests rely on)", async () => {
  const ctx = await setup();
  const { counter, promise } = run(ctx, {}, "bt-uncapped");
  assert.equal((await promise).status, "complete");
  assert.equal(counter.n, HAPPY_PATH_CALLS);
});

test("a cap of exactly the calls needed still completes (max calls are allowed)", async () => {
  const ctx = await setup();
  const { counter, promise } = run(ctx, { backtestMaxLlmCalls: String(HAPPY_PATH_CALLS) }, "bt-exact");
  const outcome = await promise;
  assert.equal(outcome.status, "complete");
  assert.equal(counter.n, HAPPY_PATH_CALLS);
  assert.equal((await getRun(ctx, "bt-exact")).status, "complete");
});

test("a cap hit mid-pipeline fails the run, recorded 'failed' with the budget message, and no further calls are made", async () => {
  const ctx = await setup();
  const { counter, promise } = run(ctx, { backtestMaxLlmCalls: "3" }, "bt-mid");
  const outcome = await promise;
  assert.equal(outcome.status, "failed");
  assert.match(outcome.error, /LLM call budget exceeded: this run is capped at 3 calls/);
  assert.equal(counter.n, 3, "the model was called exactly `max` times, never more");
  const persisted = await getRun(ctx, "bt-mid");
  assert.equal(persisted.status, "failed");
  assert.match(persisted.error, /capped at 3 calls/);
});

test("a cap hit on the LAST call -- the reflection inside settle.js's try/catch -- still fails the run instead of being swallowed", async () => {
  const ctx = await setup();
  const { counter, promise } = run(ctx, { backtestMaxLlmCalls: String(HAPPY_PATH_CALLS - 1) }, "bt-last");
  const outcome = await promise;
  assert.equal(outcome.status, "failed", "settlePositionOutcome must not swallow the budget error");
  assert.match(outcome.error, /capped at 7 calls/);
  assert.equal(counter.n, HAPPY_PATH_CALLS - 1);
});

test("a malformed BACKTEST_MAX_LLM_CALLS fails the run (recorded, no LLM call made) rather than silently meaning 'no cap'", async () => {
  const ctx = await setup();
  const { counter, promise } = run(ctx, { backtestMaxLlmCalls: "lots" }, "bt-bad");
  const outcome = await promise;
  assert.equal(outcome.status, "failed");
  assert.match(outcome.error, /must be a positive integer/);
  assert.equal(counter.n, 0);
  assert.equal((await getRun(ctx, "bt-bad")).status, "failed");
});

test("each run gets its own counter: the same config object used for two runs doesn't carry the first run's count into the second", async () => {
  const ctx1 = await setup();
  const ctx2 = await setup();
  const counter = { n: 0 };
  const config = { geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, maxPositionHoldDays: 2, fakeModel: makeFakeModel(counter), backtestMaxLlmCalls: String(HAPPY_PATH_CALLS) };
  const args = { tickers: ["AAPL"], testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-06T00:00:00.000Z", graceDays: 3 };
  assert.equal((await runManualBacktest({}, config, ctx1, { id: "bt-a", ...args })).status, "complete");
  assert.equal((await runManualBacktest({}, config, ctx2, { id: "bt-b", ...args })).status, "complete");
  assert.equal(counter.n, HAPPY_PATH_CALLS * 2);
  assert.equal(config.llmBudget, undefined, "the caller's config is not mutated");
});
