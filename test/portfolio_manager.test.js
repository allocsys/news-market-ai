// portfolio_manager.js previously had no dedicated test file at all --
// only exercised indirectly, if ever, through graph/pipeline.js. Covers
// evaluatePortfolio's core ceiling math (unchanged by the netting fix --
// see storage/d1.js#getOpenPositionsRiskPctAsOf and
// graph/pipeline.js's risk_checked stage for where the actual exclusion
// happens) plus the isReplacingPosition reason-text behavior added
// alongside it.

import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePortfolio } from "../src/agents/managers/portfolio_manager.js";

function approvedRiskDecision(overrides = {}) {
  return {
    tradeThesisId: "AAPL|2026-01-10T00:00:00Z",
    approved: true,
    positionSizePct: 0.03,
    stopLossPct: 0.03,
    takeProfitPct: 0.06,
    reason: "confidence above threshold",
    ...overrides,
  };
}

test("rejects immediately when risk_mgmt did not approve the thesis, regardless of exposure", () => {
  const riskDecision = approvedRiskDecision({ approved: false, positionSizePct: 0 });
  const decision = evaluatePortfolio(riskDecision, { openPositionsRiskPct: 0 });

  assert.equal(decision.approvedForExecution, false);
  assert.equal(decision.finalPositionSizePct, 0);
  assert.match(decision.reason, /risk_mgmt did not approve/);
});

test("approves when combined risk is under the ceiling", () => {
  const riskDecision = approvedRiskDecision({ positionSizePct: 0.03 });
  const decision = evaluatePortfolio(riskDecision, { openPositionsRiskPct: 0.05 });

  assert.equal(decision.approvedForExecution, true);
  assert.equal(decision.finalPositionSizePct, 0.03);
  assert.match(decision.reason, /<= ceiling/);
});

test("rejects when combined risk would exceed the ceiling", () => {
  const riskDecision = approvedRiskDecision({ positionSizePct: 0.03 });
  const decision = evaluatePortfolio(riskDecision, { openPositionsRiskPct: 0.19 });

  assert.equal(decision.approvedForExecution, false);
  assert.equal(decision.finalPositionSizePct, 0);
  assert.match(decision.reason, /would exceed ceiling/);
});

test("defaults openPositionsRiskPct to 0 when omitted", () => {
  const riskDecision = approvedRiskDecision({ positionSizePct: 0.03 });
  const decision = evaluatePortfolio(riskDecision);

  assert.equal(decision.approvedForExecution, true);
  assert.equal(decision.finalPositionSizePct, 0.03);
});

// --- Netting: isReplacingPosition -----------------------------------------
// The actual netting MATH happens one layer down (openPositionsRiskPct is
// already ticker-excluded by the time it reaches this function -- see
// graph/pipeline.js). isReplacingPosition only changes the reason string,
// but that string is the audit trail (plan.md Adopted Pattern #5), so it's
// worth asserting on directly rather than treating it as decorative.

test("isReplacingPosition does not change the approval math, only the reason text", () => {
  const riskDecision = approvedRiskDecision({ positionSizePct: 0.03 });

  const withoutReplace = evaluatePortfolio(riskDecision, { openPositionsRiskPct: 0.05, isReplacingPosition: false });
  const withReplace = evaluatePortfolio(riskDecision, { openPositionsRiskPct: 0.05, isReplacingPosition: true });

  assert.equal(withoutReplace.approvedForExecution, withReplace.approvedForExecution);
  assert.equal(withoutReplace.finalPositionSizePct, withReplace.finalPositionSizePct);
  assert.doesNotMatch(withoutReplace.reason, /replac/i);
  assert.match(withReplace.reason, /replac/i);
});

test("isReplacingPosition reason note also appears on a rejection, not just an approval", () => {
  const riskDecision = approvedRiskDecision({ positionSizePct: 0.03 });
  const decision = evaluatePortfolio(riskDecision, { openPositionsRiskPct: 0.19, isReplacingPosition: true });

  assert.equal(decision.approvedForExecution, false);
  assert.match(decision.reason, /would exceed ceiling/);
  assert.match(decision.reason, /replac/i);
});

test("a ticker at exactly its old position size, replaced, nets to just the new thesis's own size (no double count)", () => {
  // Scenario this whole fix exists for: AAPL already has an open position
  // sized 0.03. A new thesis for AAPL proposes 0.04. Without netting,
  // openPositionsRiskPct would (wrongly) include AAPL's own old 0.03,
  // making the combined total 0.07 look like it's competing against
  // itself. With netting (excludeTicker applied one layer down in
  // pipeline.js), openPositionsRiskPct passed in here is ONLY other
  // tickers' exposure -- e.g. 0.10 from MSFT/GOOGL -- so combined is a
  // true 0.14, not an inflated 0.17.
  const riskDecision = approvedRiskDecision({ positionSizePct: 0.04 });
  const decision = evaluatePortfolio(riskDecision, { openPositionsRiskPct: 0.10, isReplacingPosition: true });

  assert.equal(decision.approvedForExecution, true); // 0.10 + 0.04 = 0.14 <= 0.20 ceiling
  assert.equal(decision.finalPositionSizePct, 0.04);
});
