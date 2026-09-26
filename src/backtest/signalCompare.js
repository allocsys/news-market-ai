// Signal on/off comparison harness (plan.md open item, Adopted Pattern #6:
// "prove the signal helps before trusting it" -- compare with the news/
// analysis signal on vs. off rather than assuming the LLM layer adds
// value).
//
// HONEST SCOPE: this module does NOT itself run the pipeline or fetch
// trade outcomes -- that would require live Gemini calls through the full
// agent graph (analysts -> researchers -> trader -> risk -> portfolio) for
// "signal on", and a comparable no-signal baseline strategy for "signal
// off", against REAL closed-trade returns. UPDATE: storage/run_store.js#RunStore.closePosition
// now HAS a caller -- graph/exit_check.js#checkOpenPositionExits, called
// from both the live cron path (src/index.js#scheduled) and the backtest
// walk (backtest/onSignalRunner.js) -- so realized per-trade returns do
// exist via RunStore#getRealizedReturnsInRange. That end-to-end wiring is
// not used by THIS harness, though: runBacktest.js scores by daily equity
// curve (equity.js) over calendar days, not by pooling realized per-trade
// returns through this module's getOnReturns/getOffReturns seam. A caller
// that wants the per-trade-return comparison this module was written for
// can still plug onSignalRunner.js#makeOnSignalReturns in as getOnReturns.
//
// What this module DOES provide, and what actually unblocks that later
// work: the walk-forward iteration + metrics-comparison machinery itself,
// as pure functions taking already-computed return series as input. Once
// closePosition has a caller and realized per-trade returns exist,
// `compareSignalOnOffByWindow`'s `getOnReturns`/`getOffReturns` callbacks
// are the exact seam where that real data plugs in -- this harness doesn't
// need to change, only what's passed into it.

import { walkForwardWindows } from "./pointInTime.js";
import { summarizeReturns } from "./metrics.js";

/**
 * Compares two already-computed return series (signal-on vs. signal-off/
 * baseline) over the same period. `delta` is `on - off` for
 * cumulativeReturn/sharpeRatio/winRate (positive = signal helped) and
 * `off - on` for maxDrawdown (positive = signal reduced drawdown, i.e. also
 * "signal helped") -- the sign convention is normalized so a positive delta
 * always means "the signal looks better on this metric", for every field.
 */
export function compareSignalOnOff(onReturns, offReturns, { riskFreeRate = 0, periodsPerYear = 252 } = {}) {
  const on = summarizeReturns(onReturns, { riskFreeRate, periodsPerYear });
  const off = summarizeReturns(offReturns, { riskFreeRate, periodsPerYear });
  return {
    on,
    off,
    delta: {
      cumulativeReturn: on.cumulativeReturn - off.cumulativeReturn,
      sharpeRatio: on.sharpeRatio - off.sharpeRatio,
      winRate: on.winRate - off.winRate,
      maxDrawdown: off.maxDrawdown - on.maxDrawdown,
    },
  };
}

/**
 * Rolls `compareSignalOnOff` across every walk-forward test window between
 * `startDate` and `endDate` (see pointInTime.js#walkForwardWindows for the
 * train/test roll semantics). For each window, calls
 * `getOnReturns(window)`/`getOffReturns(window)` (sync or async, both
 * awaited) to obtain that window's realized returns -- this package
 * supplies the windowing and comparison math, not the trade data, per this
 * file's header. Returns per-window comparisons plus one comparison pooling
 * every window's returns together, so a caller can see both "did it help
 * consistently across regimes" and "did it help overall".
 */
export async function compareSignalOnOffByWindow({
  startDate,
  endDate,
  trainDays,
  testDays,
  getOnReturns,
  getOffReturns,
  riskFreeRate = 0,
  periodsPerYear = 252,
}) {
  const perWindow = [];
  const pooledOn = [];
  const pooledOff = [];

  for (const window of walkForwardWindows(startDate, endDate, { trainDays, testDays })) {
    const [onReturns, offReturns] = await Promise.all([getOnReturns(window), getOffReturns(window)]);
    pooledOn.push(...onReturns);
    pooledOff.push(...offReturns);
    perWindow.push({ window, comparison: compareSignalOnOff(onReturns, offReturns, { riskFreeRate, periodsPerYear }) });
  }

  return {
    perWindow,
    overall: compareSignalOnOff(pooledOn, pooledOff, { riskFreeRate, periodsPerYear }),
  };
}
