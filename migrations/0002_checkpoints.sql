-- Backs graph/checkpointer.js (plan.md Adopted Pattern #12: checkpoint/
-- resume for multi-agent runs). Chosen on D1 rather than KV: checkpoint
-- writes happen per pipeline stage per ticker per run, which can exceed
-- KV's 1K writes/day free-tier cap reserved for LLM cooldown state (see
-- plan.md "Deployment" section) -- D1's 100K rows-written/day budget has
-- much more headroom for this write pattern.
--
-- One row per (run_id, ticker): `stage` records the last COMPLETED stage,
-- so a resumed run knows to start at the next one rather than re-spending
-- LLM calls on stages that already succeeded.
CREATE TABLE pipeline_checkpoints (
  run_id      TEXT NOT NULL,
  ticker      TEXT NOT NULL,
  stage       TEXT NOT NULL,   -- e.g. 'ingested' | 'analyzed' | 'debated' | 'traded' | 'risk_checked' | 'portfolio_checked'
  state       TEXT,            -- JSON snapshot of stage output, so resume doesn't re-fetch/re-call the LLM
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (run_id, ticker)
);
CREATE INDEX idx_checkpoints_run ON pipeline_checkpoints(run_id);
