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
import { SubrequestBudgetExhaustedError, VendorError } from "../shared/errors.js";

const DAY_MS = 86400000;

/** A Gemini failure worth pausing for (see walkOnSignalWindow): the client's cascade is exhausted but a later try may succeed. */
function isTransientGeminiError(err) {
  return err instanceof VendorError && err.vendor === "gemini" && err.transient === true;
}

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
 * lives, so countSignalWalkSteps, runOnSignalForTicker, and runBacktest.js's
 * own grace-extended price-grid load (see equity.js/priceGrid.js) can't drift.
 */
export function computeWalkEnd(config, { testEnd, graceDays, clock }) {
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
 * The news items of one (ticker, day): the day's own [00:00, next 00:00) range
 * clipped to [testStart, testEnd) (so grace days past testEnd have none and no
 * query is made for them). Boundary values that come from the caller are passed
 * through unchanged, so what is matched is exactly what one range read of
 * [testStart, testEnd) grouped by day would have matched.
 */
async function getDayNewsItems(ctx, { ticker, dayIso, testStart, testEnd }) {
  const dayStartMs = Date.parse(dayIso);
  const nextDayMs = dayStartMs + DAY_MS;
  const from = Date.parse(testStart) >= dayStartMs ? testStart : dayIso;
  const to = Date.parse(testEnd) <= nextDayMs ? testEnd : new Date(nextDayMs).toISOString();
  if (!(Date.parse(from) < Date.parse(to))) return [];
  return getNewsItemsInRange(ctx.inputs, { ticker, from, to });
}

/** Whether `item` sorts strictly after a resume cursor's `after` key in getNewsItemsInRange's (published_at, id) order. */
function isAfterCursorKey(item, after) {
  return item.published_at > after.publishedAt || (item.published_at === after.publishedAt && item.id > after.id);
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
 * Walks every ticker through one test window DAY-MAJOR (days outermost,
 * tickers innermost), leaving the resulting positions in the run's store. No
 * return value: see walkOnSignalForTicker.
 *
 * DAY-MAJOR, NOT TICKER-MAJOR: an earlier version of this function looped
 * tickers outermost, walking ticker A through its ENTIRE window (every day,
 * including its grace period) before ticker B's walk started at all. That
 * breaks the cross-ticker portfolio check runPipelineForTicker's portfolio
 * stage does on every decision (store.getOpenPositionsRiskPctAsOf({asOf,
 * excludeTicker})): by the time ticker B's day-1 decision ran, ticker A's
 * walk had already advanced through its whole window, so B's "exposure from
 * other tickers as of day 1" read reflected A's END-of-window state (which
 * positions A happened to still hold on the very last day of its walk), not
 * A's ACTUAL day-1 state -- a lookahead into A's future relative to B, and a
 * portfolio-risk check that could wrongly approve or reject B's decision
 * based on exposure that, chronologically, didn't exist yet. Looping days
 * outermost and every ticker's same-day work innermost keeps the store's
 * state, at the moment any ticker's decision is evaluated, advanced through
 * exactly the calendar days up to and including that one -- matching what
 * the live cron path would have seen (plan.md Adopted Pattern #6: this
 * whole harness exists to replay the live path faithfully).
 *
 * Exit checks (checkOpenPositionExits) also move: now called ONCE per day,
 * after every ticker's news for that day has run, rather than once per
 * (ticker, day) pair -- it already scans every open position across all
 * tickers (see exit_check.js; it takes no ticker filter), so calling it once
 * a day is both correct and avoids redundant re-scans of positions that
 * belong to a ticker other than the one currently "at bat".
 *
 * BUDGETED / RESUMABLE WALK (backtest-worker.js, subrequestBudget.js): a Worker
 * invocation can only make so many subrequests, so the walk can be PAUSED and
 * continued in a later invocation. With a `budget` it stops (returns
 * `{ complete: false, cursor, reason }`) at the first point where the next unit
 * of work -- one news item, or one day's exit check -- would not fit in what is
 * left, or where the budget runs out mid-item; without one it always runs to the
 * end, exactly as before. Passing that `cursor` back in resumes at the same spot:
 *   cursor = { day: ISO midnight, ticker: index, after: {publishedAt, id} | null, exits: bool }
 * i.e. "on `day`, ticker #`ticker`'s items up to and including `after` are done"
 * (`exits: true`: every ticker's items for `day` are done, the exit check is not).
 * `after` is a (published_at, id) KEY, not a position: news ingested while the
 * run is paused cannot shift what is skipped. An item interrupted mid-pipeline
 * is simply run again -- graph/checkpointer.js resumes it from its last finished
 * stage -- and the day's exit check is never cut in half (it runs inside
 * `budget.unenforced`, which counts but never refuses): a position closed but not yet reflected on
 * would change what later decisions remember.
 *
 * News is therefore read lazily, one (ticker, day) at a time, instead of the
 * whole window up front: resuming would otherwise re-page the whole window's
 * news in every invocation. The union of the per-day ranges is exactly
 * [testStart, testEnd), so what gets processed is unchanged.
 *
 * GEMINI OUTAGES PAUSE, THEY DON'T FAIL (budgeted walks only): when a news
 * item's pipeline throws a transient Gemini VendorError -- the client's whole
 * model cascade came up empty (llm/gemini/client.js: rate limits, overload,
 * timeouts, everything in cooldown) -- the walk pauses at that item exactly as
 * for "exhausted" (its finished stages are checkpointed, the item re-runs on
 * resume) and reports `reason: "transient"` with the error and its
 * `retryAfterSeconds` hint, so the caller can delay the next part. Before this,
 * a sub-minute outage failed the run and deleted 72 minutes of work. Only the
 * item's pipeline pauses: a news read or the exit check that throws still
 * fails the run, and with no budget (no continuation chain to resume in)
 * nothing changes -- the error propagates as before.
 *
 * Returns `{ complete: true }` or `{ complete: false, cursor, reason }`
 * (`reason`: "budget" = the next unit didn't fit, "exhausted" = the budget ran
 * out inside a unit, "transient" = Gemini was unavailable inside a unit; that
 * one also carries `error` and `retryAfterSeconds`).
 */

export async function walkOnSignalWindow(env, config, ctx, { tickers, testStart, testEnd, graceDays, onStep, clock, cursor = null, budget = null }) {
  const walkEnd = computeWalkEnd(config, { testEnd, graceDays, clock });
  const days = eachDayIso(testStart, walkEnd);

  let dayIndex = 0;
  if (cursor) {
    dayIndex = days.indexOf(cursor.day);
    if (dayIndex < 0) throw new Error(`walkOnSignalWindow: resume cursor day ${cursor.day} is not one of this window's walk days`);
  }
  // Where the walk is right now; a copy of it IS the cursor whenever the walk pauses.
  const pos = cursor ? { day: cursor.day, ticker: cursor.ticker, after: cursor.after ?? null, exits: Boolean(cursor.exits) } : { day: days[0], ticker: 0, after: null, exits: false };
  const pause = (reason, extra = {}) => ({ complete: false, reason, cursor: { ...pos, after: pos.after ? { ...pos.after } : null }, ...extra });
  const prefixFor = (ticker) => `${testStart}|${ticker}`;

  try {
    for (; dayIndex < days.length; dayIndex++) {
      const dayIso = days[dayIndex];
      if (dayIso !== pos.day) Object.assign(pos, { day: dayIso, ticker: 0, after: null, exits: false });

      // Resuming straight into a day's exit check: no ticker segment runs this
      // time, so re-announce the last one (the failure suffix in runBacktest.js
      // then still names a ticker-day if the exit check throws).
      const resumedIntoExits = pos.exits;
      if (!pos.exits) {
        while (pos.ticker < tickers.length) {
          const ticker = tickers[pos.ticker];
          // Read first, announce second: a failing news read is a setup
          // failure, not something to blame on a ticker-day that hasn't begun.
          let dayItems;
          try {
            // A fixed cost of reaching the first item (re-paid on every resume),
            // so it is counted but never refused: refusing it could leave a
            // small budget stuck before any item, making no progress at all.
            const read = () => getDayNewsItems(ctx, { ticker, dayIso, testStart, testEnd });
            dayItems = budget ? await budget.unenforced(read) : await read();
          } catch (err) {
            // Not a pipeline failure: keep runBacktest.js from blaming the
            // previous ticker-day (whose items all finished) for a read error.
            if (err && typeof err === "object" && !(err instanceof SubrequestBudgetExhaustedError)) err.skipStepSuffix = true;
            throw err;
          }
          // Told when a ticker's day starts -- again on resume, so the failure
          // suffix in runBacktest.js still names the ticker-day in flight.
          await onStep?.({ ticker, dayIso, done: false });
          for (const item of dayItems) {
            if (pos.after && !isAfterCursorKey(item, pos.after)) continue;
            if (budget && !budget.canStart("item")) return pause("budget");
            const before = budget?.mark();
            try {
              await runPipelineForTicker(env, config, ctx, {
                pipelineRunId: `${prefixFor(ticker)}|${item.id}`,
                ticker,
                newsItem: { id: item.id, tickers: [ticker], title: item.title, body: item.body, publishedAt: item.published_at },
                asOf: item.published_at,
              });
            } catch (err) {
              if (budget && isTransientGeminiError(err)) return pause("transient", { error: err, retryAfterSeconds: err.retryAfterSeconds ?? null });
              throw err;
            }
            budget?.recordUnit("item", before);
            pos.after = { publishedAt: item.published_at, id: item.id };
          }
          pos.ticker++;
          pos.after = null;
        }
        pos.exits = true;
      }

      if (budget && !budget.canStart("exits")) return pause("budget");
      if (resumedIntoExits && tickers.length) await onStep?.({ ticker: tickers[tickers.length - 1], dayIso, done: false });
      // Runs regardless of whether any news landed today -- an already-open
      // position from an earlier day can still hit its stop-loss/take-profit/
      // time-based exit on a day with no news at all, same as the live path.
      const exitsBefore = budget?.mark();
      const runExits = () => checkOpenPositionExits(env, config, ctx, { asOf: dayIso });
      if (budget) await budget.unenforced(runExits);
      else await runExits();
      budget?.recordUnit("exits", exitsBefore);
      for (const ticker of tickers) {
        await onStep?.({ ticker, dayIso, done: true });
      }
    }
    return { complete: true };
  } catch (err) {
    // The budget ran out INSIDE a unit (an item's pipeline, a news read): the
    // work already done is in the store/checkpoints, so pause where we are.
    if (err instanceof SubrequestBudgetExhaustedError) return pause("exhausted");
    throw err;
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
