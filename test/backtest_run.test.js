// Covers src/backtest/runBacktest.js -- the wiring layer that combines
// onSignalRunner.js#makeOnSignalReturns + noSignalBaseline.js#makeBuyAndHoldOffReturns
// + signalCompare.js#compareSignalOnOffByWindow into one persisted run
// (backtest_runs), the piece plan.md's "Backtest harness" Known Gaps note
// flagged as the last open item. Post-M2 this runs on REAL sqlite DBs
// (test/helpers/engine_ctx.js): inputs + state for the engine, and a
// separate registry DB (the sim schema's backtest_runs table) for the run
// registry -- the split runManualBacktest's {inputs, store, registryDb}
// signature encodes. Same config.fakeModel convention, zero real
// Gemini/Finnhub calls.

import test from "node:test";
import assert from "node:assert/strict";
import { runManualBacktest } from "../src/backtest/runBacktest.js";
import { SimClock } from "../src/backtest/simClock.js";
import { insertBacktestRun } from "../src/storage/sim_registry.js";
import { AnalystOpinion, DebateSide, DebateVerdict, TradeThesis } from "../src/schemas/index.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { makeCtx, seedNews, seedBar, stateRows, SIM_DIR } from "./helpers/engine_ctx.js";

/** Engine ctx + a registry DB holding only the sim schema's backtest_runs. */
function makeBacktestCtx() {
  const ctx = makeCtx({ runId: "bt-test" });
  const registryDb = createTestD1([SIM_DIR]);
  return { ...ctx, registryDb };
}

async function getRun(registryDb, id) {
  return registryDb.prepare("SELECT * FROM backtest_runs WHERE id = ?").bind(id).first();
}

function makeFakeModel() {
  return async (prompt, opts) => {
    if (prompt.startsWith("A trade decision for")) {
      return JSON.stringify({ reflection: "the thesis played out as expected" });
    }
    if (opts.schema === AnalystOpinion) {
      if (opts.extraFields.agent === "news_event") return JSON.stringify({ eventType: "earnings_beat", entities: [], summary: "beat on EPS", justification: "guidance raised" });
      if (opts.extraFields.agent === "sentiment") return JSON.stringify({ sentiment: "positive", summary: "positive reaction", justification: "beat + raised guidance" });
      if (opts.extraFields.agent === "technical") return JSON.stringify({ summary: "flat, single data point", justification: "not enough bars for a real trend read" });
      throw new Error(`unexpected AnalystOpinion agent: ${opts.extraFields.agent}`);
    }
    if (opts.schema === DebateSide) {
      return opts.extraFields.stance === "bull"
        ? JSON.stringify({ argument: "earnings beat justifies a long position", justification: "fundamentals improved" })
        : JSON.stringify({ argument: "one beat doesn't confirm a trend", justification: "macro risk remains" });
    }
    if (opts.schema === DebateVerdict) return JSON.stringify({ direction: "long", confidence: 0.8, timeHorizon: "days", justification: "bull case outweighs bear case" });
    if (opts.schema === TradeThesis) return JSON.stringify({ instrument: "equity", rationale: "ride the post-earnings momentum" });
    throw new Error(`unexpected schema/prompt in test fake model: ${prompt.slice(0, 60)}`);
  };
}

test("runManualBacktest persists a 'complete' run with the real compareSignalOnOffByWindow result shape", async () => {
  const ctx = makeBacktestCtx();
  await seedNews(ctx.inputs, { id: "news-1", tickers: ["AAPL"], publishedAt: "2026-01-01T00:00:00.000Z", title: "AAPL beats earnings", body: "Apple reported EPS above estimates." });
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2025-12-31", close: 100 });
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-05", close: 110 });
  const config = { geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, maxPositionHoldDays: 2, fakeModel: makeFakeModel() };

  const outcome = await runManualBacktest({}, config, ctx, {
    id: "run-happy", tickers: ["AAPL"], testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-06T00:00:00.000Z", graceDays: 3,
  });

  assert.equal(outcome.status, "complete");
  assert.ok(outcome.result.overall);
  assert.ok(Array.isArray(outcome.result.perWindow));
  assert.equal(outcome.result.perWindow.length, 1); // trainDays=0, one implicit test window covering the whole range

  const persisted = await getRun(ctx.registryDb, "run-happy");
  assert.equal(persisted.status, "complete");
  assert.deepEqual(JSON.parse(persisted.result), outcome.result);
  assert.ok(persisted.finished_at);

  // Real pipeline actually ran (a position opened from the backfilled news item).
  assert.equal((await stateRows(ctx.stateDb, "positions")).length, 1);
});

test("runManualBacktest persists a 'failed' run with the error message, still returns status: 'failed' rather than throwing", async () => {
  const ctx = makeBacktestCtx();
  // The news read is the first thing the on-signal walk does -- make the
  // inputs handle fail exactly there.
  const realInputs = ctx.inputs;
  ctx.inputs = {
    prepare(sql) {
      if (/FROM news_item_revisions r/.test(sql)) throw new Error("simulated D1 read failure");
      return realInputs.prepare(sql);
    },
  };
  const config = { geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, fakeModel: makeFakeModel() };

  const outcome = await runManualBacktest({}, config, ctx, {
    id: "run-fail", tickers: ["AAPL"], testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-06T00:00:00.000Z",
  });

  assert.equal(outcome.status, "failed");
  assert.match(outcome.error, /simulated D1 read failure/);

  const persisted = await getRun(ctx.registryDb, "run-fail");
  assert.equal(persisted.status, "failed");
  assert.match(persisted.error, /simulated D1 read failure/);
  assert.equal(persisted.result, null);
});

test("runManualBacktest with no backfilled news for the window still completes, with a thin/empty 'on' side (never fabricates)", async () => {
  const ctx = makeBacktestCtx();
  // nothing backfilled for this ticker/window -- only price bars for the off side
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-01", close: 100 });
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-06", close: 100 });
  const config = { geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, fakeModel: makeFakeModel() };

  const outcome = await runManualBacktest({}, config, ctx, {
    id: "run-empty", tickers: ["AAPL"], testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-06T00:00:00.000Z",
  });

  assert.equal(outcome.status, "complete");
  assert.equal((await stateRows(ctx.stateDb, "positions")).length, 0); // no news -> no pipeline run -> no position
  assert.equal(outcome.result.overall.on.cumulativeReturn, 0); // empty return series, not a fabricated number
});

// ---------------------------------------------------------------------------
// M3: SimClock + LLM call log wiring
// ---------------------------------------------------------------------------

test("runManualBacktest fails a run whose testEnd is in the future, recording it as a 'failed' registry row (not a silent reinterpretation)", async () => {
  const ctx = makeBacktestCtx();
  const config = { geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, fakeModel: makeFakeModel() };

  const outcome = await runManualBacktest({}, config, ctx, {
    id: "run-future", tickers: ["AAPL"], testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-06T00:00:00.000Z",
    clock: new SimClock("2026-01-03T00:00:00.000Z"),
  });

  assert.equal(outcome.status, "failed");
  assert.match(outcome.error, /testEnd/);
  assert.match(outcome.error, /future/);
  const persisted = await getRun(ctx.registryDb, "run-future");
  assert.equal(persisted.status, "failed");
  assert.match(persisted.error, /future/);
  assert.equal((await stateRows(ctx.stateDb, "positions")).length, 0);
});

test("runManualBacktest clamps the grace-period overshoot to the clock's now: progress totals are sized to the clamped walk", async () => {
  const ctx = makeBacktestCtx();
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-01", close: 100 });
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-03", close: 100 });
  const config = { geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, fakeModel: makeFakeModel() };
  const updates = [];

  const outcome = await runManualBacktest({}, config, ctx, {
    id: "run-clamped", tickers: ["AAPL"], testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-03T00:00:00.000Z", graceDays: 30,
    clock: new SimClock("2026-01-04T00:00:00.000Z"),
    onProgress: async (u) => { updates.push(u); },
  });

  assert.equal(outcome.status, "complete");
  const simulating = updates.filter((u) => u.phase === "simulating");
  // Jan 1..Jan 4 inclusive = 4 days, NOT the 33 an unclamped 30-day grace would walk.
  assert.equal(simulating.at(-1).total, 4);
  assert.equal(simulating.at(-1).done, 4);
});

test("runManualBacktest tags every LLM call it makes source 'backtest' with its own id as job_id, in the run's own store", async () => {
  const ctx = makeBacktestCtx();
  await seedNews(ctx.inputs, { id: "news-1", tickers: ["AAPL"], publishedAt: "2026-01-01T00:00:00.000Z", title: "AAPL beats earnings", body: "Apple reported EPS above estimates." });
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2025-12-31", close: 100 });
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-05", close: 110 });
  const config = { geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, maxPositionHoldDays: 2, llmLogEnabled: true, fakeModel: makeFakeModel() };

  const outcome = await runManualBacktest({}, config, ctx, {
    id: "run-logged", tickers: ["AAPL"], testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-06T00:00:00.000Z", graceDays: 3,
  });

  assert.equal(outcome.status, "complete");
  const calls = await stateRows(ctx.stateDb, "llm_calls");
  assert.ok(calls.length > 0, "the pipeline's LLM calls were logged");
  for (const row of calls) {
    assert.equal(row.source, "backtest");
    assert.equal(row.job_id, "run-logged");
    assert.equal(row.env_run_id, "bt-test", "written under the ctx store's own run id, never 'live'");
  }
});

test("runManualBacktest logs nothing when config.llmLogEnabled isn't on (the wrangler.backtest.toml default)", async () => {
  const ctx = makeBacktestCtx();
  await seedNews(ctx.inputs, { id: "news-1", tickers: ["AAPL"], publishedAt: "2026-01-01T00:00:00.000Z" });
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2025-12-31", close: 100 });
  const config = { geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, maxPositionHoldDays: 2, llmLogEnabled: false, fakeModel: makeFakeModel() };

  const outcome = await runManualBacktest({}, config, ctx, {
    id: "run-unlogged", tickers: ["AAPL"], testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-03T00:00:00.000Z", graceDays: 1,
  });

  assert.equal(outcome.status, "complete");
  assert.equal((await stateRows(ctx.stateDb, "llm_calls")).length, 0);
});

test("insertBacktestRun is idempotent on id: a second insert (redelivered queue message) keeps the first row untouched and doesn't throw", async () => {
  const registryDb = createTestD1([SIM_DIR]);
  const row = { id: "run-dup", tickers: ["AAPL"], testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-06T00:00:00.000Z", trainDays: 0, testDays: 5, graceDays: 2 };

  await insertBacktestRun(registryDb, { ...row, startedAt: "2026-02-01T00:00:00.000Z" });
  await insertBacktestRun(registryDb, { ...row, graceDays: 9, startedAt: "2026-02-02T00:00:00.000Z" });

  const { n } = await registryDb.prepare("SELECT COUNT(*) as n FROM backtest_runs WHERE id = ?").bind("run-dup").first();
  assert.equal(n, 1);
  const persisted = await getRun(registryDb, "run-dup");
  assert.equal(persisted.started_at, "2026-02-01T00:00:00.000Z");
  assert.equal(persisted.grace_days, 2);
});
