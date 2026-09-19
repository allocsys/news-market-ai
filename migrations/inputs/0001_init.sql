-- inputs DB: news, price, and fundamentals data. Shared across every
-- environment (live + every backtest run), written only by `ingest`
-- (`backend` too until the Step 5 backfill-mover gap closes -- see
-- plan.md). Every read is point-in-time via the existing asOf/range
-- filters in storage/inputs_view.js (ported unchanged from storage/d1.js).
--
-- This is old migrations/0001_init.sql's news_items/news_item_revisions/
-- news_item_tickers, plus old 0004_price_bars.sql and 0005_fundamental_
-- facts.sql, unchanged. Their per-table design rationale (why revisions
-- are a separate table, why fundamental_facts keys on
-- (ticker,tag,fiscal_year,fiscal_period,form) instead of overwriting
-- restated values, etc.) lives in the old migrations/000{1,4,5}_*.sql
-- files, kept in git history -- not restated here to avoid the two copies
-- drifting.
--
-- Deliberately NOT carried over from old 0001_init.sql: analyst_opinions
-- and debates. Both have no write path (see d1.js's own header on
-- insertTradeDecision: "the debates table has no write path either, same
-- previously-undiscovered gap"), so migrating them into the new split
-- would just carry two dead tables forward. Flagged in plan.md, not
-- fixed here.

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

CREATE TABLE price_bars (
  ticker       TEXT NOT NULL,
  date         TEXT NOT NULL,   -- YYYY-MM-DD, exchange-local as the vendor reports it
  open         REAL NOT NULL,
  high         REAL NOT NULL,
  low          REAL NOT NULL,
  close        REAL NOT NULL,
  volume       REAL NOT NULL,
  source       TEXT NOT NULL,
  ingested_at  TEXT NOT NULL,
  PRIMARY KEY (ticker, date)
);
CREATE INDEX idx_price_bars_ticker_date ON price_bars(ticker, date);

CREATE TABLE fundamental_facts (
  ticker         TEXT NOT NULL,
  cik            TEXT NOT NULL,
  tag            TEXT NOT NULL,
  val            REAL NOT NULL,
  unit           TEXT NOT NULL,
  fiscal_year    INTEGER NOT NULL,
  fiscal_period  TEXT NOT NULL,
  form           TEXT NOT NULL,
  filed_at       TEXT NOT NULL,
  source         TEXT NOT NULL,
  ingested_at    TEXT NOT NULL,
  PRIMARY KEY (ticker, tag, fiscal_year, fiscal_period, form)
);
CREATE INDEX idx_fundamental_facts_lookup ON fundamental_facts(ticker, tag, filed_at);
