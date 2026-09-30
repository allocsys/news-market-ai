// Entry timing for the next-session-open fill (PR 3). Pure functions, no I/O.
//
// An approved thesis is normally opened at resolveCurrentPrice's price (graph/price_resolution.js).
// That price is only a real "now" while a fresh intraday bar exists. Off-hours news gets the last
// close, up to 5 days old, and a position opened there starts with a fill nobody could have traded.
// So a stale entry price does not open a position: the decision waits as 'pending_entry' and fills
// at the OPEN of the first bar that starts at/after its asOf -- the first price after the news that a
// real order could have got.
//
// Staleness is decided from the data (how old the newest visible intraday bar is), not from a
// market-hours calendar: holidays, early closes, DST and extended-hours sessions are already
// reflected in which bars exist. A false "stale" (ingestion lag) only delays the fill to the next
// bar's open, it never invents a price.

import { INTRADAY_BAR_MS, intradayBarAvailableAt } from "./intraday_availability.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A visible intraday bar older than this (since it closed) is not "the current price". */
export const ENTRY_FRESH_MAX_AGE_MS = 30 * 60 * 1000;

/** A pending entry that no bar fills within this long after its asOf expires (same bound as INTRADAY_MAX_AGE_MS). */
export const PENDING_ENTRY_EXPIRY_MS = 5 * DAY_MS;

/**
 * Is the resolved entry price too stale to fill at? `resolved` is resolveCurrentPrice's
 * `{ price, source, bar }`. Only a fresh INTRADAY bar counts as current: a daily-close fallback is
 * always stale, and so is "no price" (callers treat a null price separately, as no-price-data).
 * An intraday bar whose ts does not parse is stale, never fresh.
 */
export function isEntryPriceStale(resolved, asOf, { maxAgeMs = ENTRY_FRESH_MAX_AGE_MS } = {}) {
  if (!resolved || resolved.source !== "intraday" || !resolved.bar) return true;
  const asOfMs = Date.parse(asOf);
  if (Number.isNaN(asOfMs)) return true;
  let closedMs;
  try {
    closedMs = Date.parse(intradayBarAvailableAt(resolved.bar.ts));
  } catch {
    return true;
  }
  if (Number.isNaN(closedMs)) return true;
  return asOfMs - closedMs > maxAgeMs;
}

/** ISO deadline for a pending entry decided at `asOf`; null when asOf does not parse. */
export function pendingEntryExpiresAt(asOf, { expiryMs = PENDING_ENTRY_EXPIRY_MS } = {}) {
  const ms = Date.parse(asOf);
  return Number.isNaN(ms) ? null : new Date(ms + expiryMs).toISOString();
}

/**
 * The bar to fill a pending entry at: the first bar in `sequence` (shared/bar_window.js#buildBarSequence
 * output, chronological, already limited to bars closed by the caller's asOf) whose OPEN is at or after
 * `asOf`. Bars that opened before asOf are never used -- the decision did not exist yet, and the bar
 * straddling asOf holds prices from before it. Returns
 * `{ price, source, barTs, openedAt }` or null when no such bar has closed yet (keep waiting).
 *   price    -- the bar's open.
 *   source   -- 'intraday' | 'daily' (provenance for positions.entry_price_source).
 *   barTs    -- the bar's identity for positions.entry_price_bar_ts (intraday ts, or daily date).
 *   openedAt -- the bar's open instant, ms ISO (positions.opened_at).
 * A bar with a non-finite or non-positive open is skipped, never filled at.
 */
export function findFillBar(sequence, asOf) {
  const asOfMs = Date.parse(asOf);
  if (Number.isNaN(asOfMs)) return null;
  for (const bar of sequence ?? []) {
    if (!(bar.openMs >= asOfMs)) continue;
    if (!Number.isFinite(bar.open) || bar.open <= 0) continue;
    const openedAt = new Date(bar.openMs).toISOString();
    return {
      price: bar.open,
      source: bar.kind,
      barTs: bar.kind === "daily" ? openedAt.slice(0, 10) : `${openedAt.slice(0, 19)}Z`,
      openedAt,
    };
  }
  return null;
}

/** Has a pending entry run out of time at `now`? An unparseable deadline counts as expired (never pending forever). */
export function isPendingEntryExpired(fillExpiresAt, now) {
  const exp = Date.parse(fillExpiresAt);
  const nowMs = Date.parse(now);
  if (Number.isNaN(exp) || Number.isNaN(nowMs)) return true;
  return nowMs >= exp;
}

export { INTRADAY_BAR_MS };
