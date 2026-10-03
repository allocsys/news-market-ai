// A DAILY bar (a day with no intraday rows) that touches both the stop and the
// target hides which came first. Default stays stop-first (pessimistic);
// dailyBothTouchedNearestOpen=1 resolves it to the level nearer the bar's open.
// Either way the exit is flagged `ambiguous` and the walk's caller logs it.
// Pure walk in agents/risk_mgmt/exit_bars.js; wiring through graph/exit_check.js
// and config.js / per-run knob overrides.

import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { walkBarsForExit } from "../src/agents/risk_mgmt/exit_bars.js";
import { checkOpenPositionExits } from "../src/graph/exit_check.js";
import { loadConfig } from "../src/config.js";
import { parseKnobOverrides, applyKnobOverrides, effectiveKnobs } from "../src/backtest/knobOverrides.js";
import { makeCtx, seedBarOhlc, stateRows } from "./helpers/engine_ctx.js";
import { makeFakeLongModel } from "./helpers/fake_long_model.js";

const LONG = { direction: "long", entryPrice: 100, stopLossPct: 0.05, takeProfitPct: 0.1 }; // stop 95, target 110
const SHORT = { direction: "short", entryPrice: 100, stopLossPct: 0.05, takeProfitPct: 0.1 }; // stop 105, target 90

const bar = (kind, open, high, low, close) => ({ kind, openMs: 0, availableAt: "2026-01-07T00:00:00Z", open, high, low, close });
const daily = (...ohlc) => bar("daily", ...ohlc);
const intraday = (...ohlc) => bar("intraday", ...ohlc);

const walk = (position, b, nearest) => walkBarsForExit(position, [b], { dailyBothTouchedNearestOpen: nearest });
const near = (actual, expected, msg) => assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < 1e-9, `${msg ?? "price"}: expected ~${expected}, got ${actual}`);

test("default: a daily bar touching both resolves as a stop, flagged ambiguous", () => {
  const r = walk(LONG, daily(108, 111, 94, 100), 0);
  assert.equal(r.exit.reason, "stop_loss");
  assert.equal(r.exit.ambiguous, true);
  near(r.exit.exitPrice, 95);
});

test("nearest-to-open: the target wins when the open is nearer the target", () => {
  const r = walk(LONG, daily(108, 111, 94, 100), 1);
  assert.equal(r.exit.reason, "take_profit");
  assert.equal(r.exit.ambiguous, true);
  near(r.exit.exitPrice, 110);
});

test("nearest-to-open: the stop wins when the open is nearer the stop, and on an exact tie", () => {
  assert.equal(walk(LONG, daily(98, 111, 94, 100), 1).exit.reason, "stop_loss");
  assert.equal(walk(LONG, daily(102.5, 111, 94, 100), 1).exit.reason, "stop_loss"); // 7.5 from each
});

test("nearest-to-open: a level the bar opened through (a gap) wins outright, at the open", () => {
  const gapDown = walk(LONG, daily(94, 111, 93, 100), 1); // opened below the stop
  assert.equal(gapDown.exit.reason, "stop_loss");
  near(gapDown.exit.exitPrice, 94);
  const gapUp = walk(LONG, daily(112, 113, 94, 100), 1); // opened above the target
  assert.equal(gapUp.exit.reason, "take_profit");
  near(gapUp.exit.exitPrice, 112);
});

test("nearest-to-open works for a short (stop above, target below)", () => {
  const r = walk(SHORT, daily(91, 106, 89, 100), 1); // open 91 is 1 from the target 90, 14 from the stop 105
  assert.equal(r.exit.reason, "take_profit");
  near(r.exit.exitPrice, 90);
  assert.equal(r.exit.ambiguous, true);
  assert.equal(walk(SHORT, daily(91, 106, 89, 100), 0).exit.reason, "stop_loss");
});

test("an intraday bar spanning both levels is never ambiguous and always stop-first, whatever the knob says", () => {
  for (const nearest of [0, 1]) {
    const r = walk(LONG, intraday(108, 111, 94, 100), nearest);
    assert.equal(r.exit.reason, "stop_loss");
    assert.equal("ambiguous" in r.exit, false);
  }
});

test("a daily bar touching only one level has no ambiguous key and is unchanged by the knob", () => {
  for (const nearest of [0, 1]) {
    const r = walk(LONG, daily(100, 111, 99, 105), nearest);
    assert.equal(r.exit.reason, "take_profit");
    assert.equal("ambiguous" in r.exit, false);
  }
});

// ---------------------------------------------------------------------------
// wired through checkOpenPositionExits
// ---------------------------------------------------------------------------

const OPENED = "2026-01-05T14:30:00Z";

async function setup() {
  const ctx = makeCtx();
  await ctx.store.openPosition({
    id: "AAPL|t1", ticker: "AAPL", tradeThesisId: "AAPL|t1", positionSizePct: 0.03, direction: "long",
    entryPrice: 100, stopLossPct: 0.03, takeProfitPct: 0.06, openedAt: OPENED, // stop 97, target 106
  });
  // Jan 6 touches both 97 and 106; it opens at 105, right next to the target.
  await seedBarOhlc(ctx.inputs, { ticker: "AAPL", date: "2026-01-06", open: 105, high: 110, low: 90, close: 100 });
  return ctx;
}

async function run(ctx, extra) {
  const spy = mock.method(console, "error", () => {});
  try {
    const closed = await checkOpenPositionExits({}, { maxPositionHoldDays: 10, geminiQuickModel: "quick", fakeModel: makeFakeLongModel(), ...extra }, ctx, { asOf: "2026-01-08T00:00:00.000Z" });
    return { closed, logs: spy.mock.calls.map((c) => String(c.arguments[0])) };
  } finally {
    spy.mock.restore();
  }
}

test("exit_check default (knob absent/0): stop-first, and the ambiguous exit is logged", async () => {
  const ctx = await setup();
  const { closed, logs } = await run(ctx, {});
  assert.deepEqual(closed, [{ id: "AAPL|t1", ticker: "AAPL", reason: "stop_loss" }]);
  assert.ok(logs.some((l) => /touched both stop and target/.test(l)), "ambiguity logged");
  near((await stateRows(ctx.stateDb, "positions"))[0].exit_price, 97);
});

test("exit_check with dailyBothTouchedNearestOpen=1: the nearer level (target) wins, still logged", async () => {
  const ctx = await setup();
  const { closed, logs } = await run(ctx, { dailyBothTouchedNearestOpen: 1 });
  assert.deepEqual(closed, [{ id: "AAPL|t1", ticker: "AAPL", reason: "take_profit" }]);
  assert.ok(logs.some((l) => /touched both stop and target/.test(l)));
  near((await stateRows(ctx.stateDb, "positions"))[0].exit_price, 106); // max(open 105, target 106)
});

// ---------------------------------------------------------------------------
// config + per-run override
// ---------------------------------------------------------------------------

test("config: DAILY_BOTH_TOUCHED_NEAREST_OPEN defaults to 0 and reads the env var", () => {
  assert.equal(loadConfig({}).dailyBothTouchedNearestOpen, 0);
  assert.equal(loadConfig({ DAILY_BOTH_TOUCHED_NEAREST_OPEN: "1" }).dailyBothTouchedNearestOpen, 1);
});

test("per-run override: 0/1 only, applied to that run's config and recorded in its effective knobs", () => {
  const from = (obj) => (name) => (Object.prototype.hasOwnProperty.call(obj, name) ? obj[name] : null);
  assert.deepEqual(parseKnobOverrides(from({ dailyBothTouchedNearestOpen: "1" })), { overrides: { dailyBothTouchedNearestOpen: 1 } });
  assert.deepEqual(parseKnobOverrides(from({ dailyBothTouchedNearestOpen: "0" })), { overrides: { dailyBothTouchedNearestOpen: 0 } });
  assert.ok(parseKnobOverrides(from({ dailyBothTouchedNearestOpen: "2" })).error);
  assert.ok(parseKnobOverrides(from({ dailyBothTouchedNearestOpen: "0.5" })).error);
  const config = applyKnobOverrides({ dailyBothTouchedNearestOpen: 0 }, { dailyBothTouchedNearestOpen: 1 });
  assert.equal(config.dailyBothTouchedNearestOpen, 1);
  assert.equal(effectiveKnobs(config).dailyBothTouchedNearestOpen, 1);
});
