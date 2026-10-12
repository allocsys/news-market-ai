// Live-tunable break-even / trailing knobs (agents/risk_mgmt/trailing.js), kept in LIVE_DB's
// system_flags next to the pause switches (storage/pause_flags.js).
//
// One row per knob, key `knob:<configKey>`, numeric payload in system_flags.value (migration 0011).
// NO ROW = no override (the env/config default applies). Clearing a knob deletes its row.
//
// READS ARE FREE: pause_flags.js#getPauseFlags already reads every system_flags row in one statement
// per batch; it now also returns the parsed knobs from that same result (parseLiveKnobRows). Nothing in
// this file issues a read.
//
// SNAPSHOT SEMANTICS: a live value only changes the config used when a position OPENS. At open the
// effective four knobs are copied onto the row (positions.trail_knobs, snapshotTrailKnobs), and the exit
// walk uses that snapshot (positionTrailConfig). Changing a knob therefore never rewrites the stop of a
// position that is already open. Rows opened before migration 0011 (trail_knobs NULL) use the config.
//
// FAIL SAFE: any bad value, missing binding or D1 error means "no override" (the config default), never
// a half-applied one. Bounds are the same as the per-run backtest overrides (backtest/knobOverrides.js).
// A backtest NEVER reads these rows: its per-run override (or the config default) decides, so a run is
// reproducible whatever the live knobs are set to.

import { KNOB_OVERRIDES } from "../backtest/knobOverrides.js";

export const LIVE_KNOB_NAMES = Object.freeze(["breakEvenTriggerR", "trailActivationR", "trailDistanceR", "trailRemovesTarget"]);
// On/off decision switches (0/1), stored in the same `knob:<name>` rows but kept apart from the trail knobs: they are NOT
// snapshotted onto positions and never show in the Exit knobs card. They apply to the next decision immediately.
export const LIVE_SWITCH_NAMES = Object.freeze(["intradayTechnical", "independenceNote", "rangeLocationFilter", "entryConfirmation"]);
export const LIVE_KNOB_KEY_PREFIX = "knob:";

export function liveKnobKey(name) {
  return `${LIVE_KNOB_KEY_PREFIX}${name}`;
}

/** The config key behind a system_flags key, or null when the row is not a live knob. */
export function liveKnobNameOfKey(key) {
  if (typeof key !== "string" || !key.startsWith(LIVE_KNOB_KEY_PREFIX)) return null;
  const name = key.slice(LIVE_KNOB_KEY_PREFIX.length);
  return LIVE_KNOB_NAMES.includes(name) ? name : null;
}

/** `{ value }` or `{ error }`: same bounds / integer rule as KNOB_OVERRIDES. */
export function validateLiveKnob(name, raw) {
  const rule = LIVE_KNOB_NAMES.includes(name) || LIVE_SWITCH_NAMES.includes(name) ? KNOB_OVERRIDES[name] : null;
  if (!rule) return { error: `unknown knob: ${name}` };
  if (raw === undefined || raw === null || String(raw).trim() === "") return { error: `${name} needs a value` };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { error: `${name} must be a number (got "${raw}")` };
  if (rule.integer && !Number.isInteger(n)) return { error: `${name} must be a whole number (got "${raw}")` };
  if (n < rule.min || n > rule.max) return { error: `${name} must be between ${rule.min} and ${rule.max} (got "${raw}")` };
  return { value: n };
}

/**
 * Pure: knob rows -> `{ values: {name: number}, meta: {name: {updatedAt, updatedBy}} }`. Takes the rows of the
 * shared system_flags SELECT (key, paused, value, updated_at, updated_by); ignores every other row. A row that
 * is paused, has no value, or whose value is out of bounds is skipped (fail-safe: no override).
 */
export function parseLiveKnobRows(rows) {
  const values = {};
  const meta = {};
  for (const row of rows ?? []) {
    const name = liveKnobNameOfKey(row?.key);
    if (!name || Number(row.paused) === 1 || row.value == null) continue;
    const checked = validateLiveKnob(name, row.value);
    if (checked.error) continue;
    values[name] = checked.value;
    meta[name] = { updatedAt: row.updated_at ?? null, updatedBy: row.updated_by ?? null };
  }
  return { values, meta };
}

/** The switch name behind a system_flags key, or null when the row is not a live switch. */
export function liveSwitchNameOfKey(key) {
  if (typeof key !== "string" || !key.startsWith(LIVE_KNOB_KEY_PREFIX)) return null;
  const name = key.slice(LIVE_KNOB_KEY_PREFIX.length);
  return LIVE_SWITCH_NAMES.includes(name) ? name : null;
}

/** Pure: switch rows -> `{ values: {name: 0|1}, meta }`. Same fail-safe as parseLiveKnobRows (bad/paused/valueless row = no override). */
export function parseLiveSwitchRows(rows) {
  const values = {};
  const meta = {};
  for (const row of rows ?? []) {
    const name = liveSwitchNameOfKey(row?.key);
    if (!name || Number(row.paused) === 1 || row.value == null) continue;
    const checked = validateLiveKnob(name, row.value);
    if (checked.error) continue;
    values[name] = checked.value;
    meta[name] = { updatedAt: row.updated_at ?? null, updatedBy: row.updated_by ?? null };
  }
  return { values, meta };
}

/** A NEW config with the live switches applied (0/1 -> boolean); the very same object when there is nothing to apply. */
export function applyLiveSwitches(config, values) {
  if (!values) return config;
  const picked = {};
  for (const name of LIVE_SWITCH_NAMES) {
    if (Object.prototype.hasOwnProperty.call(values, name) && Number.isFinite(values[name])) picked[name] = values[name] !== 0;
  }
  return Object.keys(picked).length === 0 ? config : { ...config, ...picked };
}

/** The effective switches of `config` as 0/1 (missing = 0 = off). */
export function snapshotSwitches(config) {
  return Object.fromEntries(LIVE_SWITCH_NAMES.map((n) => [n, config?.[n] === true ? 1 : 0]));
}

/** A NEW config with the live values applied; the very same object when there is nothing to apply. */
export function applyLiveKnobs(config, values) {
  if (!values) return config;
  const picked = {};
  for (const name of LIVE_KNOB_NAMES) {
    if (Object.prototype.hasOwnProperty.call(values, name) && Number.isFinite(values[name])) picked[name] = values[name];
  }
  return Object.keys(picked).length === 0 ? config : { ...config, ...picked };
}

/** The four effective knobs of `config` as plain non-negative numbers (missing/invalid = 0 = off). */
export function snapshotTrailKnobs(config) {
  const pos = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
  return {
    breakEvenTriggerR: pos(config?.breakEvenTriggerR),
    trailActivationR: pos(config?.trailActivationR),
    trailDistanceR: pos(config?.trailDistanceR),
    trailRemovesTarget: pos(config?.trailRemovesTarget),
  };
}

/** JSON text for positions.trail_knobs. */
export function serializeTrailKnobs(config) {
  return JSON.stringify(snapshotTrailKnobs(config));
}

/** positions.trail_knobs -> knob object, or null (NULL column, bad JSON, wrong shape = "use the config"). */
export function parseTrailKnobs(text) {
  if (text == null || text === "") return null;
  try {
    const o = JSON.parse(text);
    if (!o || typeof o !== "object") return null;
    return snapshotTrailKnobs(o);
  } catch {
    return null;
  }
}

/**
 * The config the exit walk should resolve trailing from for ONE position: the config with the position's own
 * snapshot laid over it. No snapshot (pre-migration row) = the config itself.
 */
export function positionTrailConfig(config, position) {
  const snap = position?.trailKnobs;
  return snap ? { ...config, ...snap } : config;
}

/** Upserts knobs (validated by the caller via validateLiveKnob). One batch. Throws on a D1 error. */
export async function setLiveKnobs(db, values, { by = null, now = new Date().toISOString() } = {}) {
  const entries = Object.entries(values);
  for (const [name, v] of entries) {
    const checked = validateLiveKnob(name, v);
    if (checked.error) throw new Error(checked.error);
  }
  const sql =
    "INSERT INTO system_flags (key, paused, updated_at, updated_by, value) VALUES (?, 0, ?, ?, ?) " +
    "ON CONFLICT(key) DO UPDATE SET paused = 0, updated_at = excluded.updated_at, updated_by = excluded.updated_by, value = excluded.value";
  const who = by ? String(by).slice(0, 64) : null;
  await db.batch(entries.map(([name, v]) => db.prepare(sql).bind(liveKnobKey(name), now, who, Number(v))));
}

/** Deletes knob rows (back to the config default). Throws on an unknown name or a D1 error. */
export async function clearLiveKnobs(db, names) {
  for (const name of names) {
    if (!LIVE_KNOB_NAMES.includes(name) && !LIVE_SWITCH_NAMES.includes(name)) throw new Error(`unknown knob: ${name}`);
  }
  await db.batch(names.map((name) => db.prepare("DELETE FROM system_flags WHERE key = ?").bind(liveKnobKey(name))));
}
