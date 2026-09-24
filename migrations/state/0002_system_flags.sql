-- Operator pause switches (dashboard /dashboard/controls). One row per switch
-- (ingestion, trading, llm, backtests). A missing row means NOT paused, so
-- this table starts empty. Applied to LIVE_DB and SIM_DB alike (both use
-- migrations/state/); only LIVE_DB's copy is ever read.
CREATE TABLE IF NOT EXISTS system_flags (
  key        TEXT PRIMARY KEY,
  paused     INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  updated_by TEXT
);
