// Drawdown circuit breaker (plan item 6): when trailing-window REALIZED book P&L
// is at or below -drawdownBreakerPct, new entries are rejected. Covers the pure
// decision (portfolio_manager.js), the point-in-time P&L read
// (RunStore#getRealizedPnlPctAsOf), the option loader, config parsing, and the
// real pipeline on sqlite state + inputs DBs. Numbers are worked out by hand.

import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePortfolio } from "../src/agents/managers/portfolio_manager.js";
import { loadDrawdownBreakerOptions } from "../src/graph/drawdown_breaker.js";
import { runPipelineForTicker } from "../src/graph/pipeline.js";
import { loadConfig } from "../src/config.js";
import { LookaheadViolationError } from "../src/shared/errors.js";
import {
  DEFAULT_DRAWDOWN_BREAKER_PCT,
  DEFAULT_DRAWDOWN_BREAKER_WINDOW_DAYS,
  TRADE_DECISION_STATUS,
} from "../src/shared/constants.js";
import { makeCtx, seedBar, seedIntradayBar, stateRows } from "./helpers/engine_ctx.js";
import { makeFakeLongModel } from "./helpers/fake_long_model.js";

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ""} expected ${b}, got ${a}`);

// ---------------------------------------------------------------------------
// agents/managers/portfolio_manager.js
// ---------------------------------------------------------------------------

const approved = (over = {}) => ({
  tradeThesisId: "AAPL|t1", approved: true, positionSizePct: 0.03, stopLossPct: 0.03, takeProfitPct: 0.06, reason: "ok", ...over,
});

test("evaluatePortfolio: rejects when trailing realized P&L is at or below -drawdownBreakerPct (boundary inclusive)", () => {
  const below = evaluatePortfolio(approved(), { realizedPnlPct: -0.03, drawdownBreakerPct: 0.02 });
  assert.equal(below.approvedForExecution, false);
  assert.equal(below.finalPositionSizePct, 0);
  assert.match(below.reason, /drawdown circuit breaker/);

  const exactly = evaluatePortfolio(approved(), { realizedPnlPct: -0.02, drawdownBreakerPct: 0.02 });
  assert.equal(exactly.approvedForExecution, false);
});

test("evaluatePortfolio: approves above the line, on gains, and when the breaker is off or its inputs are missing", () => {
  assert.equal(evaluatePortfolio(approved(), { realizedPnlPct: -0.019, drawdownBreakerPct: 0.02 }).approvedForExecution, true);
  assert.equal(evaluatePortfolio(approved(), { realizedPnlPct: 0.05, drawdownBreakerPct: 0.02 }).approvedForExecution, true);
  assert.equal(evaluatePortfolio(approved(), { realizedPnlPct: -0.5, drawdownBreakerPct: 0 }).approvedForExecution, true); // 0 disables
  assert.equal(evaluatePortfolio(approved(), { realizedPnlPct: -0.5 }).approvedForExecution, true); // no pct: unguarded
  assert.equal(evaluatePortfolio(approved(), { drawdownBreakerPct: 0.02 }).approvedForExecution, true); // no P&L: unguarded
  assert.equal(evaluatePortfolio(approved(), {}).approvedForExecution, true);
});

test("evaluatePortfolio: a risk_mgmt rejection keeps its own reason ahead of the breaker", () => {
  const d = evaluatePortfolio(approved({ approved: false, positionSizePct: 0 }), { realizedPnlPct: -0.5, drawdownBreakerPct: 0.02 });
  assert.match(d.reason, /risk_mgmt did not approve/);
});

// ---------------------------------------------------------------------------
// RunStore#getRealizedPnlPctAsOf
// ---------------------------------------------------------------------------

async function seedClosed(store, { ticker, direction, size, entry, exit, openedAt, closedAt }) {
  await store.openPosition({
    id: `${ticker}|t1`, ticker, tradeThesisId: `${ticker}|t1`, positionSizePct: size, direction, entryPrice: entry, openedAt,
  });
  if (closedAt) await store.closePosition({ id: `${ticker}|t1`, closedAt, closeReason: "stop_loss", exitPrice: exit });
}

// asOf 2026-02-01 with a 14-day window: closes in (2026-01-18, 2026-02-01] count.
const ASOF = "2026-02-01T00:00:00Z";

async function seedBook(store) {
  // Counted: long 0.10 at 100 -> 90 (-10% * 0.10 = -0.01), closed 01-25.
  await seedClosed(store, { ticker: "AAA", direction: "long", size: 0.1, entry: 100, exit: 90, openedAt: "2026-01-20T00:00:00Z", closedAt: "2026-01-25T00:00:00Z" });
  // Counted: short 0.05 at 100 -> 90 (+10% * 0.05 = +0.005), closed 01-30.
  await seedClosed(store, { ticker: "BBB", direction: "short", size: 0.05, entry: 100, exit: 90, openedAt: "2026-01-20T00:00:00Z", closedAt: "2026-01-30T00:00:00Z" });
  // Before the window (closed 01-10): excluded even though it lost 50% * 0.10.
  await seedClosed(store, { ticker: "CCC", direction: "long", size: 0.1, entry: 100, exit: 50, openedAt: "2026-01-02T00:00:00Z", closedAt: "2026-01-10T00:00:00Z" });
  // After asOf (closed 02-05): a lookahead if counted.
  await seedClosed(store, { ticker: "DDD", direction: "long", size: 0.1, entry: 100, exit: 10, openedAt: "2026-01-20T00:00:00Z", closedAt: "2026-02-05T00:00:00Z" });
  // Still open: realized only, so excluded.
  await seedClosed(store, { ticker: "EEE", direction: "long", size: 0.1, entry: 100, exit: null, openedAt: "2026-01-20T00:00:00Z" });
  // Closed in the window but no exit price: return not computable, contributes nothing.
  await seedClosed(store, { ticker: "FFF", direction: "long", size: 0.1, entry: 100, exit: null, openedAt: "2026-01-20T00:00:00Z", closedAt: "2026-01-26T00:00:00Z" });
}

test("getRealizedPnlPctAsOf: sums size * realized return over closes inside the window only, point-in-time", async () => {
  const { store } = makeCtx();
  await seedBook(store);
  close(await store.getRealizedPnlPctAsOf({ asOf: ASOF, windowDays: 14 }), -0.01 + 0.005);
});

test("getRealizedPnlPctAsOf: costBps nets one round trip per counted position, like settle", async () => {
  const { store } = makeCtx();
  await seedBook(store);
  // 100 bps/side -> 2% round trip. AAA: (-0.10 - 0.02) * 0.10 = -0.012. BBB: (0.10 - 0.02) * 0.05 = +0.004.
  close(await store.getRealizedPnlPctAsOf({ asOf: ASOF, windowDays: 14, costBps: 100 }), -0.012 + 0.004);
});

test("getRealizedPnlPctAsOf: the window rolls, a wider one reaches older closes, and an empty book is 0", async () => {
  const { store } = makeCtx();
  await seedBook(store);
  // Window start 2026-01-28: only BBB (closed 01-30) is inside.
  close(await store.getRealizedPnlPctAsOf({ asOf: ASOF, windowDays: 4 }), 0.005);
  // 30 days back reaches CCC (closed 01-10): -50% * 0.10 = -0.05 more.
  close(await store.getRealizedPnlPctAsOf({ asOf: ASOF, windowDays: 30 }), -0.01 + 0.005 - 0.05);
  close(await makeCtx().store.getRealizedPnlPctAsOf({ asOf: ASOF, windowDays: 14 }), 0);
  // No usable window -> 0 rather than a throw.
  close(await store.getRealizedPnlPctAsOf({ asOf: ASOF, windowDays: 0 }), 0);
  close(await store.getRealizedPnlPctAsOf({ asOf: ASOF }), 0);
});

test("getRealizedPnlPctAsOf: requires an explicit asOf (LookaheadViolationError)", async () => {
  const { store } = makeCtx();
  await assert.rejects(() => store.getRealizedPnlPctAsOf({ windowDays: 14 }), LookaheadViolationError);
});

// ---------------------------------------------------------------------------
// graph/drawdown_breaker.js
// ---------------------------------------------------------------------------

test("loadDrawdownBreakerOptions: {} with no store read when unconfigured or 0; otherwise P&L and threshold", async () => {
  const { store } = makeCtx();
  await seedBook(store);
  let reads = 0;
  const spy = { getRealizedPnlPctAsOf: async (args) => { reads += 1; return store.getRealizedPnlPctAsOf(args); } };

  assert.deepEqual(await loadDrawdownBreakerOptions(spy, {}, { asOf: ASOF }), {});
  assert.deepEqual(await loadDrawdownBreakerOptions(spy, { drawdownBreakerPct: 0, drawdownBreakerWindowDays: 14 }, { asOf: ASOF }), {});
  assert.equal(reads, 0, "a disabled breaker must not add a store read (budget-paced walks count them)");

  const opts = await loadDrawdownBreakerOptions(spy, { drawdownBreakerPct: 0.02, drawdownBreakerWindowDays: 14 }, { asOf: ASOF });
  assert.equal(reads, 1);
  assert.equal(opts.drawdownBreakerPct, 0.02);
  close(opts.realizedPnlPct, -0.005);
});

// ---------------------------------------------------------------------------
// graph/pipeline.js (real sqlite state + inputs DBs)
// ---------------------------------------------------------------------------

const pipelineConfig = (extra = {}) => ({
  geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, maxPositionHoldDays: 10,
  fakeModel: makeFakeLongModel(), ...extra,
});
const newsItem = (id, publishedAt) => ({ id, tickers: ["AAPL"], title: "AAPL news", body: "body", publishedAt });

// MSFT closed at a -10% loss on 0.10 of the book on 2026-01-10: realized P&L -0.01.
async function seedLoss(ctx) {
  await seedClosed(ctx.store, { ticker: "MSFT", direction: "long", size: 0.1, entry: 100, exit: 90, openedAt: "2026-01-05T00:00:00Z", closedAt: "2026-01-10T00:00:00Z" });
}

async function runAapl(ctx, config, asOf, barDate) {
  await seedBar(ctx.inputs, { ticker: "AAPL", date: barDate, close: 180 });
  // A fresh intraday bar (closed <=30min before asOf) is the entry price; a daily close alone is stale and would wait as pending_entry.
  const barTs = `${new Date(Math.floor(Date.parse(asOf) / 300000) * 300000 - 300000).toISOString().slice(0, 19)}Z`;
  await seedIntradayBar(ctx.inputs, { ticker: "AAPL", ts: barTs, close: 180 });
  return runPipelineForTicker({}, config, ctx, { pipelineRunId: `news-${asOf}`, ticker: "AAPL", newsItem: newsItem("n1", asOf), asOf });
}

test("pipeline: a tripped breaker rejects the new entry -- decision logged 'rejected', no AAPL position", async () => {
  const ctx = makeCtx();
  await seedLoss(ctx);
  const decision = await runAapl(ctx, pipelineConfig({ drawdownBreakerPct: 0.005, drawdownBreakerWindowDays: 14 }), "2026-01-15T13:36:00Z", "2026-01-14");

  assert.equal(decision.approvedForExecution, false);
  assert.match(decision.reason, /drawdown circuit breaker/);
  assert.deepEqual((await stateRows(ctx.stateDb, "positions")).map((p) => p.ticker), ["MSFT"]);
  const [row] = await stateRows(ctx.stateDb, "trade_decisions");
  assert.equal(row.status, TRADE_DECISION_STATUS.REJECTED);
});

test("pipeline: the same loss does not block when the loss is under the line, the breaker is 0, or the config has no breaker", async () => {
  for (const extra of [
    { drawdownBreakerPct: 0.02, drawdownBreakerWindowDays: 14 }, // -0.01 is above -0.02
    { drawdownBreakerPct: 0, drawdownBreakerWindowDays: 14 },
    {},
  ]) {
    const ctx = makeCtx();
    await seedLoss(ctx);
    const decision = await runAapl(ctx, pipelineConfig(extra), "2026-01-15T13:36:00Z", "2026-01-14");
    assert.equal(decision.approvedForExecution, true, JSON.stringify(extra));
    assert.deepEqual((await stateRows(ctx.stateDb, "positions")).map((p) => p.ticker).sort(), ["AAPL", "MSFT"]);
  }
});

test("pipeline: the breaker releases once the losses roll out of the window", async () => {
  const ctx = makeCtx();
  await seedLoss(ctx); // closed 2026-01-10
  const config = pipelineConfig({ drawdownBreakerPct: 0.005, drawdownBreakerWindowDays: 14 });

  // 5 days after the loss: inside the window -> blocked.
  const blocked = await runAapl(ctx, config, "2026-01-15T13:36:00Z", "2026-01-14");
  assert.equal(blocked.approvedForExecution, false);

  // 20 days after the loss: outside the 14-day window -> allowed again.
  const released = await runAapl(ctx, config, "2026-01-30T13:36:00Z", "2026-01-29");
  assert.equal(released.approvedForExecution, true);
  assert.ok((await stateRows(ctx.stateDb, "positions")).some((p) => p.ticker === "AAPL"));
});

// ---------------------------------------------------------------------------
// config.js
// ---------------------------------------------------------------------------

test("loadConfig: breaker settings default to the placeholders, honor 0 and decimals, and fall back on garbage or negatives", () => {
  const d = loadConfig({});
  assert.equal(d.drawdownBreakerPct, DEFAULT_DRAWDOWN_BREAKER_PCT);
  assert.equal(d.drawdownBreakerWindowDays, DEFAULT_DRAWDOWN_BREAKER_WINDOW_DAYS);
  assert.equal(loadConfig({ DRAWDOWN_BREAKER_PCT: "0" }).drawdownBreakerPct, 0); // 0 = off, not "unset"
  assert.equal(loadConfig({ DRAWDOWN_BREAKER_PCT: "0.05" }).drawdownBreakerPct, 0.05);
  assert.equal(loadConfig({ DRAWDOWN_BREAKER_PCT: "abc" }).drawdownBreakerPct, DEFAULT_DRAWDOWN_BREAKER_PCT);
  assert.equal(loadConfig({ DRAWDOWN_BREAKER_PCT: "-1" }).drawdownBreakerPct, DEFAULT_DRAWDOWN_BREAKER_PCT);
  assert.equal(loadConfig({ DRAWDOWN_BREAKER_WINDOW_DAYS: "30" }).drawdownBreakerWindowDays, 30);
  assert.equal(loadConfig({ DRAWDOWN_BREAKER_WINDOW_DAYS: "" }).drawdownBreakerWindowDays, DEFAULT_DRAWDOWN_BREAKER_WINDOW_DAYS);
});
