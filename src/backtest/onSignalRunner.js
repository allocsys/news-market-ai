// The "signal on" half of Adopted Pattern #6 ("prove the signal helps
// before trusting it"). signalCompare.js#compareSignalOnOffByWindow already
// has the walk-forward + metrics-comparison machinery and takes
// getOnReturns/getOffReturns as caller-supplied callbacks without supplying
// either itself (see that file's header). This file supplies the "on" side:
// actually running the real LLM-backed pipeline
// (graph/pipeline.js#runPipelineForTicker) over backfilled historical news
// (ingestion/ingest.js#backfillHistoricalNews), leaving the positions it opens
// in the run's store. SCORING (since plan.md step D) is not done here:
// runBacktest.js replays those positions into a daily equity curve
// (equity.js) and compares it with the equal-weight buy-and-hold curve, so it
// uses the walk* functions below; the older runOnSignal*/makeOnSignalReturns
// (per-position realized returns) remain for callers that want that series.
//
// COST / LIVE-TRAFFIC WARNING: unlike the buy-and-hold baseline (zero LLM
// calls), calling the functions this file exports for real spends real Gemini quota (multiple
// LLM calls per news item via runPipelineForTicker: analyst team, bull/bear
// debate, judge, trader, plus one more per position close via
// graph/settle.js#settlePositionOutcome's reflection call) and, if paired
// with a fresh backfillHistoricalNews call, real Finnhub quota too. This
// module adds no cost/rate-limit guard of its own beyond whatever
// llm/gemini/client.js's cascade already provides -- it is meant to be
// invoked deliberately (a real backtest run), never as a side effect of
// routine testing. Unit/integration tests in this repo exercise it via
// config.fakeModel (agents/utils/structured.js), the same convention
// test/checkpoint_resume.test.js's full-pipeline test already established,
// so covering this file costs zero real API calls.
//
// WHY A DAY-BY-DAY WALK, NOT JUST "RUN THE PIPELINE ONCE PER NEWS ITEM":
// opening a position (runPipelineForTicker's portfolio_checked stage) does
// not by itself produce a realized return -- a position only becomes a
// realized number once something CLOSES it, and closing is
// graph/exit_check.js#checkOpenPositionExits's job (stop-loss/take-profit/
// time-based, driven by day-by-day price movement), called on its own
// periodic cadence by the live cron path (src/index.js#scheduled), not by
// runPipelineForTicker itself. So a faithful backtest of "what would the
// live system have realized" has to replay that same cadence: for each day
// in the window, run the pipeline for whatever backfilled news landed that
// day (opening/replacing positions exactly as the live path would), THEN
// call checkOpenPositionExits for that same day so already-open positions
// get their scheduled chance to exit. A single end-of-window pass would
// systematically under-count closes (every position still open at testEnd
// would simply never resolve) and would let a later news item's pipeline
// run see price/position state it should only see day-by-day, not
// instantly.
//
// GRACE PERIOD: `graceDays` (default config.maxPositionHoldDays) extends
// the day-by-day walk PAST `testEnd` purely so a position opened near the
// end of the test window still gets its fair chance to hit a stop-loss/
// take-profit/time-based exit and contribute a realized return, rather
// than being silently excluded just because it happened to still be open
// exactly at testEnd. This does NOT let entry decisions see anything past
// testEnd -- getNewsItemsInRange below is still bounded to [testStart,
// testEnd) for what triggers a NEW pipeline run; the grace period only
// keeps checking positions that already opened for exits.
//
// WINDOW ATTRIBUTION: getRealizedReturnsInRange reads every realized return
// whose resolved_at (== closedAt) falls in [testStart, testEnd + graceDays),
// regardless of when the underlying position was opened -- so a position
// opened from a news item just before testStart that happens to close
// during this window IS counted. (Only runOnSignalReturns reads this; the
// equity-curve scoring in runBacktest.js is by calendar day over the span,
// see equity.js, and is not affected by which window a trade closed in.)

import { getNewsItemsInRange } from "../storage/inputs_view.js";
import { runPipelineForTicker } from "../graph/pipeline.js";
import { checkOpenPositionExits } from "../graph/exit_check.js";

const DAY_MS = 86400000;

/** Every UTC calendar day from `startIso` (truncated to midnight) through `endIso`, inclusive, as ISO strings. */
function eachDayIso(startIso, endIso) {
  const days = [];
  const cursor = new Date(startIso);
  cursor.setUTCHours(0, 0, 0, 0);
  const end = new Date(endIso);
  while (cursor.getTime() <= end.getTime()) {
    days.push(cursor.toISOString());
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/**
 * Where the day-by-day walk stops: testEnd + the grace period. This is an
 * ENGINE-computed end (not something the caller asked for), so when a
 * SimClock is supplied it is clamped to the clock's now rather than thrown
 * on -- a grace period that rolls past "now" just means the walk ends today
 * (plan.md "Engine ports": "end clamped to real now"). No clock, no clamp
 * (unit tests with fixed historical dates). The single place this arithmetic
 * lives, so countSignalWalkSteps and runOnSignalForTicker can't drift.
 */
function computeWalkEnd(config, { testEnd, graceDays, clock }) {
  const grace = graceDays ?? config.maxPositionHoldDays ?? 10;
  const walkEnd = new Date(new Date(testEnd).getTime() + grace * DAY_MS).toISOString();
  return clock ? clock.clampEnd(walkEnd) : walkEnd;
}

/**
 * How many (ticker, day) steps one on-signal walk of a single window takes --
 * exactly the iteration count runOnSignalReturns will perform, so a caller
 * reporting progress (runBacktest.js) can size its progress bar up front.
 * Pass the same `clock` the walk itself gets, so a clamped walk is sized
 * as the clamped walk.
 */
export function countSignalWalkSteps(config, { tickers, testStart, testEnd, graceDays, clock }) {
  const walkEnd = computeWalkEnd(config, { testEnd, graceDays, clock });
  return tickers.length * eachDayIso(testStart, walkEnd).length;
}

/** Groups getNewsItemsInRange's rows by their UTC calendar date (published_at's first 10 chars), for the day-by-day walk below. */
function groupItemsByDay(items) {
  const byDay = new Map();
  for (const item of items) {
    const day = item.published_at.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(item);
  }
  return byDay;
}

/**
 * Runs the real pipeline for ONE ticker across one test window (plus grace
 * period), returning the realized returns that resulted -- exactly the
 * "array of per-position returns for this window" shape
 * compareSignalOnOffByWindow's getOnReturns(window) takes.
 *
 * `runIdPrefix` disambiguates checkpoint rows (graph/checkpointer.js keys
 * on (runId, ticker)) across repeated backtest runs over the SAME
 * backfilled news items -- without it, a second walk-forward window whose
 * grace period overlaps a news item already used by an earlier window
 * would resume from that earlier run's checkpoint instead of executing
 * fresh, since runPipelineForTicker's own convention (see
 * graph/pipeline.js) is to key runId off the news item's id alone. Default
 * is the window's own testStart, which is unique per window by
 * construction (walkForwardWindows never repeats a testStart).
 */
export async function runOnSignalForTicker(env, config, ctx, { ticker, testStart, testEnd, graceDays, runIdPrefix, onStep, clock }) {
  const walkEnd = await walkOnSignalForTicker(env, config, ctx, { ticker, testStart, testEnd, graceDays, runIdPrefix, onStep, clock });
  return ctx.store.getRealizedReturnsInRange({ ticker, from: testStart, to: walkEnd });
}

/**
 * The walk itself, with no return series: replays one ticker's window (news
 * items, then the day's exit checks) so its positions land in the run's store,
 * and returns the walk's end (testEnd + grace, clamped). runBacktest.js scores
 * the run from those positions (equity.js), not from realized returns.
 */
export async function walkOnSignalForTicker(env, config, ctx, { ticker, testStart, testEnd, graceDays, runIdPrefix, onStep, clock }) {
  const walkEnd = computeWalkEnd(config, { testEnd, graceDays, clock });
  const prefix = runIdPrefix ?? testStart;

  // Every item in [testStart, testEnd), however many: getNewsItemsInRange pages
  // through the whole range (it used to stop silently at 500 per ticker).
  const newsItems = await getNewsItemsInRange(ctx.inputs, { ticker, from: testStart, to: testEnd });
  const itemsByDay = groupItemsByDay(newsItems);

  for (const dayIso of eachDayIso(testStart, walkEnd)) {
    // Optional progress hook (backtest's live progress bar): told when a day
    // starts and again when it finishes. Never affects the walk itself.
    await onStep?.({ ticker, dayIso, done: false });
    const dayItems = itemsByDay.get(dayIso.slice(0, 10)) ?? [];
    for (const item of dayItems) {
      await runPipelineForTicker(env, config, ctx, {
        pipelineRunId: `${prefix}|${item.id}`,
        ticker,
        newsItem: { id: item.id, tickers: [ticker], title: item.title, body: item.body, publishedAt: item.published_at },
        asOf: item.published_at,
      });
    }
    // Runs regardless of whether any news landed today -- an already-open
    // position from an earlier day can still hit its stop-loss/take-profit/
    // time-based exit on a day with no news at all, same as the live path.
    await checkOpenPositionExits(env, config, ctx, { asOf: dayIso });
    await onStep?.({ ticker, dayIso, done: true });
  }

  return walkEnd;
}

/**
 * Walks every ticker through one test window (sequential per ticker, for the
 * reason runOnSignalReturns gives below), leaving the resulting positions in the
 * run's store. No return value: see walkOnSignalForTicker.
 */
export async function walkOnSignalWindow(env, config, ctx, { tickers, testStart, testEnd, graceDays, onStep, clock }) {
  for (const ticker of tickers) {
    await walkOnSignalForTicker(env, config, ctx, { ticker, testStart, testEnd, graceDays, runIdPrefix: `${testStart}|${ticker}`, onStep, clock });
  }
}

/**
 * Multi-ticker sibling -- pools every ticker's realized returns for one
 * test window into a single array. Sequential per ticker
 * (not Promise.all) deliberately: runPipelineForTicker's own portfolio
 * stage reads cross-ticker open-position exposure
 * (store.getOpenPositionsRiskPctAsOf), so concurrent tickers racing through the
 * same day would see each other's NOT-YET-COMMITTED state inconsistently
 * -- the live cron path itself is also sequential per news item for the
 * same reason (analyze messages are consumed one at a time per
 * max_concurrency, not raced in a Promise.all).
 */
export async function runOnSignalReturns(env, config, ctx, { tickers, testStart, testEnd, graceDays, onStep, clock }) {
  const returns = [];
  for (const ticker of tickers) {
    const tickerReturns = await runOnSignalForTicker(env, config, ctx, { ticker, testStart, testEnd, graceDays, runIdPrefix: `${testStart}|${ticker}`, onStep, clock });
    returns.push(...tickerReturns);
  }
  return returns;
}

/**
 * Binds env/config/ctx({inputs, store})/tickers, returning a function with exactly
 * signalCompare.js#compareSignalOnOffByWindow's getOnReturns(window)
 * signature (per-position realized returns; runBacktest.js scores by equity
 * curve instead, see the header).
 *
 * See this file's header for the real cost this incurs once actually
 * invoked -- do not wire this into any automated/scheduled path without an
 * explicit decision to spend that budget.
 */
export function makeOnSignalReturns(env, config, ctx, { tickers, graceDays, onStep, clock }) {
  return (window) => runOnSignalReturns(env, config, ctx, { tickers, testStart: window.testStart, testEnd: window.testEnd, graceDays, onStep, clock });
}
