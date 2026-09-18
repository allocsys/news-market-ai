// The real end-to-end backtest run plan.md's Known Gaps section flagged as
// the last open item under "Backtest harness": wiring
// onSignalRunner.js#makeOnSignalReturns + noSignalBaseline.js#makeBuyAndHoldOffReturns
// + signalCompare.js#compareSignalOnOffByWindow together behind one real,
// callable, PERSISTED invocation -- mirroring backfillHistoricalNews's own
// gated-secret operational entry point (POST /backfill).
//
// SCOPE / WHAT THIS DOES NOT DO: this does NOT call backfillHistoricalNews
// itself and does NOT touch Finnhub at all -- both onSignalRunner.js and
// noSignalBaseline.js only ever read news/price data ALREADY in D1
// (storage/d1.js#getNewsItemsInRange / getPriceBarsAsOf), never live vendor
// traffic. A caller wanting to backtest a period with no backfilled news
// yet must run POST /backfill for that range FIRST, as a separate,
// deliberate step -- this module has no opinion on that and will just
// (correctly) produce empty/thin "on" returns for a window with no
// backfilled news, same "never fabricate" convention as the rest of this
// package.
//
// COST WARNING (still applies, see onSignalRunner.js's own header): the
// "on" side runs the real Gemini-backed pipeline over whatever backfilled
// news falls in the window -- real quota, every time this is invoked. The
// only thing this module adds beyond the math layer itself is persistence
// (migrations/0010_backtest_runs.sql) and a manual, explicit trigger (see
// src/index.js's POST /backtest/run) -- it is NOT wired into scheduled()
// and must never be, per this file's own "not automatic" mandate.
//
// TRAIN/TEST WINDOWING: compareSignalOnOffByWindow's walk-forward windows
// (pointInTime.js#walkForwardWindows) need trainDays/testDays, not just an
// overall [testStart, testEnd) -- trainDays has no effect on either return
// series here (neither onSignalRunner.js nor noSignalBaseline.js reads
// anything from a window's trainStart/trainEnd fields, only testStart/
// testEnd), it exists purely to size each walk-forward step. A caller with
// no walk-forward opinion can pass trainDays=0 for one single test window
// spanning the whole [testStart, testEnd) range.

import { makeOnSignalReturns } from "./onSignalRunner.js";
import { makeBuyAndHoldOffReturns } from "./noSignalBaseline.js";
import { compareSignalOnOffByWindow } from "./signalCompare.js";
import { insertBacktestRun, completeBacktestRun, failBacktestRun } from "../storage/d1.js";

/**
 * Runs one full signal on/off backtest, persisting its params up front
 * ('running') and its result or error once it resolves ('complete' /
 * 'failed') -- see migrations/0010_backtest_runs.sql's header for why a
 * 'running' row is written before the slow part starts, not after.
 *
 * Returns the same `{ id, status, result | error }` shape whether it
 * succeeds or fails -- callers (src/index.js) don't need a try/catch of
 * their own; a failure here is reported as data (status: 'failed'), not
 * re-thrown, so a bad backtest run doesn't look like a route/server bug.
 */
export async function runManualBacktest(env, config, db, { id, tickers, testStart, testEnd, trainDays = 0, testDays, graceDays }) {
  const startedAt = new Date().toISOString();
  // A single [testStart, testEnd) window (no walk-forward roll) unless the
  // caller explicitly asks for one via testDays -- testDays defaults to the
  // whole window's own length so walkForwardWindows yields exactly one
  // window when trainDays=0, matching this function's own trainDays=0 default.
  const resolvedTestDays = testDays ?? Math.ceil((new Date(testEnd) - new Date(testStart)) / 86400000);

  await insertBacktestRun(db, { id, tickers, testStart, testEnd, trainDays, testDays: resolvedTestDays, graceDays: graceDays ?? null, startedAt });

  try {
    const getOnReturns = makeOnSignalReturns(env, config, db, { tickers, graceDays });
    const getOffReturns = makeBuyAndHoldOffReturns(db, { tickers });

    const result = await compareSignalOnOffByWindow({
      startDate: testStart,
      endDate: testEnd,
      trainDays,
      testDays: resolvedTestDays,
      getOnReturns,
      getOffReturns,
    });

    await completeBacktestRun(db, { id, result, finishedAt: new Date().toISOString() });
    return { id, status: "complete", result };
  } catch (err) {
    await failBacktestRun(db, { id, error: err.message, finishedAt: new Date().toISOString() });
    return { id, status: "failed", error: err.message };
  }
}
