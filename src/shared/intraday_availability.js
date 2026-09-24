// When does an intraday bar become visible? One rule, in one place, used by the
// read (storage/inputs_view.js#getIntradayPriceAsOf), the ingestion adapters
// (which must store timestamps in the one canonical form the read compares
// against) and the leak-check guard/tests (plan.md finding G step 3;
// Backtesting Integrity, points 1 and 6). The intraday sibling of
// shared/price_availability.js, which does the same for daily bars.
//
// `price_bars_intraday.ts` is the bar's OPEN (start) time, the way both
// vendors stamp a bar (Alpaca's `t`, Twelve Data's `datetime`; this is the
// vendors' convention as understood from their docs, not yet confirmed
// against live responses). The bar's close/high/low/volume do not exist until
// the interval is over, so a bar is visible only once it has FULLY CLOSED:
//
//     bar is visible at asOf  <=>  ts + INTRADAY_BAR_MS <= asOf
//
// A 13:35 bar (13:35:00-13:39:59) becomes visible at 13:40:00. Reading a bar
// at its own `ts` would show a decision made at 13:35:00 a close that was not
// set until 13:40. If a vendor ever stamps a bar with its CLOSE time instead,
// this rule is merely 5 minutes late (costs realism), never early (a leak) --
// the same "conservative stand-in" stance price_availability.js takes.
//
// INTRADAY_BAR_MS is a constant, not a per-row value, so every writer must
// produce bars of exactly this length: the adapters refuse any other
// configured interval (a 15-minute bar read under a 5-minute rule would be
// visible 10 minutes early).
//
// Timestamps are compared as STRINGS in SQL (that is what keeps the
// (ticker, ts) index usable), which is only correct if every stored `ts` and
// the cutoff share one exact format: `YYYY-MM-DDTHH:MM:SSZ`
// (canonicalIntradayTs). "…:00.000Z" sorts BEFORE "…:00Z" ('.' < 'Z'), so a
// mixed-format table would silently misplace the boundary bar.
// assertNoIntradayLookahead re-checks the rows numerically, independent of
// string format, so a format slip fails loudly instead of leaking quietly.

import { LookaheadViolationError } from "./errors.js";

/** Length of every stored intraday bar. Alpaca "5Min" / Twelve Data "5min". */
export const INTRADAY_BAR_MS = 5 * 60_000;

/**
 * `value` (an ISO timestamp with `Z` or an explicit offset) as the canonical
 * stored form `YYYY-MM-DDTHH:MM:SSZ` (UTC, whole seconds, no fraction). A value
 * that does not parse is returned UNCHANGED, so a writer's own validation (the
 * market data validator's "unparseable ts") is what rejects it, not this helper.
 */
export function canonicalIntradayTs(value) {
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(ms)) return value;
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

function parseAsOfMs(asOf) {
  const ms = typeof asOf === "string" ? Date.parse(asOf) : Number.NaN;
  if (Number.isNaN(ms)) {
    throw new LookaheadViolationError(`intraday price reads need a parseable ISO timestamp, got ${JSON.stringify(asOf)}`);
  }
  return ms;
}

/**
 * The inclusive upper bound, in canonical form, for the `ts` of bars visible at
 * `asOf`: a bar is visible iff `bar.ts <= intradayCutoffTs(asOf)`. That is
 * `asOf - INTRADAY_BAR_MS`, floored to the second (stored `ts` values are whole
 * seconds, so flooring never hides a bar that is visible). An `asOf` that does
 * not parse throws LookaheadViolationError: a time that cannot be computed must
 * never quietly become "no cutoff".
 */
export function intradayCutoffTs(asOf) {
  return canonicalIntradayTs(new Date(parseAsOfMs(asOf) - INTRADAY_BAR_MS).toISOString());
}

/** When a bar stamped `ts` (its open time) has fully closed and becomes visible, as a canonical timestamp. */
export function intradayBarAvailableAt(ts) {
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) {
    throw new LookaheadViolationError(`intraday bar has an unparseable ts ${JSON.stringify(ts)}`);
  }
  return canonicalIntradayTs(new Date(ms + INTRADAY_BAR_MS).toISOString());
}

/**
 * The runtime tripwire behind the leak-check test: throws LookaheadViolationError
 * if any bar in `bars` (rows with a `ts` field) has not yet fully closed at
 * `asOf`. Compares instants numerically, not as strings. getIntradayPriceAsOf
 * already filters in SQL; this re-checks the result, so a future change to the
 * query (or a fake that ignores the rule) fails loudly instead of leaking quietly.
 */
export function assertNoIntradayLookahead(bars, asOf) {
  const asOfMs = parseAsOfMs(asOf);
  for (const bar of bars) {
    const tsMs = Date.parse(bar.ts);
    if (Number.isNaN(tsMs) || tsMs + INTRADAY_BAR_MS > asOfMs) {
      throw new LookaheadViolationError(
        `Intraday bar stamped ${JSON.stringify(bar.ts)} has not fully closed at asOf=${asOf} (a ${INTRADAY_BAR_MS / 60_000}-minute bar is visible from its ts + ${INTRADAY_BAR_MS / 60_000} minutes)`
      );
    }
  }
}
