// Covers src/agents/analysts/technicalIndicators.js#computeATR and
// src/agents/risk_mgmt/risk.js#evaluateRisk's ATR-based dynamic sizing
// (PR #137). Pure functions, no DB/LLM -- no fixtures needed, just bars.
//
// Bars follow storage/inputs_view.js#getPriceBarsAsOf's convention:
// most-recent-first, {date, open, high, low, close, volume}.

import test from "node:test";
import assert from "node:assert/strict";
import { computeATR } from "../src/agents/analysts/technicalIndicators.js";
import { evaluateRisk } from "../src/agents/risk_mgmt/risk.js";

function bar(date, { open, high, low, close, volume = 1_000_000 }) {
  return { date, open, high, low, close, volume };
}

/** `n` flat, low-volatility bars (high-low = 1, no gaps) around `close`, most-recent-first. */
function flatBars(n, close = 100) {
  return Array.from({ length: n }, (_, i) =>
    bar(`2026-01-${String(n - i).padStart(2, "0")}`, { open: close, high: close + 0.5, low: close - 0.5, close })
  );
}

function thesis(direction = "long") {
  return { ticker: "TEST", asOf: "2026-01-15", direction, instrument: "equity", rationale: "r" };
}

function verdict(confidence) {
  return {
    ticker: "TEST", asOf: "2026-01-15",
    bull: { stance: "bull", argument: "a", justification: "j" },
    bear: { stance: "bear", argument: "a", justification: "j" },
    direction: "long", confidence, timeHorizon: "days", justification: "j",
  };
}

test("computeATR: returns null with fewer than window+1 bars", () => {
  assert.equal(computeATR(flatBars(5), 14), null);
  assert.equal(computeATR(null, 14), null);
  assert.equal(computeATR([], 14), null);
});

test("computeATR: exactly window+1 bars is the minimum sufficient input", () => {
  assert.notEqual(computeATR(flatBars(15), 14), null);
});

test("computeATR: flat, gapless bars average to the constant high-low range", () => {
  // Every bar here has high-low = 1 and no gap vs. the previous close, so
  // true range = high-low = 1 for every bar -> ATR = 1 exactly.
  assert.equal(computeATR(flatBars(20), 14), 1);
});

test("computeATR: a gap up between sessions is captured even with a tight high-low range", () => {
  // Bar 0 gaps up 10 points from bar 1's close, but its own high-low is
  // only 1 -- true range must use |high - prevClose|, not just high-low.
  const bars = flatBars(16, 100);
  bars[0] = bar("2026-01-16", { open: 111, high: 111.5, low: 110.5, close: 111 });
  const atr = computeATR(bars, 14);
  // Bar 0: high=111.5, low=110.5, prevClose (bar 1's close)=100 -> true range = max(1, |111.5-100|, |110.5-100|) = 11.5.
  // Bars 1..13: flat, no gap -> true range = high-low = 1 each.
  const expected = (11.5 + 13 * 1) / 14;
  assert.ok(Math.abs(atr - expected) < 1e-9, `expected ~${expected}, got ${atr}`);
});

test("evaluateRisk: below confidence threshold -> not approved, no stop/target, flat sizing", () => {
  const decision = evaluateRisk(thesis("long"), verdict(0.4), flatBars(20));
  assert.equal(decision.approved, false);
  assert.equal(decision.positionSizePct, 0);
  assert.equal(decision.stopLossPct, undefined);
  assert.equal(decision.takeProfitPct, undefined);
});

test("evaluateRisk: direction flat -> not approved even with high confidence", () => {
  const decision = evaluateRisk(thesis("flat"), verdict(0.9), flatBars(20));
  assert.equal(decision.approved, false);
  assert.equal(decision.positionSizePct, 0);
});

test("evaluateRisk: missing bars falls back to the flat 3%/6% thresholds", () => {
  const decision = evaluateRisk(thesis("long"), verdict(0.8), undefined);
  assert.equal(decision.approved, true);
  assert.equal(decision.stopLossPct, 0.03);
  assert.equal(decision.takeProfitPct, 0.06);
});

test("evaluateRisk: too-few bars for ATR_WINDOW (14) also falls back to flat thresholds", () => {
  const decision = evaluateRisk(thesis("long"), verdict(0.8), flatBars(10));
  assert.equal(decision.approved, true);
  assert.equal(decision.stopLossPct, 0.03);
  assert.equal(decision.takeProfitPct, 0.06);
});

test("evaluateRisk: sufficient bars -> ATR-derived stop/target, still a 2:1 reward:risk ratio", () => {
  const bars = flatBars(20, 100); // ATR = 1, latestClose = 100 -> raw stopLossPct = 1.5 * 1/100 = 0.015
  const decision = evaluateRisk(thesis("long"), verdict(0.8), bars);
  assert.equal(decision.approved, true);
  assert.ok(Math.abs(decision.stopLossPct - 0.015) < 1e-9, `expected ~0.015, got ${decision.stopLossPct}`);
  assert.ok(Math.abs(decision.takeProfitPct - decision.stopLossPct * 2) < 1e-9, "takeProfitPct must stay 2x stopLossPct");
});

test("evaluateRisk: stopLossPct is clamped to the 1% floor for a very quiet ticker", () => {
  // ATR near zero (high-low = 0.01) -> raw stop would be far below 1%.
  const bars = Array.from({ length: 20 }, (_, i) =>
    bar(`2026-01-${String(20 - i).padStart(2, "0")}`, { open: 100, high: 100.005, low: 99.995, close: 100 })
  );
  const decision = evaluateRisk(thesis("long"), verdict(0.8), bars);
  assert.equal(decision.stopLossPct, 0.01);
  assert.equal(decision.takeProfitPct, 0.02);
});

test("evaluateRisk: stopLossPct is clamped to the 8% ceiling for a very volatile ticker", () => {
  // ATR = 20 on a $100 close -> raw stop = 1.5 * 20/100 = 30%, way past the 8% ceiling.
  const bars = Array.from({ length: 20 }, (_, i) =>
    bar(`2026-01-${String(20 - i).padStart(2, "0")}`, { open: 100, high: 110, low: 90, close: 100 })
  );
  const decision = evaluateRisk(thesis("long"), verdict(0.8), bars);
  assert.equal(decision.stopLossPct, 0.08);
  assert.equal(decision.takeProfitPct, 0.16);
});

test("evaluateRisk: positionSizePct scales with confidence, capped at MAX_POSITION_PCT (5%)", () => {
  const low = evaluateRisk(thesis("long"), verdict(0.6), flatBars(20));
  const high = evaluateRisk(thesis("long"), verdict(1.0), flatBars(20));
  assert.ok(Math.abs(low.positionSizePct - 0.03) < 1e-9, `expected ~0.03, got ${low.positionSizePct}`);
  assert.equal(high.positionSizePct, 0.05);
});
