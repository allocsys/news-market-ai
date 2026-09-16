// Deterministic, rule-based position sizing -- deliberately NOT an LLM call
// (plan.md Adopted Pattern #3). The trader agent (trader/trader.js) decides
// direction and rationale; this layer decides whether to act at all and how
// much, on fixed, auditable rules only. Keeping this non-LLM is the whole
// point: it's the layer that has to be trustworthy and reproducible even
// when the LLM stages aren't.

import { RiskDecision } from "../../schemas/index.js";

const MAX_POSITION_PCT = 0.05; // never risk more than 5% of portfolio on one thesis
const MIN_CONFIDENCE_TO_ACT = 0.6;
const STOP_LOSS_PCT = 0.03;
const TAKE_PROFIT_PCT = 0.06;

export function evaluateRisk(thesis, verdict) {
  const approved = verdict.confidence >= MIN_CONFIDENCE_TO_ACT && thesis.direction !== "flat";
  const positionSizePct = approved ? Math.min(MAX_POSITION_PCT, verdict.confidence * MAX_POSITION_PCT) : 0;

  return RiskDecision.parse({
    tradeThesisId: `${thesis.ticker}|${thesis.asOf}`,
    approved,
    positionSizePct,
    stopLossPct: approved ? STOP_LOSS_PCT : undefined,
    takeProfitPct: approved ? TAKE_PROFIT_PCT : undefined,
    reason: approved
      ? `confidence ${verdict.confidence} >= threshold ${MIN_CONFIDENCE_TO_ACT}; sized proportionally to confidence, capped at ${MAX_POSITION_PCT * 100}% of portfolio`
      : `confidence ${verdict.confidence} below threshold ${MIN_CONFIDENCE_TO_ACT}, or direction is flat -- no position taken`,
  });
}
