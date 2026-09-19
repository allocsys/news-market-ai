// exit_logic test (plan.md positions known-gap: "closePosition has no
// caller yet"). Covers three things: agents/risk_mgmt/exit.js#evaluateExit's
// pure stop-loss/take-profit/time-based rules, RunStore's
// openPosition/closePosition/getOpenPositionsAsOf against the exit fields,
// and graph/exit_check.js#checkOpenPositionExits' orchestration. Post-M2 the
// DB-backed half runs on REAL sqlite state + inputs DBs (test/helpers/
// engine_ctx.js) instead of a hand-rolled fake of the positions/price_bars
// tables.

import test from "node:test";
import assert from "node:assert/strict";
import { evaluateExit, CLOSE_REASON } from "../src/agents/risk_mgmt/exit.js";
import { checkOpenPositionExits } from "../src/graph/exit_check.js";
import { LookaheadViolationError } from "../src/shared/errors.js";
import { makeCtx, seedBar, stateRows } from "./helpers/engine_ctx.js";

// Deterministic, offline stand-in for the reflection LLM call --
// checkOpenPositionExits now calls settlePositionOutcome -> closeTheLoop ->
// recordAndReflect under the hood after every close (see graph/settle.js).
// Same config.fakeModel injection point memory_pointintime.test.js and
// checkpoint_resume.test.js already use.
const FAKE_REFLECTION_MODEL = async () => JSON.stringify({ reflection: "test reflection" });

// ---------------------------------------------------------------------
// evaluateExit -- pure function, no DB
// ---------------------------------------------------------------------

const BASE_LONG = {
  direction: "long",
  entryPrice: 100,
  stopLossPct: 0.03,
  takeProfitPct: 0.06,
  openedAt: "2026-01-01T00:00:00Z",
};

test("evaluateExit: long position with no threshold crossed and within hold window stays open", () => {
  const result = evaluateExit(BASE_LONG, { currentPrice: 101, asOf: "2026-01-02T00:00:00Z", maxHoldDays: 10 });
  assert.equal(result, null);
});

test("evaluateExit: long position triggers stop_loss when price drops past stopLossPct", () => {
  const result = evaluateExit(BASE_LONG, { currentPrice: 96.9, asOf: "2026-01-02T00:00:00Z", maxHoldDays: 10 }); // -3.1%
  assert.deepEqual(result, { reason: CLOSE_REASON.STOP_LOSS });
});

test("evaluateExit: long position triggers take_profit when price rises past takeProfitPct", () => {
  const result = evaluateExit(BASE_LONG, { currentPrice: 107, asOf: "2026-01-02T00:00:00Z", maxHoldDays: 10 }); // +7%
  assert.deepEqual(result, { reason: CLOSE_REASON.TAKE_PROFIT });
});

test("evaluateExit: short position triggers stop_loss when price RISES past stopLossPct (inverted)", () => {
  const short = { ...BASE_LONG, direction: "short" };
  const result = evaluateExit(short, { currentPrice: 103.5, asOf: "2026-01-02T00:00:00Z", maxHoldDays: 10 }); // price up 3.5% hurts a short
  assert.deepEqual(result, { reason: CLOSE_REASON.STOP_LOSS });
});

test("evaluateExit: short position triggers take_profit when price FALLS past takeProfitPct (inverted)", () => {
  const short = { ...BASE_LONG, direction: "short" };
  const result = evaluateExit(short, { currentPrice: 93, asOf: "2026-01-02T00:00:00Z", maxHoldDays: 10 }); // price down 7% is a win for a short
  assert.deepEqual(result, { reason: CLOSE_REASON.TAKE_PROFIT });
});

test("evaluateExit: stop_loss takes priority over take_profit when both are crossed at once", () => {
  // A price gap could, in principle, jump straight past both thresholds in
  // one bar -- stop_loss must win (protect capital first).
  const result = evaluateExit(BASE_LONG, { currentPrice: 50, asOf: "2026-01-02T00:00:00Z", maxHoldDays: 10 });
  assert.deepEqual(result, { reason: CLOSE_REASON.STOP_LOSS });
});

test("evaluateExit: time_based fires once maxHoldDays has elapsed with no price threshold crossed", () => {
  const result = evaluateExit(BASE_LONG, { currentPrice: 101, asOf: "2026-01-11T00:00:00Z", maxHoldDays: 10 });
  assert.deepEqual(result, { reason: CLOSE_REASON.TIME_BASED });
});

test("evaluateExit: time_based does not fire before maxHoldDays has elapsed", () => {
  const result = evaluateExit(BASE_LONG, { currentPrice: 101, asOf: "2026-01-09T00:00:00Z", maxHoldDays: 10 });
  assert.equal(result, null);
});

test("evaluateExit: a price threshold win still beats time_based even right at the hold-day boundary", () => {
  const result = evaluateExit(BASE_LONG, { currentPrice: 107, asOf: "2026-01-11T00:00:00Z", maxHoldDays: 10 });
  assert.deepEqual(result, { reason: CLOSE_REASON.TAKE_PROFIT });
});

test("evaluateExit: null entryPrice skips price-based exits entirely but time_based still works", () => {
  const noPrice = { ...BASE_LONG, entryPrice: null };
  const stillOpen = evaluateExit(noPrice, { currentPrice: 50, asOf: "2026-01-02T00:00:00Z", maxHoldDays: 10 });
  assert.equal(stillOpen, null); // would have been stop_loss if entryPrice were set -- must NOT fabricate one

  const timeBased = evaluateExit(noPrice, { currentPrice: 50, asOf: "2026-01-11T00:00:00Z", maxHoldDays: 10 });
  assert.deepEqual(timeBased, { reason: CLOSE_REASON.TIME_BASED });
});

test("evaluateExit: null currentPrice (no price_bars data) also skips price-based exits", () => {
  const result = evaluateExit(BASE_LONG, { currentPrice: null, asOf: "2026-01-02T00:00:00Z", maxHoldDays: 10 });
  assert.equal(result, null);
});

test("evaluateExit: direction 'flat' never triggers a price-based exit", () => {
  const flat = { ...BASE_LONG, direction: "flat" };
  const result = evaluateExit(flat, { currentPrice: 50, asOf: "2026-01-02T00:00:00Z", maxHoldDays: 10 });
  assert.equal(result, null);
});

// ---------------------------------------------------------------------
// RunStore positions (real sqlite state DB)
// ---------------------------------------------------------------------

const positionRow = async (ctx, id) => (await stateRows(ctx.stateDb, "positions")).find((r) => r.id === id);

test("getOpenPositionsAsOf throws LookaheadViolationError when asOf is omitted", async () => {
  const { store } = makeCtx();
  await assert.rejects(() => store.getOpenPositionsAsOf({}), LookaheadViolationError);
});

test("openPosition stores direction/entryPrice/stopLossPct/takeProfitPct, and getOpenPositionsAsOf returns them", async () => {
  const { store } = makeCtx();
  await store.openPosition({
    id: "AAPL|t1", ticker: "AAPL", tradeThesisId: "AAPL|t1", positionSizePct: 0.03,
    direction: "long", entryPrice: 150, stopLossPct: 0.03, takeProfitPct: 0.06,
    openedAt: "2026-01-01T00:00:00Z",
  });

  const [position] = await store.getOpenPositionsAsOf({ asOf: "2026-01-05T00:00:00Z" });
  assert.deepEqual(position, {
    id: "AAPL|t1", ticker: "AAPL", tradeThesisId: "AAPL|t1", positionSizePct: 0.03,
    direction: "long", entryPrice: 150, stopLossPct: 0.03, takeProfitPct: 0.06,
    openedAt: "2026-01-01T00:00:00Z",
  });
});

test("openPosition defaults direction/entryPrice/stopLossPct/takeProfitPct to null when omitted", async () => {
  const { store } = makeCtx();
  await store.openPosition({ id: "AAPL|t1", ticker: "AAPL", tradeThesisId: "AAPL|t1", positionSizePct: 0.03, openedAt: "2026-01-01T00:00:00Z" });

  const [position] = await store.getOpenPositionsAsOf({ asOf: "2026-01-05T00:00:00Z" });
  assert.equal(position.direction, null);
  assert.equal(position.entryPrice, null);
});

test("closePosition records closeReason and a subsequent getOpenPositionsAsOf no longer returns it", async () => {
  const ctx = makeCtx();
  const { store } = ctx;
  await store.openPosition({ id: "AAPL|t1", ticker: "AAPL", tradeThesisId: "AAPL|t1", positionSizePct: 0.03, direction: "long", openedAt: "2026-01-01T00:00:00Z" });
  await store.closePosition({ id: "AAPL|t1", closedAt: "2026-01-05T00:00:00Z", closeReason: "stop_loss" });

  const stillOpenAsOfBefore = await store.getOpenPositionsAsOf({ asOf: "2026-01-03T00:00:00Z" });
  assert.equal(stillOpenAsOfBefore.length, 1); // still open before the close

  const openAsOfAfter = await store.getOpenPositionsAsOf({ asOf: "2026-01-10T00:00:00Z" });
  assert.equal(openAsOfAfter.length, 0); // closed by then

  assert.equal((await positionRow(ctx, "AAPL|t1")).close_reason, "stop_loss");
});

// ---------------------------------------------------------------------
// checkOpenPositionExits -- orchestration
// ---------------------------------------------------------------------

const openArgs = (ticker, positionSizePct, entryPrice) => ({
  id: `${ticker}|t1`, ticker, tradeThesisId: `${ticker}|t1`, positionSizePct,
  direction: "long", entryPrice, stopLossPct: 0.03, takeProfitPct: 0.06,
  openedAt: "2026-01-01T00:00:00Z",
});

test("checkOpenPositionExits closes a position whose stop_loss triggers against price_bars, leaves others open", async () => {
  const ctx = makeCtx();
  const config = { maxPositionHoldDays: 10, geminiQuickModel: "quick", fakeModel: FAKE_REFLECTION_MODEL };

  await ctx.store.openPosition(openArgs("AAPL", 0.03, 100));
  await ctx.store.openPosition(openArgs("MSFT", 0.02, 200));
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-02", close: 95 }); // -5%, past stop_loss
  await seedBar(ctx.inputs, { ticker: "MSFT", date: "2026-01-02", close: 201 }); // unchanged, stays open

  const closed = await checkOpenPositionExits({}, config, ctx, { asOf: "2026-01-02T12:00:00Z" });

  assert.deepEqual(closed, [{ id: "AAPL|t1", ticker: "AAPL", reason: "stop_loss" }]);
  const stillOpen = await ctx.store.getOpenPositionsAsOf({ asOf: "2026-01-03T00:00:00Z" });
  assert.deepEqual(stillOpen.map((p) => p.id), ["MSFT|t1"]);

  // exitPrice recorded (the same bar that triggered the exit), and a
  // realized return computed + recorded via settlePositionOutcome.
  assert.equal((await positionRow(ctx, "AAPL|t1")).exit_price, 95);
  const memory = await stateRows(ctx.stateDb, "decision_memory");
  assert.equal(memory.length, 1);
  assert.equal(memory[0].decision_id, "AAPL|t1");
  assert.equal(memory[0].realized_return, (95 - 100) / 100); // -0.05, direction 'long'
  assert.equal(memory[0].alpha_return, null); // HONEST SCOPE -- no benchmark ingestion yet
  assert.equal(memory[0].reflection, "test reflection");
});

test("checkOpenPositionExits closes a position on a time-based exit even with no price_bars data at all, and records no reflection since the realized return isn't computable", async () => {
  const ctx = makeCtx();
  const config = { maxPositionHoldDays: 5, geminiQuickModel: "quick", fakeModel: FAKE_REFLECTION_MODEL };

  await ctx.store.openPosition(openArgs("TSLA", 0.03, null));
  // No price bars seeded for TSLA at all -- this is the "yfinance not wired
  // in yet" case documented in exit_check.js's header.

  const closed = await checkOpenPositionExits({}, config, ctx, { asOf: "2026-01-08T00:00:00Z" }); // 7 days later
  assert.deepEqual(closed, [{ id: "TSLA|t1", ticker: "TSLA", reason: "time_based" }]);

  // No entryPrice AND no exitPrice -- settlePositionOutcome must skip
  // reflection entirely rather than fabricate a realized return.
  assert.equal((await positionRow(ctx, "TSLA|t1")).exit_price, null);
  assert.equal((await stateRows(ctx.stateDb, "decision_memory")).length, 0);
});

test("checkOpenPositionExits closes nothing and returns an empty array when no position triggers", async () => {
  const ctx = makeCtx();
  const config = { maxPositionHoldDays: 10, geminiQuickModel: "quick", fakeModel: FAKE_REFLECTION_MODEL };

  await ctx.store.openPosition(openArgs("AAPL", 0.03, 100));
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-02", close: 101 });

  const closed = await checkOpenPositionExits({}, config, ctx, { asOf: "2026-01-02T12:00:00Z" });
  assert.deepEqual(closed, []);
});

test("checkOpenPositionExits is safe to re-run: an already-closed position is not returned/closed again", async () => {
  const ctx = makeCtx();
  const config = { maxPositionHoldDays: 10, geminiQuickModel: "quick", fakeModel: FAKE_REFLECTION_MODEL };

  await ctx.store.openPosition(openArgs("AAPL", 0.03, 100));
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-02", close: 95 });

  const firstRun = await checkOpenPositionExits({}, config, ctx, { asOf: "2026-01-02T12:00:00Z" });
  assert.equal(firstRun.length, 1);

  const secondRun = await checkOpenPositionExits({}, config, ctx, { asOf: "2026-01-03T12:00:00Z" });
  assert.deepEqual(secondRun, []);

  // settlePositionOutcome only ran once, on the first (real) close.
  assert.equal((await stateRows(ctx.stateDb, "decision_memory")).length, 1);
});

test("checkOpenPositionExits only sees its own environment's positions (run_id isolation)", async () => {
  const live = makeCtx({ runId: "live" });
  const { RunStore } = await import("../src/storage/run_store.js");
  const other = new RunStore(live.stateDb, "bt-1");
  const config = { maxPositionHoldDays: 10, geminiQuickModel: "quick", fakeModel: FAKE_REFLECTION_MODEL };

  await other.openPosition(openArgs("AAPL", 0.03, 100)); // belongs to bt-1, not live
  await seedBar(live.inputs, { ticker: "AAPL", date: "2026-01-02", close: 95 });

  const closed = await checkOpenPositionExits({}, config, live, { asOf: "2026-01-02T12:00:00Z" });
  assert.deepEqual(closed, []);
  assert.equal((await other.getOpenPositionsAsOf({ asOf: "2026-01-03T00:00:00Z" })).length, 1);
});
