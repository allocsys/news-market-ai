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
// HONEST SCOPE: currentPrice comes from inputs_view.js#getPriceBarsAsOf,
// which reads the price_bars table -- populated by Tiingo ingestion (plan.md
// "Price data sources"; yfinance was dropped 2026-09-20 after Yahoo 429'd
// every Workers-egress call, Tiingo has been the live bar source since
// 2026-09-21). Stop-loss/take-profit exits can fire for any ticker Tiingo
// has backfilled bars for; a ticker with no bars yet still falls back to
// evaluateExit's null-price handling and only the time-based exit can
// trigger for it -- an honest per-ticker degradation, not a blanket one.

import { resolveCurrentPrice } from "./price_resolution.js";
import { evaluateExit } from "../agents/risk_mgmt/exit.js";
import { settlePositionOutcome } from "./settle.js";
import { withLlmLogContext } from "../storage/llm_calls.js";

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

    const exit = evaluateExit(position, {
      currentPrice,
      asOf,
      maxHoldDays: config.maxPositionHoldDays,
    });

    if (exit) {
      // currentPrice IS the exit price -- it's the same bar that triggered
      // this exit decision (or null for a time_based exit with no price
      // data, same honest-gap convention evaluateExit already follows).
      await store.closePosition({ id: position.id, closedAt: asOf, closeReason: exit.reason, exitPrice: currentPrice });
      await settlePositionOutcome(env, config, store, { position, exitPrice: currentPrice, closedAt: asOf, closeReason: exit.reason });
      closed.push({ id: position.id, ticker: position.ticker, reason: exit.reason });
    }
  }

  return closed;
}
