// Deterministic, rule-based position sizing -- deliberately NOT an LLM call
// (plan.md Adopted Pattern #3). The trader agent (trader/trader.js) decides
// direction and rationale; this layer decides whether to act at all and how
// much, on fixed, auditable rules only. Keeping this non-LLM is the whole
// point: it's the layer that has to be trustworthy and reproducible even
// when the LLM stages aren't -- ATR below is pure math over price bars
// already being fetched elsewhere in the pipeline, not a new LLM call.

import { RiskDecision } from "../../schemas/index.js";
import { computeATR } from "../analysts/technicalIndicators.js";

const MAX_POSITION_PCT = 0.05; // never risk more than 5% of portfolio on one thesis
const MIN_CONFIDENCE_TO_ACT = 0.6;

// Fallback flat thresholds -- used only when `bars` isn't enough to compute
// an ATR (new ticker with <ATR_WINDOW+1 bars of history, or a caller that
// doesn't pass bars at all). These are the ORIGINAL flat constants this file
// used for every ticker before ATR-based sizing; kept as a safety net rather
// than removed, so a data gap degrades to the old known-safe behavior
// instead of leaving stop/target undefined.
const FALLBACK_STOP_LOSS_PCT = 0.03;
const FALLBACK_TAKE_PROFIT_PCT = 0.06;

// ATR-based dynamic sizing: stop/target now scale with the ticker's OWN
// recent volatility instead of applying the same distance to a sleepy
// utility and a name that swings 5% in a day (flagged as a real weakness of
// the flat constants -- see this session's checkpoint). Reward:risk is kept
// at the same 2:1 ratio the old flat constants implied (6% / 3% = 2), so
// this change is "the same risk philosophy, volatility-aware distances" --
// not a change in how much reward is demanded per unit of risk.
const ATR_WINDOW = 14;
const ATR_STOP_MULTIPLE = 1.5;
const REWARD_RISK_RATIO = 2;
const MIN_STOP_LOSS_PCT = 0.01; // floor: never tighter than 1%, even for a very quiet ticker
const MAX_STOP_LOSS_PCT = 0.08; // ceiling: never wider than 8%, even for a very volatile ticker

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Stop-loss/take-profit as a % of price, scaled to the ticker's own recent
 * volatility (ATR) rather than one flat distance for every ticker. Falls
 * back to FALLBACK_STOP_LOSS_PCT/FALLBACK_TAKE_PROFIT_PCT when `bars` is
 * missing, empty, or too short for ATR_WINDOW -- see comment on those
 * constants above.
 */
function computeStopAndTarget(bars) {
  const atr = bars ? computeATR(bars, ATR_WINDOW) : null;
  const latestClose = bars?.[0]?.close;

  if (atr == null || !latestClose) {
    return { stopLossPct: FALLBACK_STOP_LOSS_PCT, takeProfitPct: FALLBACK_TAKE_PROFIT_PCT };
  }

  const stopLossPct = clamp(ATR_STOP_MULTIPLE * (atr / latestClose), MIN_STOP_LOSS_PCT, MAX_STOP_LOSS_PCT);
  const takeProfitPct = stopLossPct * REWARD_RISK_RATIO;

  return { stopLossPct, takeProfitPct };
}

/**
 * `bars` (optional, same shape/ordering as storage/inputs_view.js's
 * getPriceBarsAsOf: most-recent-first, with open/high/low/close/volume) is
 * the ticker's own recent daily bars as of this thesis's `asOf` -- pass
 * whatever the caller already fetched for this ticker/asOf point in time.
 * Omitting it (or passing too few bars) is safe and falls back to the flat
 * thresholds above, it just loses the volatility-aware sizing.
 */
export function evaluateRisk(thesis, verdict, bars) {
  const approved = verdict.confidence >= MIN_CONFIDENCE_TO_ACT && thesis.direction !== "flat";
  const positionSizePct = approved ? Math.min(MAX_POSITION_PCT, verdict.confidence * MAX_POSITION_PCT) : 0;
  const { stopLossPct, takeProfitPct } = computeStopAndTarget(bars);

  return RiskDecision.parse({
    tradeThesisId: `${thesis.ticker}|${thesis.asOf}`,
    approved,
    positionSizePct,
    stopLossPct: approved ? stopLossPct : undefined,
    takeProfitPct: approved ? takeProfitPct : undefined,
    reason: approved
      ? `confidence ${verdict.confidence} >= threshold ${MIN_CONFIDENCE_TO_ACT}; sized proportionally to confidence, capped at ${MAX_POSITION_PCT * 100}% of portfolio; stop/target ATR-scaled to recent volatility`
      : `confidence ${verdict.confidence} below threshold ${MIN_CONFIDENCE_TO_ACT}, or direction is flat -- no position taken`,
  });
}
