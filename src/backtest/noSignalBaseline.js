// The "signal off" half of Adopted Pattern #6 ("prove the signal helps
// before trusting it") -- signalCompare.js's compareSignalOnOffByWindow
// already has the walk-forward + metrics-comparison machinery, but it
// takes getOnReturns/getOffReturns as caller-supplied callbacks and
// supplies neither itself (see that file's header: "this harness doesn't
// need to change, only what's passed into it"). getOnReturns is the real,
// LLM-backed pipeline (graph/pipeline.js#runPipelineForTicker over
// backfilled historical news, per backfillHistoricalNews) -- expensive,
// slow, and a separate concern from this file. getOffReturns needs a
// baseline strategy that's genuinely comparable (same universe, same test
// window, same point-in-time price data) but requires ZERO LLM calls and
// zero news reads, so "signal off" isn't a strawman.
//
// BASELINE CHOSEN: naive buy-and-hold, long every ticker in the given
// universe for the full test window, equal-weighted. This is the standard
// null hypothesis for "does an active signal beat doing nothing" (same
// role as an index/benchmark comparison in llm-rl-finance-trader, the
// prior-art project plan.md's Adopted Patterns section cites for this
// exact validation approach) -- if the LLM-driven "on" strategy can't beat
// staying long the same names for the same period, the signal isn't
// earning its cost (in Gemini calls, in latency, in complexity).
//
// HONEST SCOPE: this is intentionally the SIMPLEST possible baseline, not
// a tuned one -- no stop-loss/take-profit, no position sizing beyond equal
// weight, no direction (always long). A more sophisticated "off" baseline
// (e.g. running the SAME deterministic risk/sizing layer from
// agents/risk_mgmt/risk.js but with a coin-flip or always-long thesis
// instead of an LLM one) is a reasonable future upgrade but a separate,
// bigger design decision -- not attempted here, since "beats a naive
// buy-and-hold" is already a meaningful, well-understood bar to clear
// first.

import { getPriceBarsAsOf } from "../storage/inputs_view.js";

/**
 * One ticker's buy-and-hold return over [testStart, testEnd): entry at the
 * close of the first bar on or after testStart, exit at the close of the
 * last bar on or before testEnd. Returns null (never fabricates a number)
 * if there's no bar on or after testStart within the window -- same "don't
 * invent a return you can't compute" convention as
 * graph/settle.js#settlePositionOutcome.
 *
 * Point-in-time correctness: getPriceBarsAsOf(asOf: testEnd) is itself the
 * enforced cutoff (storage/inputs_view.js, Backtesting Integrity point 1) -- this
 * function only ever sees bars dated <= testEnd, so it cannot leak a price
 * from after the test window even by accident.
 *
 * `limit` is generous enough to cover the window (testDays + buffer) since
 * getPriceBarsAsOf returns the `limit` most recent bars <= asOf, most-
 * recent-first -- too small a limit could return only bars from the tail
 * end of the window and silently miss the testStart-side entry bar. Callers
 * with unusually long test windows (this project's walk-forward windows
 * are day/week scale, not multi-year) should pass a larger `limit`
 * explicitly rather than relying on the default.
 */
export async function computeBuyAndHoldReturn(inputs, { ticker, testStart, testEnd, limit }) {
  const testDays = Math.ceil((new Date(testEnd) - new Date(testStart)) / 86400000);
  const bars = await getPriceBarsAsOf(inputs, { ticker, asOf: testEnd, limit: limit ?? Math.max(200, testDays + 50) });

  // bars is most-recent-first (DESC); the exit bar is simply the first
  // element (latest date <= testEnd). The entry bar is the OLDEST bar that
  // is still >= testStart -- i.e. the last element in ascending-within-
  // window order, found by filtering then taking the min.
  const inWindow = bars.filter((b) => b.date >= testStart);
  if (inWindow.length === 0) return null;

  const exitBar = inWindow[0]; // DESC order preserved by the filter
  const entryBar = inWindow[inWindow.length - 1];
  if (entryBar.date === exitBar.date) return null; // only one bar in-window -- no hold period to measure

  return (exitBar.close - entryBar.close) / entryBar.close;
}

/**
 * Equal-weighted buy-and-hold return series across every ticker in
 * `tickers` for one test window -- this IS the shape
 * signalCompare.js#compareSignalOnOffByWindow's `getOffReturns(window)`
 * callback expects (an array of per-position returns for that window, to
 * be pooled/summarized by metrics.js#summarizeReturns). A ticker with no
 * computable return (see computeBuyAndHoldReturn's null case -- missing
 * price data for that window) is simply absent from the array rather than
 * padded with a fabricated 0, same "never fabricate" principle applied at
 * the series level.
 */
export async function computeBuyAndHoldReturns(inputs, { tickers, testStart, testEnd, limit }) {
  const returns = [];
  for (const ticker of tickers) {
    const r = await computeBuyAndHoldReturn(inputs, { ticker, testStart, testEnd, limit });
    if (r !== null) returns.push(r);
  }
  return returns;
}

/**
 * Binds a fixed ticker universe to computeBuyAndHoldReturns, returning a
 * function with exactly signalCompare.js#compareSignalOnOffByWindow's
 * `getOffReturns(window)` signature -- pass this straight through as that
 * option, no adapter code needed at the call site:
 *
 *   const getOffReturns = makeBuyAndHoldOffReturns(inputs, { tickers: config.watchlist.map(w => w.ticker) });
 *   await compareSignalOnOffByWindow({ ..., getOnReturns, getOffReturns });
 */
export function makeBuyAndHoldOffReturns(inputs, { tickers, limit }) {
  return (window) => computeBuyAndHoldReturns(inputs, { tickers, testStart: window.testStart, testEnd: window.testEnd, limit });
}
