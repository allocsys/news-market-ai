// Deterministic exit evaluation (stop-loss/take-profit/time-based) --
// same non-LLM, rule-based convention as risk.js (plan.md Adopted Pattern
// #3). Whether an already-open position should close is not something an
// LLM judges here: it's a fixed check against the thresholds risk.js
// already decided at open time and copied onto the position row (see
// storage/run_store.js#RunStore.openPosition), plus a portfolio-level max-hold-days knob.
//
// HONEST SCOPE: this module only judges ONE position against ONE
// already-known currentPrice/asOf -- it does no fetching and enforces no
// point-in-time cutoff itself. graph/exit_check.js is the caller that
// sources currentPrice via storage/inputs_view.js#getPriceBarsAsOf (which DOES
// enforce the required-asOf convention) and calls closePosition when this
// returns non-null.

export const CLOSE_REASON = {
  STOP_LOSS: "stop_loss",
  TAKE_PROFIT: "take_profit",
  TIME_BASED: "time_based",
};

function daysBetween(fromIso, toIso) {
  return (new Date(toIso).getTime() - new Date(fromIso).getTime()) / (1000 * 60 * 60 * 24);
}

/**
 * Returns `{ reason }` (one of CLOSE_REASON's values) if `position` should
 * close given `currentPrice`/`asOf`/`maxHoldDays`, else `null`.
 *
 * `position` is the shape storage/run_store.js#RunStore.getOpenPositionsAsOf returns:
 * { direction, entryPrice, stopLossPct, takeProfitPct, openedAt, ... }.
 *
 * Priority when more than one condition is met on the same check (e.g. a
 * price gap that jumps past both thresholds at once): stop-loss first --
 * protecting capital takes priority over locking in a gain -- then
 * take-profit, then time-based, which is checked last since it only
 * matters when neither price target fired.
 *
 * `position.entryPrice` (or `currentPrice`) may be null -- price_bars has
 * no data yet for this ticker/date, a known gap, see plan.md. In that
 * case price-based exits are skipped
 * entirely and only the time-based exit can fire; this function never
 * fabricates a price to force a stop-loss/take-profit decision.
 */
export function evaluateExit(position, { currentPrice, asOf, maxHoldDays }) {
  const { direction, entryPrice, stopLossPct, takeProfitPct, openedAt } = position;

  if (entryPrice != null && currentPrice != null && (direction === "long" || direction === "short")) {
    const changePct =
      direction === "long" ? (currentPrice - entryPrice) / entryPrice : (entryPrice - currentPrice) / entryPrice;

    if (stopLossPct != null && changePct <= -stopLossPct) {
      return { reason: CLOSE_REASON.STOP_LOSS };
    }
    if (takeProfitPct != null && changePct >= takeProfitPct) {
      return { reason: CLOSE_REASON.TAKE_PROFIT };
    }
  }

  if (maxHoldDays != null && openedAt && asOf && daysBetween(openedAt, asOf) >= maxHoldDays) {
    return { reason: CLOSE_REASON.TIME_BASED };
  }

  return null;
}
