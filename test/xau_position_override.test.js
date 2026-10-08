// Per-ticker position-size override (MAX_POSITION_PCT_BY_TICKER) and per-group exposure cap
// (GROUP_EXPOSURE_CAP_BY_GROUP) for XAUUSD. Pure functions, no DB/LLM.

import test from "node:test";
import assert from "node:assert/strict";
import { evaluateRisk } from "../src/agents/risk_mgmt/risk.js";
import { evaluatePortfolio } from "../src/agents/managers/portfolio_manager.js";
import { GROUP_EXPOSURE_CAP_BY_GROUP, MAX_GROUP_EXPOSURE_PCT, MAX_POSITION_PCT_BY_TICKER, groupCapOf } from "../src/shared/constants.js";

function thesis(ticker, direction = "long") {
  return { ticker, asOf: "2026-01-15", direction, instrument: "equity", rationale: "r" };
}

function verdict(ticker, confidence) {
  return {
    ticker, asOf: "2026-01-15",
    bull: { stance: "bull", argument: "a", justification: "j" },
    bear: { stance: "bear", argument: "a", justification: "j" },
    direction: "long", confidence, timeHorizon: "days", justification: "j",
  };
}

test("overrides: XAUUSD has a larger size cap and the gold group a larger group cap; everything else keeps the defaults", () => {
  assert.equal(MAX_POSITION_PCT_BY_TICKER.XAUUSD, 0.3);
  assert.equal(GROUP_EXPOSURE_CAP_BY_GROUP.gold, 0.3);
  assert.equal(groupCapOf("gold"), 0.3);
  assert.equal(groupCapOf("equity"), MAX_GROUP_EXPOSURE_PCT);
  assert.equal(groupCapOf("NVDA"), MAX_GROUP_EXPOSURE_PCT);
});

test("evaluateRisk: XAUUSD is sized confidence * 30%, other tickers stay confidence * 5%", () => {
  const xau = evaluateRisk(thesis("XAUUSD"), verdict("XAUUSD", 0.8), null);
  assert.ok(Math.abs(xau.positionSizePct - 0.24) < 1e-12);
  const aapl = evaluateRisk(thesis("AAPL"), verdict("AAPL", 0.8), null);
  assert.ok(Math.abs(aapl.positionSizePct - 0.04) < 1e-12);
});

test("evaluateRisk: the confidence threshold is unchanged for XAUUSD (0.55 is still rejected)", () => {
  const xau = evaluateRisk(thesis("XAUUSD"), verdict("XAUUSD", 0.55), null);
  assert.equal(xau.approved, false);
  assert.equal(xau.positionSizePct, 0);
});

test("evaluatePortfolio: a 24% XAUUSD thesis passes the gold group cap, the same size in the equity group is rejected", () => {
  const risk = { tradeThesisId: "X|t", approved: true, positionSizePct: 0.24, stopLossPct: 0.03, takeProfitPct: 0.06, reason: "test" };
  const xau = evaluatePortfolio(risk, { ticker: "XAUUSD", direction: "long", openPositions: [] });
  assert.equal(xau.approvedForExecution, true);
  assert.equal(xau.finalPositionSizePct, 0.24);
  const aapl = evaluatePortfolio(risk, { ticker: "AAPL", direction: "long", openPositions: [] });
  assert.equal(aapl.approvedForExecution, false);
  assert.match(aapl.reason, /group cap 0.1\b/);
});

test("evaluatePortfolio: above the raised 30% gold cap is still rejected", () => {
  const risk = { tradeThesisId: "X|t", approved: true, positionSizePct: 0.31, stopLossPct: 0.03, takeProfitPct: 0.06, reason: "test" };
  const xau = evaluatePortfolio(risk, { ticker: "XAUUSD", direction: "long", openPositions: [] });
  assert.equal(xau.approvedForExecution, false);
  assert.match(xau.reason, /group cap 0.3/);
});
