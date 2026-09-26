// Covers src/backtest/runBacktest.js -- the wiring layer that combines the
// on-signal walk (onSignalRunner.js), the daily equity-curve scoring of both
// sides (equity.js, plan.md step D) and signalCompare.js#compareSignalOnOffByWindow
// into one persisted run (backtest_runs), the piece plan.md's "Backtest
// harness" Known Gaps note flagged as the last open item. Every run needs
// price bars covering its span: the preflight (priceGrid.js) refuses one that
// has none BEFORE any LLM call. Post-M2 this runs on REAL sqlite DBs
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
import { AnalystTeamOpinion, DebateSide, DebateVerdict, TradeThesis } from "../src/schemas/index.js";
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

/** Flat daily bars 2025-12-31 .. 2026-01-05 for each ticker, so a run over 2026-01-01 .. 2026-01-06 (or any shorter span inside it) passes the price-coverage preflight.
 * NOTE: the preflight now also requires coverage through testEnd + graceDays (the
 * grace-period scoring fix), so a caller that doesn't explicitly pass graceDays: 0
 * needs bars reaching the DEFAULT grace (config.maxPositionHoldDays ?? 10) past
 * whatever testEnd it uses -- well beyond this helper's fixed 6-day range. Tests
 * below that aren't actually testing grace pass graceDays: 0 for exactly this reason. */
async function seedCoverage(inputs, tickers) {
  for (const ticker of tickers) {
    for (const date of ["2025-12-31", "2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05"]) {
      await seedBar(inputs, { ticker, date, close: 100 });
    }
  }
}

function makeFakeModel() {
  return async (prompt, opts) => {
    if (prompt.startsWith("A trade decision for")) {
      return JSON.stringify({ reflection: "the thesis played out as expected" });
    }
    if (opts.schema === AnalystTeamOpinion) {
      return JSON.stringify({
        news_event: { eventType: "earnings_beat", entities: [], summary: "beat on EPS", justification: "guidance raised" },
        sentiment: { sentiment: "positive", summary: "positive reaction", justification: "beat + raised guidance" },
        technical: { summary: "flat, single data point", justification: "not enough bars for a real trend read" },
      });
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
  // Scored as daily equity curves over one shared grid (plan.md step D), not per-trade returns.
  const { portfolio } = outcome.result;
  assert.equal(portfolio.method, "daily-equity-curve-v2");
  assert.deepEqual(portfolio.tickers, ["AAPL"]);
  assert.deepEqual(portfolio.series.dates, ["2026-01-05"]); // the only bar inside [Jan 1, Jan 6)
  assert.equal(portfolio.series.on.length, portfolio.series.dates.length);
  assert.equal(portfolio.series.off.length, portfolio.series.dates.length);
  assert.equal(outcome.result.overall.on.n, 1);
  assert.equal(outcome.result.overall.off.n, 1);

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
  await seedCoverage(ctx.inputs, ["AAPL"]);
  const realInputs = ctx.inputs;
  ctx.inputs = {
    prepare(sql) {
      if (/FROM news_item_revisions r/.test(sql)) throw new Error("simulated D1 read failure");
      return realInputs.prepare(sql);
    },
  };
  const config = { geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, fakeModel: makeFakeModel() };

  const outcome = await runManualBacktest({}, config, ctx, {
    id: "run-fail", tickers: ["AAPL"], testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-06T00:00:00.000Z", graceDays: 0,
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
    id: "run-empty", tickers: ["AAPL"], testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-06T00:00:00.000Z", graceDays: 0,
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
  await seedCoverage(ctx.inputs, ["AAPL"]);
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

// ---------------------------------------------------------------------------
// M3 (8/N): a failed run's error says WHERE it died (its data is cleaned up
// afterwards, so this is what remains to tell how far it got)
// ---------------------------------------------------------------------------

/** A model that throws once the pipeline reaches it -- i.e. mid-walk, on the first day that has news. */
const explodingModel = async () => {
  throw new Error("model exploded");
};

test("a run that dies mid-walk records WHICH ticker-day it died on, in both the outcome and the registry row -- and names the right day, not an earlier finished one", async () => {
  for (const withProgress of [false, true]) {
    const ctx = makeBacktestCtx();
    // News only on day 3: days 1-2 complete (clearing the in-flight marker) before day 3 blows up.
    await seedNews(ctx.inputs, { id: "news-1", tickers: ["AAPL"], publishedAt: "2026-01-03T12:00:00.000Z", title: "AAPL beats earnings", body: "b" });
    await seedCoverage(ctx.inputs, ["AAPL"]);
    const config = { geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, fakeModel: explodingModel };
    const id = `run-mid-${withProgress}`;

    const outcome = await runManualBacktest({}, config, ctx, {
      id, tickers: ["AAPL"], testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-06T00:00:00.000Z", graceDays: 0,
      ...(withProgress ? { onProgress: async () => {} } : {}),
    });

    assert.equal(outcome.status, "failed", `withProgress=${withProgress}`);
    assert.match(outcome.error, /model exploded/);
    assert.match(outcome.error, /\[while processing AAPL 2026-01-03\]$/, `withProgress=${withProgress}: the suffix must work even with no progress reporter`);
    assert.equal((await getRun(ctx.registryDb, id)).error, outcome.error, "the registry stores the same suffixed message");
  }
});

test("a run that fails BEFORE the walk starts gets no 'while processing' suffix", async () => {
  // (a) future testEnd -- rejected before any ticker-day.
  const ctx = makeBacktestCtx();
  const config = { geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, fakeModel: makeFakeModel() };
  const future = await runManualBacktest({}, config, ctx, {
    id: "run-pre-1", tickers: ["AAPL"], testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-06T00:00:00.000Z", clock: new SimClock("2026-01-03T00:00:00.000Z"),
  });
  assert.equal(future.status, "failed");
  assert.doesNotMatch(future.error, /while processing/);

  // (b) the news read (first thing per ticker) failing -- before that ticker's first day starts.
  const ctx2 = makeBacktestCtx();
  await seedCoverage(ctx2.inputs, ["AAPL"]);
  const realInputs = ctx2.inputs;
  ctx2.inputs = { prepare(sql) { if (/FROM news_item_revisions r/.test(sql)) throw new Error("simulated D1 read failure"); return realInputs.prepare(sql); } };
  const read = await runManualBacktest({}, config, ctx2, {
    id: "run-pre-2", tickers: ["AAPL"], testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-06T00:00:00.000Z", graceDays: 0,
  });
  assert.equal(read.status, "failed");
  assert.match(read.error, /simulated D1 read failure/);
  assert.doesNotMatch(read.error, /while processing/);
});

test("a failure BETWEEN ticker-days is not blamed on the last day that finished: AAPL's walk completes, MSFT's news read fails -> no 'while processing' suffix", async () => {
  const ctx = makeBacktestCtx();
  await seedCoverage(ctx.inputs, ["AAPL", "MSFT"]);
  const realInputs = ctx.inputs;
  ctx.inputs = {
    prepare(sql) {
      const stmt = realInputs.prepare(sql);
      if (!/FROM news_item_revisions r/.test(sql)) return stmt;
      return { bind: (...args) => { if (args.includes("MSFT")) throw new Error("MSFT news read failed"); return stmt.bind(...args); } };
    },
  };
  const config = { geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, fakeModel: makeFakeModel() };

  const outcome = await runManualBacktest({}, config, ctx, {
    id: "run-between", tickers: ["AAPL", "MSFT"], testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-04T00:00:00.000Z", graceDays: 0,
  });

  assert.equal(outcome.status, "failed");
  assert.match(outcome.error, /MSFT news read failed/);
  assert.doesNotMatch(outcome.error, /while processing/, "AAPL's last day finished cleanly; blaming it would send the debugger to the wrong place");
});

// ---------------------------------------------------------------------------
// plan.md step D: scoring by daily equity curve, and the free price preflight
// ---------------------------------------------------------------------------

test("runManualBacktest scores both sides as daily equity curves over the same days: hand-checked numbers", async () => {
  const ctx = makeBacktestCtx();
  await seedNews(ctx.inputs, { id: "news-1", tickers: ["AAPL"], publishedAt: "2026-01-02T12:00:00.000Z", title: "AAPL beats earnings", body: "Apple reported EPS above estimates." });
  for (const [date, close] of [["2025-12-31", 100], ["2026-01-01", 100], ["2026-01-02", 110], ["2026-01-03", 121], ["2026-01-04", 121], ["2026-01-05", 121]]) {
    await seedBar(ctx.inputs, { ticker: "AAPL", date, close });
  }
  const config = { geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, maxPositionHoldDays: 10, fakeModel: makeFakeModel() };

  const outcome = await runManualBacktest({}, config, ctx, {
    id: "run-numbers", tickers: ["AAPL"], testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-06T00:00:00.000Z", graceDays: 3,
  });

  assert.equal(outcome.status, "complete", outcome.error);
  // The pipeline opened a long at the PRIOR close (Jan 1 = 100) sized min(5%, 0.8 * 5%) = 4%; the Jan 2 close of 110 is +10% >= the 6% take-profit,
  // so the Jan 3 exit check closed it at the prior close, 110.
  const [position] = await stateRows(ctx.stateDb, "positions");
  assert.equal(position.entry_price, 100);
  assert.ok(Math.abs(position.position_size_pct - 0.04) < 1e-12); // 0.8 * 0.05, give or take float noise
  assert.equal(position.exit_price, 110);
  assert.equal(position.closed_at, "2026-01-03T00:00:00.000Z");

  const { portfolio, overall } = outcome.result;
  assert.deepEqual(portfolio.series.dates, ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05"]);
  const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: expected ${expected}, got ${actual}`);
  // Buy-and-hold: bought at the Dec 31 close of 100, so +0% on Jan 1, +10% on Jan 2, +10% on Jan 3, flat after.
  [0, 0.1, 0.1, 0, 0].forEach((r, i) => near(portfolio.series.off[i], r, `off[${i}]`));
  // Signal: in cash except Jan 2, when 4% of the portfolio earned 10%.
  [0, 0.004, 0, 0, 0].forEach((r, i) => near(portfolio.series.on[i], r, `on[${i}]`));
  near(overall.off.cumulativeReturn, 1.1 * 1.1 - 1, "off cumulative");
  near(overall.on.cumulativeReturn, 0.004, "on cumulative");
  near(overall.delta.cumulativeReturn, 0.004 - 0.21, "delta"); // the signal LOST to buy-and-hold here, and says so
  assert.equal(overall.on.n, 5);
  assert.equal(overall.off.n, 5);
  assert.equal(portfolio.on.positionsTraded, 1);
  assert.equal(portfolio.on.positionsIgnored, 0);
  near(portfolio.on.avgExposure, 0.04 / 5, "avg exposure");
  assert.equal(portfolio.off.avgExposure, 1);
});

test("runManualBacktest refuses a ticker with no usable prices BEFORE any LLM call, naming it, and never shrinks the universe", async () => {
  const ctx = makeBacktestCtx();
  await seedNews(ctx.inputs, { id: "news-1", tickers: ["AAPL"], publishedAt: "2026-01-02T12:00:00.000Z", title: "AAPL beats earnings", body: "b" });
  await seedCoverage(ctx.inputs, ["AAPL"]); // AAPL is fine; MSFT has no bars at all
  let calls = 0;
  const model = makeFakeModel();
  const config = { geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, fakeModel: async (...args) => { calls++; return model(...args); } };

  const outcome = await runManualBacktest({}, config, ctx, {
    id: "run-nocoverage", tickers: ["AAPL", "MSFT"], testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-06T00:00:00.000Z", graceDays: 0,
  });

  assert.equal(outcome.status, "failed");
  assert.match(outcome.error, /Price coverage check failed/);
  assert.match(outcome.error, /no LLM calls were made/);
  assert.match(outcome.error, /MSFT: no price bars/);
  assert.doesNotMatch(outcome.error, /AAPL: /);
  assert.doesNotMatch(outcome.error, /while processing/);
  assert.equal(calls, 0, "not one model call was spent");
  assert.equal((await stateRows(ctx.stateDb, "positions")).length, 0);
  assert.equal((await stateRows(ctx.stateDb, "trade_decisions")).length, 0);
  assert.equal((await getRun(ctx.registryDb, "run-nocoverage")).status, "failed");
});

test("runManualBacktest refuses a price hole inside the span (a hole is not a holiday)", async () => {
  const ctx = makeBacktestCtx();
  for (const date of ["2025-12-31", "2026-01-01", "2026-01-20", "2026-01-30"]) await seedBar(ctx.inputs, { ticker: "AAPL", date, close: 100 });
  const config = { geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, fakeModel: makeFakeModel() };

  // graceDays: 0 -- grace now extends the price-coverage requirement past testEnd
  // too (the preflight has to cover whatever the walk will actually score), so a
  // nonzero default grace would fail this run on the TAIL gap (no bars near the
  // grace-extended end) before ever reaching the mid-span hole this test targets.

  const outcome = await runManualBacktest({}, config, ctx, {
    id: "run-hole", tickers: ["AAPL"], testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-31T00:00:00.000Z", graceDays: 0,
  });

  assert.equal(outcome.status, "failed");
  assert.match(outcome.error, /AAPL: no price bars for 19 days between 2026-01-01 and 2026-01-20/);
});

test("runManualBacktest fails a backwards range and a range too short for any walk-forward window, before doing anything", async () => {
  const ctx = makeBacktestCtx();
  await seedCoverage(ctx.inputs, ["AAPL"]);
  const config = { geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, fakeModel: makeFakeModel() };

  const backwards = await runManualBacktest({}, config, ctx, { id: "run-back", tickers: ["AAPL"], testStart: "2026-01-05T00:00:00.000Z", testEnd: "2026-01-01T00:00:00.000Z" });
  assert.equal(backwards.status, "failed");
  assert.match(backwards.error, /testStart .* must be before testEnd/);

  const same = await runManualBacktest({}, config, ctx, { id: "run-same", tickers: ["AAPL"], testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-01T00:00:00.000Z" });
  assert.equal(same.status, "failed");

  const noWindow = await runManualBacktest({}, config, ctx, { id: "run-nowin", tickers: ["AAPL"], testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-05T00:00:00.000Z", trainDays: 3, testDays: 4 });
  assert.equal(noWindow.status, "failed");
  assert.match(noWindow.error, /No walk-forward window fits/);
});

test("runManualBacktest with several walk-forward windows: per-window slices tile the whole curve, and the progress total sums every window's walk", async () => {
  const ctx = makeBacktestCtx();
  for (const [date, close] of [["2025-12-31", 100], ["2026-01-01", 100], ["2026-01-02", 110], ["2026-01-03", 110], ["2026-01-04", 99], ["2026-01-05", 99]]) {
    await seedBar(ctx.inputs, { ticker: "AAPL", date, close });
  }
  const config = { geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, fakeModel: makeFakeModel() };
  const updates = [];

  const outcome = await runManualBacktest({}, config, ctx, {
    id: "run-windows", tickers: ["AAPL"], testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-05T00:00:00.000Z", trainDays: 0, testDays: 2, graceDays: 1,
    onProgress: async (u) => { updates.push(u); },
  });

  assert.equal(outcome.status, "complete", outcome.error);
  const { perWindow, overall, portfolio } = outcome.result;
  assert.equal(perWindow.length, 2); // [Jan 1, Jan 3) and [Jan 3, Jan 5)
  // Window 2 is the LAST window: its own slice is widened by its 1 grace day (Jan 5),
  // which has a real bar here, so it scores 3 days (Jan 3-5) instead of 2 -- the whole
  // point of the grace-period scoring fix. Window 1 isn't last, so it's untouched.
  assert.deepEqual(perWindow.map((w) => w.comparison.off.n), [2, 3]);
  assert.equal(overall.off.n, 5);
  assert.deepEqual(portfolio.series.dates, ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05"]);
  // The pooled curve is exactly the windows chained: (1 + w1) * (1 + w2) - 1.
  const chained = (1 + perWindow[0].comparison.off.cumulativeReturn) * (1 + perWindow[1].comparison.off.cumulativeReturn) - 1;
  assert.ok(Math.abs(overall.off.cumulativeReturn - chained) < 1e-9);
  assert.ok(Math.abs(overall.off.cumulativeReturn - (99 / 100 - 1)) < 1e-9); // bought at 100, ended at 99 (Jan 5 is flat vs Jan 4, same ending value)

  // Window 1 walks Jan 1..Jan 4 (through testEnd + 1 grace day), window 2 Jan 3..Jan 6: 8 ticker-days, not the 6 a single walk of the whole range would be.
  const simulating = updates.filter((u) => u.phase === "simulating");
  assert.equal(simulating.at(-1).total, 8);
  assert.equal(simulating.at(-1).done, 8);
});
