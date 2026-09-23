-- inputs DB: persisted per-vendor daily request counters.
-- See plan.md finding G step 1: "Rate limiting: token-bucket/counter per
-- vendor, persisted in D1 (not in-memory), checked before each fetch; live
-- candle fetching shares same budget/counter as backfill so they can't
-- double-spend the daily cap."
--
-- Why D1 and not shared/throttle.js: throttle.js only paces calls *within
-- one Worker invocation's loop* (see that file's header) -- it has no memory
-- across separate invocations, so it cannot enforce a whole-day cap like
-- Twelve Data free Basic's 800 requests/day, split across a scheduled
-- backfill tick AND live candle fetches that both run as separate
-- invocations. This table is that shared memory.
--
-- One row per (vendor, day); `count` is incremented atomically per request
-- via `UPDATE ... SET count = count + 1 WHERE vendor = ? AND day = ?`
-- (see shared/d1_rate_limiter.js), falling back to an INSERT when the row
-- doesn't exist yet for that day. `day` is UTC YYYY-MM-DD, matching every
-- other day-boundary convention in this schema (intraday_backfill_status.date,
-- price_bars.date).
CREATE TABLE vendor_request_counters (
  vendor  TEXT NOT NULL,
  day     TEXT NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (vendor, day)
);
