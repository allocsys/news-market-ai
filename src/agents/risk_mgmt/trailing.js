// Break-even and trailing stop: the stop LEVEL as a pure function of the position's
// high-water mark. No I/O -- exit_bars.js walks the bars and calls this once per bar; the
// peak itself is persisted in positions.peak_price (migration 0010).
//
// UNITS. Everything is in R, where R = the position's INITIAL stop distance as a fraction of
// entry (positions.stop_loss_pct, already ATR-scaled and clamped by risk.js). So the same R
// setting is wider on a volatile name and tighter on a calm one, with no second vol model.
//
//   favorable = direction-aware gross return of the PEAK vs entry (shared/returns.js)
//
//   initial stop     entry -/+ R                               always present
//   break-even stop  once favorable >= breakEvenTriggerR * R:
//                    long  entry * (1 + roundTripCost)         a stop at "flat NET of costs"
//                    short entry * (1 - roundTripCost)         so a break-even exit is not a small net loss
//   trailing stop    once favorable >= trailActivationR * R:
//                    long  peak * (1 - trailDistanceR * R)
//                    short peak * (1 + trailDistanceR * R)
//
// The effective stop is the MOST PROTECTIVE of the three (highest for a long, lowest for a
// short) and, because the peak only ever improves, it only ever tightens: it can never loosen
// the original stop. `kind` names the binding level and becomes the close reason.
//
// NO LOOKAHEAD. exit_bars.js evaluates a bar against the level computed from the peak through
// the PREVIOUS bar and only then folds the bar's own high/low into the peak. A bar's OHLC says
// nothing about the order inside it, so a bar that spikes to a new high and falls back through
// the (new) trailing level is NOT stopped by the level that spike would have created -- it can
// only be stopped by the level that existed when the bar opened. Conservative in the right
// direction for a daily-bar fallback too.
//
// DISABLED by default (every R = 0): resolveTrailingConfig returns null and the walk is
// byte-for-byte the old stop/target walk.

import { CLOSE_REASON } from "./exit.js";
import { computeGrossReturn, roundTripCostFraction } from "../../shared/returns.js";

/**
 * Reads the knobs off `config` (config.js: breakEvenTriggerR, trailActivationR, trailDistanceR,
 * trailRemovesTarget, tradeCostBps). Returns null when neither feature is enabled, so callers can
 * treat "no trailing" as one falsy value. A non-finite / negative knob counts as 0 (off).
 * Trailing needs BOTH an activation and a distance > 0 (a zero distance would stop at the peak
 * itself, which is not a trail).
 */
export function resolveTrailingConfig(config) {
  if (!config) return null;
  const pos = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
  const breakEvenTriggerR = pos(config.breakEvenTriggerR);
  const trailActivationR = pos(config.trailActivationR);
  const trailDistanceR = pos(config.trailDistanceR);
  const trailingOn = trailActivationR > 0 && trailDistanceR > 0;
  if (breakEvenTriggerR === 0 && !trailingOn) return null;
  return {
    breakEvenTriggerR,
    trailActivationR: trailingOn ? trailActivationR : 0,
    trailDistanceR: trailingOn ? trailDistanceR : 0,
    // "Let winners run": once the trail is the binding stop, the fixed take-profit is ignored.
    trailRemovesTarget: trailingOn && Number(config.trailRemovesTarget) === 1,
    costFraction: roundTripCostFraction(config.tradeCostBps),
  };
}

/**
 * Stop level and which rule produced it, for a position whose best favorable price so far is
 * `peakPrice` (null = never beyond entry). Returns null when it cannot be computed (no direction,
 * non-positive entry, no usable initial stop pct) -- the caller then keeps the static stop.
 */
export function ratchetedStop({ direction, entryPrice, stopLossPct, peakPrice }, trailing) {
  if (!trailing) return null;
  if (direction !== "long" && direction !== "short") return null;
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;
  if (!Number.isFinite(stopLossPct) || stopLossPct <= 0) return null;

  const isLong = direction === "long";
  const R = stopLossPct;
  const better = (a, b) => (isLong ? a > b : a < b); // a is more protective than b

  let level = isLong ? entryPrice * (1 - R) : entryPrice * (1 + R);
  let reason = CLOSE_REASON.STOP_LOSS;

  const peak = Number.isFinite(peakPrice) && peakPrice > 0 ? peakPrice : entryPrice;
  const favorable = computeGrossReturn({ direction, entryPrice, exitPrice: peak }) ?? 0;

  if (trailing.breakEvenTriggerR > 0 && favorable >= trailing.breakEvenTriggerR * R) {
    const be = isLong ? entryPrice * (1 + trailing.costFraction) : entryPrice * (1 - trailing.costFraction);
    if (better(be, level)) {
      level = be;
      reason = CLOSE_REASON.BREAKEVEN_STOP;
    }
  }

  if (trailing.trailDistanceR > 0 && favorable >= trailing.trailActivationR * R) {
    const gap = trailing.trailDistanceR * R;
    const tr = isLong ? peak * (1 - gap) : peak * (1 + gap);
    if (better(tr, level)) {
      level = tr;
      reason = CLOSE_REASON.TRAILING_STOP;
    }
  }

  return { level, reason };
}

/** The better (more favorable) of two prices for `direction`; a null side loses. */
export function betterPeak(direction, a, b) {
  if (!Number.isFinite(a)) return Number.isFinite(b) ? b : null;
  if (!Number.isFinite(b)) return a;
  return direction === "short" ? Math.min(a, b) : Math.max(a, b);
}
