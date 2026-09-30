// Exit-check orchestration -- closes the plan.md positions known-gap:
// "closePosition has no caller yet -- exit logic (stop-loss/take-profit/
// time-based) doesn't exist, so once opened a position stays open
// forever." Runs the deterministic exit rules against every currently open
// position and closes the ones that trigger.
//
// This is a portfolio-level periodic check, not a per-news-item stage like
// runPipelineForTicker -- it has no natural checkpoint/resume state of its
// own (each position is judged independently and closePosition's `closed_at
// IS NULL` guard already makes re-running this function harmless/idempotent
// on a position that already closed).
//
// BAR-BASED PRICE EXITS. Stop-loss / take-profit are decided by WALKING THE BARS
// that fully closed since the position's last check (positions.last_checked_at,
// or opened_at the first time), not by sampling one price at check time:
//   - intraday OHLC bars (price_bars_intraday) where a UTC day has them, else that
//     day's daily OHLC bar (price_bars) -- shared/bar_window.js;
//   - the first bar whose low/high touched the stop or target wins, stop first
//     when one bar touches both; the fill is the level, or the bar's open when it
//     gapped past it -- agents/risk_mgmt/exit_bars.js;
//   - MAE/MFE come from the same bars' lows/highs (store.recordPositionExcursionRange).
// A touch between two checks is therefore caught by the next check, and its
// `closedAt` is the triggering bar's close time (always <= asOf), not the check's asOf.
// The cursor advances (store.advancePositionCheck) only after a window was evaluated
// with NO exit; on an exit it is left alone, so a crash between "exit found" and
// closePosition re-finds the same exit.
//
// TIME EXIT. Unchanged: agents/risk_mgmt/exit.js#evaluateExit with price exits
// skipped, closing at `asOf` with graph/price_resolution.js#resolveCurrentPrice as
// the exit price (intraday close when a bar is visible, else the previous UTC day's
// daily close -- Adopted Pattern #11 logging lives there).
//
// HONEST SCOPE:
//   - The entry-time bar is never counted and a UTC day with no intraday rows
//     falls back to its daily bar; if the entry day has no intraday rows it is not
//     checked at all (a touch that day is missed, never optimistic about lookahead).
//     See shared/bar_window.js.
//   - A ticker with no bars in the window gets no price exit and no excursion from
//     this check; the cursor stays put and the next check re-reads from the same
//     start. Only the time exit can fire for it -- an honest per-ticker degradation.
//   - A suspected stock split in the raw bars stops the walk before that bar, is
//     logged on every check, and suppresses price exits (see exit_bars.js).

import { resolveCurrentPrice } from "./price_resolution.js";
import { evaluateExit } from "../agents/risk_mgmt/exit.js";
import { exitLevels, walkBarsForExit } from "../agents/risk_mgmt/exit_bars.js";
import { settlePositionOutcome } from "./settle.js";
import { withLlmLogContext } from "../storage/llm_calls.js";
import { getDailyBarsWindowAsOf, getIntradayBarsWindowAsOf } from "../storage/inputs_view.js";
import { buildBarSequence, exitWindowStart } from "../shared/bar_window.js";
import { detectSplitJump } from "../shared/split_guard.js";

/**
 * Reads the position's bar window (intraday + daily, both asOf-gated) and walks
 * it. Returns the walkBarsForExit result, or `null` when there is nothing to walk:
 * no computable stop/target levels (skips the reads entirely), or a cursor /
 * opened_at that does not parse (logged; a date that cannot be computed is never
 * turned into "the beginning of time").
 */
async function walkPositionBars(inputs, position, { asOf, splitGuardTolerance }) {
  if (!exitLevels(position)) return null;

  const start = exitWindowStart({ openedAt: position.openedAt, lastCheckedAt: position.lastCheckedAt });
  if (!start) {
    console.error("checkOpenPositionExits: position has no parseable opened_at/last_checked_at -- price walk skipped, only the time exit can fire", {
      positionId: position.id,
      ticker: position.ticker,
      openedAt: position.openedAt,
      lastCheckedAt: position.lastCheckedAt ?? null,
    });
    return null;
  }

  const intraday = await getIntradayBarsWindowAsOf(inputs, { ticker: position.ticker, fromTs: start.intradayFromTs, asOf });
  const daily = await getDailyBarsWindowAsOf(inputs, { ticker: position.ticker, fromDate: start.dailyFromDate, asOf });
  const bars = buildBarSequence({ intraday: intraday.rows, daily: daily.rows, intradayTruncated: intraday.truncated });

  if (bars.some((b) => b.kind === "daily")) {
    // Daily-bar fallback (no intraday rows for some UTC day in the window): coarser -- a day
    // that touches both levels can only resolve as stop-first -- so log it (Adopted Pattern #11).
    console.error("checkOpenPositionExits: daily-bar fallback used for part of the exit window", {
      positionId: position.id,
      ticker: position.ticker,
      dailyBars: bars.filter((b) => b.kind === "daily").length,
      intradayBars: bars.filter((b) => b.kind === "intraday").length,
      windowStart: start.anchorIso,
      asOf,
    });
  }
  if (intraday.truncated) {
    console.error("checkOpenPositionExits: intraday window hit its row cap -- the rest is walked on the next check", {
      positionId: position.id,
      ticker: position.ticker,
      intradayBars: intraday.rows.length,
      asOf,
    });
  }

  return walkBarsForExit(position, bars, { splitGuardTolerance });
}

/**
 * `ctx` is `{ inputs, store }`: `inputs` is an inputs-DB handle (read-only is
 * enough -- pass readOnly(env.INPUTS_DB)) for price bars, `store` a RunStore
 * for the environment being checked.
 *
 * Evaluates every position open as of `asOf` and closes any that trigger a
 * stop-loss, take-profit, or `config.maxPositionHoldDays` time-based exit.
 * Returns the list of positions actually closed this run (empty if none
 * triggered) -- caller (src/index.js#scheduled) logs this rather than the
 * function doing its own logging, same separation as runScheduledIngestion.
 */
export async function checkOpenPositionExits(env, config, { inputs, store }, { asOf }) {
  // The reflection at a position close is an LLM call; route its log row to
  // this store's environment (llm_calls.env_run_id), same as the pipeline does.
  config = withLlmLogContext(config, { store });
  const openPositions = await store.getOpenPositionsAsOf({ asOf });
  const closed = [];

  for (const position of openPositions) {
    const walk = await walkPositionBars(inputs, position, { asOf, splitGuardTolerance: config.splitGuardTolerance });

    // Split guard: bars are raw/unadjusted, so a split looks like a crash. The walk already
    // stopped before the suspicious bar; log loudly on every check (Adopted Pattern #11) so an
    // operator sees it. Price exits are suppressed for this position (only the time exit can fire).
    const split = walk?.split ?? null;
    if (split) {
      console.error("checkOpenPositionExits: possible stock split in raw prices -- price-based exits suppressed", {
        positionId: position.id,
        ticker: position.ticker,
        entryPrice: position.entryPrice,
        ratio: split.ratio,
        suspected: split.kind,
        factor: split.factor,
        barKind: split.barKind,
        barOpenMs: split.barOpenMs,
        asOf,
      });
    }

    if (walk && walk.invalidBars > 0) {
      console.error("checkOpenPositionExits: bars with non-finite/inverted OHLC skipped in the exit window", {
        positionId: position.id,
        ticker: position.ticker,
        invalidBars: walk.invalidBars,
        asOf,
      });
    }

    // MAE/MFE from the walked bars' lows/highs, recorded BEFORE closing so the bar that
    // triggers a stop/target is itself counted (recordPositionExcursionRange only touches an open row).
    if (walk && (walk.maePct != null || walk.mfePct != null)) {
      await store.recordPositionExcursionRange({ id: position.id, maePct: walk.maePct, mfePct: walk.mfePct });
    }

    // Price exit found in the bars: fill at the level (or the gapped open), stamped with the
    // triggering bar's close time. The cursor is deliberately NOT advanced here.
    if (walk?.exit) {
      const { reason, exitPrice, closedAt } = walk.exit;
      const didClose = await store.closePosition({ id: position.id, closedAt, closeReason: reason, exitPrice });
      // Lost a race (commitThesis replaced it after our read): the replaced path
      // settles it with the right reason/price, so settling here would double-record.
      if (!didClose) continue;
      await settlePositionOutcome(env, config, store, { position, exitPrice, closedAt, closeReason: reason });
      closed.push({ id: position.id, ticker: position.ticker, reason });
      continue;
    }

    // No price exit: only the time-based exit remains (price exits skipped on purpose -- the
    // bars above already decided them).
    const timeExit = evaluateExit(position, {
      currentPrice: null,
      asOf,
      maxHoldDays: config.maxPositionHoldDays,
      skipPriceExits: true,
    });

    if (timeExit) {
      // Time exits close at asOf; the exit price is the current price (same resolver as
      // before). A split-suspected price is not a real exit price, so it closes with a null
      // exit price: settle skips the reflection ("return not computable") instead of
      // recording a fake -50% lesson. The current price is checked against the split ratio
      // too, in case the bars in the window were missing and the walk could not see it.
      let exitPrice = null;
      if (!split) {
        const { price } = await resolveCurrentPrice(inputs, { ticker: position.ticker, asOf });
        exitPrice = detectSplitJump(position.entryPrice, price, config.splitGuardTolerance) ? null : price;
      }
      const didClose = await store.closePosition({ id: position.id, closedAt: asOf, closeReason: timeExit.reason, exitPrice });
      if (!didClose) continue;
      await settlePositionOutcome(env, config, store, { position, exitPrice, closedAt: asOf, closeReason: timeExit.reason });
      closed.push({ id: position.id, ticker: position.ticker, reason: timeExit.reason });
      continue;
    }

    // Window evaluated, nothing fired: move the cursor to the last bar walked (never past a
    // suspected split bar -- walk.lastBarAvailableAt stops before it).
    if (walk?.lastBarAvailableAt) {
      await store.advancePositionCheck({ id: position.id, lastCheckedAt: walk.lastBarAvailableAt });
    }
  }

  return closed;
}
