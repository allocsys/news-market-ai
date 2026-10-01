// Tests for backtest/newsReplay.js -- the operator tool that runs a selected
// historical news item through BOTH the pre-#132 parallel 3-analyst-call path
// and the current batched runAnalystTeam path, and diffs the resulting trade
// decision. Uses config.fakeModel (same injection point analyst_team.test.js
// and test/helpers/fake_long_model.js use) so no real Gemini calls happen,
// and makeCtx()'s real sqlite-backed state DB (test/helpers/engine_ctx.js) so
// the "writes nothing" claim is checked against the real schema, not a mock.

import test from "node:test";
import assert from "node:assert/strict";
import { replayNewsItem, replayNewsItems, simulateForward } from "../src/backtest/newsReplay.js";
import { getNewsItemsByIds } from "../src/storage/inputs_view.js";
import { makeCtx, seedNews, seedBar, seedIntradayBar, seedIntradayBarOhlc, stateRows } from "./helpers/engine_ctx.js";
import { AnalystOpinion, AnalystTeamOpinion, DebateSide, DebateVerdict, TradeThesis } from "../src/schemas/index.js";

/**
 * A fake model that answers every schema this comparison can ask for, and
 * counts calls by schema so tests can assert "3 separate calls" vs "1
 * batched call" without inspecting prompts. Bull/bear/verdict/trader answers
 * are FIXED regardless of the opinions they're handed -- the point of these
 * tests is comparing the analyst-call SHAPE, not analyst-content-driven
 * trading logic (already covered by analyst_team.test.js and
 * signalCompare.js's own tests), so both modes should land on an identical
 * downstream decision when the fixed answers are identical.
 */
function makeFakeModel() {
  const calls = { analystOpinion: 0, analystTeam: 0, debateSide: 0, debateVerdict: 0, tradeThesis: 0 };
  const fakeModel = async (prompt, opts) => {
    if (opts.schema === AnalystOpinion) {
      calls.analystOpinion += 1;
      if (opts.extraFields.agent === "news_event") {
        return JSON.stringify({ eventType: "earnings", entities: ["AAPL"], summary: "beat estimates", justification: "eps up" });
      }
      if (opts.extraFields.agent === "sentiment") {
        return JSON.stringify({ sentiment: "positive", summary: "market pleased", justification: "beat + guidance raise" });
      }
      return JSON.stringify({ summary: "up trend", justification: "price above SMA" }); // technical
    }
    if (opts.schema === AnalystTeamOpinion) {
      calls.analystTeam += 1;
      return JSON.stringify({
        news_event: { eventType: "earnings", entities: ["AAPL"], summary: "beat estimates", justification: "eps up" },
        sentiment: { sentiment: "positive", summary: "market pleased", justification: "beat + guidance raise" },
        technical: { summary: "up trend", justification: "price above SMA" },
      });
    }
    if (opts.schema === DebateSide) {
      calls.debateSide += 1;
      return opts.extraFields.stance === "bull"
        ? JSON.stringify({ argument: "earnings beat justifies a long position", justification: "fundamentals improved" })
        : JSON.stringify({ argument: "one beat doesn't confirm a trend", justification: "macro risk remains" });
    }
    if (opts.schema === DebateVerdict) {
      calls.debateVerdict += 1;
      return JSON.stringify({ direction: "long", confidence: 0.8, timeHorizon: "days", justification: "bull case outweighs bear case" });
    }
    if (opts.schema === TradeThesis) {
      calls.tradeThesis += 1;
      return JSON.stringify({ instrument: "equity", rationale: "ride the post-earnings momentum" });
    }
    throw new Error(`unexpected schema in test fake model: ${JSON.stringify(opts.extraFields)}`);
  };
  return { fakeModel, calls };
}

function baseConfig(fakeModel) {
  return { geminiQuickModel: "test-model", fakeModel };
}

test("replayNewsItem: parallel mode makes 3 separate analyst calls, batched mode makes 1", async () => {
  const { inputs, store } = makeCtx({ runId: "replay-test-1" });
  await seedNews(inputs, { id: "news1", tickers: ["AAPL"], publishedAt: "2026-01-10T14:00:00.000Z", title: "AAPL beats", body: "AAPL beat EPS estimates." });
  for (const [date, close] of [["2026-01-05", 100], ["2026-01-06", 102], ["2026-01-07", 104], ["2026-01-08", 106], ["2026-01-09", 108]]) {
    await seedBar(inputs, { ticker: "AAPL", date, close });
  }

  const { fakeModel, calls } = makeFakeModel();
  const config = baseConfig(fakeModel);
  const newsItem = { id: "news1", title: "AAPL beats", body: "AAPL beat EPS estimates." };

  const result = await replayNewsItem({}, config, { inputs, store }, { ticker: "AAPL", newsItem, asOf: "2026-01-10T14:00:00.000Z" });

  assert.equal(calls.analystOpinion, 3, "old parallel path should make exactly 3 separate AnalystOpinion calls");
  assert.equal(calls.analystTeam, 1, "batched path should make exactly 1 AnalystTeamOpinion call");
  assert.equal(result.parallel.opinions.length, 3);
  assert.equal(result.batched.opinions.length, 3);
});

test("replayNewsItem: both modes land on the same trade decision when given identical downstream answers", async () => {
  const { inputs, store } = makeCtx({ runId: "replay-test-2" });
  await seedNews(inputs, { id: "news1", tickers: ["AAPL"], publishedAt: "2026-01-10T14:00:00.000Z", title: "AAPL beats", body: "b" });

  const { fakeModel } = makeFakeModel();
  const config = baseConfig(fakeModel);
  const newsItem = { id: "news1", title: "AAPL beats", body: "b" };

  const result = await replayNewsItem({}, config, { inputs, store }, { ticker: "AAPL", newsItem, asOf: "2026-01-10T14:00:00.000Z" });

  assert.equal(result.diff.directionMatch, true);
  assert.equal(result.diff.approvedMatch, true);
  assert.equal(result.diff.positionSizePctDelta, 0);
  assert.equal(result.parallel.summary.direction, "long");
  assert.equal(result.batched.summary.direction, "long");
});

test("replayNewsItem: diff also compares stop/target and pnl fields, not just direction/approval/sizing/confidence", async () => {
  const { inputs, store } = makeCtx({ runId: "replay-test-2b" });
  await seedNews(inputs, { id: "news1", tickers: ["AAPL"], publishedAt: "2026-01-10T14:00:00.000Z", title: "AAPL beats", body: "b" });

  const { fakeModel } = makeFakeModel();
  const config = baseConfig(fakeModel);
  const newsItem = { id: "news1", title: "AAPL beats", body: "b" };

  const result = await replayNewsItem({}, config, { inputs, store }, { ticker: "AAPL", newsItem, asOf: "2026-01-10T14:00:00.000Z" });

  // Both modes get identical fixed downstream answers (same fake model) and
  // no price bars are seeded, so both fall back to the same flat 3%/6%
  // thresholds and the same (all-null, unapproved-pnl-shape) simulateForward
  // result -- every new diff field should show "identical", not "missing".
  assert.equal(result.diff.stopLossPctDelta, 0);
  assert.equal(result.diff.takeProfitPctDelta, 0);
  assert.equal(result.diff.exitReasonMatch, true);
  assert.equal(result.diff.realizedReturnPctDelta, null, "both sides null (unapproved pnl shape) -> can't-compare null, not a false 0");
  assert.equal(result.diff.positionPnlPctDelta, null);
  assert.equal(result.diff.maxDrawdownPctDelta, null);
  assert.equal(result.diff.holdDaysDelta, null);
});

test("replayNewsItem never writes positions, trade_decisions, or pipeline_checkpoints", async () => {
  const { inputs, store, stateDb } = makeCtx({ runId: "replay-test-3" });
  await seedNews(inputs, { id: "news1", tickers: ["AAPL"], publishedAt: "2026-01-10T14:00:00.000Z", title: "AAPL beats", body: "b" });

  const { fakeModel } = makeFakeModel();
  const config = baseConfig(fakeModel);
  const newsItem = { id: "news1", title: "AAPL beats", body: "b" };

  await replayNewsItem({}, config, { inputs, store }, { ticker: "AAPL", newsItem, asOf: "2026-01-10T14:00:00.000Z" });

  assert.deepEqual(await stateRows(stateDb, "positions"), []);
  assert.deepEqual(await stateRows(stateDb, "trade_decisions"), []);
  assert.deepEqual(await stateRows(stateDb, "pipeline_checkpoints"), []);
});

test("replayNewsItems: runs one comparison per selected item and defaults asOf to each item's own published_at", async () => {
  const { inputs, store } = makeCtx({ runId: "replay-test-4" });
  await seedNews(inputs, { id: "news1", tickers: ["AAPL"], publishedAt: "2026-01-10T14:00:00.000Z", title: "first", body: "b" });
  await seedNews(inputs, { id: "news2", tickers: ["AAPL"], publishedAt: "2026-01-11T09:00:00.000Z", title: "second", body: "b" });

  const { fakeModel } = makeFakeModel();
  const config = baseConfig(fakeModel);
  const newsItems = await getNewsItemsByIds(inputs, { ids: ["news1", "news2"] });
  assert.equal(newsItems.length, 2);

  const results = await replayNewsItems({}, config, { inputs, store }, { ticker: "AAPL", newsItems });

  assert.equal(results.length, 2);
  assert.deepEqual(results.map((r) => r.newsItemId).sort(), ["news1", "news2"]);
  assert.deepEqual(
    results.map((r) => r.asOf).sort(),
    ["2026-01-10T14:00:00.000Z", "2026-01-11T09:00:00.000Z"]
  );
});

test("getNewsItemsByIds: returns the latest revision for known ids and silently omits unknown ones", async () => {
  const { inputs } = makeCtx({ runId: "replay-test-5" });
  await seedNews(inputs, { id: "news1", tickers: ["AAPL"], publishedAt: "2026-01-10T14:00:00.000Z", title: "first", body: "b" });

  const rows = await getNewsItemsByIds(inputs, { ids: ["news1", "does-not-exist"] });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "news1");
  assert.equal(rows[0].title, "first");
});

test("getNewsItemsByIds: empty ids array returns empty without querying", async () => {
  const { inputs } = makeCtx({ runId: "replay-test-6" });
  assert.deepEqual(await getNewsItemsByIds(inputs, { ids: [] }), []);
});

test("simulateForward: approved long position hits take-profit within horizon", async () => {
  const { inputs } = makeCtx({ runId: "replay-test-7" });
  // A stale daily close no longer prices an entry (it would wait for the next bar open); a fresh 5m bar closing at asOf does.
  await seedIntradayBar(inputs, { ticker: "AAPL", ts: "2026-01-10T13:55:00Z", close: 100 });
  await seedBar(inputs, { ticker: "AAPL", date: "2026-01-09", close: 100 });
  await seedBar(inputs, { ticker: "AAPL", date: "2026-01-10", close: 115 });

  const pnl = await simulateForward(inputs, {}, {
    ticker: "AAPL",
    asOf: "2026-01-10T14:00:00.000Z",
    decision: {
      thesis: { direction: "long" },
      riskDecision: { stopLossPct: 0.05, takeProfitPct: 0.10 },
      portfolioDecision: { approvedForExecution: true, finalPositionSizePct: 0.5 }
    }
  });

  assert.equal(pnl.entryPrice, 100);
  assert.equal(pnl.exitPrice, 115);
  assert.equal(pnl.exitReason, "take_profit");
  assert.equal(pnl.realizedReturnPct, 0.15);
  assert.equal(pnl.positionPnlPct, 0.15 * 0.5);
});

test("simulateForward: unapproved position produces all-null pnl shape", async () => {
  const { inputs } = makeCtx({ runId: "replay-test-8" });
  const pnl = await simulateForward(inputs, {}, {
    ticker: "AAPL",
    asOf: "2026-01-10T14:00:00.000Z",
    decision: {
      thesis: { direction: "long" },
      riskDecision: {},
      portfolioDecision: { approvedForExecution: false }
    }
  });

  assert.strictEqual(pnl.entryPrice, null);
  assert.strictEqual(pnl.exitReason, null);
});

test("simulateForward: maxDrawdownPct correctly tracked peak-to-trough", async () => {
  const { inputs } = makeCtx({ runId: "replay-test-9" });
  await seedIntradayBar(inputs, { ticker: "AAPL", ts: "2026-01-10T13:55:00Z", close: 100 });
  await seedBar(inputs, { ticker: "AAPL", date: "2026-01-09", close: 100 });
  await seedBar(inputs, { ticker: "AAPL", date: "2026-01-10", close: 110 });
  await seedBar(inputs, { ticker: "AAPL", date: "2026-01-11", close: 95 });
  await seedBar(inputs, { ticker: "AAPL", date: "2026-01-12", close: 105 });

  const pnl = await simulateForward(inputs, {}, {
    ticker: "AAPL",
    asOf: "2026-01-10T14:00:00.000Z",
    decision: {
      thesis: { direction: "long" },
      riskDecision: {},
      portfolioDecision: { approvedForExecution: true }
    }
  });

  // Entry 100, Peak at day 1 (110, +10%), dip at day 2 (95, -5% from entry).
  // Drawdown from peak: (110-95)/100 = 15% = 0.15.
  assert.ok(Math.abs(pnl.maxDrawdownPct - 0.15) < 0.001);
});

const APPROVED_LONG = {
  thesis: { direction: "long" },
  riskDecision: { stopLossPct: 0.05, takeProfitPct: 0.10 },
  portfolioDecision: { approvedForExecution: true, finalPositionSizePct: 0.5 },
};

test("simulateForward: stale entry price fills at the next bar's open, and the exit walk starts from the fill", async () => {
  const { inputs } = makeCtx({ runId: "replay-test-10" });
  // asOf is off-hours: only the 01-09 daily close (100) is visible, so the entry is stale.
  await seedBar(inputs, { ticker: "AAPL", date: "2026-01-09", close: 100 });
  await seedIntradayBarOhlc(inputs, { ticker: "AAPL", ts: "2026-01-11T14:30:00Z", open: 102, high: 103, low: 101, close: 103 });
  await seedBar(inputs, { ticker: "AAPL", date: "2026-01-12", close: 120 });

  const pnl = await simulateForward(inputs, {}, { ticker: "AAPL", asOf: "2026-01-10T22:00:00.000Z", decision: APPROVED_LONG });

  assert.equal(pnl.entryPrice, 102, "filled at the first bar's OPEN, not the stale 100 close");
  assert.equal(pnl.entryAsOf, "2026-01-11T14:30:00.000Z");
  assert.equal(pnl.exitReason, "take_profit");
  assert.equal(pnl.exitPrice, 120);
  assert.ok(Math.abs(pnl.realizedReturnPct - 18 / 102) < 1e-9, "return is measured from the fill, and the pre-fill 01-09 bar is never walked");
  assert.equal(pnl.holdDays, 1);
});

test("simulateForward: stale entry with no bar opening after asOf reports skipped_no_fill", async () => {
  const { inputs } = makeCtx({ runId: "replay-test-11" });
  await seedBar(inputs, { ticker: "AAPL", date: "2026-01-09", close: 100 });

  const pnl = await simulateForward(inputs, {}, { ticker: "AAPL", asOf: "2026-01-10T22:00:00.000Z", decision: APPROVED_LONG });

  assert.equal(pnl.exitReason, "skipped_no_fill");
  assert.strictEqual(pnl.entryPrice, null);
  assert.strictEqual(pnl.realizedReturnPct, null);
  assert.strictEqual(pnl.holdDays, null);
});

test("simulateForward: a bar that only opens after the 5-day pending-entry expiry is too late to fill", async () => {
  const { inputs } = makeCtx({ runId: "replay-test-12" });
  await seedBar(inputs, { ticker: "AAPL", date: "2026-01-09", close: 100 });
  // asOf + 5d = 2026-01-15T22:00Z; this bar opens on 01-16.
  await seedIntradayBarOhlc(inputs, { ticker: "AAPL", ts: "2026-01-16T14:30:00Z", open: 102, high: 103, low: 101, close: 103 });

  const pnl = await simulateForward(inputs, {}, { ticker: "AAPL", asOf: "2026-01-10T22:00:00.000Z", decision: APPROVED_LONG });

  assert.equal(pnl.exitReason, "skipped_no_fill");
  assert.strictEqual(pnl.entryPrice, null);
});
