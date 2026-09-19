// Closes the last link in the realized-outcome chain: once a position has
// both an entryPrice and an exitPrice (RunStore#closePosition / commitThesis's
// exitPrice), this computes the realized
// return and feeds it into reflection.js#closeTheLoop -- which already
// existed (agents/utils/memory.js#recordAndReflect) but had NO caller
// anywhere in the pipeline until now, because nothing produced a realized
// return for it to record (plan.md known gap).
//
// HONEST SCOPE: alphaReturn (return vs. a benchmark) is always null here --
// there is no benchmark price series ingested anywhere in this project yet
// (only per-ticker price_bars). fetchPriorLessons/getDecisionMemoryAsOf
// already tolerate a null alpha_return, so this is an honest partial
// implementation, not a blocking one -- wiring an actual benchmark is a
// separate, larger gap left in plan.md.
//
// Reflection generation is an LLM call (recordAndReflect -> callStructured)
// -- a failure here (model down, schema validation failure) must not crash
// the caller (checkOpenPositionExits closing OTHER positions, or the
// pipeline's replace-position branch opening a new one). Logged and
// swallowed, same Adopted Pattern #11 "surface, don't silently abort the
// whole run" convention as pipeline.js's per-source failure isolation --
// the position itself is already closed regardless of whether its
// reflection got recorded.

import { closeTheLoop } from "./reflection.js";
import { LlmBudgetExceededError } from "../shared/errors.js";

/**
 * Direction-aware realized return, same sign convention as
 * agents/risk_mgmt/exit.js#evaluateExit's changePct. Returns null (never a
 * fabricated number) when entryPrice/exitPrice is missing or direction
 * isn't 'long'/'short' -- e.g. a time_based exit fired with no price_bars
 * data for that ticker (see exit_check.js's header).
 */
function computeRealizedReturn({ direction, entryPrice, exitPrice }) {
  if (entryPrice == null || exitPrice == null) return null;
  if (direction === "long") return (exitPrice - entryPrice) / entryPrice;
  if (direction === "short") return (entryPrice - exitPrice) / entryPrice;
  return null;
}

/**
 * Called right after a position closes. `position` is the shape RunStore's
 * getOpenPositionsAsOf / getUnsettledReplacedPositions return (must include tradeThesisId, ticker, direction, entryPrice,
 * positionSizePct, openedAt). Computes the realized return from
 * `position`'s entryPrice/direction and the exitPrice just recorded, then
 * records it via closeTheLoop -- the loop fetchPriorLessons/
 * loadLessonsForDebate reads back from on a future decision for the same
 * ticker.
 *
 * Returns the reflection text on success, or null if either the return
 * couldn't be computed (see computeRealizedReturn) or closeTheLoop itself
 * failed (logged, not thrown -- see header).
 */
export async function settlePositionOutcome(env, config, store, { position, exitPrice, closedAt, closeReason }) {
  const realizedReturn = computeRealizedReturn({
    direction: position.direction,
    entryPrice: position.entryPrice,
    exitPrice,
  });

  if (realizedReturn == null) {
    console.error("settlePositionOutcome: skipping reflection -- realized return not computable", {
      tradeThesisId: position.tradeThesisId,
      ticker: position.ticker,
      direction: position.direction,
      entryPrice: position.entryPrice,
      exitPrice,
      closeReason,
    });
    return null;
  }

  const decisionSummary = {
    ticker: position.ticker,
    direction: position.direction,
    entryPrice: position.entryPrice,
    exitPrice,
    positionSizePct: position.positionSizePct,
    openedAt: position.openedAt,
    closedAt,
    closeReason,
  };

  try {
    return await closeTheLoop(env, config, store, {
      decisionId: position.tradeThesisId,
      ticker: position.ticker,
      decisionSummary,
      realizedReturn,
      alphaReturn: null, // HONEST SCOPE -- see header
      resolvedAt: closedAt,
    });
  } catch (err) {
    // A spent LLM budget is a hard stop for the whole run, not a per-position
    // reflection hiccup: let it fail the run instead of being logged away.
    if (err instanceof LlmBudgetExceededError) throw err;
    console.error("settlePositionOutcome: closeTheLoop failed -- position stays closed, no reflection recorded", {
      tradeThesisId: position.tradeThesisId,
      ticker: position.ticker,
      message: err.message,
    });
    return null;
  }
}
