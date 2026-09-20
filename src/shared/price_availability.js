// When does a daily price bar become visible? One rule, in one place, used by
// the read (storage/inputs_view.js#getPriceBarsAsOf) and by the leak-check
// guard/tests (plan.md Backtesting Integrity, points 1 and 6).
//
// `price_bars.date` is a bare `YYYY-MM-DD` and the row holds that day's FINAL
// open/high/low/close/volume. The final close does not exist until the day is
// over, so the bar for day D is visible only from the END of day D onward:
//
//     bar D is visible at asOf  <=>  D < (UTC calendar date of asOf)
//
// i.e. from D+1 00:00:00Z. Anything else lets a decision made at 09:35 on day D
// see the close (or high/low/volume) of day D, which was not knowable then --
// the same-day look-ahead the 2026-09-20 audit found (plan.md, step C). The
// consequence, by design: at any moment the freshest price the engine can see
// is the previous UTC day's close, in a backtest and live alike.
//
// The day boundary is UTC midnight for every instrument, a deliberately
// conservative stand-in for "the market has closed": US equities close about
// 21:00 UTC and spot FX 22:00 UTC, both before midnight, so this never shows a
// bar early. It can show it a few hours late, which costs realism, not
// integrity.

import { LookaheadViolationError } from "./errors.js";

/**
 * The exclusive upper bound, as a `YYYY-MM-DD` string, for bar dates visible at
 * `asOf`: a bar is visible iff `bar.date < priceBarCutoffDate(asOf)`. `asOf` is
 * any ISO timestamp (with a `Z` or an explicit offset) or a bare date. Anything
 * that does not parse throws LookaheadViolationError: a cutoff that cannot be
 * computed must never quietly become "no cutoff".
 */
export function priceBarCutoffDate(asOf) {
  const ms = typeof asOf === "string" ? Date.parse(asOf) : Number.NaN;
  if (Number.isNaN(ms)) {
    throw new LookaheadViolationError(`price bar reads need a parseable ISO asOf timestamp, got ${JSON.stringify(asOf)}`);
  }
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The runtime tripwire behind the leak-check test: throws LookaheadViolationError
 * if any bar in `bars` (rows with a `date` field) is not yet visible at `asOf`.
 * getPriceBarsAsOf already filters in SQL; this re-checks the result, so a
 * future change to the query (or a fake that ignores the rule) fails loudly
 * instead of leaking quietly.
 */
export function assertNoPriceBarLookahead(bars, asOf) {
  const cutoff = priceBarCutoffDate(asOf);
  for (const bar of bars) {
    if (bar.date >= cutoff) {
      throw new LookaheadViolationError(
        `Price bar dated ${JSON.stringify(bar.date)} is not yet visible at asOf=${asOf} (a bar is visible from the UTC day after its date; cutoff ${cutoff})`
      );
    }
  }
}
