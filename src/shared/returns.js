// Direction-aware realized return of one position -- the single definition
// graph/settle.js (writing decision_memory) and the dashboard's backtest
// trade timeline (showing per-position P&L) both use, so the number a
// reflection was recorded against and the number on the page cannot drift.
// Pure: no I/O, no imports.

/**
 * Same sign convention as agents/risk_mgmt/exit.js#evaluateExit's changePct:
 * long = (exit - entry) / entry, short = (entry - exit) / entry. Returns null
 * (never a fabricated number) when entryPrice/exitPrice is missing or direction
 * isn't 'long'/'short' -- e.g. a time_based exit fired with no price_bars data
 * for that ticker, or a position still open. Moved verbatim out of
 * graph/settle.js; behavior is unchanged.
 *
 * `costBps` (optional, per SIDE, basis points; see constants.js#DEFAULT_TRADE_COST_BPS)
 * makes this the NET return of a closed position: gross minus one entry and one
 * exit cost, i.e. 2 * costBps / 10000 (a first-order approximation, exact
 * enough at a few bps). Omitted / 0 / non-finite / negative -> gross, as before.
 */
export function computeRealizedReturn({ direction, entryPrice, exitPrice, costBps }) {
  const gross = computeGrossReturn({ direction, entryPrice, exitPrice });
  if (gross == null) return null;
  return gross - roundTripCostFraction(costBps);
}

/** Cost of one round trip as a fraction of notional; 0 for a missing/invalid costBps. */
export function roundTripCostFraction(costBps) {
  return Number.isFinite(costBps) && costBps > 0 ? (2 * costBps) / 10000 : 0;
}

/** The gross, cost-free return (the pre-cost-model definition). */
export function computeGrossReturn({ direction, entryPrice, exitPrice }) {
  if (entryPrice == null || exitPrice == null) return null;
  if (direction === "long") return (exitPrice - entryPrice) / entryPrice;
  if (direction === "short") return (entryPrice - exitPrice) / entryPrice;
  return null;
}
