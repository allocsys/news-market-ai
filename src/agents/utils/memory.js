// Reflection/memory loop (plan.md Adopted Pattern #8), restructured into
// agents/utils/ as shared agent tooling rather than being embedded inside
// any single agent. Wraps storage/d1.js's decision_memory read/write so
// agents never touch that table directly, and adds the one piece storage
// doesn't own: turning a realized outcome into a short natural-language
// reflection via the quick model (this is a summarization task, not a
// reasoning-quality one, so it doesn't need the deep model).
//
// CRITICAL: fetchPriorLessons requires an explicit `asOf` and passes it
// straight through to getDecisionMemoryAsOf's own enforced cutoff -- see
// plan.md Backtesting Integrity point 4. This file must never grow a
// "give me all reflections" path with no asOf, for the same reason
// storage/d1.js never grew one either.

import { getDecisionMemoryAsOf, recordDecisionOutcome } from "../../storage/d1.js";
import { callStructured } from "./structured.js";
import { z } from "zod";

const Reflection = z.object({ reflection: z.string() });

/**
 * Fetches prior same-ticker decision outcomes strictly before `asOf`,
 * formatted as plain text ready to inject into an analyst/researcher/trader
 * prompt. Returns "" (not null) when there's no history yet, so callers can
 * always safely append the result to a prompt.
 */
export async function fetchPriorLessons(db, { ticker, asOf, limit = 5 }) {
  const rows = await getDecisionMemoryAsOf(db, { ticker, asOf, limit });
  if (rows.length === 0) return "";

  const lines = rows.map(
    (r) => `- ${r.resolved_at}: realized_return=${r.realized_return}, alpha_return=${r.alpha_return} -- ${r.reflection ?? "(no reflection recorded)"}`
  );
  return `Prior lessons for ${ticker} (most recent first, all strictly before ${asOf}):\n${lines.join("\n")}`;
}

/**
 * Once a decision's outcome is known (realized + alpha return computed
 * elsewhere, e.g. by the backtest harness or a live P&L job), generates a
 * short reflection and persists it. `resolvedAt` must be the timestamp the
 * outcome became knowable -- this is what fetchPriorLessons's asOf cutoff
 * checks against, so getting it right is what keeps the loop leak-free.
 */
export async function recordAndReflect(env, config, db, { id, decisionId, ticker, decisionSummary, realizedReturn, alphaReturn, resolvedAt }) {
  const prompt = `A trade decision for ${ticker} has resolved. Write ONE short sentence \
reflecting on what worked or didn't -- this will be shown to a future version of yourself \
before a similar decision. Be specific and actionable, not generic.

Respond as JSON only, matching exactly:
{ "reflection": string }

Decision: ${JSON.stringify(decisionSummary)}
Realized return: ${realizedReturn}
Alpha (vs. benchmark): ${alphaReturn}`;

  const { reflection } = await callStructured(env, config, Reflection, prompt, { model: config.geminiQuickModel, label: "reflection", ticker });

  await recordDecisionOutcome(db, { id, decisionId, ticker, realizedReturn, alphaReturn, reflection, resolvedAt });
  return reflection;
}
