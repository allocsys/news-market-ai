// backtest_signal_compare test (plan.md open item: signal on/off backtest
// comparison harness). Covers metrics.js's pure statistical functions with
// hand-checkable numbers, and signalCompare.js's comparison + walk-forward
// rolling logic against fake return-generator callbacks (no real trade
// data or live pipeline needed -- see signalCompare.js's header for why
// that's an honest, separate, not-yet-attempted piece of work).

import test from "node:test";
import assert from "node:assert/strict";
import { cumulativeReturn, meanReturn, stdDevReturn, sharpeRatio, maxDrawdown, winRate, summarizeReturns } from "../src/backtest/metrics.js";
import { compareSignalOnOff, compareSignalOnOffByWindow } from "../src/backtest/signalCompare.js";

// ---------------------------------------------------------------------------
// metrics.js
// ---------------------------------------------------------------------------

test("cumulativeReturn compounds a return series correctly", () => {
  // (1.10)(0.95)(1.05) - 1 = 0.09725
  assert.ok(Math.abs(cumulativeReturn([0.10, -0.05, 0.05]) - 0.09725) < 1e-9);
});

test("cumulativeReturn is 0 for an empty series", () => {
  assert.equal(cumulativeReturn([]), 0);
});

test("meanReturn and stdDevReturn match hand-computed values", () => {
  const returns = [0.02, 0.04, 0.06]; // mean 0.04, sample stdev 0.02
  assert.ok(Math.abs(meanReturn(returns) - 0.04) < 1e-9);
  assert.ok(Math.abs(stdDevReturn(returns) - 0.02) < 1e-9);
});

test("stdDevReturn is 0 for fewer than 2 points", () => {
  assert.equal(stdDevReturn([0.05]), 0);
  assert.equal(stdDevReturn([]), 0);
});

test("sharpeRatio is 0 (not NaN/Infinity) when stdev is 0", () => {
  assert.equal(sharpeRatio([0.01, 0.01, 0.01]), 0);
});

test("sharpeRatio rewards higher mean / lower volatility", () => {
  const steady = [0.01, 0.012, 0.011, 0.0105];
  const volatile = [0.03, -0.02, 0.025, -0.015];
  assert.ok(sharpeRatio(steady) > sharpeRatio(volatile));
});

test("maxDrawdown finds the worst peak-to-trough decline, not just the last dip", () => {
  // equity: 1 -> 1.20 (peak) -> 0.90 (drawdown 0.25) -> 1.35 (new peak) -> 1.21 (drawdown ~0.1037)
  const returns = [0.20, -0.25, 0.50, -0.1037];
  assert.ok(Math.abs(maxDrawdown(returns) - 0.25) < 1e-6);
});

test("maxDrawdown is 0 for a monotonically increasing equity curve", () => {
  assert.equal(maxDrawdown([0.01, 0.02, 0.03]), 0);
});

test("winRate counts strictly positive returns only", () => {
  assert.equal(winRate([0.01, -0.01, 0, 0.02]), 0.5); // 2 of 4 strictly positive (0 doesn't count)
});

test("summarizeReturns bundles all metrics with the right n", () => {
  const s = summarizeReturns([0.05, -0.02, 0.03]);
  assert.equal(s.n, 3);
  assert.equal(typeof s.cumulativeReturn, "number");
  assert.equal(typeof s.sharpeRatio, "number");
  assert.equal(typeof s.maxDrawdown, "number");
  assert.equal(typeof s.winRate, "number");
});

// ---------------------------------------------------------------------------
// signalCompare.js
// ---------------------------------------------------------------------------

test("compareSignalOnOff normalizes delta sign so positive always means 'signal looks better'", () => {
  const on = [0.05, 0.04, 0.06]; // strong, steady, low drawdown
  const off = [-0.10, 0.30, -0.15]; // volatile, worse cumulative, bigger drawdown
  const { delta } = compareSignalOnOff(on, off);
  assert.ok(delta.cumulativeReturn > 0);
  assert.ok(delta.sharpeRatio > 0);
  assert.ok(delta.maxDrawdown > 0); // signal-on had the smaller drawdown -> positive delta
});

test("compareSignalOnOff returns zeroed comparisons for two empty series without throwing", () => {
  const { on, off, delta } = compareSignalOnOff([], []);
  assert.equal(on.n, 0);
  assert.equal(off.n, 0);
  assert.equal(delta.cumulativeReturn, 0);
});

test("compareSignalOnOffByWindow rolls across every walk-forward window and pools an overall comparison", async () => {
  const calls = [];
  const result = await compareSignalOnOffByWindow({
    startDate: "2026-01-01T00:00:00Z",
    endDate: "2026-03-01T00:00:00Z",
    trainDays: 30,
    testDays: 10,
    getOnReturns: async (window) => { calls.push(window); return [0.02, 0.01]; },
    getOffReturns: async () => [0.005, 0.0],
  });

  assert.ok(result.perWindow.length > 0);
  assert.equal(calls.length, result.perWindow.length);
  // pooled overall should have 2 returns per window on each side
  assert.equal(result.overall.on.n, result.perWindow.length * 2);
  assert.ok(result.overall.delta.cumulativeReturn > 0); // "on" returns are consistently better in this fixture
});

test("compareSignalOnOffByWindow supports sync (non-Promise) return-generator callbacks", async () => {
  const result = await compareSignalOnOffByWindow({
    startDate: "2026-01-01T00:00:00Z",
    endDate: "2026-02-01T00:00:00Z",
    trainDays: 20,
    testDays: 5,
    getOnReturns: () => [0.01],
    getOffReturns: () => [0.0],
  });
  assert.ok(result.perWindow.length > 0);
});
