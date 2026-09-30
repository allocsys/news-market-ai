-- positions.entry_price_source / entry_price_bar_ts: where the entry fill price came from
-- (graph/price_resolution.js#resolveCurrentPrice at open time).
--   entry_price_source: 'intraday' (latest closed 5m bar) or 'daily' (last daily close fallback).
--   entry_price_bar_ts: that bar's identity -- the intraday bar's ts (ISO), or the daily bar's date.
-- Lets analysis separate fills priced off a live intraday bar from fills priced off a stale
-- daily close (off-hours news can get a close up to 5 days old). Provenance only: nothing
-- reads these for trading decisions yet. NULL on rows opened before this migration.
ALTER TABLE positions ADD COLUMN entry_price_source TEXT;
ALTER TABLE positions ADD COLUMN entry_price_bar_ts TEXT;
