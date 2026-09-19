// Shared agent tooling (plan.md Adopted Pattern #4: shared structured
// schemas everywhere). Extracts the "call Gemini -> stripJsonFence ->
// JSON.parse -> zod .parse()" sequence that was previously copy-pasted
// across agents/managers/research_manager.js, agents/trader/trader.js, and
// both analysts -- one implementation instead of four, so a fix (e.g.
// better JSON-repair on malformed model output) only has to happen once.

import { geminiGenerateText, stripJsonFence } from "../../llm/gemini/client.js";
import { recordLlmCall } from "../../storage/llm_calls.js";

/**
 * Fake-model injection point (plan.md open item, closed 2026-09-17). Every
 * agent (analysts, researchers, research_manager, trader, memory.js's
 * recordAndReflect) calls callStructured with the same (env, config, ...)
 * shape, so `config.fakeModel` -- if set -- is checked here, BEFORE the
 * real Gemini cascade, rather than adding a new param to every one of
 * those call sites individually. This is what unblocks a true end-to-end
 * test of the LLM-call path (checkpoint/resume across the full pipeline,
 * memory's write path, an analyst's "has data" path) without mocking
 * global.fetch and hand-reconstructing Gemini's response envelope --
 * previously the only way in (see technical_analyst.test.js's own fetch-
 * mock test, predating this).
 *
 * Contract: `config.fakeModel(prompt, { model, schema, extraFields, env,
 * config })` must return a JSON string (may be ```json-fenced, same as a
 * real model's output) -- it goes through the exact same stripJsonFence +
 * JSON.parse + schema.parse path below as a real Gemini response, so a
 * fake model that returns a shape the schema rejects fails a test exactly
 * the way a real prompt/schema mismatch would. Receiving `schema` lets a
 * test dispatch on the exact schema object reference (e.g. `schema ===
 * DebateSide`) rather than string-matching the prompt, and `extraFields`
 * (e.g. `{agent: "sentiment"}` or `{stance: "bull"}`) disambiguates two
 * agents that share one schema.
 *
 * Undefined by default -- config.js's loadConfig never sets this key, so
 * every production call falls through to the real geminiGenerateText call
 * below, unchanged.
 */
async function generateText(env, config, prompt, { model, schema, extraFields, trace } = {}) {
  if (config.fakeModel) {
    const text = await config.fakeModel(prompt, { model: model || config.geminiQuickModel, schema, extraFields, env, config });
    if (trace) trace.modelUsed = "fake";
    return text;
  }
  return geminiGenerateText(env, config, prompt, { model, trace });
}

/**
 * Calls Gemini with `prompt`, strips markdown JSON fences, parses the JSON,
 * and validates the result against `schema` (a zod schema), merged with any
 * `extraFields` the caller already knows (e.g. ticker/asOf/newsItemId) so
 * the model doesn't have to echo values back that we already have.
 *
 * Deliberately does NOT swallow parse/validation errors -- a schema
 * mismatch usually means the prompt or model output shape changed in a way
 * worth surfacing, not silently recovering from.
 *
 * LLM CALL LOG (storage/llm_calls.js): every call -- success, vendor
 * failure, unparseable JSON, schema mismatch -- is recorded with the exact
 * prompt sent and raw text received, for the dashboard's "LLM calls" page.
 * That happens here, at the one choke point all eight agents share, so no
 * agent needs its own logging. `label` says which agent this call is (shown
 * on the page); `ticker` overrides the ticker from config.llmLog (which
 * runPipelineForTicker sets) for callers outside a pipeline run, e.g. the
 * reflection at position close. Logging is best-effort and never changes what
 * this function returns or throws.
 */
export async function callStructured(env, config, schema, prompt, { model, extraFields = {}, label, ticker } = {}) {
  const requestedModel = model || config.geminiQuickModel;
  const trace = {};
  const startedAt = Date.now();
  const log = (fields) =>
    recordLlmCall(config, {
      label,
      ticker,
      requestedModel,
      modelUsed: trace.modelUsed,
      keyIndex: trace.keyIndex,
      attempts: trace.attempts,
      durationMs: Date.now() - startedAt,
      prompt,
      ...fields,
    });

  let text;
  try {
    text = await generateText(env, config, prompt, { model, schema, extraFields, trace });
  } catch (err) {
    await log({ status: "error", errorStage: "vendor", error: err?.message ?? String(err), response: null });
    throw err;
  }

  let result;
  try {
    const parsed = JSON.parse(stripJsonFence(text));
    result = schema.parse({ ...extraFields, ...parsed });
  } catch (err) {
    await log({ status: "error", errorStage: err?.name === "ZodError" ? "validation" : "parse", error: err?.message ?? String(err), response: text });
    throw err;
  }

  await log({ status: "ok", response: text });
  return result;
}
