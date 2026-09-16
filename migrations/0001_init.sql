-- Initial schema. Design notes:
--
-- * news_item_revisions is a SEPARATE table from news_items (which only
--   tracks the stable id/source/url) so we can store every edited version
--   of an article with its own published_at. This is what makes
--   getNewsAsOf() in src/storage/d1.js revision-aware instead of always
--   serving the latest live version (plan.md Backtesting Integrity, #2).
--
-- * news_item_tickers is a junction table rather than a JSON array column,
--   specifically so ticker+time queries can use a real index instead of
--   scanning/parsing JSON per row.

CREATE TABLE news_items (
  id                  TEXT PRIMARY KEY,
  source              TEXT NOT NULL,
  url                 TEXT NOT NULL,
  first_published_at  TEXT NOT NULL,
  ingested_at         TEXT NOT NULL,
  title               TEXT NOT NULL,
  body                TEXT NOT NULL,
  raw                 TEXT
);

CREATE TABLE news_item_revisions (
  news_item_id  TEXT NOT NULL REFERENCES news_items(id),
  revision      INTEGER NOT NULL,
  published_at  TEXT NOT NULL,
  ingested_at   TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  raw           TEXT,
  PRIMARY KEY (news_item_id, revision)
);
CREATE INDEX idx_revisions_published_at ON news_item_revisions(published_at);

CREATE TABLE news_item_tickers (
  news_item_id  TEXT NOT NULL REFERENCES news_items(id),
  ticker        TEXT NOT NULL,
  PRIMARY KEY (news_item_id, ticker)
);
CREATE INDEX idx_tickers_ticker ON news_item_tickers(ticker);

CREATE TABLE analyst_opinions (
  id            TEXT PRIMARY KEY,
  news_item_id  TEXT NOT NULL REFERENCES news_items(id),
  revision      INTEGER NOT NULL,
  agent         TEXT NOT NULL,   -- 'news_event' | 'sentiment' | 'technical'
  output        TEXT NOT NULL,   -- JSON, validated against schemas/index.js AnalystOpinion before insert
  model_used    TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_opinions_news_item ON analyst_opinions(news_item_id);

CREATE TABLE debates (
  id            TEXT PRIMARY KEY,
  ticker        TEXT NOT NULL,
  as_of         TEXT NOT NULL,   -- simulated (backtest) or real timestamp this debate is anchored to
  bull_output   TEXT NOT NULL,   -- JSON, DebateSide
  bear_output   TEXT NOT NULL,   -- JSON, DebateSide
  judge_output  TEXT NOT NULL,   -- JSON, DebateVerdict
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_debates_ticker_as_of ON debates(ticker, as_of);

CREATE TABLE trade_decisions (
  id             TEXT PRIMARY KEY,
  ticker         TEXT NOT NULL,
  as_of          TEXT NOT NULL,
  debate_id      TEXT REFERENCES debates(id),
  thesis         TEXT NOT NULL,  -- JSON, TradeThesis
  risk_decision  TEXT NOT NULL,  -- JSON, RiskDecision (deterministic, not LLM -- see risk_mgmt/risk.js)
  status         TEXT NOT NULL,  -- 'proposed' | 'approved' | 'rejected'
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_decisions_ticker_as_of ON trade_decisions(ticker, as_of);

-- Backs the reflection/memory loop (plan.md Adopted Pattern #8). In
-- backtest, rows here must only ever be read back for as_of values strictly
-- before the simulated "now" -- see plan.md Backtesting Integrity, point 4.
CREATE TABLE decision_memory (
  id                TEXT PRIMARY KEY,
  decision_id       TEXT NOT NULL REFERENCES trade_decisions(id),
  ticker            TEXT NOT NULL,
  realized_return   REAL,
  alpha_return      REAL,        -- return vs. benchmark
  reflection        TEXT,        -- short natural-language reflection, injected into future prompts
  resolved_at       TEXT NOT NULL,
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_memory_ticker_resolved ON decision_memory(ticker, resolved_at);
