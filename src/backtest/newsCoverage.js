// News' sibling to priceGrid.js's price-coverage preflight. runManualBacktest
// (runBacktest.js) already refuses, for free and before any LLM call, a run
// whose tickers don't have usable PRICE data over the span (priceGrid.js#
// assertPriceCoverage). It had no equivalent check for NEWS: a span with
// prices but no backfilled news for a ticker used to "complete" successfully
// and just walk that ticker day-by-day with nothing to analyze, producing a
// thin/empty "on" side and a result that looks like a real comparison but
// isn't (see runBacktest.js's own older header: "will just (correctly)
// produce empty/thin 'on' returns for a window with no backfilled news").
//
// This turns that into the same kind of loud, free, pre-LLM refusal
// assertPriceCoverage already gives missing prices. It does NOT call
// backfillHistoricalNews and does NOT touch any news vendor itself -- same
// scope carve-out as priceGrid.js and the rest of runBacktest.js: it only
// ever reads news ALREADY in D1. A caller wanting to backtest a range with no
// backfilled news yet must still run POST /backfill for that range first.

import { getNewsItemsInRange } from "../storage/inputs_view.js";

/**
 * Loads a `{ ticker: count }` map of how many backfilled news items each
 * requested ticker has anywhere in [testStart, testEnd) -- the exact same
 * span the on-signal walk itself reads from (onSignalRunner.js#
 * getDayNewsItems reads day-by-day slices of this same range), so a count of
 * 0 here really does mean the walk would see nothing for that ticker, not an
 * approximation of it. `testStart`/`testEnd` are ISO timestamps, `testEnd`
 * exclusive, same convention as everywhere else in this package.
 */
export async function loadNewsCoverage(inputs, { tickers, testStart, testEnd }) {
  const counts = {};
  for (const ticker of tickers) {
    const items = await getNewsItemsInRange(inputs, { ticker, from: testStart, to: testEnd });
    counts[ticker] = items.length;
  }
  return { counts, testStart, testEnd };
}

/**
 * Throws if any requested ticker has zero backfilled news items over the
 * span, naming every one and the range. Same "no silently smaller universe"
 * stance as assertPriceCoverage: a ticker that would walk the whole window
 * without a single decision point is refused up front, not quietly scored as
 * a run that never opens a position for it.
 */
export function assertNewsCoverage({ counts, testStart, testEnd }) {
  const empty = Object.entries(counts)
    .filter(([, count]) => count === 0)
    .map(([ticker]) => ticker);
  if (empty.length === 0) return;
  const verb = empty.length === 1 ? "has" : "have";
  throw new Error(
    `News coverage check failed, so no LLM calls were made. ${empty.join(", ")} ${verb} no backfilled news in [${testStart}, ${testEnd}). ` +
      `Backfill news for ${empty.join(", ")} covering that range (POST /backfill) and run the backtest again.`
  );
}
