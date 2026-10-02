// Mark-to-market for the drawdown breaker (migration 0009, positions.last_price):
//   exit_bars.js#walkBarsForExit -> lastClose, RunStore#advancePositionCheck stores it with the
//   cursor, RunStore#getRealizedPnlPctAsOf({ includeUnrealized }) counts marked open positions,
//   graph/drawdown_breaker.js feeds it to the portfolio manager. Real sqlite-backed D1.

import test from "node:test";
import assert from "node:assert/strict";
import { walkBarsForExit } from "../src/agents/risk_mgmt/exit_bars.js";
import { loadDrawdownBreakerOptions } from "../src/graph/drawdown_breaker.js";
import { evaluatePortfolio } from "../src/agents/managers/portfolio_manager.js";
import { makeCtx } from "./helpers/engine_ctx.js";

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} !~ ${b}`);
const ASOF = "2026-02-01T00:00:00.000Z";

function bar(i, o, h, l, c) {
  const openMs = Date.UTC(2026, 0, 10 + i);
  return { kind: "daily", openMs, availableAt: new Date(openMs + 86400000).toISOString(), open: o, high: h, low: l, close: c };
}

const LONG = { direction: "long", entryPrice: 100, stopLossPct: 0.5, takeProfitPct: 1 };

async function seedOpen(store, { ticker = "AAA", size = 0.1, direction = "long", entry = 100, openedAt = "2026-01-20T00:00:00.000Z" } = {}) {
  await store.openPosition({ id: `${ticker}|t1`, ticker, tradeThesisId: `${ticker}|t1`, positionSizePct: size, direction, entryPrice: entry, stopLossPct: 0.5, takeProfitPct: 1, openedAt });
  return `${ticker}|t1`;
}

async function lastPriceOf(store, id) {
  const row = await store.db.prepare(`SELECT last_price, last_checked_at FROM positions WHERE run_id = ? AND id = ?`).bind(store.runId, id).first();
  return row;
}

test("walkBarsForExit returns the last valid bar's close as lastClose (null when nothing walked)", () => {
  const walk = walkBarsForExit(LONG, [bar(0, 100, 101, 99, 100.5), bar(1, 100.5, 102, 100, 101.5)]);
  assert.equal(walk.lastClose, 101.5);
  assert.equal(walkBarsForExit(LONG, []).lastClose, null);
  assert.equal(walkBarsForExit({ ...LONG, direction: null }, [bar(0, 100, 101, 99, 100)]).lastClose, null);
});

test("walkBarsForExit: an invalid last bar advances the cursor but keeps the previous valid close", () => {
  const bad = { ...bar(1, 100, 101, 99, 100), close: Number.NaN };
  const walk = walkBarsForExit(LONG, [bar(0, 100, 101, 99, 100.5), bad]);
  assert.equal(walk.lastClose, 100.5);
  assert.equal(walk.lastBarAvailableAt, bad.availableAt);
  assert.equal(walk.invalidBars, 1);
});

test("advancePositionCheck stores last_price with the cursor and keeps the old mark on a null price", async () => {
  const { store } = makeCtx();
  const id = await seedOpen(store);
  assert.equal(await store.advancePositionCheck({ id, lastCheckedAt: "2026-01-21T00:00:00.000Z", lastPrice: 95 }), true);
  assert.equal((await lastPriceOf(store, id)).last_price, 95);

  assert.equal(await store.advancePositionCheck({ id, lastCheckedAt: "2026-01-22T00:00:00.000Z", lastPrice: null }), true);
  const row = await lastPriceOf(store, id);
  assert.equal(row.last_price, 95, "a null/missing price must not overwrite the mark");
  assert.equal(row.last_checked_at, "2026-01-22T00:00:00.000Z");

  // Stale (non-forward) call is a no-op for the price too.
  assert.equal(await store.advancePositionCheck({ id, lastCheckedAt: "2026-01-21T12:00:00.000Z", lastPrice: 50 }), false);
  assert.equal((await lastPriceOf(store, id)).last_price, 95);

  // Non-finite / non-positive prices are ignored.
  await store.advancePositionCheck({ id, lastCheckedAt: "2026-01-23T00:00:00.000Z", lastPrice: Number.NaN });
  await store.advancePositionCheck({ id, lastCheckedAt: "2026-01-24T00:00:00.000Z", lastPrice: 0 });
  assert.equal((await lastPriceOf(store, id)).last_price, 95);
});

test("getRealizedPnlPctAsOf: includeUnrealized counts a marked open position; off by default", async () => {
  const { store } = makeCtx();
  const id = await seedOpen(store, { size: 0.1, entry: 100 });
  await store.advancePositionCheck({ id, lastCheckedAt: "2026-01-25T00:00:00.000Z", lastPrice: 90 });

  close(await store.getRealizedPnlPctAsOf({ asOf: ASOF, windowDays: 14 }), 0); // realized only: nothing closed
  close(await store.getRealizedPnlPctAsOf({ asOf: ASOF, windowDays: 14, includeUnrealized: true }), -0.01); // 0.10 * -10%
});

test("getRealizedPnlPctAsOf: unrealized is direction-aware, nets costBps, and adds to realized closes", async () => {
  const { store } = makeCtx();
  const shortId = await seedOpen(store, { ticker: "SHT", size: 0.05, direction: "short", entry: 100 });
  await store.advancePositionCheck({ id: shortId, lastCheckedAt: "2026-01-25T00:00:00.000Z", lastPrice: 90 }); // short gains 10%
  // A realized loser in the window: long 0.10 100 -> 95, closed 01-28 => -0.005.
  await seedOpen(store, { ticker: "CLS", size: 0.1, entry: 100 });
  await store.closePosition({ id: "CLS|t1", closedAt: "2026-01-28T00:00:00.000Z", closeReason: "stop_loss", exitPrice: 95 });

  close(await store.getRealizedPnlPctAsOf({ asOf: ASOF, windowDays: 14, includeUnrealized: true }), 0.05 * 0.1 - 0.005);
  // 100 bps/side: each counted position pays a 2% round trip. SHT (0.10 - 0.02) * 0.05 + CLS (-0.05 - 0.02) * 0.10.
  close(await store.getRealizedPnlPctAsOf({ asOf: ASOF, windowDays: 14, costBps: 100, includeUnrealized: true }), 0.08 * 0.05 - 0.07 * 0.1);
});

test("getRealizedPnlPctAsOf: a never-marked position, or a mark newer than asOf, counts as flat (no lookahead)", async () => {
  const { store } = makeCtx();
  await seedOpen(store, { ticker: "NEW", size: 0.1, entry: 100 }); // never marked
  const futureId = await seedOpen(store, { ticker: "FUT", size: 0.1, entry: 100 });
  await store.advancePositionCheck({ id: futureId, lastCheckedAt: "2026-02-10T00:00:00.000Z", lastPrice: 10 }); // after ASOF

  close(await store.getRealizedPnlPctAsOf({ asOf: ASOF, windowDays: 14, includeUnrealized: true }), 0);
  // The same mark IS visible once asOf has passed it.
  close(await store.getRealizedPnlPctAsOf({ asOf: "2026-02-11T00:00:00.000Z", windowDays: 14, includeUnrealized: true }), -0.09);
});

test("the breaker trips on an unrealized loss through loadDrawdownBreakerOptions + evaluatePortfolio", async () => {
  const { store } = makeCtx();
  const id = await seedOpen(store, { size: 0.05, entry: 100 });
  await store.advancePositionCheck({ id, lastCheckedAt: "2026-01-25T00:00:00.000Z", lastPrice: 50 }); // -50% * 0.05 = -2.5%

  const opts = await loadDrawdownBreakerOptions(store, { drawdownBreakerPct: 0.02, drawdownBreakerWindowDays: 14 }, { asOf: ASOF });
  close(opts.realizedPnlPct, -0.025);
  const risk = { tradeThesisId: "X|t", approved: true, positionSizePct: 0.03, stopLossPct: 0.03, takeProfitPct: 0.06, reason: "t" };
  const decision = evaluatePortfolio(risk, opts);
  assert.equal(decision.approvedForExecution, false);
  assert.match(decision.reason, /drawdown circuit breaker/);
});
