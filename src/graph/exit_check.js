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
// TIME EXIT. agents/risk_mgmt/exit.js#evaluateExit decides WHEN (price exits skipped); the
// price is the OPEN of the first bar at/after the instant the hold limit was reached
// (exit.js#timeExitDueAt, graph/bar_fill.js), stamped closedAt = that bar's open -- the same
// rule as a pending entry's fill, so an exit is never priced at a stale close nobody could
// trade. While no such bar is visible yet (market shut, bars not ingested) the position stays
// open and the next check retries; after 5 days with no bar it closes at `asOf` at
// graph/price_resolution.js#resolveCurrentPrice (the legacy price, possibly null) so a ticker
// with no data cannot stay open forever. The price walk is capped at the due instant, so a
// bar after it can never trigger a stop/target on a position that should already be gone.
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
import { evaluateExit, timeExitDueAt } from "../agents/risk_mgmt/exit.js";
import { exitLevels, walkBarsForExit } from "../agents/risk_mgmt/exit_bars.js";
import { resolveTrailingConfig } from "../agents/risk_mgmt/trailing.js";
import { settlePositionOutcome } from "./settle.js";
import { withLlmLogContext } from "../storage/llm_calls.js";
import { getDailyBarsWindowAsOf, getIntradayBarsWindowAsOf } from "../storage/inputs_view.js";
import { buildBarSequence, exitWindowStart } from "../shared/bar_window.js";
import { detectSplitJump } from "../shared/split_guard.js";
import { findFirstBarOpenAtOrAfter } from "./bar_fill.js";
import { PENDING_ENTRY_EXPIRY_MS } from "../shared/entry_timing.js";

/**
 * Reads the position's bar window (intraday + daily, both asOf-gated) and walks
 * it. Returns the walkBarsForExit result, or `null` when there is nothing to walk:
 * no computable stop/target levels (skips the reads entirely), or a cursor /
 * opened_at that does not parse (logged; a date that cannot be computed is never
 * turned into "the beginning of time").
 */
async function walkPositionBars(inputs, position, { asOf, splitGuardTolerance, trailing = null, dailyBothTouchedNearestOpen = 0 }) {
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

  return walkBarsForExit(position, bars, { splitGuardTolerance, trailing, dailyBothTouchedNearestOpen });
}

/**
 * Records MAE/MFE for a position that is about to be closed by something OTHER than an exit check
 * (commitThesis 'flipped' / 'replaced'), so a position closed before any check saw it is not left
 * with empty excursions. Walks the same bar window as checkOpenPositionExits (cursor ?? opened_at
 * up to `asOf`, asOf-gated) and writes only the excursion: it never closes the position and never
 * moves the cursor, so it cannot change any exit outcome. Call it BEFORE the closing write
 * (recordPositionExcursionRange only touches an open row). Idempotent (MIN/MAX), so a
 * checkpoint-resumed re-run is harmless. Returns true when an excursion was written.
 */
export async function recordExcursionBeforeClose(config, { inputs, store }, position, { asOf }) {
  const walk = await walkPositionBars(inputs, position, { asOf, splitGuardTolerance: config.splitGuardTolerance });
  if (!walk || (walk.maePct == null && walk.mfePct == null)) return false;
  await store.recordPositionExcursionRange({ id: position.id, maePct: walk.maePct, mfePct: walk.mfePct });
  return true;
}

/**
 * Where a due time exit fills: `{ exitPrice, closedAt }` to close now, or `null` to wait for the
 * next check. `dueAt` is exit.js#timeExitDueAt (null -> legacy pricing). A fill price that looks
 * like a stock split is not a real exit price and closes with a null exit price (settle skips the
 * reflection), same as the legacy path.
 */
async function resolveTimeExitFill(inputs, position, { asOf, dueAt, splitGuardTolerance }) {
  const dueMs = dueAt == null ? Number.NaN : Date.parse(dueAt);
  if (!Number.isNaN(dueMs)) {
    const fill = await findFirstBarOpenAtOrAfter(inputs, { ticker: position.ticker, from: dueAt, asOf });
    if (fill) {
      const exitPrice = detectSplitJump(position.entryPrice, fill.price, splitGuardTolerance) ? null : fill.price;
      return { exitPrice, closedAt: fill.openedAt };
    }
    // No tradable bar yet: wait (quietly -- this is the normal overnight/weekend state, every 15 min).
    if (Date.parse(asOf) - dueMs <= PENDING_ENTRY_EXPIRY_MS) return null;
  }
  const { price } = await resolveCurrentPrice(inputs, { ticker: position.ticker, asOf });
  const exitPrice = detectSplitJump(position.entryPrice, price, splitGuardTolerance) ? null : price;
  return { exitPrice, closedAt: asOf };
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
  // Break-even / trailing stop (config.breakEvenTriggerR / trailActivationR / trailDistanceR); null = off, and the
  // walk below is then exactly the static stop/target walk. recordExcursionBeforeClose deliberately walks WITHOUT it:
  // it only records excursions, which must not be cut short by a ratcheted stop.
  const trailing = resolveTrailingConfig(config);

  for (const position of openPositions) {
    // Once the time exit is due, the price walk stops at that instant: bars after it must not be
    // able to stop/target out a position that the hold rule has already ended (and in the daily
    // backtest walk the due day's own bars are visible by the time the exit is priced).
    const dueAt = config.maxPositionHoldDays != null ? timeExitDueAt(position.openedAt, config.maxPositionHoldDays) : null;
    const timeDue = dueAt != null && Date.parse(dueAt) <= Date.parse(asOf);
    const walk = await walkPositionBars(inputs, position, {
      asOf: timeDue ? dueAt : asOf,
      splitGuardTolerance: config.splitGuardTolerance,
      trailing,
      dailyBothTouchedNearestOpen: config.dailyBothTouchedNearestOpen,
    });

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
    // Running extremes INCLUDING this window (the stored values were read before the walk), handed to
    // settle so the reflection knows how far the trade went against / for us. null = never sampled.
    const excursion = {
      maePct: position.maePct == null && walk?.maePct == null ? null : Math.min(position.maePct ?? 0, walk?.maePct ?? 0),
      mfePct: position.mfePct == null && walk?.mfePct == null ? null : Math.max(position.mfePct ?? 0, walk?.mfePct ?? 0),
    };

    // Price exit found in the bars: fill at the level (or the gapped open), stamped with the
    // triggering bar's close time. The cursor is deliberately NOT advanced here.
    if (walk?.exit) {
      const { reason, exitPrice, closedAt: barClosedAt } = walk.exit;
      if (walk.exit.ambiguous) {
        // A daily bar (no intraday rows that day) touched both stop and target: the order inside it is unknowable.
        // Loud so the share of such exits in a run is countable (Adopted Pattern #11); see exit_bars.js DAILY-BAR AMBIGUITY.
        console.error("checkOpenPositionExits: exit on a daily bar that touched both stop and target -- order unknown", {
          positionId: position.id,
          ticker: position.ticker,
          reason,
          nearestOpenRule: Number(config.dailyBothTouchedNearestOpen) > 0,
          barOpenMs: walk.exit.barOpenMs,
          asOf,
        });
      }
      // positions.closed_at is compared as a STRING against asOf (getOpenPositionsAsOf, getRealizedPnlPctAsOf),
      // and asOf everywhere is toISOString() form ("...:00.000Z"). The bar's canonical "...:00Z" sorts AFTER
      // that ('.' < 'Z'), so a daily bar closing exactly at asOf would still read as open at asOf. Store the
      // same instant in the ms form, which compares as closed (never wrongly open).
      const closedAt = new Date(Date.parse(barClosedAt)).toISOString();
      const didClose = await store.closePosition({ id: position.id, closedAt, closeReason: reason, exitPrice });
      // Lost a race (commitThesis replaced it after our read): the replaced path
      // settles it with the right reason/price, so settling here would double-record.
      if (!didClose) continue;
      await settlePositionOutcome(env, config, store, { position, exitPrice, closedAt, closeReason: reason, excursion });
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
      // Fills at the first bar open after the due instant (resolveTimeExitFill), or waits for one.
      // A split-suspected price is not a real exit price, so it closes at asOf with a null exit
      // price: settle skips the reflection ("return not computable") instead of recording a fake
      // -50% lesson. The fill price is checked against the split ratio too, in case the bars in
      // the window were missing and the walk could not see it.
      const fill = split
        ? { exitPrice: null, closedAt: asOf }
        : await resolveTimeExitFill(inputs, position, { asOf, dueAt, splitGuardTolerance: config.splitGuardTolerance });
      if (fill) {
        const { exitPrice, closedAt } = fill;
        const didClose = await store.closePosition({ id: position.id, closedAt, closeReason: timeExit.reason, exitPrice });
        if (!didClose) continue;
        await settlePositionOutcome(env, config, store, { position, exitPrice, closedAt, closeReason: timeExit.reason, excursion });
        closed.push({ id: position.id, ticker: position.ticker, reason: timeExit.reason });
        continue;
      }
      // No tradable bar yet: stay open, fall through to the cursor advance, retry next check.
    }

    // Window evaluated, nothing fired: move the cursor to the last bar walked (never past a
    // suspected split bar -- walk.lastBarAvailableAt stops before it). The same UPDATE stores that
    // window's last valid close as the position's mark (positions.last_price, for the breaker's unrealized P&L)
    // and, when break-even/trailing is on, the new high-water mark (positions.peak_price): no extra D1 call, and
    // never a split-suspected price.
    if (walk?.lastBarAvailableAt) {
      await store.advancePositionCheck({ id: position.id, lastCheckedAt: walk.lastBarAvailableAt, lastPrice: walk.lastClose, peakPrice: walk.peakPrice });
    }
  }

  return closed;
}
