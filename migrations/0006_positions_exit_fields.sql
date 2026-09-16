-- Adds the fields closePosition's exit logic needs (plan.md positions
-- known-gap: "closePosition has no caller yet -- exit logic doesn't exist,
-- so once opened a position stays open forever"). See src/agents/risk_mgmt/
-- exit.js#evaluateExit and src/graph/exit_check.js#checkOpenPositionExits.
--
-- direction/stop_loss_pct/take_profit_pct are copied from the TradeThesis/
-- RiskDecision that opened the position (see storage/d1.js#openPosition) so
-- exit evaluation never has to reach back through trade_thesis_id to
-- another table to know what its own thresholds were -- same
-- self-contained-row convention as fundamental_facts storing filedAt on
-- every row instead of joining out to a filings table.
--
-- entry_price is nullable ON PURPOSE: it comes from price_bars (yfinance),
-- which is not yet wired into graph/pipeline.js (separate known plan.md
-- gap). A position opened before price data exists for its ticker gets
-- entry_price = NULL, and evaluateExit's own null-check means such a
-- position can still be closed on a time-based exit, just never on
-- stop-loss/take-profit until real price data is available -- an honest
-- degradation, not a silent one.
ALTER TABLE positions ADD COLUMN direction TEXT;
ALTER TABLE positions ADD COLUMN entry_price REAL;
ALTER TABLE positions ADD COLUMN stop_loss_pct REAL;
ALTER TABLE positions ADD COLUMN take_profit_pct REAL;
ALTER TABLE positions ADD COLUMN close_reason TEXT; -- 'stop_loss' | 'take_profit' | 'time_based', set by closePosition
