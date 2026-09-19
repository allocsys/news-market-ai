-- One row per LLM call (every agents/utils/structured.js#callStructured), so
-- the dashboard's "LLM calls" page can show exactly what went to Gemini and
-- what came back -- for the automatic pipeline (ANALYZE consumer), manual
-- backtests, and the exit-check reflections alike. Before this table the only
-- traces of an LLM call were the PARSED results folded into
-- trade_decisions.opinions/debate (migrations/0008) and the opaque
-- pipeline_checkpoints JSON: never the prompt, never the raw response, and
-- nothing at all for a call that failed or returned unparseable JSON.
--
-- Written by the `llm` Worker only (best-effort -- see src/storage/llm_calls.js:
-- a failed log write never fails the call it describes); read by `backend`'s
-- /api/llm-calls for the dashboard.
--
-- source:  'pipeline'   live ANALYZE consumer (news item -> decision)
--          'backtest'   a manual backtest run (job_id = backtest_runs.id /
--                       job_progress.id) -- includes the exit-check
--                       reflections that run inside the backtest walk
--          'exit_check' the scheduled live exit check's reflections
-- run_id:  runPipelineForTicker's runId -- the news item id for live runs,
--          "<window start>|<ticker>|<news item id>" for backtests -- so every
--          call belonging to ONE decision can be pulled up together.
--
-- prompt/response are stored verbatim up to LLM_LOG_MAX_CHARS each;
-- `truncated` = 1 means at least one was clipped, prompt_chars/response_chars
-- keep the true lengths. `attempts` is the JSON cascade trace (every
-- model/key tried, incl. cooldown skips and 429/503s), which is how a call
-- that "succeeded" only after falling back is visible. `error_stage` says
-- where a failed call died: 'vendor' (Gemini/cascade), 'parse' (not JSON) or
-- 'validation' (JSON that failed the agent's zod schema).
--
-- WRITE COST: D1 counts index writes as rows written, so each call costs
-- ~4 rows written (table + 3 indexes) against the free tier's 100K/day. Kept
-- to the three indexes the page/pruning actually need; rows older than
-- LLM_LOG_RETENTION_DAYS (default 14) are pruned by the exit-check tick, and
-- LLM_LOG_ENABLED="false" turns logging off entirely.
CREATE TABLE llm_calls (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at      TEXT NOT NULL,
  source          TEXT NOT NULL,     -- 'pipeline' | 'backtest' | 'exit_check'
  job_id          TEXT,              -- backtest job id; null for live calls
  run_id          TEXT,              -- pipeline runId; null for reflections outside a run
  ticker          TEXT,
  label           TEXT NOT NULL,     -- e.g. 'analyst:news_event', 'debate:judge', 'trader', 'reflection'
  requested_model TEXT,
  model_used      TEXT,              -- differs from requested_model when the cascade fell back
  key_index       INTEGER,
  status          TEXT NOT NULL,     -- 'ok' | 'error'
  error_stage     TEXT,              -- 'vendor' | 'parse' | 'validation' -- only when status = 'error'
  error           TEXT,
  duration_ms     INTEGER,
  attempts        TEXT,              -- JSON array of cascade attempts
  prompt          TEXT,
  response        TEXT,              -- raw model text, before fence-stripping/parsing; null if the call never returned
  prompt_chars    INTEGER NOT NULL DEFAULT 0,
  response_chars  INTEGER NOT NULL DEFAULT 0,
  truncated       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_llm_calls_created_at ON llm_calls (created_at);   -- retention pruning
CREATE INDEX idx_llm_calls_job_id ON llm_calls (job_id, id);       -- "all calls of this backtest"
CREATE INDEX idx_llm_calls_run_id ON llm_calls (run_id, id);       -- "all calls of this decision"
