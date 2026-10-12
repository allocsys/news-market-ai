// Range-location filter (decision switch `rangeLocationFilter`, default OFF). Pure: no DB, no LLM, never throws.
//
// WHY: on the BTCUSD 2026-09-11..10-11 backtests the losses clustered on a few entry dates (0 wins, MFE <= ~1%): entries AT
// a range extreme right before the reversal -- shorts at local lows that then rallied, longs at local highs that then dropped.
// This gate is the deterministic counter: a LONG within `edgePct` (a fraction of the N-day high-low range) of the N-day high,
// or a SHORT within `edgePct` of the N-day low, is blocked -- unless the price is already BEYOND that extreme (a breakout:
// long above the prior N-day high, short below the prior N-day low), which is allowed.
//
// KNOWN LIMITS (measured on those runs, not guessed): range position alone does not separate every loser from every winner.
// A continuation long just under the high after a breakout day (2026-09-19, winners) looks the same as a long under the high
// after a multi-day run-up (2026-09-23, losers); and a breakdown short below the prior low lost on 10-08 but won earlier that
// day. So this is a trade-off to be judged by matched A/B backtests per trade, not a proven filter.
//
// INPUTS: `bars` are daily bars as graph/pipeline.js already holds them (storage/inputs_view.js#getPriceBarsAsOf: strictly
// before the decision's UTC date, MOST RECENT FIRST, with high/low). They exclude the current session, so `price` (the
// current price the pipeline resolved for the entry) can sit outside the range -- that is what "breakout" means here.
// Missing or too little history never blocks: the gate is simply not applied.

import { DEFAULT_RANGE_FILTER_DAYS, DEFAULT_RANGE_FILTER_EDGE_PCT } from "../../shared/constants.js";

/** The effective `{ days, edgePct }` of a config: a missing or invalid value falls back to the constants.js default. */
export function rangeFilterParams(config) {
  const d = config?.rangeFilterDays;
  const e = config?.rangeFilterEdgePct;
  return {
    days: Number.isInteger(d) && d >= 2 ? d : DEFAULT_RANGE_FILTER_DAYS,
    edgePct: Number.isFinite(e) && e > 0 && e <= 0.5 ? e : DEFAULT_RANGE_FILTER_EDGE_PCT,
  };
}

/**
 * Where `price` sits in the high-low range of the `days` most recent usable bars: 0 = at the range low, 1 = at the range
 * high, above 1 / below 0 = beyond it. Returns `{ high, low, positionPct, barsUsed }`, or null when the position is not
 * computable (bad price, fewer than `days` usable bars, or a flat range).
 */
export function computeRangePosition(bars, price, days) {
  if (!Array.isArray(bars) || !Number.isFinite(price) || !(price > 0)) return null;
  const used = [];
  for (const bar of bars) {
    if (used.length >= days) break;
    if (Number.isFinite(bar?.high) && Number.isFinite(bar?.low) && bar.low > 0 && bar.high >= bar.low) used.push(bar);
  }
  if (used.length < days) return null;
  let high = -Infinity;
  let low = Infinity;
  for (const bar of used) {
    if (bar.high > high) high = bar.high;
    if (bar.low < low) low = bar.low;
  }
  if (!(high > low)) return null;
  return { high, low, positionPct: (price - low) / (high - low), barsUsed: used.length };
}

const round4 = (n) => Math.round(n * 10000) / 10000;

/**
 * The gate decision, as one record (stored in decision.debate.evidence.rangeFilter so a postmortem can slice by it):
 *   { applied, blocked, breakout, rangePositionPct, high, low, days, edgePct, reason }
 * `applied: false` means the gate had nothing to judge (flat/unknown direction, or not enough history) and never blocks.
 */
export function evaluateRangeLocation({ direction, price, bars, days = DEFAULT_RANGE_FILTER_DAYS, edgePct = DEFAULT_RANGE_FILTER_EDGE_PCT }) {
  const base = { applied: false, blocked: false, breakout: false, rangePositionPct: null, high: null, low: null, days, edgePct, reason: "" };
  if (direction !== "long" && direction !== "short") return { ...base, reason: "no long/short direction -- range filter not applied" };

  const range = computeRangePosition(bars, price, days);
  if (!range) return { ...base, reason: `fewer than ${days} usable daily bars or no usable price -- range filter not applied` };

  const pos = range.positionPct;
  const isLong = direction === "long";
  const breakout = isLong ? pos > 1 : pos < 0;
  const nearEdge = isLong ? pos >= 1 - edgePct : pos <= edgePct;
  const blocked = nearEdge && !breakout;
  const where = `${direction} at ${Math.round(pos * 100)}% of the ${days}-day range (${range.low}-${range.high})`;

  let reason;
  if (blocked) reason = `range filter: ${where}, within ${Math.round(edgePct * 100)}% of the ${isLong ? "high" : "low"}`;
  else if (breakout) reason = `range filter passed: ${where}, beyond the prior ${isLong ? "high" : "low"} (breakout)`;
  else reason = `range filter passed: ${where}`;

  return { applied: true, blocked, breakout, rangePositionPct: round4(pos), high: range.high, low: range.low, days, edgePct, reason };
}
