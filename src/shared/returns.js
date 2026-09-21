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
 */
export function computeRealizedReturn({ direction, entryPrice, exitPrice }) {
  if (entryPrice == null || exitPrice == null) return null;
  if (direction === "long") return (exitPrice - entryPrice) / entryPrice;
  if (direction === "short") return (entryPrice - exitPrice) / entryPrice;
  return null;
}
