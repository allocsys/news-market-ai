// Per-run LLM-call budget (plan.md "Decided (2026-09-19)": BACKTEST_MAX_LLM_CALLS,
// "the run fails when exceeded"). Cloudflare KV cooldowns isolate a backtest's
// Gemini *cooldown state* from live, but the upstream quota per key is shared,
// so a backtest also gets a hard cap on how many calls it may make.
//
// MECHANISM: one mutable counter object, `{ max, used }`, created once per run
// (runBacktest.js) and carried on `config.llmBudget`. withLlmLogContext and
// every other config helper shallow-copy `config`, so the SAME object reaches
// every agent and the count survives those copies; it is deliberately NOT
// created in loadConfig (that would be shared by every run an isolate handles).
// The single charge point is agents/utils/structured.js#callStructured -- the
// choke point all eight agents already share.
//
// SEMANTICS: `max` calls are allowed; call number max+1 throws
// LlmBudgetExceededError (and is not counted). It counts LOGICAL calls (one per
// callStructured), not the HTTP attempts inside the Gemini model/key cascade,
// so a call that retries across keys still costs 1. Live has no `llmBudget` on
// its config, so it is never capped.
//
// UNSET = NO CAP. The owner has not chosen a default. A value that is set but
// not a positive integer fails the run instead of being read as "no cap": a
// typo in a safety limit should not silently disable it.

import { LlmBudgetExceededError } from "../shared/errors.js";

/** `{ max, used: 0 }`, or null (uncapped) when `max` is unset/blank. Throws on a set-but-invalid value. */
export function createLlmBudget(max) {
  if (max === undefined || max === null || String(max).trim() === "") return null;
  const n = Number(max);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`BACKTEST_MAX_LLM_CALLS must be a positive integer, got ${JSON.stringify(max)}`);
  }
  return { max: n, used: 0 };
}

/** Counts one LLM call against `config.llmBudget` (no-op without one); throws LlmBudgetExceededError past the cap. */
export function chargeLlmCall(config) {
  const budget = config?.llmBudget;
  if (!budget) return;
  if (budget.used >= budget.max) throw new LlmBudgetExceededError(budget.max);
  budget.used++;
}
