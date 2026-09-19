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
// HONEST SCOPE: currentPrice comes from storage/d1.js#getPriceBarsAsOf,
// which reads the price_bars table -- but yfinance ingestion is not yet
// wired into graph/pipeline.js (separate, already-documented plan.md gap).
// So in practice price_bars will be empty for most/all tickers until that
// lands, and this function will only be able to fire time-based exits
// until then -- an honest degradation per evaluateExit's own null-price
// handling, not a silent one. Not yet exercised against real price data
// for the same reason.

import { getOpenPositionsAsOf, getPriceBarsAsOf, closePosition } from "../storage/d1.js";
import { evaluateExit } from "../agents/risk_mgmt/exit.js";
import { settlePositionOutcome } from "./settle.js";
import { LookaheadViolationError } from "../shared/errors.js";

// Clock-skew slack for the future-asOf guard below (the cron tick computes
// asOf in `backend`, this runs in `llm` a queue hop later).
const FUTURE_ASOF_TOLERANCE_MS = 60_000;

/**
 * Evaluates every position open as of `asOf` and closes any that trigger a
 * stop-loss, take-profit, or `config.maxPositionHoldDays` time-based exit.
 * Returns the list of positions actually closed this run (empty if none
 * triggered) -- caller (src/index.js#scheduled) logs this rather than the
 * function doing its own logging, same separation as runScheduledIngestion.
 */
export async function checkOpenPositionExits(env, config, db, { asOf }) {
  // A simulated or scheduled "now" can never be in the future: closing
  // positions at a future date writes future-dated closed_at/resolved_at
  // rows that then read as still-open to the portfolio ceiling check and as
  // closed on the dashboard (plan.md "Backtest / Live Isolation").
  // `config.nowMs` is a test-only clock override.
  const nowMs = typeof config?.nowMs === "number" ? config.nowMs : Date.now();
  if (new Date(asOf).getTime() > nowMs + FUTURE_ASOF_TOLERANCE_MS) {
    throw new LookaheadViolationError(`checkOpenPositionExits: asOf ${asOf} is in the future -- refusing to close positions at a date that has not happened`);
  }

  const openPositions = await getOpenPositionsAsOf(db, { asOf });
  const closed = [];

  for (const position of openPositions) {
    const bars = await getPriceBarsAsOf(db, { ticker: position.ticker, asOf, limit: 1 });
    const currentPrice = bars[0]?.close ?? null;

    const exit = evaluateExit(position, {
      currentPrice,
      asOf,
      maxHoldDays: config.maxPositionHoldDays,
    });

    if (exit) {
      // currentPrice IS the exit price -- it's the same bar that triggered
      // this exit decision (or null for a time_based exit with no price
      // data, same honest-gap convention evaluateExit already follows).
      await closePosition(db, { id: position.id, closedAt: asOf, closeReason: exit.reason, exitPrice: currentPrice });
      await settlePositionOutcome(env, config, db, { position, exitPrice: currentPrice, closedAt: asOf, closeReason: exit.reason });
      closed.push({ id: position.id, ticker: position.ticker, reason: exit.reason });
    }
  }

  return closed;
}
