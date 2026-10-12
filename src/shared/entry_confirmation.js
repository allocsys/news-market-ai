// Entry confirmation (decision switch `entryConfirmation`, default OFF). Pure functions, no I/O.
//
// WHY: on the BTCUSD 2026-09-11..10-11 backtests the losing entries were wrong from the first bar (MFE 0.4-1.1%). With the
// switch on, an approved entry does not open at once: the pipeline stores it as 'pending_entry' (the existing deferred-entry
// machinery, graph/entry_fill.js) with the decision price as the reference, and the fill step opens it only after a bar
// CLOSES at least `movePct` (a fraction) in the trade direction from that reference, within `hours` of the decision. The
// position then opens at the OPEN of the first bar after the confirming bar (graph/bar_fill.js, same rule as every pending
// fill, so no price that was not yet knowable is used). No confirmation by the deadline -> 'skipped_no_fill' (the existing
// expiry), with the outcome recorded in decision.debate.evidence.entryConfirmation.
//
// The rule is defined on the BAR SEQUENCE, not on when the fill step happens to run: the live exit tick (every 15 min) and
// the backtest's once-a-day tick see the same bars and reach the same answer.
//
// SCOPE: only entries that would have opened immediately (a fresh intraday price). A stale-price entry already waits for
// the next session open (shared/entry_timing.js) and is not confirmed.

import { DEFAULT_ENTRY_CONFIRM_MOVE_PCT, DEFAULT_ENTRY_CONFIRM_HOURS } from "./constants.js";

const HOUR_MS = 60 * 60 * 1000;

/** The effective `{ movePct, hours }` of a config: a missing or invalid value falls back to the constants.js default. */
export function entryConfirmationParams(config) {
  const y = config?.entryConfirmMovePct;
  const h = config?.entryConfirmHours;
  return {
    movePct: Number.isFinite(y) && y > 0 && y <= 0.2 ? y : DEFAULT_ENTRY_CONFIRM_MOVE_PCT,
    hours: Number.isFinite(h) && h >= 1 && h <= 72 ? h : DEFAULT_ENTRY_CONFIRM_HOURS,
  };
}

/** Milliseconds a confirming entry may wait (pass as `expiryMs` to entry_timing.js#pendingEntryExpiresAt). */
export function entryConfirmationExpiryMs(hours) {
  return hours * HOUR_MS;
}

/** The record stored on the pending decision (debate.evidence.entryConfirmation) when it is created. */
export function pendingConfirmationRecord({ refPrice, movePct, hours }) {
  return { status: "pending", refPrice, movePct, hours };
}

/**
 * A pending decision's stored confirmation spec, or null when it has none (a plain stale-price pending entry). The spec is
 * recognised by its numbers, NOT by status: graph/entry_fill.js writes the outcome ('confirmed' / 'expired') into the same
 * record BEFORE it commits or expires the row, and a crash in between must re-run the same confirming fill, not fall back to
 * a plain first-bar fill.
 */
export function confirmationSpecOf(pending) {
  const spec = pending?.debate?.evidence?.entryConfirmation;
  if (!spec || typeof spec !== "object") return null;
  if (!Number.isFinite(spec.refPrice) || !(spec.refPrice > 0) || !Number.isFinite(spec.movePct) || !(spec.movePct > 0)) return null;
  return spec;
}

/**
 * The first bar of `sequence` (shared/bar_window.js#buildBarSequence output: chronological, only bars already closed at the
 * caller's asOf) that confirms the entry: it opened at/after `from`, its CLOSE moved at least `movePct` in `direction` from
 * `refPrice`, and it closed before `expiresAt`. Returns `{ closedAt, close, movePct, kind }` (closedAt = the bar's close
 * instant, ISO) or null (keep waiting, or never confirmed). Bars that opened before `from` are never used: the decision did
 * not exist yet and the bar straddling `from` holds prices from before it.
 */
export function findConfirmationBar(sequence, { from, direction, refPrice, movePct, expiresAt }) {
  const fromMs = Date.parse(from);
  const expMs = Date.parse(expiresAt);
  if (Number.isNaN(fromMs) || Number.isNaN(expMs)) return null;
  if (direction !== "long" && direction !== "short") return null;
  if (!Number.isFinite(refPrice) || !(refPrice > 0) || !Number.isFinite(movePct) || !(movePct > 0)) return null;

  for (const bar of sequence ?? []) {
    if (!(bar.openMs >= fromMs)) continue;
    const closeMs = Date.parse(bar.availableAt);
    if (Number.isNaN(closeMs)) continue;
    if (closeMs >= expMs) return null; // the sequence is chronological: every later bar closes later still
    if (!Number.isFinite(bar.close) || !(bar.close > 0)) continue;
    const move = direction === "long" ? (bar.close - refPrice) / refPrice : (refPrice - bar.close) / refPrice;
    if (move >= movePct) return { closedAt: new Date(closeMs).toISOString(), close: bar.close, movePct: move, kind: bar.kind };
  }
  return null;
}
