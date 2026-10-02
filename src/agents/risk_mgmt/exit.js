// Deterministic exit evaluation (stop-loss/take-profit/time-based) --
// same non-LLM, rule-based convention as risk.js (plan.md Adopted Pattern
// #3). Whether an already-open position should close is not something an
// LLM judges here: it's a fixed check against the thresholds risk.js
// already decided at open time and copied onto the position row (see
// storage/run_store.js#RunStore.openPosition), plus a portfolio-level max-hold-days knob (counted in trading days,
// Mon-Fri -- see tradingDaysBetween).
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
  // The ratcheted stop (agents/risk_mgmt/trailing.js) was the binding level when a bar touched it:
  // the entry-anchored break-even stop, or the peak-anchored trailing stop. Bar-walk exits only
  // (exit_bars.js); the single-price evaluateExit below never returns them.
  BREAKEVEN_STOP: "breakeven_stop",
  TRAILING_STOP: "trailing_stop",
};

const MS_PER_DAY = 1000 * 60 * 60 * 24;

function utcDayStartMs(iso) {
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? NaN : Math.floor(t / MS_PER_DAY) * MS_PER_DAY;
}

/**
 * Whole Mon-Fri UTC days in the half-open interval (from's UTC date, to's UTC
 * date]: the opening day itself never counts, `to`'s own day counts if it is
 * a weekday. Example: opened Thu 2026-01-01, asOf Thu 2026-01-15 -> 10.
 *
 * HONEST SCOPE: weekends only -- there is no exchange-holiday calendar, so a
 * market holiday still counts as a trading day and the time exit can fire up
 * to a few days early around holidays. Good enough for a 10-day placeholder
 * knob; add a calendar if maxHoldDays is ever tuned tightly. XAUUSD (FX)
 * also trades Mon-Fri, so the same rule fits every instrument on the
 * watchlist. Returns NaN for an unparseable date (NaN >= n is false, so the
 * time exit simply never fires -- same as the previous calendar-day math).
 */
export function tradingDaysBetween(fromIso, toIso) {
  const from = utcDayStartMs(fromIso);
  const to = utcDayStartMs(toIso);
  if (Number.isNaN(from) || Number.isNaN(to)) return NaN;
  let count = 0;
  for (let t = from + MS_PER_DAY; t <= to; t += MS_PER_DAY) {
    const weekday = new Date(t).getUTCDay(); // 0 = Sunday, 6 = Saturday
    if (weekday !== 0 && weekday !== 6) count += 1;
  }
  return count;
}

/**
 * Calendar days that always cover `tradingDays` trading days from any start
 * day: whole weeks, ceil(n / 5) * 7. Used to size windows that must reach a
 * time exit (backtest grace period, replay bar horizon) now that maxHoldDays
 * is in trading days. Non-positive / non-finite input -> 0.
 */
export function calendarDaysCoveringTradingDays(tradingDays) {
  if (!Number.isFinite(tradingDays) || tradingDays <= 0) return 0;
  return Math.ceil(tradingDays / 5) * 7;
}

/**
 * The instant a position's time exit becomes due: 00:00:00.000Z of the first weekday on which
 * tradingDaysBetween(openedAt, that midnight) reaches maxHoldDays -- exactly the first instant
 * evaluateExit's time rule is true. Lets the exit check price the exit at the first tradable bar
 * after this instant instead of at whatever stale price is visible when it happens to run. Returns
 * null when it cannot be computed (unparseable openedAt, maxHoldDays <= 0 or absurdly large); the
 * caller then keeps the legacy 'close at asOf' behavior.
 */
export function timeExitDueAt(openedAt, maxHoldDays) {
  if (!Number.isFinite(maxHoldDays) || maxHoldDays <= 0 || maxHoldDays > 1000) return null;
  const from = utcDayStartMs(openedAt);
  if (Number.isNaN(from)) return null;
  let count = 0;
  for (let t = from + MS_PER_DAY; ; t += MS_PER_DAY) {
    const weekday = new Date(t).getUTCDay();
    if (weekday !== 0 && weekday !== 6) count += 1;
    if (count >= maxHoldDays) return new Date(t).toISOString();
  }
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
 *
 * `skipPriceExits: true` does the same on purpose: the caller distrusts the
 * price (graph/exit_check.js sets it when shared/split_guard.js suspects a
 * stock split in the raw bars), so only the time-based exit can fire.
 */
export function evaluateExit(position, { currentPrice, asOf, maxHoldDays, skipPriceExits = false }) {
  const { direction, entryPrice, stopLossPct, takeProfitPct, openedAt } = position;

  if (!skipPriceExits && entryPrice != null && currentPrice != null && (direction === "long" || direction === "short")) {
    const changePct =
      direction === "long" ? (currentPrice - entryPrice) / entryPrice : (entryPrice - currentPrice) / entryPrice;

    if (stopLossPct != null && changePct <= -stopLossPct) {
      return { reason: CLOSE_REASON.STOP_LOSS };
    }
    if (takeProfitPct != null && changePct >= takeProfitPct) {
      return { reason: CLOSE_REASON.TAKE_PROFIT };
    }
  }

  if (maxHoldDays != null && openedAt && asOf && tradingDaysBetween(openedAt, asOf) >= maxHoldDays) {
    return { reason: CLOSE_REASON.TIME_BASED };
  }

  return null;
}
