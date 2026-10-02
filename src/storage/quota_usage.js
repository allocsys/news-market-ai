// Per-UTC-day ledger of what the backtest worker has spent against the daily
// platform quotas it SHARES with live ingestion/trading (migrations/sim/
// 0003_pause_resume_quota.sql, quota_usage). One row per day; counters are
// plain INTEGER columns so an increment is a single atomic UPSERT, plus a JSON
// object for Gemini requests per "<model>|<key label>".
//
// We only see OUR (backtest) usage -- live workers hit the same D1/KV/Gemini
// caps and are not in this table -- so the thresholds in config.js apply to the
// backtest's own share of each quota (see config.js quota* settings).
//
// Parts run strictly one at a time (queue max_concurrency 1), so the worker
// reads the day's row ONCE at the start of a part (the value to check the
// thresholds against, plus the part's own in-memory counts) and writes the part's
// increment in the SAME db.batch as its backtest_runs.rows_written update.

/** UTC calendar day (YYYY-MM-DD) of `now` -- the D1/KV quota reset boundary. */
export function utcDay(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/** The next UTC midnight after `now`, ISO string: when D1/KV daily quotas reset. */
export function nextUtcMidnightIso(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
  return d.toISOString();
}

const EMPTY = Object.freeze({ d1Written: 0, d1Read: 0, kvReads: 0, kvWrites: 0, gemini: {} });

/** Today's (or `day`'s) ledger row as {d1Written, d1Read, kvReads, kvWrites, gemini:{}}; zeros when there is no row yet. */
export async function getQuotaUsage(db, day = utcDay()) {
  const row = await db.prepare(`SELECT d1_written, d1_read, kv_reads, kv_writes, gemini FROM quota_usage WHERE day = ?`).bind(day).first();
  if (!row) return { ...EMPTY, gemini: {} };
  let gemini = {};
  try {
    gemini = row.gemini ? JSON.parse(row.gemini) : {};
  } catch {
    gemini = {};
  }
  return { d1Written: row.d1_written ?? 0, d1Read: row.d1_read ?? 0, kvReads: row.kv_reads ?? 0, kvWrites: row.kv_writes ?? 0, gemini };
}

/** Adds two {"<model>|<key>": n} maps. */
export function mergeGeminiCounts(a = {}, b = {}) {
  const out = { ...a };
  for (const [k, n] of Object.entries(b)) out[k] = (out[k] ?? 0) + n;
  return out;
}

/**
 * PREPARED (not run) UPSERT adding one part's counts to `day`'s row, for
 * inclusion in an existing db.batch([...]) -- that is what keeps the ledger at
 * ~zero extra subrequests. `gemini` must be the FULL merged JSON object
 * (start-of-part ledger value + this part's counts, see mergeGeminiCounts);
 * the integer columns are added atomically in SQL.
 */
export function quotaUsageUpsertStatement(db, { day = utcDay(), d1Written = 0, d1Read = 0, kvReads = 0, kvWrites = 0, gemini = {}, now = new Date() }) {
  return db
    .prepare(
      `INSERT INTO quota_usage (day, d1_written, d1_read, kv_reads, kv_writes, gemini, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET
         d1_written = d1_written + excluded.d1_written,
         d1_read = d1_read + excluded.d1_read,
         kv_reads = kv_reads + excluded.kv_reads,
         kv_writes = kv_writes + excluded.kv_writes,
         gemini = excluded.gemini,
         updated_at = excluded.updated_at`
    )
    .bind(day, d1Written, d1Read, kvReads, kvWrites, JSON.stringify(gemini), now.toISOString());
}
