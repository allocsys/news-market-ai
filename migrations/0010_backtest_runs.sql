-- Persists a manually-triggered backtest run (plan.md Adopted Pattern #6,
-- "signal on/off comparison"). Previously src/backtest/*.js was a pure
-- computation library with no persisted output at all -- src/dashboard.js's
-- #backtest section (before this migration's companion PR) just said "not
-- shown yet". One row per POST /backtest/run call (src/index.js): inserted
-- with status='running' before the (slow, LLM-calling) comparison starts,
-- then updated to 'complete' (result populated) or 'failed' (error
-- populated) once it resolves or throws. This lets the dashboard show a
-- run's outcome (or that it's still going / died) across separate requests,
-- since a single Worker invocation's response body is the only other place
-- that result would otherwise ever appear.
--
-- `tickers`/`result` are stored as JSON text, same convention as
-- trade_decisions.thesis/risk_decision/portfolio_decision
-- (migrations/0001_init.sql) -- this table has no need to query inside
-- those fields, so no reason to normalize them out.
CREATE TABLE backtest_runs (
  id TEXT PRIMARY KEY,
  tickers TEXT NOT NULL,      -- JSON array, e.g. ["AAPL","MSFT"]
  test_start TEXT NOT NULL,   -- ISO 8601 -- overall window given to compareSignalOnOffByWindow
  test_end TEXT NOT NULL,
  train_days INTEGER NOT NULL,
  test_days INTEGER NOT NULL,
  grace_days INTEGER,         -- null means "use config.maxPositionHoldDays", see onSignalRunner.js
  status TEXT NOT NULL,       -- 'running' | 'complete' | 'failed'
  result TEXT,                -- JSON: compareSignalOnOffByWindow's { perWindow, overall } -- null until complete
  error TEXT,                 -- error message -- only set when status = 'failed'
  started_at TEXT NOT NULL,
  finished_at TEXT            -- null while status = 'running'
);

-- Dashboard reads "most recent N runs" -- see getRecentBacktestRuns.
CREATE INDEX idx_backtest_runs_started_at ON backtest_runs (started_at DESC);
