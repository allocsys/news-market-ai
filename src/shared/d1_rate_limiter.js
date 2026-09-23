// D1-persisted per-vendor daily request counter -- plan.md finding G step 1's
// "Rate limiting: token-bucket/counter per vendor, persisted in D1 (not
// in-memory), checked before each fetch; live candle fetching shares same
// budget/counter as backfill so they can't double-spend the daily cap."
// Table: migrations/inputs/0003_vendor_rate_limits.sql.
//
// DELIBERATELY A DIFFERENT CONCERN FROM shared/throttle.js: throttle.js paces
// calls *within one Worker invocation's loop* and has no memory across
// invocations (see its own header). This module is the cross-invocation
// memory a whole-day cap needs -- Twelve Data free Basic's 800 requests/day
// is spent across a scheduled backfill tick AND live candle fetches, which
// run as separate Worker invocations and would each start counting from zero
// without a shared, persisted counter.
//
// A simple day-bucketed counter, not a true token bucket (no partial refill,
// no burst allowance) -- the vendor limit this exists for (Twelve Data's
// 800/day) is itself a flat daily count, so a counter is the exact match; a
// smoother bucket would be solving a problem this vendor doesn't have.
// ingestion/sources/alpaca.js does not use this today (Alpaca's free tier has
// no comparable hard daily cap -- see that file's header), but any adapter
// that later needs one just calls reserve() with its own vendor name.

import { VendorError } from "./errors.js";

/**
 * `day` in UTC YYYY-MM-DD, matching every other day-boundary convention in
 * the inputs schema (price_bars.date, intraday_backfill_status.date).
 */
export function todayUtc(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Atomically reserves `n` requests (default 1) against `vendor`'s daily
 * budget of `limit` for `day` (defaults to today, UTC). Returns
 * `{ allowed: true, count }` (the count AFTER this reservation) if the
 * reservation fit within `limit`, or `{ allowed: false, count }` (the count
 * BEFORE this call -- nothing is reserved) if it would have exceeded it.
 *
 * Never throws on "limit reached" -- that is an ordinary, expected outcome
 * for a caller pacing itself against a free-tier cap, not a vendor failure.
 * Throws a VendorError only if the D1 calls themselves fail.
 *
 * Two statements, not one atomic UPSERT...RETURNING, because D1 (SQLite)
 * does support `RETURNING` but this needs a conditional increment ("only if
 * under limit"), which a single UPSERT can't express without a subquery D1's
 * SQLite version may not support consistently -- read-then-write is the
 * simpler, verified-portable choice. This is not safe against a genuine
 * concurrent race (two invocations reading the same pre-increment count at
 * once could both proceed), which is an accepted gap: the ingest/backfill
 * Workers here are cron-triggered, not high-concurrency, and a rare
 * off-by-a-few over a free-tier daily cap is a low-cost failure mode (the
 * vendor 429s that one extra request, per its own contract) compared to the
 * complexity of a fully serialized reservation.
 */
export async function reserve(db, { vendor, limit, n = 1, day = todayUtc() } = {}) {
  if (!vendor) throw new Error("reserve requires a vendor name");
  if (!Number.isFinite(limit) || limit < 0) throw new Error(`reserve requires a non-negative finite limit, got ${limit}`);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`reserve requires a positive finite n, got ${n}`);

  let row;
  try {
    row = await db.prepare(`SELECT count FROM vendor_request_counters WHERE vendor = ? AND day = ?`).bind(vendor, day).first();
  } catch (err) {
    throw new VendorError(vendor, `rate limiter read failed: ${err.message}`);
  }
  const current = row?.count ?? 0;

  if (current + n > limit) {
    return { allowed: false, count: current };
  }

  try {
    await db
      .prepare(
        `INSERT INTO vendor_request_counters (vendor, day, count) VALUES (?, ?, ?)
         ON CONFLICT(vendor, day) DO UPDATE SET count = count + excluded.count`
      )
      .bind(vendor, day, n)
      .run();
  } catch (err) {
    throw new VendorError(vendor, `rate limiter write failed: ${err.message}`);
  }

  return { allowed: true, count: current + n };
}

/** Read-only: today's count so far for `vendor` (0 if no row yet). Never reserves. */
export async function currentCount(db, { vendor, day = todayUtc() } = {}) {
  try {
    const row = await db.prepare(`SELECT count FROM vendor_request_counters WHERE vendor = ? AND day = ?`).bind(vendor, day).first();
    return row?.count ?? 0;
  } catch (err) {
    throw new VendorError(vendor, `rate limiter read failed: ${err.message}`);
  }
}
