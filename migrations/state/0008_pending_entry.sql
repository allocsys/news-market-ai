-- trade_decisions.fill_expires_at: deadline for a 'pending_entry' decision.
-- An approved thesis whose entry price is stale (off-hours, holiday, no fresh intraday bar) is
-- stored as a decision with status 'pending_entry' and NO position. A fill step opens the position
-- at the OPEN of the first bar at/after the decision's as_of; if no bar fills it by this timestamp
-- the decision becomes 'skipped_no_fill'. Thesis, risk and sizing stay in the existing JSON columns,
-- so nothing else is needed to fill. NULL on every decision that is not (or never was) pending.
ALTER TABLE trade_decisions ADD COLUMN fill_expires_at TEXT;

-- The fill step scans only pending rows; a partial index keeps that cheap as history grows.
CREATE INDEX idx_decisions_pending ON trade_decisions(run_id, as_of) WHERE status = 'pending_entry';
