// The real end-to-end backtest run plan.md's Known Gaps section flagged as
// the last open item under "Backtest harness": wiring the on-signal walk
// (onSignalRunner.js) + the daily equity-curve scoring of BOTH sides
// (equity.js) + signalCompare.js#compareSignalOnOffByWindow together behind
// one real, callable, PERSISTED invocation -- mirroring backfillHistoricalNews's
// own gated-secret operational entry point (POST /backfill).
//
// HOW A RUN GOES (plan.md step D): (1) PREFLIGHT, before any LLM call: load the
// price bars for the whole span and require every requested ticker to have
// usable ones (priceGrid.js); a ticker that cannot be scored fails the run
// with a message naming it, never a quietly smaller universe. (2) WALK: for
// each walk-forward window in order, replay the real pipeline over the
// backfilled news (onSignalRunner.js#walkOnSignalWindow), leaving positions in
// the run's store. (3) SCORE: replay those positions into a daily portfolio
// equity curve and compare it with the equal-weight buy-and-hold curve of the
// same tickers over the same days (equity.js), then slice both by window.
//
// M3: runs inside the `backtest` Worker (src/backtest-worker.js), off the
// BACKTEST queue. Everything it touches is SIM-side: `store` is
// RunStore(SIM_DB, <this backtest's id>), `registryDb` is SIM_DB itself (the
// backtest_runs registry, storage/sim_registry.js), `inputs` is a read-only
// INPUTS_DB handle. No LIVE_DB anywhere in this call graph.
//
// SCOPE / WHAT THIS DOES NOT DO: this does NOT call backfillHistoricalNews
// itself and does NOT touch Finnhub at all -- the walk and the scoring only
// ever read news/price data ALREADY in D1 (storage/inputs_view.js#
// getNewsItemsInRange / getPriceBarsAsOf / getPriceBarsInRange), never live
// vendor traffic. A caller wanting to backtest a period with no backfilled news
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
// (migrations/sim/0001_backtest_runs.sql) and a manual, explicit trigger (see
// src/index.js's POST /backtest/run) -- it is NOT wired into scheduled()
// and must never be, per this file's own "not automatic" mandate.
//
// TRAIN/TEST WINDOWING: compareSignalOnOffByWindow's walk-forward windows
// (pointInTime.js#walkForwardWindows) need trainDays/testDays, not just an
// overall [testStart, testEnd) -- trainDays has no effect on either return
// series here (neither the walk nor the scoring reads anything from a
// window's trainStart/trainEnd fields, only testStart/testEnd), it exists
// purely to size each walk-forward step. A caller with
// no walk-forward opinion can pass trainDays=0 for one single test window
// spanning the whole [testStart, testEnd) range.

import { walkOnSignalWindow, countSignalWalkSteps } from "./onSignalRunner.js";
import { onEquityReturns, offEquityReturns, sliceSeriesByWindow, meanOf, DEFAULT_MAX_PRICE_GAP_DAYS } from "./equity.js";
import { loadPriceGrid, assertPriceCoverage } from "./priceGrid.js";
import { walkForwardWindows } from "./pointInTime.js";
import { compareSignalOnOffByWindow } from "./signalCompare.js";
import { insertBacktestRun, completeBacktestRun, failBacktestRun } from "../storage/sim_registry.js";
import { withLlmLogContext } from "../storage/llm_calls.js";
import { SimClock } from "./simClock.js";
import { createLlmBudget } from "../llm/budget.js";

/**
 * Runs one full signal on/off backtest, persisting its params up front
 * ('running') and its result or error once it resolves ('complete' /
 * 'failed') -- see storage/sim_registry.js#insertBacktestRun for why a
 * 'running' row is written before the slow part starts, not after.
 *
 * `clock` (a SimClock, default: one pinned to the real now, captured once
 * for this run) does two jobs: an explicit testEnd in the future fails the
 * run (assertNotFuture -- a caller mistake, recorded as a 'failed' row so
 * it's visible), and the engine-computed walk end (testEnd + grace) is
 * clamped to now instead of throwing (onSignalRunner.js#computeWalkEnd).
 * Every LLM call this run makes is logged (when config.llmLogEnabled) under
 * source "backtest" with this run's id as jobId, into RunStore(SIM_DB, id).
 *
 * Returns the same `{ id, status, result | error }` shape whether it
 * succeeds or fails -- callers (src/index.js) don't need a try/catch of
 * their own; a failure here is reported as data (status: 'failed'), not
 * re-thrown, so a bad backtest run doesn't look like a route/server bug.
 */
export async function runManualBacktest(env, config, { inputs, store, registryDb }, { id, tickers, testStart, testEnd, trainDays = 0, testDays, graceDays, onProgress, clock = new SimClock() }) {
  const startedAt = new Date().toISOString();
  config = withLlmLogContext(config, { source: "backtest", jobId: id });
  // A single [testStart, testEnd) window (no walk-forward roll) unless the
  // caller explicitly asks for one via testDays -- testDays defaults to the
  // whole window's own length so walkForwardWindows yields exactly one
  // window when trainDays=0, matching this function's own trainDays=0 default.
  const resolvedTestDays = testDays ?? Math.ceil((new Date(testEnd) - new Date(testStart)) / 86400000);

  await insertBacktestRun(registryDb, { id, tickers, testStart, testEnd, trainDays, testDays: resolvedTestDays, graceDays: graceDays ?? null, startedAt });

  // Live-progress wiring (src/storage/jobs.js's percent convention: 0-95 for
  // the day-by-day walk, 98 for saving, 100 only via reporter.complete()).
  // `onProgress` is the caller's job reporter's `update` -- optional, so this
  // function stays a plain no-op-progress call for tests/callers that don't
  // care (same as backfillHistoricalNews's own onProgress convention).
  // totalSteps is computed up front via onSignalRunner.js#countSignalWalkSteps
  // so the FIRST progress tick already knows the real denominator, not a
  // guess that jumps around as ticker-days complete.
  let totalSteps = 0;
  let completedSteps = 0;
  // onStep fires twice per ticker-day (done:false when it starts, done:true
  // when it finishes, see onSignalRunner.js) -- only count the finish, so
  // completedSteps never exceeds totalSteps.
  //
  // The wrapper is ALWAYS defined (even with no onProgress) because it also
  // remembers the ticker-day currently in flight: set when a day starts,
  // cleared when it finishes. If the run then throws, that is WHERE it died,
  // and it is appended to the stored error so a failed run whose data has
  // been cleaned up (backtest/cleanup.js) still says how far it got.
  let current = null;
  const onStep = async ({ ticker, dayIso, done }) => {
    if (!done) {
      current = { ticker, dayIso };
      return;
    }
    current = null;
    completedSteps++;
    if (!onProgress) return;
    await onProgress({
      phase: "simulating",
      percent: Math.min(95, Math.round((95 * completedSteps) / Math.max(totalSteps, 1))),
      done: completedSteps,
      total: totalSteps,
      detail: `${ticker} ${dayIso.slice(0, 10)}`,
    });
  };

  try {
    // Fresh per-run LLM-call counter (llm/budget.js), created here -- not in
    // loadConfig -- so each run gets its own; it rides on config to every agent.
    // Inside the try: a malformed BACKTEST_MAX_LLM_CALLS is recorded as a
    // 'failed' run rather than escaping and looping the queue message.
    config = { ...config, llmBudget: createLlmBudget(config.backtestMaxLlmCalls) };
    clock.assertNotFuture(testEnd, "testEnd");

    // The walk-forward windows this run covers (contiguous test windows; the
    // same ones compareSignalOnOffByWindow rolls below). None fitting is a
    // caller mistake, refused here instead of "completing" with an empty result.
    if (!(Date.parse(testStart) < Date.parse(testEnd))) {
      throw new Error(`testStart (${testStart}) must be before testEnd (${testEnd})`);
    }
    const windows = [...walkForwardWindows(testStart, testEnd, { trainDays, testDays: resolvedTestDays })];
    if (windows.length === 0) {
      throw new Error(`No walk-forward window fits in ${testStart} .. ${testEnd} with trainDays=${trainDays} and testDays=${resolvedTestDays}; nothing to run`);
    }
    const spanStart = windows[0].testStart;
    const spanEnd = windows[windows.length - 1].testEnd;

    // PREFLIGHT (free): every ticker needs usable prices over the whole span
    // before a single LLM call is made.
    const grid = await loadPriceGrid(inputs, { tickers, testStart: spanStart, testEnd: spanEnd });
    assertPriceCoverage(grid);

    if (onProgress) {
      totalSteps = windows.reduce((sum, w) => sum + countSignalWalkSteps(config, { tickers, testStart: w.testStart, testEnd: w.testEnd, graceDays, clock }), 0);
    }

    // WALK: windows in order, each one leaving its positions in the store.
    for (const window of windows) {
      await walkOnSignalWindow(env, config, { inputs, store }, { tickers, testStart: window.testStart, testEnd: window.testEnd, graceDays, onStep, clock });
    }

    // SCORE: both sides as daily equity curves over the same grid, then sliced
    // per window (their pooled series is the whole-span curve).
    const positions = await store.getPositionsInRange({ from: spanStart, to: spanEnd });
    const on = onEquityReturns(grid, positions);
    const off = offEquityReturns(grid);

    const result = await compareSignalOnOffByWindow({
      startDate: testStart,
      endDate: testEnd,
      trainDays,
      testDays: resolvedTestDays,
      getOnReturns: (window) => sliceSeriesByWindow(grid.dates, on.returns, window),
      getOffReturns: (window) => sliceSeriesByWindow(grid.dates, off.returns, window),
    });
    result.portfolio = {
      method: "daily-equity-curve-v1",
      from: grid.from,
      to: grid.to,
      days: grid.dates.length,
      tickers: grid.tickers,
      maxGapDays: DEFAULT_MAX_PRICE_GAP_DAYS,
      on: { avgExposure: meanOf(on.exposure), positionsTraded: on.positionsTraded, positionsIgnored: on.positionsIgnored },
      off: { avgExposure: meanOf(off.exposure), holdings: grid.tickers.length },
      series: { dates: grid.dates, on: on.returns, off: off.returns, onExposure: on.exposure },
    };

    await onProgress?.({ phase: "saving", percent: 98, done: totalSteps, total: totalSteps, detail: "Saving backtest results", force: true });
    await completeBacktestRun(registryDb, { id, result, finishedAt: new Date().toISOString() });
    return { id, status: "complete", result };
  } catch (err) {
    // No suffix when it failed before the walk started (e.g. assertNotFuture).
    const error = current && !err?.skipStepSuffix ? `${err.message} [while processing ${current.ticker} ${current.dayIso.slice(0, 10)}]` : err.message;
    await failBacktestRun(registryDb, { id, error, finishedAt: new Date().toISOString() });
    return { id, status: "failed", error };
  }
}
