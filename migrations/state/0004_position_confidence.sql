-- positions.confidence: the DebateVerdict confidence the position was opened
-- with (0..1). Read by RunStore#commitThesis's hold/flip rule (P3) so a later
-- thesis for the same ticker can be judged against it inside the atomic batch.
-- Nullable: rows opened before this migration, and the low-level openPosition
-- path, have none (treated as "unknown" -> never blocks a replacement).
-- Also new close_reason value 'flipped' (opposite-direction replacement);
-- the column is free text so nothing to alter, see 0001_init.sql's comment.
ALTER TABLE positions ADD COLUMN confidence REAL;
