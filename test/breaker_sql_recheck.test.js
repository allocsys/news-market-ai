// Drawdown circuit breaker enforced INSIDE RunStore#commitThesis's SQL (closeOld / openNew / decision CASE),
// so a close or mark that lands between the pipeline's read and the commit still blocks the entry. Every test
// calls commitThesis directly (no portfolio_manager pre-check), which is exactly the racing case: the SQL
// alone must reject. Real sqlite-backed D1.

import test from "node:test";
import assert from "node:assert/strict";
import { makeCtx } from "./helpers/engine_ctx.js";

const ASOF = "2026-02-01T00:00:00.000Z";
const BREAKER = { drawdownBreakerPct: 0.02, drawdownBreakerWindowDays: 14, tradeCostBps: 0 };

// Seeds use GOOG/NVDA (outside TICKER_GROUPS) with a tight stop so neither the group cap nor the exposure /
// loss-at-stop ceilings can be what rejects the entry under test.
async function seedOpen(store, { ticker = "GOOG", size = 0.05, direction = "long", entry = 100, openedAt = "2026-01-20T00:00:00.000Z" } = {}) {
  const id = `${ticker}|seed`;
  await store.openPosition({ id, ticker, tradeThesisId: id, positionSizePct: size, direction, entryPrice: entry, stopLossPct: 0.03, takeProfitPct: 0.06, openedAt });
  return id;
}

function thesisArgs({ ticker = "AAPL", asOf = ASOF, direction = "long", confidence = 0.8, positionSizePct = 0.05, ...extra } = {}) {
  const id = `${ticker}|${asOf}`;
  return {
    id,
    ticker,
    tradeThesisId: id,
    positionSizePct,
    direction,
    confidence,
    entryPrice: 100,
    stopLossPct: 0.03,
    takeProfitPct: 0.06,
    asOf,
    thesis: { ticker, asOf, direction },
    riskDecision: { approved: true, positionSizePct },
    createdAt: asOf,
    ...extra,
  };
}

async function commit(store, args) {
  await store.commitThesis(args);
  const row = await store.db.prepare(`SELECT status FROM trade_decisions WHERE run_id = ? AND id = ?`).bind(store.runId, args.id).first();
  return row?.status ?? null;
}

async function isOpen(store, ticker, asOf = "2026-03-01T00:00:00.000Z") {
  return (await store.getOpenPositionForTickerAsOf({ ticker, asOf })) !== null;
}

test("an unrealized loss past the breaker rejects the entry in SQL, with no position opened", async () => {
  const { store } = makeCtx();
  const id = await seedOpen(store);
  await store.advancePositionCheck({ id, lastCheckedAt: "2026-01-25T00:00:00.000Z", lastPrice: 50 }); // -50% * 5% = -2.5%
  assert.equal(await commit(store, thesisArgs({ ...BREAKER })), "rejected");
  assert.equal(await isOpen(store, "AAPL"), false);
});

test("a loss inside the breaker still opens", async () => {
  const { store } = makeCtx();
  const id = await seedOpen(store);
  await store.advancePositionCheck({ id, lastCheckedAt: "2026-01-25T00:00:00.000Z", lastPrice: 62 }); // -38% * 5% = -1.9%
  assert.equal(await commit(store, thesisArgs({ ...BREAKER })), "opened");
  assert.equal(await isOpen(store, "AAPL"), true);
});

test("the breaker is skipped when it is off or the caller passes no window (entry_fill path)", async () => {
  for (const extra of [{ drawdownBreakerPct: 0, drawdownBreakerWindowDays: 14 }, { drawdownBreakerPct: 0.02 }, {}]) {
    const { store } = makeCtx();
    const id = await seedOpen(store);
    await store.advancePositionCheck({ id, lastCheckedAt: "2026-01-25T00:00:00.000Z", lastPrice: 50 });
    assert.equal(await commit(store, thesisArgs(extra)), "opened", JSON.stringify(extra));
  }
});

test("a realized loss in the window trips the breaker; one that closed before the window does not", async () => {
  const inWindow = makeCtx().store;
  await seedOpen(inWindow);
  await inWindow.closePosition({ id: "GOOG|seed", closedAt: "2026-01-28T00:00:00.000Z", closeReason: "stop_loss", exitPrice: 50 }); // -2.5%
  assert.equal(await commit(inWindow, thesisArgs({ ...BREAKER })), "rejected");

  const outOfWindow = makeCtx().store;
  await seedOpen(outOfWindow, { openedAt: "2025-11-01T00:00:00.000Z" });
  await outOfWindow.closePosition({ id: "GOOG|seed", closedAt: "2025-12-01T00:00:00.000Z", closeReason: "stop_loss", exitPrice: 50 });
  assert.equal(await commit(outOfWindow, thesisArgs({ ...BREAKER })), "opened");
});

test("point-in-time: a never-marked position is flat and a mark newer than asOf is ignored", async () => {
  const { store } = makeCtx();
  await seedOpen(store, { ticker: "GOOG" }); // never marked
  const future = await seedOpen(store, { ticker: "NVDA" });
  await store.advancePositionCheck({ id: future, lastCheckedAt: "2026-02-10T00:00:00.000Z", lastPrice: 10 }); // after ASOF
  assert.equal(await commit(store, thesisArgs({ ...BREAKER })), "opened");
});

test("the SQL nets trade costs like getRealizedPnlPctAsOf", async () => {
  const args = { drawdownBreakerPct: 0.0025, drawdownBreakerWindowDays: 14 };
  for (const [tradeCostBps, expected] of [[0, "opened"], [100, "rejected"]]) {
    const { store } = makeCtx();
    const id = await seedOpen(store);
    await store.advancePositionCheck({ id, lastCheckedAt: "2026-01-25T00:00:00.000Z", lastPrice: 96 }); // -4% * 5% = -0.2%; -0.3% with a 2% round trip
    assert.equal(await commit(store, thesisArgs({ ...args, tradeCostBps })), expected, `costBps ${tradeCostBps}`);
  }
});

test("a direction-less or missing-price row counts as flat, never as a loss", async () => {
  const { store } = makeCtx();
  const id = await seedOpen(store, { direction: null });
  await store.advancePositionCheck({ id, lastCheckedAt: "2026-01-25T00:00:00.000Z", lastPrice: 1 });
  assert.equal(await commit(store, thesisArgs({ ...BREAKER })), "opened");
});

test("a flip is blocked by the breaker, and the open position is left in place", async () => {
  const { store } = makeCtx();
  const id = await seedOpen(store, { ticker: "AAPL" });
  await store.advancePositionCheck({ id, lastCheckedAt: "2026-01-25T00:00:00.000Z", lastPrice: 50 }); // this ticker's own loss counts: -2.5%
  assert.equal(await commit(store, thesisArgs({ ...BREAKER, direction: "short", confidence: 0.9 })), "rejected");
  const open = await store.getOpenPositionForTickerAsOf({ ticker: "AAPL", asOf: "2026-03-01T00:00:00.000Z" });
  assert.equal(open?.id, id, "closeOld must not close the old row when the breaker rejects");
  assert.equal(open?.direction, "long");
});

test("a flip under the breaker still closes the old row and opens the new one", async () => {
  const { store } = makeCtx();
  const id = await seedOpen(store, { ticker: "AAPL" });
  await store.advancePositionCheck({ id, lastCheckedAt: "2026-01-25T00:00:00.000Z", lastPrice: 98 }); // -0.1%
  assert.equal(await commit(store, thesisArgs({ ...BREAKER, direction: "short", confidence: 0.9 })), "opened");
  const open = await store.getOpenPositionForTickerAsOf({ ticker: "AAPL", asOf: "2026-03-01T00:00:00.000Z" });
  assert.equal(open?.direction, "short");
});
