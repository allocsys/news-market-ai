-- State DB schema. Applied verbatim to BOTH `live` (run_id = 'live') and
-- `sim` (run_id = a backtest id) -- see plan.md "Design: environments".
-- This is what makes isolation structural rather than a discipline: the
-- environment id is part of every primary/unique key below, so a
-- `ticker|asOf` thesis id can no longer collide across runs, and
-- RunStore(db, runId) (src/storage/run_store.js) is the only code allowed
-- to touch these tables -- every method filters on its own runId.
--
-- Ported from the old migrations/0001,0003,0006,0007,0008,0009,0011,0012
-- (see git history for the original per-column rationale, not restated
-- here). analyst_opinions/debates are dropped (see migrations/inputs/
-- 0001_init.sql's header -- no write path, not carried into the split).
--
-- NAMING: two of these tables already had a column named `run_id` BEFORE
-- this split, meaning a per-execution PIPELINE run (e.g. one news item's
-- trip through the agent graph), not an ENVIRONMENT. To avoid silently
-- conflating the two:
--   * pipeline_checkpoints keeps that column, renamed to `pipeline_run_id`
--     for clarity, and gets a NEW `run_id` column for the environment.
--   * llm_calls keeps its existing `run_id` (pipeline run, nullable, used
--     to group every call belonging to one decision) UNCHANGED, and gets
--     a NEW `env_run_id` column for the environment instead of reusing
--     the name.
-- Every other table here had no pre-existing `run_id`, so `run_id` on
-- those columns unambiguously means the environment.

CREATE TABLE positions (
  run_id             TEXT NOT NULL,
  id                 TEXT NOT NULL,   -- trade_thesis_id (ticker|asOf)
  ticker             TEXT NOT NULL,
  trade_thesis_id    TEXT NOT NULL,
  position_size_pct  REAL NOT NULL,
  direction          TEXT,
  entry_price        REAL,
  stop_loss_pct      REAL,
  take_profit_pct    REAL,
  exit_price         REAL,
  close_reason       TEXT,           -- 'stop_loss' | 'take_profit' | 'time_based' | 'replaced'
  opened_at          TEXT NOT NULL,
  closed_at          TEXT,
  PRIMARY KEY (run_id, id)
);
CREATE INDEX idx_positions_open ON positions(run_id, opened_at, closed_at);
-- Backstop for the atomic commitThesis batch (plan.md "Atomic portfolio
-- commit"): a bug in the batch's own WHERE-predicate guard fails loudly
-- here instead of silently double-opening a position for the same ticker.
CREATE UNIQUE INDEX idx_positions_one_open_per_ticker
  ON positions(run_id, ticker) WHERE closed_at IS NULL;

CREATE TABLE trade_decisions (
  run_id             TEXT NOT NULL,
  id                 TEXT NOT NULL,   -- trade_thesis_id (ticker|asOf)
  ticker             TEXT NOT NULL,
  as_of              TEXT NOT NULL,
  debate_id          TEXT,            -- no FK: debates table dropped (no write path), see header
  thesis             TEXT NOT NULL,   -- JSON TradeThesis
  risk_decision      TEXT NOT NULL,   -- JSON RiskDecision
  portfolio_decision TEXT,            -- JSON PortfolioDecision
  status             TEXT NOT NULL,   -- 'proposed' | 'approved' | 'rejected' | ... (see commitThesis outcomes)
  opinions           TEXT,            -- JSON array of AnalystOpinion
  debate             TEXT,            -- JSON DebateVerdict
  created_at         TEXT NOT NULL,
  PRIMARY KEY (run_id, id)
);
CREATE INDEX idx_decisions_ticker_as_of ON trade_decisions(run_id, ticker, as_of);

CREATE TABLE decision_memory (
  run_id            TEXT NOT NULL,
  id                TEXT NOT NULL,
  decision_id       TEXT NOT NULL,   -- trade_decisions.id within the same run_id; no FK (composite key, see header)
  ticker            TEXT NOT NULL,
  realized_return   REAL,
  alpha_return      REAL,
  reflection        TEXT,
  resolved_at       TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  PRIMARY KEY (run_id, id)
);
CREATE INDEX idx_memory_ticker_resolved ON decision_memory(run_id, ticker, resolved_at);

-- pipeline_checkpoints: run_id (environment) is NEW; pipeline_run_id is the
-- renamed original `run_id` (one per-ticker pipeline execution -- see
-- header). Primary key grows from (run_id, ticker) to
-- (run_id, pipeline_run_id, ticker) accordingly.
CREATE TABLE pipeline_checkpoints (
  run_id           TEXT NOT NULL,
  pipeline_run_id  TEXT NOT NULL,
  ticker           TEXT NOT NULL,
  stage            TEXT NOT NULL,
  state            TEXT,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (run_id, pipeline_run_id, ticker)
);
CREATE INDEX idx_checkpoints_run ON pipeline_checkpoints(run_id, pipeline_run_id);

-- llm_calls: env_run_id (environment) is NEW; run_id keeps its original
-- meaning (pipeline run, nullable) -- see header.
CREATE TABLE llm_calls (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  env_run_id      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  source          TEXT NOT NULL,     -- 'pipeline' | 'backtest' | 'exit_check'
  job_id          TEXT,
  run_id          TEXT,              -- pipeline runId, NOT the environment -- see header
  ticker          TEXT,
  label           TEXT NOT NULL,
  requested_model TEXT,
  model_used      TEXT,
  key_index       INTEGER,
  status          TEXT NOT NULL,     -- 'ok' | 'error'
  error_stage     TEXT,
  error           TEXT,
  duration_ms     INTEGER,
  attempts        TEXT,
  prompt          TEXT,
  response        TEXT,
  prompt_chars    INTEGER NOT NULL DEFAULT 0,
  response_chars  INTEGER NOT NULL DEFAULT 0,
  truncated       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_llm_calls_env_created_at ON llm_calls (env_run_id, created_at);
CREATE INDEX idx_llm_calls_job_id ON llm_calls (env_run_id, job_id, id);
CREATE INDEX idx_llm_calls_run_id ON llm_calls (env_run_id, run_id, id);

CREATE TABLE job_progress (
  run_id       TEXT NOT NULL,
  id           TEXT NOT NULL,
  type         TEXT NOT NULL,        -- 'backfill' | 'backtest'
  status       TEXT NOT NULL,        -- 'queued' | 'running' | 'complete' | 'failed'
  phase        TEXT,
  percent      INTEGER NOT NULL DEFAULT 0,
  done         INTEGER NOT NULL DEFAULT 0,
  total        INTEGER NOT NULL DEFAULT 0,
  detail       TEXT,
  params       TEXT,
  result       TEXT,
  error        TEXT,
  created_at   TEXT NOT NULL,
  started_at   TEXT,
  updated_at   TEXT NOT NULL,
  finished_at  TEXT,
  PRIMARY KEY (run_id, id)
);
CREATE INDEX idx_job_progress_created_at ON job_progress (run_id, created_at DESC);
