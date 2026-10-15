// Trend filter (knobs `trendFilterAgainst` / `trendFilterMixed`, both default OFF, backtest per-run only). Pure: no DB, no LLM, never throws.
//
// WHY: evidence.js#technicalAlignment already says, per decision, whether price vs SMA and the recent price change lean the same way as the
// trade ('with'), the opposite way ('against'), or split ('mixed'). Until now it was diagnostic only. This gate can block a decision on it.
// It is a TUNING EXPERIMENT, not a proven edge: on Jun runs the big losers were tagged 'with' and most 'against' entries won, and on Sep-Oct
// 'with' did no better than counter-trend. So it ships OFF and is tested per window before anything else depends on it.
//
// 'unknown' (no snapshot data, flat direction) is never blocked: nothing to judge.

const BLOCKABLE = Object.freeze(new Set(["against", "mixed"]));

/** Which alignments the config blocks: `{ against, mixed }` booleans (a missing key means OFF). */
export function trendFilterParams(config) {
  return { against: config?.trendFilterAgainst === true, mixed: config?.trendFilterMixed === true };
}

/** True when at least one alignment is selected, i.e. the gate does anything. */
export function trendFilterActive(config) {
  const p = trendFilterParams(config);
  return p.against || p.mixed;
}

/**
 * @param {{ alignment: string | null | undefined, blockAgainst?: boolean, blockMixed?: boolean }} args
 * @returns {{ applied: boolean, blocked: boolean, alignment: string, blockAgainst: boolean, blockMixed: boolean, reason: string }}
 * `applied` = the alignment was known and one of the blockable kinds was selected or passed through the check; the record goes to
 * decision.debate.evidence.trendFilter whether the gate blocked or not.
 */
export function evaluateTrendFilter({ alignment, blockAgainst = false, blockMixed = false } = {}) {
  const a = typeof alignment === "string" ? alignment : "unknown";
  const base = { alignment: a, blockAgainst: blockAgainst === true, blockMixed: blockMixed === true };
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
