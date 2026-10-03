// Operator ticker selection for the LIVE pipeline, stored in LIVE_DB's system_flags table next to the
// pause switches (storage/pause_flags.js, migrations/state/0002_system_flags.sql) -- no new migration.
// One row per ticker the operator has touched: key `ticker:<SYMBOL>`, paused = 1 means DISABLED,
// paused = 0 means active again. No row = active, so an empty table runs the whole watchlist (the
// default) and a ticker added to WATCHLIST_TICKERS later starts active. pause_flags.js ignores these
// rows (it only reads its own four keys).
//
// A disabled ticker gets, in the live pipeline only: no ingest_ticker fan-out message (so no news /
// price / fundamentals fetch for it), and its ANALYZE messages are dropped by both the ingest and the
// llm consumers (so no new Gemini spend). It never touches: exit checks and pending-entry fills for
// positions already open, the intraday backfill tick, manual backfills, and backtests (a backtest
// takes its tickers from its own form).
//
// FAIL OPEN: a missing binding or any D1 error reads as "nothing disabled", with a console.warn, so a
// flaky read never silently halts a ticker.

export const TICKER_FLAG_PREFIX = "ticker:";

/** Every value (repeated params and/or comma lists) as a deduped, upper-cased array. */
export function normalizeTickers(values) {
  const out = [];
  for (const value of values ?? []) {
    for (const part of String(value ?? "").split(",")) {
      const ticker = part.trim().toUpperCase();
      if (ticker && !out.includes(ticker)) out.push(ticker);
    }
  }
  return out;
}

/**
 * Validates an operator's selection against the watchlist: at least one ticker, every one in the
 * watchlist. `{ tickers }` on success, `{ error }` otherwise. Selecting nothing is refused on purpose:
 * stopping everything is what the pause switches are for.
 */
export function checkTickerSelection(watchlist, selected) {
  const tickers = normalizeTickers(Array.isArray(selected) ? selected : [selected]);
  if (tickers.length === 0) return { error: "select at least one ticker (use the pause switches to stop everything)" };
  const unknown = tickers.filter((t) => !watchlist.includes(t));
  if (unknown.length > 0) return { error: `not in the watchlist: ${unknown.join(", ")}` };
  return { tickers };
}

/** `{ disabled: Set<string>, meta: {SYMBOL: {updatedAt, updatedBy}}, error }`. Never throws. */
export async function getDisabledTickers(db) {
  const disabled = new Set();
  const meta = {};
  if (!db) return { disabled, meta, error: null };
  try {
    const { results } = await db.prepare(`SELECT key, paused, updated_at, updated_by FROM system_flags WHERE key LIKE '${TICKER_FLAG_PREFIX}%'`).all();
    for (const row of results ?? []) {
      const key = String(row.key ?? "");
      if (!key.startsWith(TICKER_FLAG_PREFIX)) continue;
      const ticker = key.slice(TICKER_FLAG_PREFIX.length);
      if (!ticker) continue;
      meta[ticker] = { updatedAt: row.updated_at ?? null, updatedBy: row.updated_by ?? null };
      if (Number(row.paused) === 1) disabled.add(ticker);
    }
    return { disabled, meta, error: null };
  } catch (err) {
    console.warn("active tickers read failed -- failing open (nothing disabled)", { message: err.message });
    return { disabled: new Set(), meta: {}, error: err.message };
  }
}

/** `{ watchlist, active, disabled, meta, error }`, all in watchlist order (disabled/active are arrays). Never throws. */
export async function getActiveTickers(db, watchlist) {
  const list = [...watchlist];
  const { disabled, meta, error } = await getDisabledTickers(db);
  return {
    watchlist: list,
    active: list.filter((t) => !disabled.has(t)),
    disabled: list.filter((t) => disabled.has(t)),
    meta,
    error,
  };
}

/**
 * Makes exactly `selected` active and every other watchlist ticker disabled, in one batch. Throws on
 * an invalid selection (see checkTickerSelection) or a D1 error; callers report it.
 */
export async function setActiveTickers(db, watchlist, selected, { by = null, now = new Date().toISOString() } = {}) {
  const checked = checkTickerSelection(watchlist, selected);
  if (checked.error) throw new Error(checked.error);
  const chosen = new Set(checked.tickers);
  const sql =
    "INSERT INTO system_flags (key, paused, updated_at, updated_by) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(key) DO UPDATE SET paused = excluded.paused, updated_at = excluded.updated_at, updated_by = excluded.updated_by";
  const who = by ? String(by).slice(0, 64) : null;
  await db.batch(watchlist.map((ticker) => db.prepare(sql).bind(`${TICKER_FLAG_PREFIX}${ticker}`, chosen.has(ticker) ? 0 : 1, now, who)));
}
