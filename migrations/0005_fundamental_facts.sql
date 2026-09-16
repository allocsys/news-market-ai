-- Fundamental facts (plan.md Backtesting Integrity, point 3: point-in-time
-- fundamentals). See src/storage/d1.js's insertFundamentalFact /
-- getFundamentalFactsAsOf for the access layer,
-- src/ingestion/sources/edgar_fundamentals.js for the adapter, and
-- src/ingestion/market_data_validator.js#validateFundamentalFact for the
-- sanity check every fact passes before insertion.
--
-- One row per (ticker, tag, fiscal_year, fiscal_period, form) -- NOT one
-- row per (ticker, tag, fiscal_year, fiscal_period). A restated value (a
-- later 10-K/A for a period SEC EDGAR already reported via the original
-- 10-K) is a SEPARATE row with a later filed_at, not an update to the
-- original -- this is what lets getFundamentalFactsAsOf reconstruct "what
-- was the best known value for this period at time T" by picking the
-- latest filed_at <= T per (ticker, tag, fiscal_year, fiscal_period),
-- rather than only ever having today's (possibly restated) figure.
CREATE TABLE fundamental_facts (
  ticker         TEXT NOT NULL,
  cik            TEXT NOT NULL,
  tag            TEXT NOT NULL,   -- XBRL us-gaap concept, e.g. "Revenues"
  val            REAL NOT NULL,
  unit           TEXT NOT NULL,
  fiscal_year    INTEGER NOT NULL,
  fiscal_period  TEXT NOT NULL,   -- "FY", "Q1".."Q4"
  form           TEXT NOT NULL,   -- "10-K", "10-Q", "10-K/A", ...
  filed_at       TEXT NOT NULL,   -- ISO8601 UTC -- when this fact became public
  source         TEXT NOT NULL,
  ingested_at    TEXT NOT NULL,
  PRIMARY KEY (ticker, tag, fiscal_year, fiscal_period, form)
);
CREATE INDEX idx_fundamental_facts_lookup ON fundamental_facts(ticker, tag, filed_at);
