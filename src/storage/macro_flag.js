// Operator switch for the LIVE macro-context feature (FRED + CFTC COT for XAUUSD),
// stored in LIVE_DB's system_flags next to the pause switches and ticker selection
// (storage/pause_flags.js, storage/active_tickers.js) -- no new migration.
//
// One row, key `feature:macro`. `paused` is reused with the same polarity as the
// other flags: 1 = DISABLED, 0 = ENABLED. NO ROW = OFF: unlike a ticker (where a
// read error silently halting trading is the worse failure), this is an opt-in
// feature that costs vendor requests and prompt tokens, so every doubtful case
// resolves to OFF -- no row, a missing binding, or any D1 error (logged).
//
// When OFF the live path does no FRED/COT fetches, writes no macro rows, and the
// analysts get no macro block. Backtests ignore this flag: they take their own
// per-run `macroEnabled` knob (backtest/knobOverrides.js), default off.

export const MACRO_FLAG_KEY = "feature:macro";

/** `{ enabled, updatedAt, updatedBy, error }`. Never throws; any failure reads as OFF. */
export async function getMacroFlag(db) {
  if (!db) return { enabled: false, updatedAt: null, updatedBy: null, error: null };
  try {
    const row = await db.prepare(`SELECT paused, updated_at, updated_by FROM system_flags WHERE key = ?`).bind(MACRO_FLAG_KEY).first();
    if (!row) return { enabled: false, updatedAt: null, updatedBy: null, error: null };
    return { enabled: Number(row.paused) === 0, updatedAt: row.updated_at ?? null, updatedBy: row.updated_by ?? null, error: null };
  } catch (err) {
    console.warn("macro flag read failed -- treating the macro feature as OFF", { message: err.message });
    return { enabled: false, updatedAt: null, updatedBy: null, error: err.message };
  }
}

/** Convenience for callers that only need the boolean. */
export async function isMacroEnabled(db) {
  return (await getMacroFlag(db)).enabled;
}

/** Turns the live macro feature on or off. Throws on a D1 error; callers report it. */
export async function setMacroEnabled(db, enabled, { by = null, now = new Date().toISOString() } = {}) {
  const who = by ? String(by).slice(0, 64) : null;
  await db
    .prepare(
      "INSERT INTO system_flags (key, paused, updated_at, updated_by) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET paused = excluded.paused, updated_at = excluded.updated_at, updated_by = excluded.updated_by"
    )
    .bind(MACRO_FLAG_KEY, enabled ? 0 : 1, now, who)
    .run();
  return { enabled: Boolean(enabled), updatedAt: now, updatedBy: who };
}
