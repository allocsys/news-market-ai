// Final sign-off step (plan.md Adopted Pattern #3, restructured under
// agents/managers/ alongside research_manager.js). risk_mgmt/risk.js decides
// per-thesis sizing in isolation; this decides whether to actually execute
// given account-level state -- other open positions, correlation exposure,
// total portfolio risk budget. Deliberately NOT an LLM call, same reasoning
// as risk.js: this is the layer that has to be trustworthy and reproducible.
//
// HONEST STATE: there is no portfolio/positions store wired up yet (no
// "list open positions" read exists anywhere in src/storage/d1.js), so the
// account-level checks below are a structural placeholder, not a real
// correlation/exposure check. This function exists so the pipeline has the
// right shape -- trader -> risk -> portfolio_manager -- before that data is
// available, rather than skipping the stage and bolting it on awkwardly
// later. Do not treat MAX_PORTFOLIO_RISK_PCT below as tuned; it's a
// placeholder ceiling until real position data exists to check against.

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
