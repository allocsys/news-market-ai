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
// instead of a hardcoded 0. Two things are still placeholders, though: (1)
// MAX_PORTFOLIO_RISK_PCT below is not tuned against anything real yet, and
// (2) there's still no correlation/cross-asset-exposure check -- this is a
// flat total-risk-budget check only. Also see getOpenPositionsRiskPctAsOf's
// own header for a known double-counting edge case on re-evaluating an
// already-open ticker.

import { PortfolioDecision } from "../../schemas/index.js";

const MAX_PORTFOLIO_RISK_PCT = 0.20; // placeholder: no real cross-position exposure data yet

export function evaluatePortfolio(riskDecision, { openPositionsRiskPct = 0 } = {}) {
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

  return PortfolioDecision.parse({
    tradeThesisId: riskDecision.tradeThesisId,
    approvedForExecution,
    finalPositionSizePct: approvedForExecution ? riskDecision.positionSizePct : 0,
    reason: approvedForExecution
      ? `combined portfolio risk ${wouldBeTotalRiskPct} <= placeholder ceiling ${MAX_PORTFOLIO_RISK_PCT} (openPositionsRiskPct is not yet backed by real position data)`
      : `combined portfolio risk ${wouldBeTotalRiskPct} would exceed placeholder ceiling ${MAX_PORTFOLIO_RISK_PCT} -- rejected`,
  });
}
