-- Backtest pause/resume + daily quota ledger. Sim-only, same as 0001/0002 --
-- never applied to LIVE_DB. Additive only (0001/0002 already ran in prod).
--
-- backtest_runs gains the fields a PAUSED run needs. status itself has no
-- CHECK constraint (free text), so the new 'paused' value needs no schema
-- change. A run's continuation cursor ({clockNow, phase, window, walk, stall,
-- completed, skipped}) otherwise lives only in the queue message, which can
-- expire on the Free plan; persisting it here is what makes a pause that
-- outlasts the queue's message retention resumable.
--   cursor        JSON text of the cursor to continue from (NULL unless paused)
--   paused_reason why it paused: 'operator' | 'd1_write_budget' |
--                 'gemini_daily_cap' | 'platform_limit' | 'quota_threshold'
--   paused_at     ISO timestamp of the pause
--   resume_after  ISO timestamp when the limiting quota resets (informational,
--                 shown on the dashboard; resume is manual)
ALTER TABLE backtest_runs ADD COLUMN cursor TEXT;
ALTER TABLE backtest_runs ADD COLUMN paused_reason TEXT;
ALTER TABLE backtest_runs ADD COLUMN paused_at TEXT;
ALTER TABLE backtest_runs ADD COLUMN resume_after TEXT;

-- One row per UTC day of what the backtest worker has spent against the
-- daily platform quotas it shares with live ingestion/trading. Parts run
-- strictly sequentially (queue max_concurrency 1), so each part adds its own
-- counts in the same db.batch as its backtest_runs.rows_written update.
-- Counted from D1 meta.rows_written / meta.rows_read (billing units), not
-- meta.changes. `gemini` is a JSON object {"<model>|<key label>": requests}
-- (Gemini's day rolls over at Pacific midnight; bucketed here by UTC day
-- and reconciled with the key cooldowns, see shared/cooldown.js).
CREATE TABLE IF NOT EXISTS quota_usage (
  day         TEXT PRIMARY KEY,
  d1_written  INTEGER NOT NULL DEFAULT 0,
  d1_read     INTEGER NOT NULL DEFAULT 0,
  kv_reads    INTEGER NOT NULL DEFAULT 0,
  kv_writes   INTEGER NOT NULL DEFAULT 0,
  gemini      TEXT NOT NULL DEFAULT '{}',
  updated_at  TEXT
);
