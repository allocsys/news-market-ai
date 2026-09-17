// Final sign-off step (plan.md Adopted Pattern #3, restructured under
// agents/managers/ alongside research_manager.js). risk_mgmt/risk.js decides
// per-thesis sizing in isolation; this decides whether to actually execute
// given account-level state -- other open positions, correlation exposure,
// total portfolio risk budget. Deliberately NOT an LLM call, same reasoning
// as risk.js: this is the layer that has to be trustworthy and reproducible.
//
// UPDATE: a real positions store now exists (migrations/0003_positions.sql,
// storage/d1.js#openPosition/closePosition/getOpenPositionsRiskPctAsOf),
// and graph/pipeline.js passes a real point-in-time openPositionsRiskPct
// instead of a hardcoded 0.
//
// NETTING (previously a known gap, now closed): re-evaluating a thesis for
// a ticker that already has an open position no longer double-counts that
// ticker's exposure. graph/pipeline.js's risk_checked stage now calls
// getOpenPositionsRiskPctAsOf with `excludeTicker` set to the current
// ticker, so `openPositionsRiskPct` below already reflects every OTHER
// ticker's exposure only -- this function doesn't need to know about the
// current ticker's own old position at all for the MATH to be correct.
// `isReplacingPosition` is accepted purely so the `reason` string is
// honest about what happened (pipeline.js also closes the old position,
// with close_reason 'replaced', before opening the new one when this is
// true -- see that file for the actual replace logic).
//
// Two things are still placeholders, though: (1) MAX_PORTFOLIO_RISK_PCT
// below is not tuned against anything real yet, and (2) there's still no
// correlation/cross-asset-exposure check -- this is a flat total-risk-
// budget check only.

import { PortfolioDecision } from "../../schemas/index.js";

const MAX_PORTFOLIO_RISK_PCT = 0.20; // placeholder: no real cross-position exposure data yet

export function evaluatePortfolio(riskDecision, { openPositionsRiskPct = 0, isReplacingPosition = false } = {}) {
  if (!riskDecision.approved) {
    return PortfolioDecision.parse({
      tradeThesisId: riskDecision.tradeThesisId,
      approvedForExecution: false,
      finalPositionSizePct: 0,
      reason: "risk_mgmt did not approve this thesis; portfolio_manager has nothing to sign off on",
    });
  }

  const wouldBeTotalRiskPct = openPositionsRiskPct + riskDecision.positionSizePct;
  const approvedForExecution = wouldBeTotalRiskPct <= MAX_PORTFOLIO_RISK_PCT;
  const netNote = isReplacingPosition
    ? " (openPositionsRiskPct already excludes this ticker's existing position, which is being replaced)"
    : "";

  return PortfolioDecision.parse({
    tradeThesisId: riskDecision.tradeThesisId,
    approvedForExecution,
    finalPositionSizePct: approvedForExecution ? riskDecision.positionSizePct : 0,
    reason: approvedForExecution
      ? `combined portfolio risk ${wouldBeTotalRiskPct} <= ceiling ${MAX_PORTFOLIO_RISK_PCT}${netNote}`
      : `combined portfolio risk ${wouldBeTotalRiskPct} would exceed ceiling ${MAX_PORTFOLIO_RISK_PCT}${netNote} -- rejected`,
  });
}
