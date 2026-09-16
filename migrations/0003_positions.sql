-- Positions ledger (plan.md open item: "wire a real portfolio/positions
-- store so portfolio_manager.js's openPositionsRiskPct placeholder becomes
-- a real read instead of 0"). See src/storage/d1.js's openPosition /
-- closePosition / getOpenPositionsRiskPctAsOf for the access layer.
--
-- HONEST SCOPE: this is a signal-generation pipeline, not a broker
-- integration -- there is no fill/execution confirmation, so opened_at is
-- the timestamp portfolio_manager approved the trade (the thesis's asOf),
-- not a real fill time. closed_at has a write path (closePosition) but
-- nothing calls it yet -- exit logic (stop-loss/take-profit/time-based) is
-- a separate open item, same honest-gap convention as the trade_decisions/
-- debates/analyst_opinions tables in 0001_init.sql, which also have no
-- write path wired yet.
CREATE TABLE positions (
  id                 TEXT PRIMARY KEY,   -- trade_thesis_id (ticker|asOf) -- lets a checkpoint-resumed run's portfolio_checked stage re-run without double-opening the same position
  ticker             TEXT NOT NULL,
  trade_thesis_id    TEXT NOT NULL,
  position_size_pct  REAL NOT NULL,
  opened_at          TEXT NOT NULL,
  closed_at          TEXT
);
CREATE INDEX idx_positions_open ON positions(opened_at, closed_at);
