// The I/O half of backtest/equity.js: reads the price bars a backtest span needs
// and builds the shared grid, and turns "some ticker has no usable prices" into
// one clear failure. runManualBacktest calls this FIRST, before any LLM call, so
// a run that could not be scored is refused for free instead of after spending
// the Gemini quota (plan.md step E's price-coverage preflight).

import { getPriceBarsInRange } from "../storage/inputs_view.js";
import { utcDateOf } from "../shared/price_availability.js";
import { addDays, buildPriceGrid, DEFAULT_MAX_PRICE_GAP_DAYS } from "./equity.js";

/**
 * Loads [testStart, testEnd) bars (plus up to `maxGapDays` before it, enough to
 * find an entry price; anything older would be rejected as stale anyway) for
 * every ticker and builds the grid (equity.js#buildPriceGrid). `testStart` and
 * `testEnd` are ISO timestamps; their UTC dates bound the span, `testEnd`
 * exclusive.
 */
export async function loadPriceGrid(inputs, { tickers, testStart, testEnd, maxGapDays = DEFAULT_MAX_PRICE_GAP_DAYS }) {
  const from = utcDateOf(testStart);
  const to = utcDateOf(testEnd);
  const lookbackFrom = addDays(from, -maxGapDays);

  const barsByTicker = {};
  for (const ticker of tickers) {
    barsByTicker[ticker] = await getPriceBarsInRange(inputs, { ticker, fromDate: lookbackFrom, toDate: to });
  }
  return buildPriceGrid({ barsByTicker, tickers, from, to, maxGapDays });
}

/**
 * Throws if any requested ticker has unusable price data, naming every one and
 * why. There is deliberately no "run with the tickers that do have data": a
 * silently smaller universe would make the result answer a different question
 * than the one that was asked.
 */
export function assertPriceCoverage(grid) {
  if (grid.problems.length === 0) return;
  const detail = grid.problems.map((p) => `${p.ticker}: ${p.reason}`).join("; ");
  throw new Error(
    `Price coverage check failed, so no LLM calls were made. ${detail}. ` +
      `Backfill daily price bars for ${grid.problems.map((p) => p.ticker).join(", ")} covering ${grid.from} to ${grid.to} and run the backtest again.`
  );
}
