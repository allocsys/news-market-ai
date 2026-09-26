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

import { walkOnSignalWindow, countSignalWalkSteps, computeWalkEnd } from "./onSignalRunner.js";
import { onEquityReturns, offEquityReturns, sliceSeriesByWindow, meanOf, DEFAULT_MAX_PRICE_GAP_DAYS } from "./equity.js";
import { loadPriceGrid, assertPriceCoverage } from "./priceGrid.js";
import { walkForwardWindows } from "./pointInTime.js";
import { compareSignalOnOffByWindow } from "./signalCompare.js";
import { insertBacktestRun, completeBacktestRun, failBacktestRun } from "../storage/sim_registry.js";
import { withLlmLogContext } from "../storage/llm_calls.js";
import { SimClock } from "./simClock.js";
import { createLlmBudget } from "../llm/budget.js";

// Consecutive Gemini-outage pauses on one news item before the run gives up
// (config.backtestMaxTransientStalls overrides; that config key is the source of
// truth, this only covers a hand-built config that lacks it).
const DEFAULT_MAX_TRANSIENT_STALLS = 30;

/** A stored stall error is quoted in the final failure message: keep two of them well under any row/message limit. */
function clipStallError(message, max = 700) {
  return message.length > max ? `${message.slice(0, max)}...` : message;
}

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
export async function runManualBacktest(env, config, { inputs, store, registryDb }, { id, tickers, testStart, testEnd, trainDays = 0, testDays, graceDays, onProgress, clock = new SimClock(), cursor = null, budget = null, part = 1, maxParts = Infinity }) {
  const startedAt = new Date().toISOString();
  // A continuation part pins the clock to part 1's now, so the grace-day clamp
  // (computeWalkEnd) -- and with it the walk's day list -- cannot shift between
  // parts and invalidate the cursor.
  if (cursor) clock = new SimClock(cursor.clockNow);
  config = withLlmLogContext(config, { source: "backtest", jobId: id });
  // The Free-plan subrequest budget (backtest/subrequestBudget.js) rides on
  // config to the Gemini client (it charges every fetch). `unenf` runs
  // bookkeeping that must not be cut in half: counted, never refused.
  if (budget) config = { ...config, subrequestBudget: budget };
  const unenf = (fn) => (budget ? budget.unenforced(fn) : fn());
  // A single [testStart, testEnd) window (no walk-forward roll) unless the
  // caller explicitly asks for one via testDays -- testDays defaults to the
  // whole window's own length so walkForwardWindows yields exactly one
  // window when trainDays=0, matching this function's own trainDays=0 default.
  const resolvedTestDays = testDays ?? Math.ceil((new Date(testEnd) - new Date(testStart)) / 86400000);

  // Part 1 only: a continuation part must not re-insert the registry row.
  if (!cursor) {
    await unenf(() => insertBacktestRun(registryDb, { id, tickers, testStart, testEnd, trainDays, testDays: resolvedTestDays, graceDays: graceDays ?? null, startedAt }));
  }

  // Live-progress wiring (src/storage/jobs.js's percent convention: 0-95 for
  // the day-by-day walk, 98 for saving, 100 only via reporter.complete()).
  // `onProgress` is the caller's job reporter's `update` -- optional, so this
  // function stays a plain no-op-progress call for tests/callers that don't
  // care (same as backfillHistoricalNews's own onProgress convention).
  // totalSteps is computed up front via onSignalRunner.js#countSignalWalkSteps
  // so the FIRST progress tick already knows the real denominator, not a
  // guess that jumps around as ticker-days complete.
  let totalSteps = 0;
  // Carried across parts in the cursor (each part only sees its own onStep calls).
  let completedSteps = cursor?.completed ?? 0;
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
    // Progress writes are bookkeeping: never let the budget cut one off in the
    // middle of the walk's own step accounting.
    await unenf(() =>
      onProgress({
        phase: "simulating",
        percent: Math.min(95, Math.round((95 * completedSteps) / Math.max(totalSteps, 1))),
        done: completedSteps,
        total: totalSteps,
        detail: `${ticker} ${dayIso.slice(0, 10)}`,
      }),
    );
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
    // The LAST window's grace period extends past spanEnd (earlier windows'
    // grace periods overlap the NEXT window's own real test range, already
    // covered by [spanStart, spanEnd) since walkForwardWindows produces
    // contiguous windows -- only the final window has no "next window" to
    // fall into). Extending the grid/scoring span by this same amount is what
    // lets a position opened near the end of the run get priced through its
    // real grace-period close instead of being scored as still-open at
    // spanEnd regardless of what really happened (onSignalRunner.js's own
    // computeWalkEnd -- same function, same graceDays/clock -- so this can't
    // drift from the walk's own grace end).
    const graceExtendedSpanEnd = computeWalkEnd(config, { testEnd: spanEnd, graceDays, clock });

    // PREFLIGHT (free): every ticker needs usable prices over the whole span,
    // including the final grace extension, before a single LLM call is made.
    // Part 1 only (a continuation already passed it, and reloads the grid at
    // scoring time). Unenforced: it is a fixed cost before any unit can run.
    let grid = null;
    if (!cursor) {
      grid = await unenf(async () => {
        const g = await loadPriceGrid(inputs, { tickers, testStart: spanStart, testEnd: graceExtendedSpanEnd });
        assertPriceCoverage(g);
        return g;
      });
    }

    if (onProgress) {
      totalSteps = windows.reduce((sum, w) => sum + countSignalWalkSteps(config, { tickers, testStart: w.testStart, testEnd: w.testEnd, graceDays, clock }), 0);
    }

    // Ends this part and hands back where to pick up. Only ever RETURNS a
    // 'continue' outcome (the worker enqueues the next part); past maxParts it
    // throws instead, which lands in the catch below as a normal failed run.
    // `extra.delaySeconds` asks the worker to delay the next part by at least that
    // long (a Gemini outage: no point retrying before the cooldowns clear);
    // `extra.detail` overrides the progress line.
    const yieldPart = async (state, reason, extra = {}) => {
      if (part >= maxParts) {
        throw new Error(`Backtest exceeded ${maxParts} continuation parts without finishing (${completedSteps}/${totalSteps} ticker-days done); raise BACKTEST_MAX_PARTS or the subrequest limits`);
      }
      await unenf(() =>
        onProgress?.({
          phase: "simulating",
          percent: Math.min(95, Math.round((95 * completedSteps) / Math.max(totalSteps, 1))),
          done: completedSteps,
          total: totalSteps,
          detail: extra.detail ?? `Continuing in part ${part + 1}`,
          force: true,
        }),
      );
      return { id, status: "continue", reason, ...(extra.delaySeconds ? { delaySeconds: extra.delaySeconds } : {}), cursor: { clockNow: clock.now(), ...state, completed: completedSteps } };
    };

    // WALK: windows in order, each one leaving its positions in the store.
    if ((cursor?.phase ?? "walk") === "walk") {
      for (let wi = cursor?.window ?? 0; wi < windows.length; wi++) {
        const window = windows[wi];
        const resume = cursor && wi === cursor.window ? cursor.walk ?? null : null;
        const res = await walkOnSignalWindow(env, config, { inputs, store }, { tickers, testStart: window.testStart, testEnd: window.testEnd, graceDays, onStep, clock, cursor: resume, budget });
        if (!res.complete) {
          if (res.reason === "transient") {
            // Gemini was unavailable inside a news item (the client's whole cascade came
            // up empty): PAUSE and retry after a delay instead of failing -- a run used
            // to die, and its data get deleted, over an outage of under a minute. The
            // cursor carries a stall counter for THIS spot (window/day/ticker/last
            // finished item): only N pauses in a row on the same item mean the outage is
            // not passing, and only then does the run fail (with the first outage's
            // trace, since the later parts mostly see nothing but cooldown skips).
            const cur = res.cursor;
            const key = `${wi}|${cur.day}|${cur.ticker}|${cur.after?.id ?? ""}`;
            const prev = cursor?.stall?.key === key ? cursor.stall : null;
            const count = (prev?.count ?? 0) + 1;
            const message = res.error?.message ?? "unknown Gemini error";
            const firstError = prev?.firstError ?? clipStallError(message);
            const maxStalls = config.backtestMaxTransientStalls ?? DEFAULT_MAX_TRANSIENT_STALLS;
            if (maxStalls > 0 && count > maxStalls) {
              throw new Error(`Gemini stayed unavailable through ${maxStalls} consecutive pauses on the same news item (${tickers[cur.ticker] ?? `ticker #${cur.ticker}`} ${cur.day.slice(0, 10)}); giving up. First outage: ${firstError} | Latest: ${clipStallError(message)}`);
            }
            const delaySeconds = Math.max(config.backtestTransientPauseSeconds ?? 0, res.retryAfterSeconds ?? 0);
            return await yieldPart({ phase: "walk", window: wi, walk: cur, stall: { key, count, firstError } }, "transient", {
              delaySeconds,
              detail: `Gemini unavailable (pause ${count}); retrying in part ${part + 1}`,
            });
          }
          // Carry any in-progress stall count forward even though this pause
          // itself isn't "transient": if a budget/exhausted pause happens on the
          // SAME item as an earlier Gemini stall, dropping it here would reset
          // the giveup counter to 1 on the next transient pause and let outage +
          // budget pauses interleave forever without ever reaching maxStalls.
          return await yieldPart({ phase: "walk", window: wi, walk: res.cursor, stall: cursor?.stall }, res.reason);
        }
      }
    }

    // SCORE needs a chunk of D1 reads + the final write; if this part has spent
    // too much on the walk, do it in the next one.
    if (budget) {
      budget.setEstimate("score", { external: 0, total: tickers.length + 8 });
      if (!budget.canStart("score")) return await yieldPart({ phase: "score", window: windows.length, walk: null }, "budget");
    }
    return await unenf(async () => {
      grid ??= await loadPriceGrid(inputs, { tickers, testStart: spanStart, testEnd: graceExtendedSpanEnd });

      // SCORE: both sides as daily equity curves over the same (grace-extended)
      // grid, then sliced per window (their pooled series is the whole-span
      // curve). Earlier windows' grace periods already fall inside
      // [spanStart, spanEnd) -- they overlap the NEXT window's own real test
      // range, since walkForwardWindows produces contiguous windows -- so
      // their slice needs no adjustment. Only the LAST window has grace days
      // past spanEnd with no later window to be sliced into, so only its own
      // slice is widened to graceExtendedSpanEnd; the window objects
      // themselves (and therefore perWindow's reported testStart/testEnd)
      // are untouched, so the reported window boundaries stay the real ones.
      const positions = await store.getPositionsInRange({ from: spanStart, to: graceExtendedSpanEnd });
      const on = onEquityReturns(grid, positions);
      const off = offEquityReturns(grid);
      const scoringEnd = (window) => (window.testEnd === spanEnd ? graceExtendedSpanEnd : window.testEnd);

      const result = await compareSignalOnOffByWindow({
        startDate: testStart,
        endDate: testEnd,
        trainDays,
        testDays: resolvedTestDays,
        getOnReturns: (window) => sliceSeriesByWindow(grid.dates, on.returns, { testStart: window.testStart, testEnd: scoringEnd(window) }),
        getOffReturns: (window) => sliceSeriesByWindow(grid.dates, off.returns, { testStart: window.testStart, testEnd: scoringEnd(window) }),
    });
    result.portfolio = {
      method: "daily-equity-curve-v2",
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
    });
  } catch (err) {
    // No suffix when it failed before the walk started (e.g. assertNotFuture).
    const error = current && !err?.skipStepSuffix ? `${err.message} [while processing ${current.ticker} ${current.dayIso.slice(0, 10)}]` : err.message;
    await unenf(() => failBacktestRun(registryDb, { id, error, finishedAt: new Date().toISOString() }));
    return { id, status: "failed", error };
  }
}
