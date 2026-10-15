// Trend filter (knobs `trendFilterAgainst` / `trendFilterMixed`, both default OFF, backtest per-run only). Pure: no DB, no LLM, never throws.
//
// WHY: evidence.js#technicalAlignment already says, per decision, whether price vs SMA and the recent price change lean the same way as the
// trade ('with'), the opposite way ('against'), or split ('mixed'). Until now it was diagnostic only. This gate can block a decision on it.
// It is a TUNING EXPERIMENT, not a proven edge: on Jun runs the big losers were tagged 'with' and most 'against' entries won, and on Sep-Oct
// 'with' did no better than counter-trend. So it ships OFF and is tested per window before anything else depends on it.
//
// 'unknown' (no snapshot data, flat direction) is never blocked: nothing to judge.
//
// LONGER TREND (knob `trendFilterWindow`, default 0 = off): the stored alignment looks at only 5 daily bars, so a bounce inside a bigger
// downtrend reads 'with' for a long (the 06-17 loser). With a window N >= 2 the gate recomputes the alignment over N daily bars instead
// (price vs the N-bar SMA and the change over N bars, same two-vote rule), from the bars the pipeline already holds. Gate only: the
// analysts still see the 5-day snapshot, so the LLM stage is unchanged and a seeded run can be re-filtered at another window.

import { computeSMA, computePriceChangePct } from "../analysts/technicalIndicators.js";
import { technicalAlignment } from "../managers/evidence.js";

const BLOCKABLE = Object.freeze(new Set(["against", "mixed"]));

/** Which alignments the config blocks: `{ against, mixed }` booleans (a missing key means OFF). */
export function trendFilterParams(config) {
  return { against: config?.trendFilterAgainst === true, mixed: config?.trendFilterMixed === true };
}

/**
 * The trend window in daily bars (a whole number >= 2), or 0 = use the stored 5-bar alignment. Anything else (missing, 1, fractions,
 * strings) is 0, so a hand-built config can never turn it on by accident. Only matters while against and/or mixed is selected.
 */
export function trendFilterWindow(config) {
  const n = config?.trendFilterWindow;
  return Number.isInteger(n) && n >= 2 ? n : 0;
}

/** True when at least one alignment is selected, i.e. the gate does anything. */
export function trendFilterActive(config) {
  const p = trendFilterParams(config);
  return p.against || p.mixed;
}

/**
 * The alignment of `direction` over the last `window` daily bars. `bars` are most-recent-first rows with `close` and `date` (the pipeline's
 * state.priceBars). The live `price` joins the series only when it belongs to a session AFTER the newest daily bar (`priceDate`, an ISO
 * date or timestamp): a price from the same session would count that session twice. Too few bars, a bad direction or a bad close is
 * 'unknown', never a guess. Pure, never throws.
 * @returns {{ alignment: string, window: number, sma: number | null, changePct: number | null, priceUsed: number | null, live: boolean }}
 */
export function longTrendAlignment({ bars, direction, window, price, priceDate } = {}) {
  const unknown = { alignment: "unknown", window: Number.isInteger(window) ? window : 0, sma: null, changePct: null, priceUsed: null, live: false };
  if (!Number.isInteger(window) || window < 2 || !Array.isArray(bars) || bars.length === 0) return unknown;
  if (!bars.every((b) => Number.isFinite(b?.close))) return unknown;
  const newestDate = typeof bars[0].date === "string" ? bars[0].date.slice(0, 10) : null;
  const live = Number.isFinite(price) && price > 0 && typeof priceDate === "string" && newestDate !== null && priceDate.slice(0, 10) > newestDate;
  const series = live ? [{ close: price }, ...bars] : bars;
  const sma = computeSMA(series, window);
  const changePct = computePriceChangePct(series, window);
  const priceUsed = series[0].close;
  const alignment = technicalAlignment({ hasData: true, currentPrice: priceUsed, sma, priceChangePct: changePct }, direction);
  return { alignment, window, sma, changePct, priceUsed, live };
}

/**
 * @param {{ alignment: string | null | undefined, blockAgainst?: boolean, blockMixed?: boolean, window?: number, shortAlignment?: string | null }} args
 * @returns {{ applied: boolean, blocked: boolean, alignment: string, blockAgainst: boolean, blockMixed: boolean, reason: string }}
 * `applied` = the alignment was known and one of the blockable kinds was selected or passed through the check; the record goes to
 * decision.debate.evidence.trendFilter whether the gate blocked or not.
 */
export function evaluateTrendFilter({ alignment, blockAgainst = false, blockMixed = false, window = 0, shortAlignment = null } = {}) {
  const a = typeof alignment === "string" ? alignment : "unknown";
  const base = { alignment: a, blockAgainst: blockAgainst === true, blockMixed: blockMixed === true };
  // A longer window is recorded next to the stored 5-bar alignment it replaced; with no window the record is unchanged.
  if (Number.isInteger(window) && window >= 2) {
    base.window = window;
    base.shortAlignment = typeof shortAlignment === "string" ? shortAlignment : "unknown";
  }
  if (!base.blockAgainst && !base.blockMixed) return { ...base, applied: false, blocked: false, reason: "trend filter: no alignment selected" };
  if (!BLOCKABLE.has(a) && a !== "with") return { ...base, applied: false, blocked: false, reason: `trend filter: alignment ${a}, nothing to judge` };
  const blocked = (a === "against" && base.blockAgainst) || (a === "mixed" && base.blockMixed);
  return {
    ...base,
    applied: true,
    blocked,
    reason: blocked ? `trend filter: entry is ${a} the trend` : `trend filter passed (${a})`,
  };
}
