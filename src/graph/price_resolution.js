// Finding G step 4 (plan.md): resolves the ONE current-price read shared by
// graph/pipeline.js's portfolio_checked stage (entryPrice/exitPrice for a
// same-day replace) and graph/exit_check.js (stop-loss/take-profit currentPrice)
// -- pulled out here so both call sites get IDENTICAL fallback behavior
// instead of two hand-copies that could drift.
//
// Prefers the intraday reader (storage/inputs_view.js#getIntradayPriceAsOf,
// step 3) -- the finer-grained read that is what actually fixes finding G's
// same-day-replace-zero-PnL bug, since two same-day decisions now each get
// their OWN real intraday price instead of sharing one previous-day daily
// close. Falls back to the existing daily-close read
// (getPriceBarsAsOf(..., limit: 1)) whenever no intraday bar is visible at
// that asOf -- an illiquid ticker, a vendor gap, a backtest window whose
// intraday history hasn't been backfilled yet (step 6, not built), or a day
// that has aged out of the planned 4-6 month intraday retention window.
//
// NO maxAgeMs BOUND (plan.md step 3's getIntradayPriceAsOf param) is passed
// here: the daily fallback already exists specifically for "no intraday bar
// at this asOf", and an unbounded intraday read that happens to be a few
// days stale (a weekend, an overnight gap) is no worse than the daily
// reader's own previous-UTC-day-close it would otherwise fall back to --
// bounding it would just turn some of those into daily-fallback reads for
// no benefit. Revisit with a real maxAgeMs if a case turns up where an
// intraday bar visible-but-very-old is worse than falling back (e.g. once
// step 6's purge is live and a very old still-unpurged row could exist).
//
// Adopted Pattern #11 (explicit vendor fallback, no silent degradation):
// every fallback-to-daily is logged, naming the ticker/asOf, so a backtest
// run that spends most of its window on the daily path (no intraday
// backfill yet) is visible in the logs, not indistinguishable from a fully
// intraday-priced run.

import { getIntradayPriceAsOf, getPriceBarsAsOf } from "../storage/inputs_view.js";

/**
 * Resolves the fill price for `ticker` as of `asOf`.
 *
 * Returns `{ price, source, bar }`:
 *   - `source: "intraday"` -- `bar` is the row from getIntradayPriceAsOf,
 *     `price` is its `close`.
 *   - `source: "daily"` -- `bar` is the row from getPriceBarsAsOf,
 *     `price` is its `close`. Logged (Pattern #11) before this is returned.
 *   - `source: null, price: null, bar: null` -- neither read found anything.
 *     Never fabricated or interpolated (Pattern #9); callers already treat a
 *     null price as "skip, no price data" (see pipeline.js's
 *     SKIPPED_NO_PRICE_DATA path and exit.js's null-price handling).
 */
export async function resolveCurrentPrice(inputs, { ticker, asOf }) {
  const intraday = await getIntradayPriceAsOf(inputs, { ticker, asOf });
  if (intraday) {
    return { price: intraday.close, source: "intraday", bar: intraday };
  }

  console.error("price_resolution: no intraday bar visible at asOf -- falling back to daily close", { ticker, asOf });

  const dailyBars = await getPriceBarsAsOf(inputs, { ticker, asOf, limit: 1 });
  const dailyBar = dailyBars[0] ?? null;
  return dailyBar
    ? { price: dailyBar.close, source: "daily", bar: dailyBar }
    : { price: null, source: null, bar: null };
}
