// Exit-check orchestration -- closes the plan.md positions known-gap:
// "closePosition has no caller yet -- exit logic (stop-loss/take-profit/
// time-based) doesn't exist, so once opened a position stays open
// forever." Runs agents/risk_mgmt/exit.js#evaluateExit's deterministic
// rules against every currently open position and closes the ones that
// trigger.
//
// This is a portfolio-level periodic check, not a per-news-item stage like
// runPipelineForTicker -- it has no natural checkpoint/resume state of its
// own (each position is judged independently and closePosition's `closed_at
// IS NULL` guard already makes re-running this function harmless/idempotent
// on a position that already closed).
//
// HONEST SCOPE: currentPrice comes from graph/price_resolution.js#resolveCurrentPrice
// (plan.md finding G step 4) -- the intraday reader (price_bars_intraday,
// Alpaca/Twelve Data) when a bar is visible at `asOf`, else the previous UTC
// day's daily close (price_bars, Tiingo-populated; yfinance was dropped
// 2026-09-20 after Yahoo 429'd every Workers-egress call, Tiingo has been the
// live daily bar source since 2026-09-21) -- logged whenever the daily
// fallback is used (Adopted Pattern #11). Stop-loss/take-profit exits can
// fire for any ticker either source has bars for; a ticker with neither
// still falls back to evaluateExit's null-price handling and only the
// time-based exit can trigger for it -- an honest per-ticker degradation,
// not a blanket one.

import { resolveCurrentPrice } from "./price_resolution.js";
import { evaluateExit } from "../agents/risk_mgmt/exit.js";
import { settlePositionOutcome } from "./settle.js";
import { withLlmLogContext } from "../storage/llm_calls.js";
import { detectSplitJump } from "../shared/split_guard.js";
import { computeGrossReturn } from "../shared/returns.js";

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
    // Finding G step 4: intraday-first, daily-close fallback (see
    // graph/price_resolution.js) -- same swap as pipeline.js's
    // portfolio_checked stage, so a stop-loss/take-profit check made later
    // the same day a position opened sees a real, current price rather than
    // the previous day's stale close.
    const { price: currentPrice } = await resolveCurrentPrice(inputs, { ticker: position.ticker, asOf });

    // Split guard: bars are raw/unadjusted, so a split looks like a crash.
    // When entry->current matches a split ratio, don't trust the price: skip
    // stop-loss/take-profit (only the time exit can fire) and log loudly on
    // every check (Adopted Pattern #11) so an operator sees it.
    const split = detectSplitJump(position.entryPrice, currentPrice, config.splitGuardTolerance);
    if (split) {
      console.error("checkOpenPositionExits: possible stock split in raw prices -- price-based exits suppressed", {
        positionId: position.id,
        ticker: position.ticker,
        entryPrice: position.entryPrice,
        currentPrice,
        ratio: split.ratio,
        suspected: split.kind,
        factor: split.factor,
        asOf,
      });
    }

    // MAE/MFE: fold this check's gross return into the position's running
    // excursion extremes BEFORE evaluating exits, so the bar that triggers a
    // stop/take-profit is itself counted. A split-suspected price is not a real
    // price, so it is never sampled; a missing price/entry/direction yields a
    // null return and is skipped (recordPositionExcursion ignores non-finite).
    // Sampled at check cadence from one price, not intrabar highs/lows.
    if (!split) {
      const returnPct = computeGrossReturn({ direction: position.direction, entryPrice: position.entryPrice, exitPrice: currentPrice });
      if (returnPct != null) await store.recordPositionExcursion({ id: position.id, returnPct });
    }

    const exit = evaluateExit(position, {
      currentPrice,
      asOf,
      maxHoldDays: config.maxPositionHoldDays,
      skipPriceExits: split != null,
    });

    if (exit) {
      // currentPrice IS the exit price -- it's the same bar that triggered
      // this exit decision (or null for a time_based exit with no price
      // data, same honest-gap convention evaluateExit already follows). A
      // split-suspected price is not a real exit price, so a time exit under
      // suspicion closes with a null exit price: settle skips the reflection
      // ("return not computable") instead of recording a fake -50% lesson.
      const exitPrice = split ? null : currentPrice;
      const didClose = await store.closePosition({ id: position.id, closedAt: asOf, closeReason: exit.reason, exitPrice });
      // Lost a race (commitThesis replaced it after our read): the replaced path
      // settles it with the right reason/price, so settling here would double-record.
      if (!didClose) continue;
      await settlePositionOutcome(env, config, store, { position, exitPrice, closedAt: asOf, closeReason: exit.reason });
      closed.push({ id: position.id, ticker: position.ticker, reason: exit.reason });
    }
  }

  return closed;
}
