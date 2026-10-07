// Which ingestion sources can even apply to the tickers the live pipeline runs.
// Used by the Health and Overview views so a source that has nothing to do is
// shown as "not applicable" instead of "stale".

// Tickers EDGAR has no filer (CIK) for, so no fundamentals are ever ingested
// for them: spot gold. Keep in step with the backend's EDGAR lookup.
const NO_EDGAR_TICKERS = new Set(["XAUUSD"]);

/**
 * True when at least one active ticker has EDGAR fundamentals. An unknown
 * selection (still loading, or the read failed) counts as applicable, so the
 * existing stale warning is never hidden by a missing answer.
 */
export function hasEdgarTicker(active: string[] | null | undefined): boolean {
  if (!active) return true;
  return active.some((t) => !NO_EDGAR_TICKERS.has(t.toUpperCase()));
}
