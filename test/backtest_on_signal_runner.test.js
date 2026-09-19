// Covers src/backtest/onSignalRunner.js -- the "signal on" side of the
// signal on/off backtest harness (plan.md Adopted Pattern #6). Post-M2 this
// runs against REAL sqlite-backed inputs + state DBs (test/helpers/
// engine_ctx.js: the real migrations, the real RunStore SQL), replacing the
// old FakeOnSignalDb regex fake that had to be kept in sync with every query
// shape by hand. Same config.fakeModel convention test/checkpoint_resume.
// test.js's full-pipeline test established (agents/utils/structured.js) --
// this exercises the REAL runPipelineForTicker/checkOpenPositionExits/
// settlePositionOutcome code paths with zero real Gemini calls and zero real
// vendor traffic, which is exactly what onSignalRunner.js's own header says
// is required before this gets invoked against anything real.

import test from "node:test";
import assert from "node:assert/strict";
import { runOnSignalForTicker, runOnSignalReturns, makeOnSignalReturns } from "../src/backtest/onSignalRunner.js";
import { AnalystOpinion, DebateSide, DebateVerdict, TradeThesis } from "../src/schemas/index.js";
import { makeCtx, seedNews, seedBar, stateRows } from "./helpers/engine_ctx.js";

/**
 * Dispatches on schema identity (AnalystOpinion/DebateSide/DebateVerdict/
 * TradeThesis, same pattern as test/checkpoint_resume.test.js's fake
 * model), plus a prompt-text check for reflection.js's Reflection schema --
 * that schema is defined inline in agents/utils/memory.js and never
 * exported, so there's no shared reference to compare against by identity;
 * its prompt text ("A trade decision for ... has resolved") is unique
 * enough to dispatch on instead. Always votes a confident long thesis so
 * the pipeline exercises its full width (risk/portfolio approve, a
 * position actually opens) -- same choice checkpoint_resume.test.js makes.
 */
function makeFakeModel({ onCall } = {}) {
  return async (prompt, opts) => {
    onCall?.(opts);
    if (prompt.startsWith("A trade decision for")) {
      return JSON.stringify({ reflection: "the long thesis on this beat played out as expected" });
    }
    if (opts.schema === AnalystOpinion) {
      if (opts.extraFields.agent === "news_event") {
        return JSON.stringify({ eventType: "earnings_beat", entities: [], summary: "beat on EPS", justification: "guidance raised" });
      }
      if (opts.extraFields.agent === "sentiment") {
        return JSON.stringify({ sentiment: "positive", summary: "positive reaction", justification: "beat + raised guidance" });
      }
      if (opts.extraFields.agent === "technical") {
        return JSON.stringify({ summary: "flat, single data point", justification: "not enough bars for a real trend read" });
      }
      throw new Error(`unexpected AnalystOpinion agent: ${opts.extraFields.agent}`);
    }
    if (opts.schema === DebateSide) {
      return opts.extraFields.stance === "bull"
        ? JSON.stringify({ argument: "earnings beat justifies a long position", justification: "fundamentals improved" })
        : JSON.stringify({ argument: "one beat doesn't confirm a trend", justification: "macro risk remains" });
    }
    if (opts.schema === DebateVerdict) {
      return JSON.stringify({ direction: "long", confidence: 0.8, timeHorizon: "days", justification: "bull case outweighs bear case" });
    }
    if (opts.schema === TradeThesis) {
      return JSON.stringify({ instrument: "equity", rationale: "ride the post-earnings momentum" });
    }
    throw new Error(`unexpected schema/prompt in test fake model: ${prompt.slice(0, 60)}`);
  };
}

test("runOnSignalForTicker opens a position from backfilled news, closes it on a time-based exit inside the grace period, and returns its realized return", async () => {
  const ctx = makeCtx();
  await seedNews(ctx.inputs, { id: "news-1", tickers: ["AAPL"], publishedAt: "2026-01-01T00:00:00.000Z", title: "AAPL beats earnings", body: "Apple reported EPS above estimates." });
  // One bar, dated before the whole window -- getPriceBarsAsOf(asOf, limit:1)
  // returns it for every asOf in the walk, so entryPrice === exitPrice
  // (realized return 0, but a REAL computed number, not a fabricated one).
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2025-12-31", close: 100 });

  const calls = [];
  const config = {
    geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1,
    maxPositionHoldDays: 2, // short, so the time-based exit fires within a small test window's grace period
    fakeModel: makeFakeModel({ onCall: (opts) => calls.push(opts) }),
  };

  const returns = await runOnSignalForTicker({}, config, ctx, {
    ticker: "AAPL",
    testStart: "2026-01-01T00:00:00.000Z",
    testEnd: "2026-01-02T00:00:00.000Z",
    graceDays: 3,
  });

  // Position opened from the news item, then closed time_based once
  // daysBetween(openedAt, asOf) >= maxPositionHoldDays (2 days).
  const positions = await stateRows(ctx.stateDb, "positions");
  assert.equal(positions.length, 1);
  assert.equal(positions[0].close_reason, "time_based");
  assert.equal(positions[0].closed_at, "2026-01-03T00:00:00.000Z");

  // A trade_decision + a decision_memory (reflection) row both exist.
  const decisions = await stateRows(ctx.stateDb, "trade_decisions");
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].status, "opened");
  const memory = await stateRows(ctx.stateDb, "decision_memory");
  assert.equal(memory.length, 1);
  assert.equal(memory[0].realized_return, 0); // entryPrice === exitPrice === 100

  // store.getRealizedReturnsInRange found exactly that one realized return.
  assert.deepEqual(returns, [0]);

  // Every stage's LLM call happened exactly once -- no re-invocation across
  // the day-by-day walk (checkpointing prevents the debate/trader stages
  // from re-running on later days, and no second news item exists to
  // trigger a second pipeline run).
  assert.equal(calls.filter((c) => c.schema === DebateVerdict).length, 1);
  assert.equal(calls.filter((c) => c.schema === TradeThesis).length, 1);
});

test("runOnSignalForTicker returns an empty array (never fabricates) when no backfilled news falls in the window", async () => {
  const ctx = makeCtx();
  const config = { geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, fakeModel: makeFakeModel() };

  const returns = await runOnSignalForTicker({}, config, ctx, {
    ticker: "AAPL", testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-02T00:00:00.000Z", graceDays: 1,
  });

  assert.deepEqual(returns, []);
  assert.equal((await stateRows(ctx.stateDb, "positions")).length, 0);
});

test("runOnSignalReturns pools realized returns across multiple tickers for one window", async () => {
  const ctx = makeCtx();
  await seedNews(ctx.inputs, { id: "news-aapl", tickers: ["AAPL"], publishedAt: "2026-01-01T00:00:00.000Z", title: "AAPL news", body: "AAPL body" });
  await seedNews(ctx.inputs, { id: "news-msft", tickers: ["MSFT"], publishedAt: "2026-01-01T00:00:00.000Z", title: "MSFT news", body: "MSFT body" });
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2025-12-31", close: 100 });
  await seedBar(ctx.inputs, { ticker: "MSFT", date: "2025-12-31", close: 200 });
  const config = { geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, maxPositionHoldDays: 1, fakeModel: makeFakeModel() };

  const returns = await runOnSignalReturns({}, config, ctx, {
    tickers: ["AAPL", "MSFT"], testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-02T00:00:00.000Z", graceDays: 2,
  });

  assert.equal(returns.length, 2);
  assert.ok(returns.every((r) => r === 0));
  const positions = await stateRows(ctx.stateDb, "positions");
  assert.equal(positions.filter((p) => p.ticker === "AAPL").length, 1);
  assert.equal(positions.filter((p) => p.ticker === "MSFT").length, 1);
});

test("makeOnSignalReturns returns a function matching compareSignalOnOffByWindow's getOnReturns(window) signature", async () => {
  const ctx = makeCtx();
  await seedNews(ctx.inputs, { id: "news-1", tickers: ["AAPL"], publishedAt: "2026-01-01T00:00:00.000Z", title: "t", body: "b" });
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2025-12-31", close: 50 });
  const config = { geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, maxPositionHoldDays: 1, fakeModel: makeFakeModel() };

  const getOnReturns = makeOnSignalReturns({}, config, ctx, { tickers: ["AAPL"], graceDays: 2 });
  // Same window shape walkForwardWindows yields -- this function only reads testStart/testEnd, ignoring the train fields.
  const returns = await getOnReturns({ trainStart: "2025-12-01T00:00:00.000Z", trainEnd: "2026-01-01T00:00:00.000Z", testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-02T00:00:00.000Z" });

  assert.deepEqual(returns, [0]);
});
