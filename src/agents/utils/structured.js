// Shared agent tooling (plan.md Adopted Pattern #4: shared structured
// schemas everywhere). Extracts the "call Gemini -> stripJsonFence ->
// JSON.parse -> zod .parse()" sequence that was previously copy-pasted
// across agents/managers/research_manager.js, agents/trader/trader.js, and
// both analysts -- one implementation instead of four, so a fix (e.g.
// better JSON-repair on malformed model output) only has to happen once.

import { geminiGenerateText, stripJsonFence } from "../../llm/gemini/client.js";

/**
 * Calls Gemini with `prompt`, strips markdown JSON fences, parses the JSON,
 * and validates the result against `schema` (a zod schema), merged with any
 * `extraFields` the caller already knows (e.g. ticker/asOf/newsItemId) so
 * the model doesn't have to echo values back that we already have.
 *
 * Deliberately does NOT swallow parse/validation errors -- a schema
 * mismatch usually means the prompt or model output shape changed in a way
 * worth surfacing, not silently recovering from.
 */
export async function callStructured(env, config, schema, prompt, { model, extraFields = {} } = {}) {
  const text = await geminiGenerateText(env, config, prompt, { model });
  const parsed = JSON.parse(stripJsonFence(text));
  return schema.parse({ ...extraFields, ...parsed });
}
