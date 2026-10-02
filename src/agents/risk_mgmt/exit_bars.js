// Bar-based stop-loss / take-profit evaluation: walks the chronological bar
// sequence shared/bar_window.js#buildBarSequence produced for one open position
// and finds the FIRST bar whose range touched the stop or the target. Pure, no
// I/O -- graph/exit_check.js does the reads and the writes. The single-price
// evaluateExit (./exit.js) still owns the time-based exit; this module only
// decides price exits, so a touch that happened BETWEEN two checks is no longer
// invisible.
//
// TOUCH RULES (per bar, in order)
//   long : stop level = entry * (1 - stopLossPct)   touched when low  <= level
//          target     = entry * (1 + takeProfitPct) touched when high >= level
//   short: stop level = entry * (1 + stopLossPct)   touched when high >= level
//          target     = entry * (1 - takeProfitPct) touched when low  <= level
//   Stop is checked FIRST: a bar that touches both resolves as a stop. A bar's
//   OHLC says nothing about the order inside it, and protecting capital wins
//   over locking in a gain (same priority as evaluateExit). Across bars the
//   order is real: the earlier bar wins.
//
// FILL PRICE
//   The exit fills at the level itself (a resting stop/limit order), EXCEPT when
//   the bar OPENED already beyond the level (a gap): then it fills at the open --
//   the first price that existed. A long stop gapped below fills at the open
//   (worse than the stop); a long target gapped above fills at the open (better
//   than the target). Normal slippage is covered by TRADE_COST_BPS downstream.
//
// TIMESTAMP
//   `closedAt` is the triggering bar's `availableAt` (when the bar fully closed):
//   the earliest instant the touch is knowable without lookahead, and always
//   <= the check's asOf. It is NOT the (unknowable) moment inside the bar.
//
// MAE / MFE
//   Gross, direction-aware extremes over the walked bars, from bar lows/highs
//   (long: adverse = low, favorable = high; short: the reverse). The triggering
//   bar is counted. Bars past a detected split are not.
//
// SPLIT GUARD
//   Bars are raw/unadjusted. If a bar's open or close matches a split ratio
//   against the entry price (shared/split_guard.js), the walk STOPS BEFORE that
//   bar and reports `split`: nothing at or after it is trusted, so no price exit
//   and no excursion comes from it. The caller logs loudly and does not advance
//   the cursor past the last clean bar, so the suspicion repeats on every check
//   (same loudness as the single-price guard).

import { CLOSE_REASON } from "./exit.js";
import { computeGrossReturn } from "../../shared/returns.js";
import { ratchetedStop, betterPeak } from "./trailing.js";
import { detectSplitJump } from "../../shared/split_guard.js";

function isFiniteBar(bar) {
  return (
    Number.isFinite(bar.open) &&
    Number.isFinite(bar.high) &&
    Number.isFinite(bar.low) &&
    Number.isFinite(bar.close) &&
    bar.high >= bar.low
  );
}

/**
 * Stop and target price levels for a position, or null when they cannot be
 * computed (no direction / non-positive entry price). A missing pct yields a
 * null level for that side only.
 */
export function exitLevels({ direction, entryPrice, stopLossPct, takeProfitPct }) {
  if (direction !== "long" && direction !== "short") return null;
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;
  const sl = Number.isFinite(stopLossPct) ? stopLossPct : null;
  const tp = Number.isFinite(takeProfitPct) ? takeProfitPct : null;
  if (direction === "long") {
    return { stop: sl != null ? entryPrice * (1 - sl) : null, target: tp != null ? entryPrice * (1 + tp) : null };
  }
  return { stop: sl != null ? entryPrice * (1 + sl) : null, target: tp != null ? entryPrice * (1 - tp) : null };
}

/**
 * Walks `bars` (oldest first, `{kind, openMs, availableAt, open, high, low, close}`)
 * for `position` (`{direction, entryPrice, stopLossPct, takeProfitPct}`).
 *
 * Returns
 *   exit               null, or { reason, exitPrice, closedAt, gapped, barKind, barOpenMs }
 *   maePct, mfePct     gross extremes over the walked bars (null when none counted)
 *   lastBarAvailableAt availableAt of the last bar EVALUATED (the cursor target);
 *                      null when no bar was evaluated. Invalid bars (non-finite OHLC)
 *                      are skipped but still advance it: bad data is never fabricated
 *                      into a price, and never re-read forever.
 *   lastClose          close of the last VALID bar evaluated (the position's mark price as of
 *                      lastBarAvailableAt, when that bar was valid); null when no valid bar was
 *                      evaluated. Never the split bar, never an invalid bar.
 *   barsWalked         bars evaluated (valid or not), excluding the split bar
 *   invalidBars        bars skipped for non-finite / inverted OHLC
 *   split              null, or { kind, factor, ratio, barOpenMs, barKind } when the walk stopped at a suspected split
 *
 *   peakPrice          best favorable price reached, INCLUDING the walked bars and never worse than entry
 *                      (what advancePositionCheck persists to positions.peak_price); null when `trailing` is off.
 *                      Not set on an exit (the position is closing, nothing persists it).
 *
 * `splitGuardTolerance` 0/absent disables the guard (detectSplitJump contract).
 *
 * `trailing` (trailing.js#resolveTrailingConfig, null/absent = off) turns on the break-even / trailing
 * stop. Each bar is judged against the level from the peak through the PREVIOUS bar (position.peakPrice,
 * then the bars already walked); the bar's own high/low is folded into the peak only afterwards, so a spike
 * inside a bar can never stop out the same bar at a level it just created. The ratcheted level replaces
 * the static stop (it is never looser: trailing.js), the exit reason is the rule that produced it
 * (STOP_LOSS / BREAKEVEN_STOP / TRAILING_STOP), and with trailRemovesTarget the take-profit is ignored
 * once the trail is the binding stop. With `trailing` off the walk is exactly the static stop/target walk.
 * With no computable levels (see exitLevels) nothing is walked and every field is empty.
 */
export function walkBarsForExit(position, bars, { splitGuardTolerance = 0, trailing = null } = {}) {
  const empty = { exit: null, maePct: null, mfePct: null, lastBarAvailableAt: null, lastClose: null, barsWalked: 0, invalidBars: 0, split: null, peakPrice: null };
  const levels = exitLevels(position);
  if (!levels || !Array.isArray(bars) || bars.length === 0) return empty;

  const { direction, entryPrice } = position;
  const isLong = direction === "long";

  let maePct = null;
  let mfePct = null;
  let lastBarAvailableAt = null;
  let lastClose = null;
  let barsWalked = 0;
  let invalidBars = 0;
  // High-water mark for the break-even / trailing ratchet. null = no peak yet (entry is the baseline).
  let peak = trailing && Number.isFinite(position.peakPrice) && position.peakPrice > 0 ? position.peakPrice : null;

  for (const bar of bars) {
    if (!isFiniteBar(bar)) {
      invalidBars += 1;
      barsWalked += 1;
      lastBarAvailableAt = bar.availableAt;
      continue;
    }

    const splitAtOpen = detectSplitJump(entryPrice, bar.open, splitGuardTolerance);
    const splitAtClose = splitAtOpen ? null : detectSplitJump(entryPrice, bar.close, splitGuardTolerance);
    const split = splitAtOpen ?? splitAtClose;
    if (split) {
      return {
        exit: null,
        maePct,
        mfePct,
        lastBarAvailableAt,
        lastClose,
        barsWalked,
        invalidBars,
        split: { kind: split.kind, factor: split.factor, ratio: split.ratio, barOpenMs: bar.openMs, barKind: bar.kind },
        peakPrice: trailing ? peak : null,
      };
    }

    const adversePrice = isLong ? bar.low : bar.high;
    const favorablePrice = isLong ? bar.high : bar.low;
    const adverse = computeGrossReturn({ direction, entryPrice, exitPrice: adversePrice });
    const favorable = computeGrossReturn({ direction, entryPrice, exitPrice: favorablePrice });
    if (adverse != null) maePct = maePct == null ? adverse : Math.min(maePct, adverse);
    if (favorable != null) mfePct = mfePct == null ? favorable : Math.max(mfePct, favorable);

    barsWalked += 1;
    lastBarAvailableAt = bar.availableAt;
    lastClose = bar.close;

    // The stop level for THIS bar comes from the peak through the PREVIOUS bar (no lookahead); only then
    // is this bar's own favorable extreme folded into the peak (for the next bar and for persistence).
    const rule = trailing
      ? ratchetedStop({ direction, entryPrice, stopLossPct: position.stopLossPct, peakPrice: peak }, trailing)
      : null;
    if (trailing) peak = betterPeak(direction, betterPeak(direction, peak, favorablePrice), entryPrice);
    const stop = rule ? rule.level : levels.stop;
    const stopReason = rule ? rule.reason : CLOSE_REASON.STOP_LOSS;
    const target = rule && trailing.trailRemovesTarget && rule.reason === CLOSE_REASON.TRAILING_STOP ? null : levels.target;

    const stopHit = stop != null && (isLong ? bar.low <= stop : bar.high >= stop);
    if (stopHit) {
      const gapped = isLong ? bar.open < stop : bar.open > stop;
      const exitPrice = isLong ? Math.min(bar.open, stop) : Math.max(bar.open, stop);
      return {
        exit: { reason: stopReason, exitPrice, closedAt: bar.availableAt, gapped, barKind: bar.kind, barOpenMs: bar.openMs },
        maePct,
        mfePct,
        lastBarAvailableAt,
        barsWalked,
        invalidBars,
        lastClose,
        split: null,
      };
    }

    const targetHit = target != null && (isLong ? bar.high >= target : bar.low <= target);
    if (targetHit) {
      const gapped = isLong ? bar.open > target : bar.open < target;
      const exitPrice = isLong ? Math.max(bar.open, target) : Math.min(bar.open, target);
      return {
        exit: { reason: CLOSE_REASON.TAKE_PROFIT, exitPrice, closedAt: bar.availableAt, gapped, barKind: bar.kind, barOpenMs: bar.openMs },
        maePct,
        mfePct,
        lastBarAvailableAt,
        barsWalked,
        invalidBars,
        lastClose,
        split: null,
      };
    }
  }

  return { exit: null, maePct, mfePct, lastBarAvailableAt, lastClose, barsWalked, invalidBars, split: null, peakPrice: trailing ? peak : null };
}
