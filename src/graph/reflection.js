// Orchestrates the reflection loop (plan.md Adopted Pattern #8) around the
// pieces that already exist: agents/utils/memory.js owns the storage-backed
// read/write + reflection generation, this file owns WHEN in the pipeline
// those get called and WHERE the result gets injected. Split this way so
// pipeline.js can stay a plain list of stages without needing to know memory
// internals.

import { fetchPriorLessons, recordAndReflect } from "../agents/utils/memory.js";

/**
 * Called before the debate stage. Fetches this ticker's prior lessons
 * (strictly before `asOf` -- see fetchPriorLessons/getDecisionMemoryAsOf for
 * the enforced cutoff) and returns them ready to pass as
 * runResearchManager's `priorLessons` param.
 */
export async function loadLessonsForDebate(store, { ticker, asOf }) {
  return fetchPriorLessons(store, { ticker, asOf });
}

/**
 * Called once a decision's real-world outcome is known (NOT part of the
 * live/backtest decision path itself -- this runs later, from whatever job
 * computes realized/alpha return, e.g. a follow-up cron tick or the backtest
 * harness settling a simulated position).
 */
export async function closeTheLoop(env, config, store, { decisionId, ticker, decisionSummary, realizedReturn, alphaReturn, resolvedAt }) {
  return recordAndReflect(env, config, store, {
    id: `${decisionId}|reflection`,
    decisionId,
    ticker,
    decisionSummary,
    realizedReturn,
    alphaReturn,
    resolvedAt,
  });
}
