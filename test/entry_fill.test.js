// graph/entry_fill.js (PR 158): the fill step for 'pending_entry' decisions, on real sqlite state + inputs DBs.
// A daily-only price is a stale entry price, so the pipeline stores the approved thesis as 'pending_entry';
// fillPendingEntries opens it at the first bar open after its asOf, or expires it.

import test from "node:test";
import assert from "node:assert/strict";
import { runPipelineForTicker } from "../src/graph/pipeline.js";
import { fillPendingEntries } from "../src/graph/entry_fill.js";
import { TRADE_DECISION_STATUS } from "../src/shared/constants.js";
import { makeCtx, seedBar, stateRows } from "./helpers/engine_ctx.js";
import { makeFakeLongModel } from "./helpers/fake_long_model.js";

const config = (modelOpts) => ({
  geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, maxPositionHoldDays: 10,
  fakeModel: makeFakeLongModel(modelOpts),
});

const ASOF = "2026-01-15T13:36:00Z";
const newsItem = (id, publishedAt) => ({ id, tickers: ["AAPL"], title: "AAPL news", body: "body", publishedAt });

/** Runs the pipeline on a daily-only ticker so the thesis is left as 'pending_entry'. */
async function pendingCtx(modelOpts, { existing } = {}) {
  const ctx = makeCtx();
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-14", close: 180 }); // stale: no intraday bar at all
  if (existing) await ctx.store.openPosition(existing);
  const originalError = console.error;
  console.error = () => {};
  try {
    await runPipelineForTicker({}, config(modelOpts), ctx, { pipelineRunId: "news-1", ticker: "AAPL", newsItem: newsItem("news-1", ASOF), asOf: ASOF });
  } finally {
    console.error = originalError;
  }
  const [decision] = await stateRows(ctx.stateDb, "trade_decisions");
  assert.equal(decision.status, TRADE_DECISION_STATUS.PENDING_ENTRY, "sanity: the stale price left a pending entry");
  return ctx;
}

const openLong = (price = 100) => ({
  id: "AAPL|old", ticker: "AAPL", tradeThesisId: "AAPL|old", positionSizePct: 0.03,
  direction: "long", entryPrice: price, stopLossPct: 0.5, takeProfitPct: 5, openedAt: "2026-01-01T00:00:00Z",
});

test("a pending entry with no bar after its asOf keeps waiting, then expires as skipped_no_fill after 5 days", async () => {
  const ctx = await pendingCtx();

  const waiting = await fillPendingEntries({}, config(), ctx, { asOf: "2026-01-16T00:00:00Z" });
  assert.deepEqual(waiting, { filled: [], expired: [], waiting: 1 });
  assert.equal((await stateRows(ctx.stateDb, "positions")).length, 0);

  const expired = await fillPendingEntries({}, config(), ctx, { asOf: "2026-01-20T13:36:00Z" }); // asOf + 5d
  assert.equal(expired.expired.length, 1);
  assert.equal(expired.filled.length, 0);
  const [decision] = await stateRows(ctx.stateDb, "trade_decisions");
  assert.equal(decision.status, TRADE_DECISION_STATUS.SKIPPED_NO_FILL);
  assert.equal((await stateRows(ctx.stateDb, "positions")).length, 0);
});

test("a fill is idempotent: re-running after it filled opens nothing more", async () => {
  const ctx = await pendingCtx();
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-16", close: 170 });

  const first = await fillPendingEntries({}, config(), ctx, { asOf: "2026-01-17T00:00:00Z" });
  assert.equal(first.filled.length, 1);
  const second = await fillPendingEntries({}, config(), ctx, { asOf: "2026-01-17T00:00:00Z" });
  assert.deepEqual(second, { filled: [], expired: [], waiting: 0 });

  const positions = await stateRows(ctx.stateDb, "positions");
  assert.equal(positions.length, 1);
  assert.equal(positions[0].entry_price, 170);
  assert.equal(positions[0].opened_at, "2026-01-16T00:00:00.000Z", "opened_at is the fill bar's open");
  const decisions = await stateRows(ctx.stateDb, "trade_decisions");
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].status, TRADE_DECISION_STATUS.OPENED);
});

test("the fill records the fill bar as the entry price provenance, not the stale signal-time close", async () => {
  const ctx = await pendingCtx();
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-16", close: 200 }); // overnight gap up from 180
  await fillPendingEntries({}, config(), ctx, { asOf: "2026-01-17T00:00:00Z" });

  const [position] = await stateRows(ctx.stateDb, "positions");
  assert.equal(position.entry_price, 200);
  assert.equal(position.entry_price_source, "daily");
  assert.equal(position.entry_price_bar_ts, "2026-01-16");
  assert.ok(position.stop_loss_pct > 0 && position.take_profit_pct > 0);
});

test("filling a same-direction thesis onto an open position HOLDS it: no second position, decision 'held'", async () => {
  const ctx = await pendingCtx(undefined, { existing: openLong() });
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-16", close: 170 });

  await fillPendingEntries({}, config(), ctx, { asOf: "2026-01-17T00:00:00Z" });

  const positions = await stateRows(ctx.stateDb, "positions");
  assert.equal(positions.length, 1);
  assert.equal(positions[0].id, "AAPL|old");
  assert.equal(positions[0].closed_at, null);
  const [decision] = await stateRows(ctx.stateDb, "trade_decisions");
  assert.equal(decision.status, TRADE_DECISION_STATUS.HELD);
});

test("filling a confident opposite thesis FLIPS the open position at the fill price and settles it", async () => {
  const ctx = await pendingCtx({ direction: "short", confidence: 0.9 }, { existing: openLong(100) });
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-16", close: 170 });

  const { filled } = await fillPendingEntries({}, config({ direction: "short", confidence: 0.9 }), ctx, { asOf: "2026-01-17T00:00:00Z" });
  assert.equal(filled.length, 1);

  const positions = await stateRows(ctx.stateDb, "positions", "opened_at");
  assert.equal(positions.length, 2);
  assert.equal(positions[0].close_reason, "flipped");
  assert.equal(positions[0].exit_price, 170, "the replaced leg exits at the fill bar's open");
  assert.equal(positions[1].direction, "short");
  assert.equal(positions[1].entry_price, 170);
  assert.equal(positions[1].closed_at, null);

  const memory = await stateRows(ctx.stateDb, "decision_memory");
  assert.equal(memory.length, 1, "the flipped position is settled once");
  assert.ok(Math.abs(memory[0].realized_return - (170 - 100) / 100) < 1e-9);
});

// Exposure opened AFTER the signal (between its asOf and the fill bar's open) was invisible to the pipeline's
// risk check, so the fill must re-check the ceiling (MAX_PORTFOLIO_RISK_PCT = 0.2, summed position_size_pct).
// GOOG is outside TICKER_GROUPS, so the 10% group cap never applies to these fixtures; only the ceiling is under test.
const otherTickerPosition = (sizePct) => ({
  id: "GOOG|new", ticker: "GOOG", tradeThesisId: "GOOG|new", positionSizePct: sizePct,
  direction: "long", entryPrice: 400, stopLossPct: 0.05, takeProfitPct: 0.1, openedAt: "2026-01-15T20:00:00Z",
});

test("a fill that would breach the portfolio risk ceiling against exposure opened after the signal is REJECTED, no position", async () => {
  const ctx = await pendingCtx();
  await ctx.store.openPosition(otherTickerPosition(0.19)); // 0.19 + the pending ~0.04 > 0.2
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-16", close: 170 });

  const { filled } = await fillPendingEntries({}, config(), ctx, { asOf: "2026-01-17T00:00:00Z" });
  assert.equal(filled.length, 1, "the commit ran (and upgraded the decision row)");

  const positions = await stateRows(ctx.stateDb, "positions");
  assert.deepEqual(positions.map((p) => p.ticker), ["GOOG"], "no AAPL position opened");
  const [decision] = await stateRows(ctx.stateDb, "trade_decisions");
  assert.equal(decision.status, TRADE_DECISION_STATUS.REJECTED);
});

test("the same fill under the ceiling (0.10 + ~0.04) opens normally", async () => {
  const ctx = await pendingCtx();
  await ctx.store.openPosition(otherTickerPosition(0.1));
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-16", close: 170 });

  await fillPendingEntries({}, config(), ctx, { asOf: "2026-01-17T00:00:00Z" });

  assert.deepEqual((await stateRows(ctx.stateDb, "positions")).map((p) => p.ticker).sort(), ["AAPL", "GOOG"]);
  const [decision] = await stateRows(ctx.stateDb, "trade_decisions");
  assert.equal(decision.status, TRADE_DECISION_STATUS.OPENED);
});
