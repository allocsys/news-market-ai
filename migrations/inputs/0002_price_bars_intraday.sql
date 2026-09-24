-- inputs DB: intraday price bars + gradual-backfill tracking.
-- See plan.md, "Next steps: make backtests trustworthy" -> finding G, step 1.
--
-- Kept as its own table rather than widening `price_bars` (daily, see
-- 0001_init.sql): different granularity, retention and write volume, and
-- every existing daily reader (getPriceBarsAsOf, getPriceBarsInRange, the
-- technical analyst) stays untouched.
--
-- Vendor split (plan.md, decided 2026-09-23): Alpaca for AAPL/MSFT/TSLA/USO
-- (USO is a US-listed equity ETF, not forex), Twelve Data free Basic for
-- XAUUSD only. `source` on each row records which vendor produced it, same
-- convention as `price_bars.source`.
--
-- Retention: rolling 4-6 month window, enforced by a scheduled purge (not
-- part of this migration -- see plan.md step 6). Once a day's bars age out,
-- getIntradayPriceAsOf (step 3) returns nothing for it and the pipeline
-- falls back to the daily close, per Adopted Pattern #11.

CREATE TABLE price_bars_intraday (
  ticker       TEXT NOT NULL,
  ts           TEXT NOT NULL,   -- ISO 8601 UTC timestamp of the bar's OPEN (start) time, canonical YYYY-MM-DDTHH:MM:SSZ, not a calendar day; visible to readers only once the bar has closed (ts + 5 min), see shared/intraday_availability.js
  open         REAL NOT NULL,
  high         REAL NOT NULL,
  low          REAL NOT NULL,
  close        REAL NOT NULL,
  volume       REAL NOT NULL,
  source       TEXT NOT NULL,   -- 'alpaca' | 'twelvedata'
  ingested_at  TEXT NOT NULL,
  PRIMARY KEY (ticker, ts)
);
CREATE INDEX idx_price_bars_intraday_ticker_ts ON price_bars_intraday(ticker, ts);

-- Tracks gradual backfill progress per (ticker, day) so a cron-driven Worker
-- tick can resume exactly where it left off instead of re-fetching or
-- silently skipping gaps -- same self-continuing-parts shape as the existing
-- news backfill (POST /backfill). One row per (ticker, date); `vendor`
-- records which of the two vendors owns that ticker (see split above, fixed
-- per ticker, not expected to change row-to-row, but kept explicit rather
-- than inferred so a status query never has to know the routing rule).
CREATE TABLE intraday_backfill_status (
  ticker        TEXT NOT NULL,
  date          TEXT NOT NULL,   -- YYYY-MM-DD, UTC
  vendor        TEXT NOT NULL,   -- 'alpaca' | 'twelvedata'
  status        TEXT NOT NULL,   -- 'pending' | 'in_progress' | 'done' | 'failed'
  last_attempt  TEXT,            -- ISO 8601 UTC, null until first attempt
  error         TEXT,            -- last error message, if status = 'failed'
  PRIMARY KEY (ticker, date)
);
CREATE INDEX idx_intraday_backfill_status_status ON intraday_backfill_status(status);
