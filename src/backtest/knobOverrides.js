// Per-run overrides of the tunable strategy knobs (docs/rollout.md "Tuning"), so
// a sweep does not need one redeploy per grid point.
//
// WHY THIS EXISTS: the knobs are read once by config.js#loadConfig from env vars,
// so before this every value tried meant changing the Worker's env and
// redeploying. A backtest run now takes them as request params
// (POST /backtest/run?drawdownBreakerPct=0.03&...), they ride on the queue
// message (like enableLlmLog), and backtest-worker.js applies them to THAT run's
// config only -- never a mutation of the shared config, never the live Worker.
// The effective values are stored in the run's result (result.knobs), so every
// run records the knobs it actually used, override or not.
//
// SCOPE: an allowlist, on purpose. Only the knobs the tuning plan names; any
// other config key (API keys, budgets, hold days) cannot be set from a request.
// Blank values are ignored (an empty form field means "use the default"); a
// present-but-invalid value is an error, never silently dropped, because a
// sweep run with the wrong knob would otherwise look like a real data point.

import {
  DEFAULT_FLIP_MIN_CONFIDENCE,
  DEFAULT_RANGE_FILTER_DAYS,
  DEFAULT_RANGE_FILTER_EDGE_PCT,
  DEFAULT_ENTRY_CONFIRM_MOVE_PCT,
  DEFAULT_ENTRY_CONFIRM_HOURS,
} from "../shared/constants.js";

/**
 * Overridable knobs: query param name === config key. `min`/`max` are inclusive
 * sanity bounds (not tuning advice); `integer` requires a whole number.
 */
export const KNOB_OVERRIDES = Object.freeze({
  tradeCostBps: Object.freeze({ min: 0, max: 1000 }),
  drawdownBreakerPct: Object.freeze({ min: 0, max: 1 }),
  drawdownBreakerWindowDays: Object.freeze({ min: 1, max: 365, integer: true }),
  splitGuardTolerance: Object.freeze({ min: 0, max: 1 }),
  flipMinConfidence: Object.freeze({ min: 0, max: 1 }),
  dailyBothTouchedNearestOpen: Object.freeze({ min: 0, max: 1, integer: true }),
  // Price-impact gate (graph/pipeline.js). Requested as 0 (off) / 1 (on) like the knob above, but the config key
  // is a boolean: `boolean: true` makes applyKnobOverrides store `n !== 0` and effectiveKnobs report true/false.
  skipNoPriceImpact: Object.freeze({ min: 0, max: 1, integer: true, boolean: true }),
  // XAUUSD macro context (FRED + CFTC COT) in the analyst prompt. Same 0/1 -> boolean handling as the gate above, but the
  // default is OFF and a backtest NEVER reads the live macro flag (storage/macro_flag.js): the run's own knob decides, so a
  // run is reproducible no matter what the live switch is set to.
  macroEnabled: Object.freeze({ min: 0, max: 1, integer: true, boolean: true }),
  // Merged verdict (graph/pipeline.js): ONE call replaces bull + bear + judge. Same 0/1 -> boolean handling; default OFF, so a
  // run without it is the normal three-call debate. Lets two runs on the same ticker/window be compared.
  mergedVerdict: Object.freeze({ min: 0, max: 1, integer: true, boolean: true }),
  // Decision switches (graph/pipeline.js intraday price for the technical analyst; judge EVIDENCE RULE). 0/1 -> boolean like the
  // knobs above; default OFF, and a backtest NEVER reads the live switch rows (storage/live_knobs.js): the run decides.
  intradayTechnical: Object.freeze({ min: 0, max: 1, integer: true, boolean: true }),
  independenceNote: Object.freeze({ min: 0, max: 1, integer: true, boolean: true }),
  // Range-location filter (agents/risk_mgmt/range_location.js) and entry confirmation (shared/entry_confirmation.js): same 0/1 ->
  // boolean handling, default OFF, a backtest NEVER reads the live switch rows. Their numeric params are per-run only (NOT live
  // knobs); bounds match rangeFilterParams / entryConfirmationParams, which fall back to the constants.js default outside them.
  rangeLocationFilter: Object.freeze({ min: 0, max: 1, integer: true, boolean: true }),
  entryConfirmation: Object.freeze({ min: 0, max: 1, integer: true, boolean: true }),
  rangeFilterDays: Object.freeze({ min: 2, max: 60, integer: true }),
  rangeFilterEdgePct: Object.freeze({ min: 0.01, max: 0.5 }),
  entryConfirmMovePct: Object.freeze({ min: 0.001, max: 0.2 }),
  entryConfirmHours: Object.freeze({ min: 1, max: 72, integer: true }),
  // Break-even / trailing stop (agents/risk_mgmt/trailing.js), in R = the position's initial stop distance. 0 = off
  // (the default), so a run without them is the static stop/target walk. Bounds are sanity limits, not tuning advice.
  breakEvenTriggerR: Object.freeze({ min: 0, max: 10 }),
  trailActivationR: Object.freeze({ min: 0, max: 10 }),
  trailDistanceR: Object.freeze({ min: 0, max: 10 }),
  // 1 = once the trail is binding, ignore the fixed take-profit. Stays a number (config reads Number(x) === 1).
  trailRemovesTarget: Object.freeze({ min: 0, max: 1, integer: true }),
});

/**
 * Reads knob overrides through `get(name) -> string | null | undefined` (works
 * for URLSearchParams#get and a form-reading closure alike).
 * Returns `{ overrides }` (possibly `{}`) or `{ error }` naming the bad param.
 */
export function parseKnobOverrides(get) {
  const overrides = {};
  for (const [name, rule] of Object.entries(KNOB_OVERRIDES)) {
    const raw = get(name);
    if (raw === undefined || raw === null || String(raw).trim() === "") continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) return { error: `${name} must be a number (got "${raw}")` };
    if (rule.integer && !Number.isInteger(n)) return { error: `${name} must be a whole number (got "${raw}")` };
    if (n < rule.min || n > rule.max) return { error: `${name} must be between ${rule.min} and ${rule.max} (got "${raw}")` };
    overrides[name] = n;
  }
  return { overrides };
}

/**
 * A NEW config with the overrides applied. With nothing to apply it returns the
 * very same object, so the no-override path is unchanged. Unknown keys are
 * ignored (defense in depth: the queue message is not the trust boundary the
 * request handler is).
 */
export function applyKnobOverrides(config, overrides) {
  if (!overrides) return config;
  const picked = {};
  for (const name of Object.keys(KNOB_OVERRIDES)) {
    if (Object.prototype.hasOwnProperty.call(overrides, name) && Number.isFinite(overrides[name])) {
      picked[name] = KNOB_OVERRIDES[name].boolean ? overrides[name] !== 0 : overrides[name];
    }
  }
  return Object.keys(picked).length === 0 ? config : { ...config, ...picked };
}

/**
 * The knob values a run actually used, for its stored result. `flipMinConfidence`
 * resolves the "unset -> constants.js default" fallback that RunStore applies, so
 * the record shows a number rather than null. A key a hand-built config lacks is
 * null (consumers given no value run unguarded, see config.js).
 */
export function effectiveKnobs(config) {
  const knobs = {};
  for (const name of Object.keys(KNOB_OVERRIDES)) knobs[name] = config[name] ?? null;
  // The gate treats a missing key as on (config.js), so the record shows true, not null.
  knobs.skipNoPriceImpact = config.skipNoPriceImpact !== false;
  // Opposite default to the gate: a missing key means macro context is OFF, so the record shows false, not null.
  knobs.macroEnabled = config.macroEnabled === true;
  // Default OFF too: a missing key means the normal three-call debate, so the record shows false, not null.
  knobs.mergedVerdict = config.mergedVerdict === true;
  // Default OFF: a missing key means the old behavior, so the record shows false, not null.
  knobs.intradayTechnical = config.intradayTechnical === true;
  knobs.independenceNote = config.independenceNote === true;
  knobs.rangeLocationFilter = config.rangeLocationFilter === true;
  knobs.entryConfirmation = config.entryConfirmation === true;
  // The numeric params resolve their constants.js default (like flipMinConfidence), so the record shows what a run used.
  knobs.rangeFilterDays = config.rangeFilterDays ?? DEFAULT_RANGE_FILTER_DAYS;
  knobs.rangeFilterEdgePct = config.rangeFilterEdgePct ?? DEFAULT_RANGE_FILTER_EDGE_PCT;
  knobs.entryConfirmMovePct = config.entryConfirmMovePct ?? DEFAULT_ENTRY_CONFIRM_MOVE_PCT;
  knobs.entryConfirmHours = config.entryConfirmHours ?? DEFAULT_ENTRY_CONFIRM_HOURS;
  knobs.flipMinConfidence = config.flipMinConfidence ?? DEFAULT_FLIP_MIN_CONFIDENCE;
  return knobs;
}
