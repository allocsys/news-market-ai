// Checkpoint/resume (plan.md Adopted Pattern #12). Thin, stage-order-aware
// layer over RunStore's saveCheckpoint/getCheckpoint -- this file owns
// "what order do stages run in and what's next", storage/run_store.js owns
// "how do we persist a row" (scoped to the store's environment run_id).
// `pipelineRunId` is the per-(news item, ticker) pipeline execution, NOT the
// environment -- see migrations/state/0001_init.sql's NAMING note. Keeping the order here (not in pipeline.js) means
// conditional_logic.js and pipeline.js can both ask "what's after X" without
// duplicating the list.

export const STAGES = ["ingested", "analyzed", "debated", "traded", "risk_checked", "portfolio_checked"];

export function nextStage(currentStage) {
  if (currentStage == null) return STAGES[0];
  const i = STAGES.indexOf(currentStage);
  if (i === -1) throw new Error(`checkpointer: unknown stage "${currentStage}"`);
  return STAGES[i + 1] ?? null; // null means the run already completed all stages
}

/** Records that `stage` just completed for (pipelineRunId, ticker), with its output attached so a resume doesn't recompute it. `store` is a RunStore. */
export async function checkpoint(store, { pipelineRunId, ticker, stage, state }) {
  await store.saveCheckpoint({ pipelineRunId, ticker, stage, state });
}

/** Where should a resumed run for (pipelineRunId, ticker) start? Returns { stage: null, state: null } for a brand-new run. */
export async function resumeFrom(store, { pipelineRunId, ticker }) {
  const existing = await store.getCheckpoint({ pipelineRunId, ticker });
  if (!existing) return { stage: null, state: null };
  return { stage: nextStage(existing.stage), state: existing.state };
}
