// Covers src/backtest/runBacktest.js -- the wiring layer that combines
// onSignalRunner.js#makeOnSignalReturns + noSignalBaseline.js#makeBuyAndHoldOffReturns
// + signalCompare.js#compareSignalOnOffByWindow into one persisted run
// (migrations/0010_backtest_runs.sql), the piece plan.md's "Backtest
// harness" Known Gaps note flagged as the last open item. FakeBacktestDb
// below is FakeOnSignalDb (test/backtest_on_signal_runner.test.js) plus
// backtest_runs table support -- same config.fakeModel convention, zero
// real Gemini/Finnhub calls.

import test from "node:test";
import assert from "node:assert/strict";
import { runManualBacktest } from "../src/backtest/runBacktest.js";
import { AnalystOpinion, DebateSide, DebateVerdict, TradeThesis } from "../src/schemas/index.js";

class FakeBacktestDb {
  constructor({ newsItems = [], priceBars = [] } = {}) {
    this.newsItems = newsItems;
    this.priceBars = priceBars;
    this.checkpoints = new Map();
    this.positions = [];
    this.tradeDecisions = [];
    this.decisionMemory = [];
    this.backtestRuns = new Map();
  }

  prepare(sql) {
    const db = this;
    return {
      bind(...args) {
        return {
          async run() {
            if (/INSERT INTO backtest_runs/.test(sql)) {
              const [id, tickers, testStart, testEnd, trainDays, testDays, graceDays, startedAt] = args;
              db.backtestRuns.set(id, { id, tickers, test_start: testStart, test_end: testEnd, status: "running", result: null, error: null, started_at: startedAt, finished_at: null });
              return;
            }
            if (/UPDATE backtest_runs SET status = 'complete'/.test(sql)) {
              const [result, finishedAt, id] = args;
              const row = db.backtestRuns.get(id);
              if (row) { row.status = "complete"; row.result = result; row.finished_at = finishedAt; }
              return;
            }
            if (/UPDATE backtest_runs SET status = 'failed'/.test(sql)) {
              const [error, finishedAt, id] = args;
              const row = db.backtestRuns.get(id);
              if (row) { row.status = "failed"; row.error = error; row.finished_at = finishedAt; }
              return;
            }
            if (/INSERT INTO pipeline_checkpoints/.test(sql)) {
              const [runId, ticker, stage, state, updatedAt] = args;
              db.checkpoints.set(`${runId}|${ticker}`, { stage, state, updated_at: updatedAt });
              return;
            }
            if (/INSERT INTO positions/.test(sql)) {
              const [id, ticker, tradeThesisId, positionSizePct, direction, entryPrice, stopLossPct, takeProfitPct, openedAt] = args;
              if (db.positions.some((p) => p.id === id)) return;
              db.positions.push({ id, ticker, trade_thesis_id: tradeThesisId, position_size_pct: positionSizePct, direction, entry_price: entryPrice, stop_loss_pct: stopLossPct, take_profit_pct: takeProfitPct, opened_at: openedAt, closed_at: null, close_reason: null, exit_price: null });
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
            throw new Error(`FakeBacktestDb: unsupported run() query: ${sql}`);
          },
          async first() {
            if (/FROM backtest_runs/.test(sql)) return db.backtestRuns.get(args[0]) ?? null;
            if (/SELECT stage, state, updated_at FROM pipeline_checkpoints/.test(sql)) {
              const [runId, ticker] = args;
              return db.checkpoints.get(`${runId}|${ticker}`) ?? null;
            }
            if (/FROM positions/.test(sql) && /LIMIT 1/.test(sql)) {
              const [ticker, asOf, asOfClose] = args;
              const open = db.positions
                .filter((p) => p.ticker === ticker && p.opened_at <= asOf && (p.closed_at === null || p.closed_at > asOfClose))
                .sort((a, b) => (a.opened_at < b.opened_at ? 1 : -1));
              return open[0] ?? null;
            }
            throw new Error(`FakeBacktestDb: unsupported first() query: ${sql}`);
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
              const [asOf, asOfClose] = args;
              const results = db.positions
                .filter((p) => p.opened_at <= asOf && (p.closed_at === null || p.closed_at > asOfClose))
                .map((p) => ({ id: p.id, ticker: p.ticker, trade_thesis_id: p.trade_thesis_id, position_size_pct: p.position_size_pct, direction: p.direction, entry_price: p.entry_price, stop_loss_pct: p.stop_loss_pct, take_profit_pct: p.take_profit_pct, opened_at: p.opened_at }));
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
              const [ticker, from, to, limit] = args;
              const results = db.decisionMemory
                .filter((m) => m.ticker === ticker && m.resolved_at >= from && m.resolved_at < to && m.realized_return != null)
                .sort((a, b) => (a.resolved_at < b.resolved_at ? -1 : 1))
                .slice(0, limit)
                .map((m) => ({ realized_return: m.realized_return }));
              return { results };
            }
            if (/FROM decision_memory/.test(sql)) return { results: [] };
            if (/FROM news_item_revisions r/.test(sql)) {
              const [ticker, from, to, limit] = args;
              const results = db.newsItems
                .filter((n) => n.tickers.includes(ticker) && n.published_at >= from && n.published_at < to)
                .sort((a, b) => (a.published_at < b.published_at ? -1 : 1))
                .slice(0, limit)
                .map((n) => ({ id: n.id, revision: 1, published_at: n.published_at, title: n.title, body: n.body }));
              return { results };
            }
            throw new Error(`FakeBacktestDb: unsupported all() query: ${sql}`);
          },
        };
      },
    };
  }
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
  const db = new FakeBacktestDb({
    newsItems: [{ id: "news-1", tickers: ["AAPL"], published_at: "2026-01-01T00:00:00.000Z", title: "AAPL beats earnings", body: "Apple reported EPS above estimates." }],
    priceBars: [
      { ticker: "AAPL", date: "2025-12-31", close: 100 },
      { ticker: "AAPL", date: "2026-01-05", close: 110 },
    ],
  });
  const config = { geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, maxPositionHoldDays: 2, fakeModel: makeFakeModel() };

  const outcome = await runManualBacktest({}, config, db, {
    id: "run-happy", tickers: ["AAPL"], testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-06T00:00:00.000Z", graceDays: 3,
  });

  assert.equal(outcome.status, "complete");
  assert.ok(outcome.result.overall);
  assert.ok(Array.isArray(outcome.result.perWindow));
  assert.equal(outcome.result.perWindow.length, 1); // trainDays=0, one implicit test window covering the whole range

  const persisted = db.backtestRuns.get("run-happy");
  assert.equal(persisted.status, "complete");
  assert.deepEqual(JSON.parse(persisted.result), outcome.result);
  assert.ok(persisted.finished_at);

  // Real pipeline actually ran (a position opened from the backfilled news item).
  assert.equal(db.positions.length, 1);
});

test("runManualBacktest persists a 'failed' run with the error message, still returns status: 'failed' rather than throwing", async () => {
  class ThrowingDb extends FakeBacktestDb {
    prepare(sql) {
      if (/FROM news_item_revisions r/.test(sql)) throw new Error("simulated D1 read failure");
      return super.prepare(sql);
    }
  }
  const db = new ThrowingDb();
  const config = { geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, fakeModel: makeFakeModel() };

  const outcome = await runManualBacktest({}, config, db, {
    id: "run-fail", tickers: ["AAPL"], testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-06T00:00:00.000Z",
  });

  assert.equal(outcome.status, "failed");
  assert.match(outcome.error, /simulated D1 read failure/);

  const persisted = db.backtestRuns.get("run-fail");
  assert.equal(persisted.status, "failed");
  assert.match(persisted.error, /simulated D1 read failure/);
  assert.equal(persisted.result, null);
});

test("runManualBacktest with no backfilled news for the window still completes, with a thin/empty 'on' side (never fabricates)", async () => {
  const db = new FakeBacktestDb({
    newsItems: [], // nothing backfilled for this ticker/window
    priceBars: [
      { ticker: "AAPL", date: "2026-01-01", close: 100 },
      { ticker: "AAPL", date: "2026-01-06", close: 100 },
    ],
  });
  const config = { geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, fakeModel: makeFakeModel() };

  const outcome = await runManualBacktest({}, config, db, {
    id: "run-empty", tickers: ["AAPL"], testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-06T00:00:00.000Z",
  });

  assert.equal(outcome.status, "complete");
  assert.equal(db.positions.length, 0); // no news -> no pipeline run -> no position
  assert.equal(outcome.result.overall.on.cumulativeReturn, 0); // empty return series, not a fabricated number
});
