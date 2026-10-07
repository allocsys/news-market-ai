-- inputs DB: point-in-time macro series for XAUUSD (FRED/ALFRED + CFTC COT).
--
-- Why a new table instead of fundamental_facts: that table is shaped for SEC
-- filings (NOT NULL fiscal_year/fiscal_period/form, unique on those), which
-- has no honest mapping for a daily yield or a weekly positioning report, and
-- its row count/last-ingested time drive the Health tab's "Fundamentals"
-- freshness check -- mixing macro rows in would hide a stale EDGAR feed.
--
-- One row per (series, obs_date, available_at):
--   series       FRED series id (DFII10, DTWEXBGS, DFF, T10YIE, CPIAUCSL) or a
--                COT_GC_* id (see ingestion/sources/cftc_cot.js).
--   obs_date     YYYY-MM-DD the value describes (COT: the Tuesday as-of date).
--   available_at ISO-8601 UTC: the first instant a reader may use the value.
--                FRED: the start of the day AFTER the vintage's realtime_start
--                (same next-UTC-day rule as daily price bars, see
--                shared/price_availability.js). COT: Saturday 00:00Z after the
--                Friday release (or later, when first seen later).
--   val          the number. Missing observations (FRED ".") are never stored.
-- A revised value is a NEW row (same obs_date, later available_at), so
-- getMacroSnapshotAsOf can return what was believed at any past asOf.
CREATE TABLE macro_observations (
  series       TEXT NOT NULL,
  obs_date     TEXT NOT NULL,
  available_at TEXT NOT NULL,
  val          REAL NOT NULL,
  source       TEXT NOT NULL,
  ingested_at  TEXT NOT NULL,
  PRIMARY KEY (series, obs_date, available_at)
);

-- The snapshot read bounds by obs_date (recent window) per series.
CREATE INDEX idx_macro_series_obs_date ON macro_observations (series, obs_date);
