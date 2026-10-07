// Transaction cost model (plan: "cost model, flip = 2 trades"). Costs are per
// SIDE in basis points: shared/returns.js (net return of one closed position),
// backtest/equity.js (both scored curves), graph/settle.js (the return a
// reflection is recorded against) and config.js (default + parsing). Every
// expected number is worked out by hand in the comments.

import test from "node:test";
import assert from "node:assert/strict";
import { computeRealizedReturn, computeGrossReturn, sideCostFraction, roundTripCostFraction } from "../src/shared/returns.js";
import { buildPriceGrid, offEquityReturns, onEquityReturns } from "../src/backtest/equity.js";
import { checkOpenPositionExits } from "../src/graph/exit_check.js";
import { loadConfig } from "../src/config.js";
import { DEFAULT_TRADE_COST_BPS } from "../src/shared/constants.js";
import { makeCtx, seedBar, stateRows } from "./helpers/engine_ctx.js";

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ""} expected ${b}, got ${a}`);
const closeAll = (actual, expected, msg) => {
  assert.equal(actual.length, expected.length, `${msg ?? ""} length`);
  actual.forEach((v, i) => close(v, expected[i], `${msg ?? ""}[${i}]`));
};
const bar = (date, c) => ({ date, close: c });

// ---------------------------------------------------------------------------
// shared/returns.js
// ---------------------------------------------------------------------------

test("computeRealizedReturn is gross when costBps is omitted, zero, negative or not a number (unchanged behavior)", () => {
  const long = { direction: "long", entryPrice: 100, exitPrice: 110 };
  close(computeRealizedReturn(long), 0.1);
  close(computeRealizedReturn({ ...long, costBps: 0 }), 0.1);
  close(computeRealizedReturn({ ...long, costBps: -5 }), 0.1);
  close(computeRealizedReturn({ ...long, costBps: NaN }), 0.1);
  close(computeGrossReturn({ ...long, costBps: 50 }), 0.1); // gross ignores cost by definition
});

test("computeRealizedReturn nets one entry + one exit cost: gross - 2 * costBps / 10000, for longs and shorts", () => {
  close(computeRealizedReturn({ direction: "long", entryPrice: 100, exitPrice: 110, costBps: 5 }), 0.1 - 0.001);
  close(computeRealizedReturn({ direction: "short", entryPrice: 100, exitPrice: 90, costBps: 5 }), 0.1 - 0.001);
  // A losing trade gets worse, a flat one turns negative.
  close(computeRealizedReturn({ direction: "long", entryPrice: 100, exitPrice: 100, costBps: 5 }), -0.001);
  close(sideCostFraction(5), 0.0005);
  close(roundTripCostFraction(5), 0.001);
});

test("computeRealizedReturn still returns null (never fabricated) when a price or direction is missing, cost or not", () => {
  assert.equal(computeRealizedReturn({ direction: "long", entryPrice: null, exitPrice: 110, costBps: 5 }), null);
  assert.equal(computeRealizedReturn({ direction: "long", entryPrice: 100, exitPrice: null, costBps: 5 }), null);
  assert.equal(computeRealizedReturn({ direction: "flat", entryPrice: 100, exitPrice: 110, costBps: 5 }), null);
});

// ---------------------------------------------------------------------------
// backtest/equity.js
// ---------------------------------------------------------------------------

// Span 2024-01-01 .. 2024-01-06 exclusive; grid dates Jan 2, 3, 4, 5.
const FROM = "2024-01-01";
const TO = "2024-01-06";
const BARS = { A: [bar("2023-12-29", 100), bar("2024-01-02", 110), bar("2024-01-03", 121), bar("2024-01-04", 121), bar("2024-01-05", 133.1)] };
const grid = () => buildPriceGrid({ barsByTicker: BARS, tickers: ["A"], from: FROM, to: TO });
const pos = (over) => ({ id: "p", ticker: "A", direction: "long", positionSizePct: 0.1, entryPrice: 100, exitPrice: null, closeReason: null, openedAt: "2024-01-02T09:30:00.000Z", closedAt: null, ...over });

// 100 bps (1%) per side keeps the hand arithmetic readable.
const C = 100;

test("offEquityReturns: no cost argument (or 0) is identical to before; a cost charges ONE entry on the first day only", () => {
  const gross = offEquityReturns(grid()).returns;
  closeAll(gross, [0.1, 0.1, 0, 0.1]); // 110/100, 121/110, 121/121, 133.1/121
  closeAll(offEquityReturns(grid(), { costBps: 0 }).returns, gross);
  // value_k = gross_k * 0.99: Jan 2 = 1.10 * 0.99 - 1 = 0.089; afterwards the ratio is unchanged.
  closeAll(offEquityReturns(grid(), { costBps: C }).returns, [1.1 * 0.99 - 1, 0.1, 0, 0.1]);
});

test("onEquityReturns: entry cost on the open day and exit cost on the first grid date after the close, hand-checked", () => {
  // Long size 0.1 at entry 100, opened during Jan 2, closed during Jan 4: active Jan 2 and Jan 3.
  const p = pos({ closedAt: "2024-01-04T00:00:00.000Z", exitPrice: 121 });
  const gross = onEquityReturns(grid(), [p]);
  closeAll(gross.returns, [0.01, 0.011 / 1.01, 0, 0]); // no cost given: exactly the old numbers

  const net = onEquityReturns(grid(), [p], { costBps: C });
  // Jan 2: alloc 0.10, value 0.11, pnl 0.01, entry cost 0.10 * 0.01 = 0.001 -> 0.009 on equity 1; equity 1.009.
  // Jan 3: value 0.121, pnl 0.011 -> 0.011 / 1.009; equity 1.020.
  // Jan 4: closed; exit cost 0.121 * 0.01 = 0.00121 -> -0.00121 / 1.020. Jan 5: nothing left to charge.
  closeAll(net.returns, [0.009, 0.011 / 1.009, -0.00121 / 1.02, 0]);
  assert.equal(net.positionsTraded, 1);
});

test("onEquityReturns: a still-open position pays its entry but no exit cost", () => {
  const net = onEquityReturns(grid(), [pos()], { costBps: C });
  // Jan 2: 0.01 - 0.001 = 0.009 (equity 1.009). Jan 3: 0.011. Jan 4: 0. Jan 5: 0.1 * 133.1/100 - 0.1 * 1.21 = 0.0121.
  closeAll(net.returns, [0.009, 0.011 / 1.009, 0, 0.0121 / (1.009 + 0.011)]);
});

test("onEquityReturns: a same-day round trip pays entry that day and exit on the next grid date", () => {
  // Opened and closed during Jan 3, entry 110 and exit 110 (the prior close); active on Jan 3 only.
  // The round trip is valued at its stored exit price (110), NOT Jan 3's close (121), so it is flat gross.
  const p = pos({ entryPrice: 110, openedAt: "2024-01-03T10:00:00.000Z", closedAt: "2024-01-03T15:00:00.000Z", exitPrice: 110 });
  const net = onEquityReturns(grid(), [p], { costBps: C });
  // Jan 3: alloc 0.10, value 0.10 * 110/110 = 0.10, gross pnl 0, entry cost 0.001 -> -0.001 on equity 1; equity 0.999.
  // Jan 4: exit cost 0.10 * 0.01 = 0.001 -> -0.001 / 0.999. Jan 5: nothing.
  closeAll(net.returns, [0, -0.001, -0.001 / 0.999, 0]);
});

test("onEquityReturns: a flip is two trades -- the old position's exit and the new position's entry both hit the same day", () => {
  const old = pos({ id: "old", closedAt: "2024-01-04T00:00:00.000Z", exitPrice: 121 });
  const flipped = pos({ id: "new", direction: "short", entryPrice: 121, openedAt: "2024-01-04T00:00:00.000Z" });
  const net = onEquityReturns(grid(), [old, flipped], { costBps: C });
  // Equity entering Jan 4 = 1.02. Exit of old: 0.121 * 0.01 = 0.00121. New short alloc = 0.10 * 1.02 = 0.102,
  // entry cost 0.00102; its move on Jan 4 is 121/121 = 1 -> value 0.102, pnl 0. Total -0.00223 / 1.02.
  close(net.returns[2], -(0.00121 + 0.00102) / 1.02, "Jan 4 carries both trades");
  // Jan 5: short marked at 133.1/121 = 1.1 -> value 0.102 * 0.9 = 0.0918, pnl -0.0102 on equity 1.02 - 0.00223.
  close(net.returns[3], -0.0102 / (1.02 - 0.00223), "Jan 5, no further cost for a position still open");
});

test("onEquityReturns: costs never create a charge for a position that was never active in the grid", () => {
  const before = pos({ id: "early", openedAt: "2023-12-01T00:00:00.000Z", closedAt: "2023-12-05T00:00:00.000Z" }); // closed before the span
  const net = onEquityReturns(grid(), [before], { costBps: C });
  // Opened before the span but closed on Dec 5 (< every grid date): never active, so it pays nothing.
  closeAll(net.returns, [0, 0, 0, 0]);
});

// ---------------------------------------------------------------------------
// graph/settle.js (via checkOpenPositionExits): the reflection is recorded against the NET return
// ---------------------------------------------------------------------------

const FAKE_REFLECTION_MODEL = async () => JSON.stringify({ reflection: "test reflection" });

async function stopLossRealizedReturn(tradeCostBps) {
  const ctx = makeCtx();
  const config = { maxPositionHoldDays: 10, geminiQuickModel: "quick", fakeModel: FAKE_REFLECTION_MODEL, ...(tradeCostBps === undefined ? {} : { tradeCostBps }) };
  await ctx.store.openPosition({
    id: "AAPL|t1", ticker: "AAPL", tradeThesisId: "AAPL|t1", positionSizePct: 0.03,
    direction: "long", entryPrice: 100, stopLossPct: 0.03, takeProfitPct: 0.06, openedAt: "2026-01-01T00:00:00Z",
  });
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-02", close: 95 }); // -5%: stop_loss
  await checkOpenPositionExits({}, config, ctx, { asOf: "2026-01-03T00:00:00Z" });
  const memory = await stateRows(ctx.stateDb, "decision_memory");
  assert.equal(memory.length, 1);
  return memory[0].realized_return;
}

test("settle records the gross return with no tradeCostBps and the net return with one (10 bps/side -> -0.2%)", async () => {
  close(await stopLossRealizedReturn(undefined), -0.05);
  close(await stopLossRealizedReturn(0), -0.05);
  close(await stopLossRealizedReturn(10), -0.05 - 0.002);
});

// ---------------------------------------------------------------------------
// config.js
// ---------------------------------------------------------------------------

test("loadConfig: TRADE_COST_BPS defaults to the placeholder, honors 0 and decimals, and falls back on garbage or negatives", () => {
  assert.equal(loadConfig({}).tradeCostBps, DEFAULT_TRADE_COST_BPS);
  assert.equal(loadConfig({ TRADE_COST_BPS: "" }).tradeCostBps, DEFAULT_TRADE_COST_BPS);
  assert.equal(loadConfig({ TRADE_COST_BPS: "0" }).tradeCostBps, 0); // 0 = costs off, not "unset"
  assert.equal(loadConfig({ TRADE_COST_BPS: "12.5" }).tradeCostBps, 12.5);
  assert.equal(loadConfig({ TRADE_COST_BPS: "abc" }).tradeCostBps, DEFAULT_TRADE_COST_BPS);
  assert.equal(loadConfig({ TRADE_COST_BPS: "-3" }).tradeCostBps, DEFAULT_TRADE_COST_BPS);
});
