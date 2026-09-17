// Covers src/backtest/onSignalRunner.js -- the "signal on" side of the
// signal on/off backtest harness (plan.md Adopted Pattern #6), plus the two
// new storage/d1.js readers it's built on (getNewsItemsInRange,
// getRealizedReturnsInRange). Same config.fakeModel convention
// test/checkpoint_resume.test.js's full-pipeline test established
// (agents/utils/structured.js) -- this exercises the REAL
// runPipelineForTicker/checkOpenPositionExits/settlePositionOutcome code
// paths with zero real Gemini calls and zero real vendor traffic, which is
// exactly what onSignalRunner.js's own header says is required before this
// gets invoked against anything real.
//
// FakeOnSignalDb is the widest fake in this repo's test suite so far --
// checkpoints, positions, trade_decisions, decision_memory (both the write
// path AND both read shapes: getDecisionMemoryAsOf's prior-lessons query
// and getRealizedReturnsInRange's new result query), price_bars, and the
// news_item_revisions/news_item_tickers join getNewsItemsInRange reads.
// Deliberately still narrow per-table (only the exact query shapes these
// modules actually issue), same "not a general SQLite emulator" convention
// as every other fake in this suite.

import test from "node:test";
import assert from "node:assert/strict";
import { runOnSignalForTicker, runOnSignalReturns, makeOnSignalReturns } from "../src/backtest/onSignalRunner.js";
import { AnalystOpinion, DebateSide, DebateVerdict, TradeThesis } from "../src/schemas/index.js";

class FakeOnSignalDb {
  constructor({ newsItems = [], priceBars = [] } = {}) {
    this.newsItems = newsItems; // [{id, tickers: [...], published_at, title, body}]
    this.priceBars = priceBars; // [{ticker, date, close}]
    this.checkpoints = new Map();
    this.positions = [];
    this.tradeDecisions = [];
    this.decisionMemory = []; // [{id, decision_id, ticker, realized_return, alpha_return, reflection, resolved_at, created_at}]
  }

  prepare(sql) {
    const db = this;
    return {
      bind(...args) {
        return {
          async run() {
            if (/INSERT INTO pipeline_checkpoints/.test(sql)) {
              const [runId, ticker, stage, state, updatedAt] = args;
              db.checkpoints.set(`${runId}|${ticker}`, { stage, state, updated_at: updatedAt });
              return;
            }
            if (/INSERT INTO positions/.test(sql)) {
              const [id, ticker, tradeThesisId, positionSizePct, direction, entryPrice, stopLossPct, takeProfitPct, openedAt] = args;
              if (db.positions.some((p) => p.id === id)) return;
              db.positions.push({
                id, ticker, trade_thesis_id: tradeThesisId, position_size_pct: positionSizePct,
                direction, entry_price: entryPrice, stop_loss_pct: stopLossPct, take_profit_pct: takeProfitPct,
                opened_at: openedAt, closed_at: null, close_reason: null, exit_price: null,
              });
              return;
            }
            if (/UPDATE positions SET closed_at/.test(sql)) {
              const [closedAt, closeReason, exitPrice, id] = args;
              const p = db.positions.find((p) => p.id === id && p.closed_at === null);
              if (p) { p.closed_at = closedAt; p.close_reason = closeReason; p.exit_price = exitPrice; }
              return;
            }
            if (/INSERT INTO trade_decisions/.test(sql)) {
              const [id, ticker, asOf, debateId, thesis, riskDecision, portfolioDecision, status, createdAt] = args;
              if (db.tradeDecisions.some((d) => d.id === id)) return;
              db.tradeDecisions.push({ id, ticker, as_of: asOf, debate_id: debateId, thesis, risk_decision: riskDecision, portfolio_decision: portfolioDecision, status, created_at: createdAt });
              return;
            }
            if (/INSERT INTO decision_memory/.test(sql)) {
              const [id, decisionId, ticker, realizedReturn, alphaReturn, reflection, resolvedAt, createdAt] = args;
              if (db.decisionMemory.some((m) => m.id === id)) return;
              db.decisionMemory.push({ id, decision_id: decisionId, ticker, realized_return: realizedReturn, alpha_return: alphaReturn, reflection, resolved_at: resolvedAt, created_at: createdAt });
              return;
            }
            throw new Error(`FakeOnSignalDb: unsupported run() query: ${sql}`);
          },
          async first() {
            if (/SELECT stage, state, updated_at FROM pipeline_checkpoints/.test(sql)) {
              const [runId, ticker] = args;
              return db.checkpoints.get(`${runId}|${ticker}`) ?? null;
            }
            if (/FROM positions/.test(sql) && /LIMIT 1/.test(sql)) {
              // getOpenPositionForTickerAsOf: bind(ticker, asOf, asOfClose)
              const [ticker, asOf, asOfClose] = args;
              const open = db.positions
                .filter((p) => p.ticker === ticker && p.opened_at <= asOf && (p.closed_at === null || p.closed_at > asOfClose))
                .sort((a, b) => (a.opened_at < b.opened_at ? 1 : -1));
              return open[0] ?? null;
            }
            throw new Error(`FakeOnSignalDb: unsupported first() query: ${sql}`);
          },
          async all() {
            if (/SELECT position_size_pct FROM positions/.test(sql)) {
              const [asOf, asOfClose, excludeTicker] = args;
              const results = db.positions
                .filter((p) => p.opened_at <= asOf && (p.closed_at === null || p.closed_at > asOfClose))
                .filter((p) => !excludeTicker || p.ticker !== excludeTicker)
                .map((p) => ({ position_size_pct: p.position_size_pct }));
              return { results };
            }
            if (/FROM positions/.test(sql)) {
              // getOpenPositionsAsOf (checkOpenPositionExits): bind(asOf, asOfClose), no ticker filter, no LIMIT
              const [asOf, asOfClose] = args;
              const results = db.positions
                .filter((p) => p.opened_at <= asOf && (p.closed_at === null || p.closed_at > asOfClose))
                .map((p) => ({
                  id: p.id, ticker: p.ticker, trade_thesis_id: p.trade_thesis_id, position_size_pct: p.position_size_pct,
                  direction: p.direction, entry_price: p.entry_price, stop_loss_pct: p.stop_loss_pct,
                  take_profit_pct: p.take_profit_pct, opened_at: p.opened_at,
                }));
              return { results };
            }
            if (/FROM price_bars/.test(sql)) {
              const [ticker, asOf, limit] = args;
              const results = db.priceBars
                .filter((b) => b.ticker === ticker && b.date <= asOf)
                .sort((a, b) => (a.date < b.date ? 1 : -1))
                .slice(0, limit)
                .map((b) => ({ ticker: b.ticker, date: b.date, open: b.close, high: b.close, low: b.close, close: b.close, volume: b.volume ?? 0, source: "test" }));
              return { results };
            }
            if (/SELECT realized_return\s*\n\s*FROM decision_memory/.test(sql)) {
              // getRealizedReturnsInRange: bind(ticker, from, to, limit)
              const [ticker, from, to, limit] = args;
              const results = db.decisionMemory
                .filter((m) => m.ticker === ticker && m.resolved_at >= from && m.resolved_at < to && m.realized_return != null)
                .sort((a, b) => (a.resolved_at < b.resolved_at ? -1 : 1))
                .slice(0, limit)
                .map((m) => ({ realized_return: m.realized_return }));
              return { results };
            }
            if (/FROM decision_memory/.test(sql)) {
              return { results: [] }; // getDecisionMemoryAsOf (loadLessonsForDebate) -- no prior lessons needed for this test
            }
            if (/FROM news_item_revisions r/.test(sql)) {
              // getNewsItemsInRange: bind(ticker, from, to, limit)
              const [ticker, from, to, limit] = args;
              const results = db.newsItems
                .filter((n) => n.tickers.includes(ticker) && n.published_at >= from && n.published_at < to)
                .sort((a, b) => (a.published_at < b.published_at ? -1 : 1))
                .slice(0, limit)
                .map((n) => ({ id: n.id, revision: 1, published_at: n.published_at, title: n.title, body: n.body }));
              return { results };
            }
            throw new Error(`FakeOnSignalDb: unsupported all() query: ${sql}`);
          },
        };
      },
    };
  }
}

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
  const db = new FakeOnSignalDb({
    newsItems: [
      { id: "news-1", tickers: ["AAPL"], published_at: "2026-01-01T00:00:00.000Z", title: "AAPL beats earnings", body: "Apple reported EPS above estimates." },
    ],
    // One bar, dated before the whole window -- getPriceBarsAsOf(asOf, limit:1)
    // returns it for every asOf in the walk, so entryPrice === exitPrice
    // (realized return 0, but a REAL computed number, not a fabricated one).
    priceBars: [{ ticker: "AAPL", date: "2025-12-31", close: 100 }],
  });

  const calls = [];
  const config = {
    geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1,
    maxPositionHoldDays: 2, // short, so the time-based exit fires within a small test window's grace period
    fakeModel: makeFakeModel({ onCall: (opts) => calls.push(opts) }),
  };

  const returns = await runOnSignalForTicker({}, config, db, {
    ticker: "AAPL",
    testStart: "2026-01-01T00:00:00.000Z",
    testEnd: "2026-01-02T00:00:00.000Z",
    graceDays: 3,
  });

  // Position opened from the news item, then closed time_based once
  // daysBetween(openedAt, asOf) >= maxPositionHoldDays (2 days).
  assert.equal(db.positions.length, 1);
  assert.equal(db.positions[0].close_reason, "time_based");
  assert.equal(db.positions[0].closed_at, "2026-01-03T00:00:00.000Z");

  // A trade_decision + a decision_memory (reflection) row both exist.
  assert.equal(db.tradeDecisions.length, 1);
  assert.equal(db.decisionMemory.length, 1);
  assert.equal(db.decisionMemory[0].realized_return, 0); // entryPrice === exitPrice === 100

  // getRealizedReturnsInRange found exactly that one realized return.
  assert.deepEqual(returns, [0]);

  // Every stage's LLM call happened exactly once -- no re-invocation across
  // the day-by-day walk (checkpointing prevents the debate/trader stages
  // from re-running on later days, and no second news item exists to
  // trigger a second pipeline run).
  assert.equal(calls.filter((c) => c.schema === DebateVerdict).length, 1);
  assert.equal(calls.filter((c) => c.schema === TradeThesis).length, 1);
});

test("runOnSignalForTicker returns an empty array (never fabricates) when no backfilled news falls in the window", async () => {
  const db = new FakeOnSignalDb({ newsItems: [], priceBars: [] });
  const config = { geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, fakeModel: makeFakeModel() };

  const returns = await runOnSignalForTicker({}, config, db, {
    ticker: "AAPL", testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-02T00:00:00.000Z", graceDays: 1,
  });

  assert.deepEqual(returns, []);
  assert.equal(db.positions.length, 0);
});

test("runOnSignalReturns pools realized returns across multiple tickers for one window", async () => {
  const db = new FakeOnSignalDb({
    newsItems: [
      { id: "news-aapl", tickers: ["AAPL"], published_at: "2026-01-01T00:00:00.000Z", title: "AAPL news", body: "AAPL body" },
      { id: "news-msft", tickers: ["MSFT"], published_at: "2026-01-01T00:00:00.000Z", title: "MSFT news", body: "MSFT body" },
    ],
    priceBars: [
      { ticker: "AAPL", date: "2025-12-31", close: 100 },
      { ticker: "MSFT", date: "2025-12-31", close: 200 },
    ],
  });
  const config = { geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, maxPositionHoldDays: 1, fakeModel: makeFakeModel() };

  const returns = await runOnSignalReturns({}, config, db, {
    tickers: ["AAPL", "MSFT"], testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-02T00:00:00.000Z", graceDays: 2,
  });

  assert.equal(returns.length, 2);
  assert.ok(returns.every((r) => r === 0));
  assert.equal(db.positions.filter((p) => p.ticker === "AAPL").length, 1);
  assert.equal(db.positions.filter((p) => p.ticker === "MSFT").length, 1);
});

test("makeOnSignalReturns returns a function matching compareSignalOnOffByWindow's getOnReturns(window) signature", async () => {
  const db = new FakeOnSignalDb({
    newsItems: [{ id: "news-1", tickers: ["AAPL"], published_at: "2026-01-01T00:00:00.000Z", title: "t", body: "b" }],
    priceBars: [{ ticker: "AAPL", date: "2025-12-31", close: 50 }],
  });
  const config = { geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, maxPositionHoldDays: 1, fakeModel: makeFakeModel() };

  const getOnReturns = makeOnSignalReturns({}, config, db, { tickers: ["AAPL"], graceDays: 2 });
  // Same window shape walkForwardWindows yields -- this function only reads testStart/testEnd, ignoring the train fields.
  const returns = await getOnReturns({ trainStart: "2025-12-01T00:00:00.000Z", trainEnd: "2026-01-01T00:00:00.000Z", testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-02T00:00:00.000Z" });

  assert.deepEqual(returns, [0]);
});
