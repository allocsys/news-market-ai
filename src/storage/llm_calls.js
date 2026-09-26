// LLM call log (the `llm_calls` table in migrations/state/): what was sent to
// Gemini and what came back, for the automatic pipeline and manual backtests
// alike.
//
//   WRITE  agents/utils/structured.js#callStructured -> recordLlmCall, in the
//          `llm` Worker only.
//   READ   `backend`'s /api/llm-calls (src/dashboard/api.js) -> the dashboard's
//          "LLM calls" page. `dashboard` never touches D1 itself.
//
// M2b: this module holds NO SQL. The table lives in the state schema, so every
// statement against it is a RunStore method (storage/run_store.js:
// insertLlmCall / pruneLlmCalls / getRecentLlmCalls / getLlmCall), scoped by
// the store's env_run_id. What stays here is the pure part -- constants,
// secret redaction, clipping, row <-> object mapping -- which RunStore imports.
//
// LOGGING IS BEST-EFFORT, ON PURPOSE (same rule as storage/jobs.js's
// reporter): recordLlmCall swallows and console.warns any failure, and is a
// silent no-op when logging is off or there is no usable db. A log write must
// never fail, retry or slow down the LLM call it describes -- and it keeps the
// function safe to leave wired into tests that aren't about logging.
//
// CONTEXT rides on `config`, not a global: withLlmLogContext returns a copy of
// config carrying `llmLog: { source, jobId, runId, ticker, store }`, which every
// agent already receives. Same injection point as config.fakeModel, and safe
// under concurrency (each pipeline run gets its own object -- three analysts
// running in parallel can't see each other's context). `store` is the RunStore
// the entry is written through (its runId becomes the row's env_run_id); with
// no store on the context, logging is a silent no-op.
//
// NOTE the two "run" ids on a row: `runId` here is the PIPELINE run (one news
// item x ticker, groups every call of one decision) and maps to the column
// `run_id`; the ENVIRONMENT ('live' or a backtest id) is the store's runId and
// maps to `env_run_id`. Same split as the state schema header explains.

export const LLM_SOURCES = ["pipeline", "backtest", "exit_check", "replay"];
export const LLM_STATUSES = ["ok", "error"];

export const DEFAULT_MAX_CHARS = 60000;
export const PREVIEW_CHARS = 240;
const MAX_ERROR_CHARS = 1000;
const MAX_ATTEMPT_DETAIL_CHARS = 300;

// Gemini keys travel in a header, not the URL, so they shouldn't appear in a
// vendor error message -- but a stored error string is exactly the wrong place
// to find out otherwise, so anything key-shaped is scrubbed on the way in.
const KEY_SHAPED = /AIza[0-9A-Za-z_-]{20,}/g;

export function redactSecrets(text) {
  return typeof text === "string" ? text.replace(KEY_SHAPED, "[redacted-key]") : text;
}

function clip(text, max) {
  if (text === undefined || text === null) return { text: null, chars: 0, clipped: false };
  const s = String(text);
  return s.length > max ? { text: s.slice(0, max), chars: s.length, clipped: true } : { text: s, chars: s.length, clipped: false };
}

function shortText(text, max) {
  if (text === undefined || text === null) return null;
  const s = redactSecrets(String(text));
  return s.length > max ? `${s.slice(0, max - 1)}\u2026` : s;
}

function definedOnly(obj) {
  return Object.fromEntries(Object.entries(obj ?? {}).filter(([, v]) => v !== undefined && v !== null));
}

/**
 * A copy of `config` whose `llmLog` context is extended with `ctx`
 * (undefined/null values are ignored, so a caller can't blank out an outer
 * field like `source`/`jobId`/`store` by passing nothing). Nesting composes:
 * llm-worker sets { source: "backtest", jobId }, runPipelineForTicker later
 * adds { runId, ticker, store } on top and the job id survives.
 */
export function withLlmLogContext(config, ctx) {
  return { ...config, llmLog: { ...(config.llmLog ?? {}), ...definedOnly(ctx) } };
}

/**
 * The column values for one llm_calls INSERT (everything but env_run_id, which
 * RunStore supplies from its own runId, and the autoincrement id): clips
 * prompt/response to `maxChars` (keeping the true length alongside), scrubs
 * key-shaped strings out of the error and attempt details. Pure -- RunStore
 * owns the SQL that consumes it.
 */
export function buildLlmCallRow(entry, { maxChars = DEFAULT_MAX_CHARS, now = new Date().toISOString() } = {}) {
  const prompt = clip(entry.prompt, maxChars);
  const response = clip(entry.response, maxChars);
  return {
    created_at: now,
    source: entry.source ?? "pipeline",
    job_id: entry.jobId ?? null,
    run_id: entry.runId ?? null,
    ticker: entry.ticker ?? null,
    label: entry.label ?? "unlabeled",
    requested_model: entry.requestedModel ?? null,
    model_used: entry.modelUsed ?? null,
    key_index: Number.isInteger(entry.keyIndex) ? entry.keyIndex : null,
    status: entry.status,
    error_stage: entry.errorStage ?? null,
    error: shortText(entry.error, MAX_ERROR_CHARS),
    duration_ms: Number.isFinite(entry.durationMs) ? Math.round(entry.durationMs) : null,
    attempts: Array.isArray(entry.attempts) && entry.attempts.length ? JSON.stringify(entry.attempts.map(cleanAttempt)) : null,
    prompt: prompt.text,
    response: response.text,
    prompt_chars: prompt.chars,
    response_chars: response.chars,
    truncated: prompt.clipped || response.clipped ? 1 : 0,
  };
}

function cleanAttempt(a) {
  return { ...a, detail: a.detail === undefined ? undefined : shortText(a.detail, MAX_ATTEMPT_DETAIL_CHARS) };
}

/**
 * The call-site entry point: merges the config's llmLog context into `entry`
 * and writes it through `config.llmLog.store`, or does nothing.
 * `config.llmLogEnabled` must be exactly true (config.js's loadConfig sets it,
 * defaulting on) AND a store must be on the context, so a hand-built config in
 * a test that never mentions logging stays silent.
 */
export async function recordLlmCall(config, entry) {
  const ctx = config?.llmLog ?? {};
  if (config?.llmLogEnabled !== true || typeof ctx.store?.insertLlmCall !== "function") return;
  try {
    await ctx.store.insertLlmCall(
      { source: ctx.source ?? "pipeline", jobId: ctx.jobId, runId: ctx.runId, ...entry, ticker: entry.ticker ?? ctx.ticker },
      { maxChars: config.llmLogMaxChars || DEFAULT_MAX_CHARS }
    );
  } catch (err) {
    console.warn("llm call log write failed (non-fatal)", { message: err.message });
  }
}

/** An llm_calls row (list shape: prompt_preview/response_preview instead of full text) as the API object. */
export function llmCallSummaryFromRow(r) {
  return {
    id: r.id,
    createdAt: r.created_at,
    source: r.source,
    jobId: r.job_id ?? null,
    runId: r.run_id ?? null,
    ticker: r.ticker ?? null,
    label: r.label,
    requestedModel: r.requested_model ?? null,
    modelUsed: r.model_used ?? null,
    keyIndex: r.key_index ?? null,
    status: r.status,
    errorStage: r.error_stage ?? null,
    error: r.error ?? null,
    durationMs: r.duration_ms ?? null,
    promptChars: r.prompt_chars ?? 0,
    responseChars: r.response_chars ?? 0,
    truncated: Boolean(r.truncated),
    promptPreview: r.prompt_preview ?? "",
    responsePreview: r.response_preview ?? "",
  };
}

function parseJsonOrNull(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** One llm_calls row in full (complete prompt + response + cascade attempts) as the API object. */
export function llmCallFromRow(row) {
  return {
    ...llmCallSummaryFromRow({ ...row, prompt_preview: "", response_preview: "" }),
    prompt: row.prompt ?? "",
    response: row.response ?? null,
    attempts: parseJsonOrNull(row.attempts) ?? [],
  };
}
