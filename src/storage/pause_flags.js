// Operator pause switches, stored in LIVE_DB's system_flags table
// (migrations/state/0002_system_flags.sql). Four independent switches:
//   ingestion -- live news/price/fundamentals fan-out and consumers
//   trading   -- exit_check and the analyze/decision pipeline
//   llm       -- every Gemini-calling path (analyze, exit_check)
//   backtests -- POST /backtest/run
// The intraday backfill tick, the retention purge and the manual /backfill
// jobs are deliberately NOT switchable: freeing headroom for them is the
// point of pausing everything else.
//
// FAIL OPEN: a missing binding or any D1 error reads as "nothing paused", with
// a console.warn. A flaky read must never silently halt the system.

export const PAUSE_KEYS = Object.freeze(["ingestion", "trading", "llm", "backtests"]);

export const PAUSE_LABELS = Object.freeze({
  ingestion: "Ingestion",
  trading: "Trading",
  llm: "LLM calls",
  backtests: "Backtests",
});

export function isPauseKey(key) {
  return PAUSE_KEYS.includes(key);
}

function allClear() {
  return Object.fromEntries(PAUSE_KEYS.map((k) => [k, false]));
}

/** `{ flags: {ingestion, trading, llm, backtests}, meta: {key: {updatedAt, updatedBy}}, error }`. Never throws. */
export async function getPauseFlags(db) {
  if (!db) return { flags: allClear(), meta: {}, error: null };
  try {
    const { results } = await db.prepare("SELECT key, paused, updated_at, updated_by FROM system_flags").all();
    const flags = allClear();
    const meta = {};
    for (const row of results ?? []) {
      if (!isPauseKey(row.key)) continue;
      flags[row.key] = Number(row.paused) === 1;
      meta[row.key] = { updatedAt: row.updated_at ?? null, updatedBy: row.updated_by ?? null };
    }
    return { flags, meta, error: null };
  } catch (err) {
    console.warn("pause flags read failed -- failing open (nothing paused)", { message: err.message });
    return { flags: allClear(), meta: {}, error: err.message };
  }
}

/** True if `key` is paused. Fails open (false). */
export async function isPaused(db, key) {
  return (await getPauseFlags(db)).flags[key] === true;
}

/** Sets each of `keys` to `paused` in one batch. Throws on an unknown key or a D1 error (callers report it). */
export async function setPauseFlags(db, keys, paused, { by = null, now = new Date().toISOString() } = {}) {
  for (const key of keys) {
    if (!isPauseKey(key)) throw new Error(`unknown pause key: ${key}`);
  }
  const sql =
    "INSERT INTO system_flags (key, paused, updated_at, updated_by) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(key) DO UPDATE SET paused = excluded.paused, updated_at = excluded.updated_at, updated_by = excluded.updated_by";
  const who = by ? String(by).slice(0, 64) : null;
  await db.batch(keys.map((key) => db.prepare(sql).bind(key, paused ? 1 : 0, now, who)));
}
