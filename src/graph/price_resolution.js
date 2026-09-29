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
// The intraday read IS BOUNDED by INTRADAY_MAX_AGE_MS (getIntradayPriceAsOf's
// maxAgeMs param). This used to be unbounded on the reasoning that a few-days-
// stale intraday bar is no worse than the daily fallback's previous-day close.
// That holds for a weekend or holiday gap, NOT for a table that only holds
// old bars: on 2026-09-24 the intraday backfill was still loading its oldest
// day (2026-06-26), so between 08:45 and ~09:15 UTC the newest visible bar for
// MSFT/AAPL was ~3 months old. Live fills, stop-loss and take-profit checks
// took that price as current (MSFT 500.59 long "stopped" at 371.94, AAPL short
// "take-profit" at 282.12 against ~336, entries at 390.30 / 294.18). A bar
// older than the bound now falls through to the daily close, which is logged.
//
// Adopted Pattern #11 (explicit vendor fallback, no silent degradation):
// every fallback-to-daily is logged, naming the ticker/asOf, so a backtest
// run that spends most of its window on the daily path (no intraday
// backfill yet) is visible in the logs, not indistinguishable from a fully
// intraday-priced run.

import { getIntradayPriceAsOf, getPriceBarsAsOf } from "../storage/inputs_view.js";

// 5 days covers the longest normal gap (a 3-day weekend plus one day of slack;
// a Friday-close bar is ~3 days old on Monday pre-market, ~4 across a Monday
// holiday). Anything older is not "the current price" and is never used.
export const INTRADAY_MAX_AGE_MS = 5 * 24 * 60 * 60 * 1000;

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
  const intraday = await getIntradayPriceAsOf(inputs, { ticker, asOf, maxAgeMs: INTRADAY_MAX_AGE_MS });
  if (intraday) {
    return { price: intraday.close, source: "intraday", bar: intraday };
  }

  console.error("price_resolution: no fresh intraday bar visible at asOf -- falling back to daily close", { ticker, asOf });

  const dailyBars = await getPriceBarsAsOf(inputs, { ticker, asOf, limit: 1 });
  const dailyBar = dailyBars[0] ?? null;
  return dailyBar
    ? { price: dailyBar.close, source: "daily", bar: dailyBar }
    : { price: null, source: null, bar: null };
}
