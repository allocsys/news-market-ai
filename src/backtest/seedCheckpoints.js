// TEMPORARY tuning aid (opt-in `seedFromRunId` on POST /backtest/run): start a backtest from another COMPLETE
// run's LLM-stage checkpoints instead of calling the model again for every news item.
//
// WHY: two runs with identical LLM-stage settings still disagree on direction for ~1 item in 4 (LLM sampling +
// lessons carried between trades), which swamps the effect of exit/gate knobs. Seeding makes a preset run see the
// SAME analyst/debate/trader output as its source, so only the deterministic stages (risk, portfolio, range filter,
// entry confirmation, fills, exits) differ. It is for tuning/A-B comparison only: it fixes ONE LLM draw, so it cannot
// show robustness to LLM variation. Confirm a winning setting with fresh, unseeded runs before trusting it.
//
// HOW: pipeline_checkpoints rows are keyed (run_id, pipeline_run_id, ticker), and pipelineRunId is
// `${testStart}|${ticker}|${newsItemId}` (onSignalRunner.js), independent of the run id. So copying the source's rows
// under the new run id makes runPipelineForTicker resume each item from its checkpoint. A `portfolio_checked` row counts
// as FINISHED (the cached decision is returned), so it is downgraded: with a verdict -> 'traded' (risk + portfolio re-run on
// the cached trader output); without one (a no-price-impact skip) -> 'analyzed' (the price-impact gate re-skips it, no
// model call). Range-filter / entry-confirmation evidence from the source is stripped so it cannot linger.
//
// What still calls the model: one reflection per closed position (graph/settle.js). Those reflections are never read
// by a seeded run, because every debate is cached.
//
// SAFETY: the target run must use the same LLM-stage settings as the source (SEED_MATCH_KNOBS), the same testStart
// (it is part of the checkpoint key) and a subset of its tickers; otherwise the cached outputs would not be what the run
// would have produced, and the run is refused before any model call. Idempotent (ON CONFLICT DO NOTHING), so a redelivered
// part 1 never overwrites progress.

import { getBacktestRun } from "../storage/sim_registry.js";

/** Knobs that change the LLM stages (or the price-impact skip): source and target must agree on every one. */
export const SEED_MATCH_KNOBS = Object.freeze(["mergedVerdict", "macroEnabled", "intradayTechnical", "independenceNote", "skipNoPriceImpact", "hideSma"]);

/** A knob value as on/off. A missing skipNoPriceImpact means ON (the gate's default); every other missing knob means OFF. */
function knobOn(name, value) {
  if (name === "skipNoPriceImpact") return value !== false && value !== 0;
  return value === true || value === 1;
}

/** Names in SEED_MATCH_KNOBS where the two effective-knob objects disagree (empty = compatible). */
export function seedKnobMismatches(sourceKnobs, targetKnobs) {
  return SEED_MATCH_KNOBS.filter((name) => knobOn(name, sourceKnobs?.[name]) !== knobOn(name, targetKnobs?.[name]));
}

/**
 * The source-run checks that need no knob values: exists, complete, same testStart, covers every requested ticker.
 * `source` is getBacktestRun's row (or null). Returns an error message or null.
 */
export function checkSeedSource(source, { sourceId, testStart, tickers }) {
  if (!source) return `seedFromRunId ${sourceId}: run not found`;
  if (source.status !== "complete") return `seedFromRunId ${sourceId}: run is ${source.status}, not complete`;
  if (source.testStart !== testStart) return `seedFromRunId ${sourceId}: testStart ${source.testStart} differs from this run's ${testStart} (checkpoint keys include it)`;
  const missing = tickers.filter((t) => !source.tickers.includes(t));
  if (missing.length > 0) return `seedFromRunId ${sourceId}: run did not cover ${missing.join(", ")}`;
  return null;
}

/**
 * Copies `sourceId`'s checkpoints for `tickers` under `targetId` (see the header). `knobs` = effectiveKnobs of THIS run's config.
 * Returns `{ error }` (nothing copied) or `{ seeded: <rows copied> }`. Never throws for a refused seed; D1 errors propagate.
 */
export async function seedCheckpointsFromRun(db, { sourceId, targetId, testStart, tickers, knobs, now = new Date().toISOString() }) {
  if (!sourceId || sourceId === targetId) return { error: "seedFromRunId must name a different, finished run" };
  const source = await getBacktestRun(db, sourceId);
  const sourceError = checkSeedSource(source, { sourceId, testStart, tickers });
  if (sourceError) return { error: sourceError };
  if (!source.result?.knobs) return { error: `seedFromRunId ${sourceId}: run has no recorded knobs, cannot verify it matches` };
  const mismatched = seedKnobMismatches(source.result.knobs, knobs);
  if (mismatched.length > 0) {
    return { error: `seedFromRunId ${sourceId}: LLM-stage settings differ from the source run (${mismatched.join(", ")}); the cached model output would not be what this run produces` };
  }

  const placeholders = tickers.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `INSERT INTO pipeline_checkpoints (run_id, pipeline_run_id, ticker, stage, state, updated_at)
       SELECT ?, pipeline_run_id, ticker,
              CASE WHEN stage = 'portfolio_checked'
                   THEN CASE WHEN json_extract(state, '$.verdict') IS NULL THEN 'analyzed' ELSE 'traded' END
                   ELSE stage END,
              json_remove(state, '$.evidence.rangeFilter', '$.evidence.entryConfirmation'),
              ?
       FROM pipeline_checkpoints
       WHERE run_id = ? AND substr(pipeline_run_id, 1, ?) = ? AND state IS NOT NULL AND ticker IN (${placeholders})
       ON CONFLICT(run_id, pipeline_run_id, ticker) DO NOTHING`
    )
    .bind(targetId, now, sourceId, testStart.length + 1, `${testStart}|`, ...tickers)
    .run();
  return { seeded: result.meta?.changes ?? result.meta?.rows_written ?? 0 };
}
