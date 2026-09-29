-- positions.mae_pct / positions.mfe_pct: maximum adverse / favorable excursion
-- of a position, as a GROSS direction-aware return vs entry_price (same sign
-- convention as shared/returns.js#computeGrossReturn: positive = winning).
--   mae_pct <= 0  worst return seen while the position was open
--   mfe_pct >= 0  best return seen while the position was open
-- Both include a 0 baseline (entry itself), so a position that only ever went
-- up has mae_pct = 0. Written by RunStore#recordPositionExcursion from
-- graph/exit_check.js on each exit check (only while closed_at IS NULL).
-- Nullable: NULL means "never sampled" (rows opened before this migration, no
-- entry price / direction, or no usable price at any check) -- distinct from a
-- sampled 0. HONEST SCOPE: sampled at exit-check cadence from one resolved
-- price (intraday bar or daily close), NOT true intrabar highs/lows, so these
-- understate the real extremes.
ALTER TABLE positions ADD COLUMN mae_pct REAL;
ALTER TABLE positions ADD COLUMN mfe_pct REAL;
