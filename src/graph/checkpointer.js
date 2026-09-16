// Checkpoint/resume (plan.md Adopted Pattern #12). Thin, stage-order-aware
// layer over storage/d1.js's saveCheckpoint/getCheckpoint -- this file owns
// "what order do stages run in and what's next", storage/d1.js owns "how do
// we persist a row". Keeping the order here (not in pipeline.js) means
// conditional_logic.js and pipeline.js can both ask "what's after X" without
// duplicating the list.

import { saveCheckpoint, getCheckpoint } from "../storage/d1.js";

export const STAGES = ["ingested", "analyzed", "debated", "traded", "risk_checked", "portfolio_checked"];

export function nextStage(currentStage) {
  if (currentStage == null) return STAGES[0];
  const i = STAGES.indexOf(currentStage);
  if (i === -1) throw new Error(`checkpointer: unknown stage "${currentStage}"`);
  return STAGES[i + 1] ?? null; // null means the run already completed all stages
}

/** Records that `stage` just completed for (runId, ticker), with its output attached so a resume doesn't recompute it. */
export async function checkpoint(db, { runId, ticker, stage, state }) {
  await saveCheckpoint(db, { runId, ticker, stage, state });
}

/** Where should a resumed run for (runId, ticker) start? Returns { stage: null, state: null } for a brand-new run. */
export async function resumeFrom(db, { runId, ticker }) {
  const existing = await getCheckpoint(db, { runId, ticker });
  if (!existing) return { stage: null, state: null };
  return { stage: nextStage(existing.stage), state: existing.state };
}
