-- Live-tunable break-even / trailing knobs (storage/live_knobs.js).
--
-- system_flags.value: a numeric payload for rows that are not on/off switches. Pause, ticker and
-- macro rows leave it NULL. Knob rows use key `knob:<configKey>` and the value is the knob. A knob row
-- is read in the SAME single `SELECT ... FROM system_flags` the pause flags already use (no extra D1
-- read per batch). No row = no live override: the env/config default applies.
ALTER TABLE system_flags ADD COLUMN value REAL;

-- positions.trail_knobs: SNAPSHOT of the effective break-even/trailing knobs taken when the position
-- OPENED, as JSON {breakEvenTriggerR, trailActivationR, trailDistanceR, trailRemovesTarget} (all four
-- always written, zeros included, so a position opened with the feature OFF stays OFF when a knob is
-- later switched on). The exit walk uses the position's own snapshot, so changing a live knob affects
-- only positions opened afterwards. NULL = opened before this migration: it falls back to the config.
ALTER TABLE positions ADD COLUMN trail_knobs TEXT;
