// Which ingestion sources can even apply to the tickers the live pipeline runs.
// Used by the Health and Overview views so a source that has nothing to do is
// shown as "not applicable" (or "disabled") instead of "stale".

// Tickers EDGAR has no filer (CIK) for, so no fundamentals are ever ingested
// for them: spot gold. Keep in step with the backend's EDGAR lookup.
const NO_EDGAR_TICKERS = new Set(["XAUUSD"]);

// The only ticker the macro context (FRED + COT) is ingested for. Keep in step
// with MACRO_TICKER in the backend's ingest.js.
export const MACRO_TICKER = "XAUUSD";

/** What a health row shows. Only "fresh" and "stale" count toward "N/M fresh". */
export type SourceState = "fresh" | "stale" | "na" | "off";

/**
 * The active-ticker list from a /api/active-tickers answer, or null when it is
 * not usable (still loading, request failed, or the backend reported an error).
 * Null means "unknown", which the helpers below treat as applicable.
 */
export function activeOrNull(
  res: { active?: string[] | null; error?: string | null } | null | undefined,
): string[] | null {
  if (!res || res.error || !Array.isArray(res.active)) return null;
  return res.active;
}

/**
 * True when at least one active ticker has EDGAR fundamentals. An unknown
 * selection (still loading, or the read failed) counts as applicable, so the
 * existing stale warning is never hidden by a missing answer.
 */
export function hasEdgarTicker(active: string[] | null | undefined): boolean {
  if (!active) return true;
  return active.some((t) => !NO_EDGAR_TICKERS.has(t.toUpperCase()));
}

/** True when the macro ticker is active. Unknown selection counts as applicable. */
export function hasMacroTicker(active: string[] | null | undefined): boolean {
  if (!active) return true;
  return active.some((t) => t.toUpperCase() === MACRO_TICKER);
}
