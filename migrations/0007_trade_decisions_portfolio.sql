-- trade_decisions (migrations/0001_init.sql) already has columns for
-- `thesis` (TradeThesis JSON) and `risk_decision` (RiskDecision JSON), but
-- no column for PortfolioDecision -- the final go/no-go sign-off produced by
-- agents/managers/portfolio_manager.js (plan.md Adopted Pattern #3: risk
-- sizing and final execution approval are deliberately separate concerns).
-- Adding it here rather than reusing the risk_decision column for both JSON
-- blobs, matching the project's existing convention of a migration per new
-- column (see 0006_positions_exit_fields.sql) rather than overloading an
-- existing column's meaning.
ALTER TABLE trade_decisions ADD COLUMN portfolio_decision TEXT;
