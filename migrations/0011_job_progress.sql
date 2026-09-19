-- Live progress for operator-triggered long-running jobs (POST /backfill and
-- POST /backtest/run). Before this table the dashboard could only say "run
-- accepted, check back in a minute": a backfill left no record at all, and a
-- backtest's only record (backtest_runs) has a status but no progress.
--
-- One row per job, keyed by the SAME id the route returns and the queue
-- message carries (so for a backtest it is also backtest_runs.id, which
-- stays the store for the run's actual results -- this table only tracks
-- progress). Lifecycle:
--   'queued'   inserted by `backend` at enqueue time, before the message is sent
--   'running'  set by the queue consumer (`backend` for backfill, `llm` for
--              backtest) when it picks the message up, then updated as it goes
--   'complete' / 'failed'  terminal; `result` / `error` populated
--
-- `percent` is the consumer's own 0-100 estimate (each job type maps its
-- phases onto it -- see src/storage/jobs.js's header); `phase`/`done`/`total`/
-- `detail` describe the current phase for display. `updated_at` doubles as a
-- liveness signal: a 'running' row whose updated_at stops moving is a job
-- whose consumer died mid-run (the dashboard flags that as stalled).
--
-- `params`/`result` are JSON text, same convention as backtest_runs and
-- trade_decisions -- nothing queries inside them.
--
-- Writes are best-effort by design (src/storage/jobs.js): a failed progress
-- write must never fail, retry, or double-run the job it is describing.
CREATE TABLE job_progress (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,          -- 'backfill' | 'backtest'
  status TEXT NOT NULL,        -- 'queued' | 'running' | 'complete' | 'failed'
  phase TEXT,                  -- e.g. 'fetching' | 'saving' | 'simulating'
  percent INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,    -- steps finished in the current phase
  total INTEGER NOT NULL DEFAULT 0,   -- steps in the current phase (0 = unknown)
  detail TEXT,                 -- human-readable current step
  params TEXT,                 -- JSON: what was requested
  result TEXT,                 -- JSON summary, only when status = 'complete'
  error TEXT,                  -- only when status = 'failed'
  created_at TEXT NOT NULL,
  started_at TEXT,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX idx_job_progress_created_at ON job_progress (created_at DESC);
