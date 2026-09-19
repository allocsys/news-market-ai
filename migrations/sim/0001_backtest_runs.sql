-- sim-only: applied on top of migrations/state/ for the `sim` DB, never for
-- `live` -- this is the one table plan.md's split calls out as sim-
-- exclusive ("the same tables with run_id = backtest id, plus
-- backtest_runs (registry)"). `id` here IS the run_id every state-table row
-- for this backtest is scoped under (positions.run_id, trade_decisions.
-- run_id, etc.) -- there is deliberately no separate run_id column on this
-- table itself, `id` already serves that purpose.
--
-- Ported unchanged from the old migrations/0010_backtest_runs.sql (see git
-- history for the original per-column rationale).
CREATE TABLE backtest_runs (
  id           TEXT PRIMARY KEY,
  tickers      TEXT NOT NULL,
  test_start   TEXT NOT NULL,
  test_end     TEXT NOT NULL,
  train_days   INTEGER NOT NULL,
  test_days    INTEGER NOT NULL,
  grace_days   INTEGER,
  status       TEXT NOT NULL,        -- 'running' | 'complete' | 'failed'
  result       TEXT,
  error        TEXT,
  rows_written INTEGER NOT NULL DEFAULT 0,  -- meta.rows_written per run, for BACKTEST_DAILY_WRITE_BUDGET (plan.md)
  started_at   TEXT NOT NULL,
  finished_at  TEXT
);
CREATE INDEX idx_backtest_runs_started_at ON backtest_runs (started_at DESC);
