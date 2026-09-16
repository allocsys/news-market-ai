-- Price bars (plan.md ingestion section: yfinance price/volume data).
-- See src/storage/d1.js's insertPriceBar / getPriceBarsAsOf for the access
-- layer, src/ingestion/sources/yfinance.js for the adapter, and
-- src/ingestion/market_data_validator.js#validatePriceBar for the sanity
-- check every bar passes before insertion.
--
-- One row per (ticker, date) -- daily bars only for now, no intraday.
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
