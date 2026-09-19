// LLM call log (migrations/0012_llm_calls.sql): what was sent to Gemini and
// what came back, for the automatic pipeline and manual backtests alike.
//
//   WRITE  agents/utils/structured.js#callStructured -> recordLlmCall, in the
//          `llm` Worker only.
//   READ   `backend`'s /api/llm-calls (src/dashboard/api.js) -> the dashboard's
//          "LLM calls" page. `dashboard` never touches D1 itself.
//
// LOGGING IS BEST-EFFORT, ON PURPOSE (same rule as storage/jobs.js's
// reporter): recordLlmCall swallows and console.warns any failure, and is a
// silent no-op when logging is off or there is no usable db. A log write must
// never fail, retry or slow down the LLM call it describes -- and it keeps the
// function safe to leave wired into tests that aren't about logging.
//
// CONTEXT rides on `config`, not a global: withLlmLogContext returns a copy of
// config carrying `llmLog: { source, jobId, runId, ticker }`, which every
// agent already receives. Same injection point as config.fakeModel, and safe
// under concurrency (each pipeline run gets its own object -- three analysts
// running in parallel can't see each other's context).

export const LLM_SOURCES = ["pipeline", "backtest", "exit_check"];
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
 * field like `source`/`jobId` by passing nothing). Nesting composes:
 * llm-worker sets { source: "backtest", jobId }, runPipelineForTicker later
 * adds { runId, ticker } on top and the job id survives.
 */
export function withLlmLogContext(config, ctx) {
  return { ...config, llmLog: { ...(config.llmLog ?? {}), ...definedOnly(ctx) } };
}

/** Inserts one row. Throws on D1 failure -- callers on the LLM path use recordLlmCall instead. */
export async function insertLlmCall(db, entry, { maxChars = DEFAULT_MAX_CHARS, now = new Date().toISOString() } = {}) {
  const prompt = clip(entry.prompt, maxChars);
  const response = clip(entry.response, maxChars);
  await db
    .prepare(
      `INSERT INTO llm_calls (created_at, source, job_id, run_id, ticker, label, requested_model, model_used, key_index, status, error_stage, error, duration_ms, attempts, prompt, response, prompt_chars, response_chars, truncated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      now,
      entry.source ?? "pipeline",
      entry.jobId ?? null,
      entry.runId ?? null,
      entry.ticker ?? null,
      entry.label ?? "unlabeled",
      entry.requestedModel ?? null,
      entry.modelUsed ?? null,
      Number.isInteger(entry.keyIndex) ? entry.keyIndex : null,
      entry.status,
      entry.errorStage ?? null,
      shortText(entry.error, MAX_ERROR_CHARS),
      Number.isFinite(entry.durationMs) ? Math.round(entry.durationMs) : null,
      Array.isArray(entry.attempts) && entry.attempts.length ? JSON.stringify(entry.attempts.map(cleanAttempt)) : null,
      prompt.text,
      response.text,
      prompt.chars,
      response.chars,
      prompt.clipped || response.clipped ? 1 : 0
    )
    .run();
}

function cleanAttempt(a) {
  return { ...a, detail: a.detail === undefined ? undefined : shortText(a.detail, MAX_ATTEMPT_DETAIL_CHARS) };
}

/**
 * The call-site entry point: merges the config's llmLog context into `entry`
 * and writes it, or does nothing. `config.llmLogEnabled` must be exactly true
 * (config.js's loadConfig sets it, defaulting on), so a hand-built config in a
 * test that never mentions logging stays silent.
 */
export async function recordLlmCall(env, config, entry) {
  if (config?.llmLogEnabled !== true || !env?.DB) return;
  const ctx = config.llmLog ?? {};
  try {
    await insertLlmCall(
      env.DB,
      { source: ctx.source ?? "pipeline", jobId: ctx.jobId, runId: ctx.runId, ...entry, ticker: entry.ticker ?? ctx.ticker },
      { maxChars: config.llmLogMaxChars || DEFAULT_MAX_CHARS }
    );
  } catch (err) {
    console.warn("llm call log write failed (non-fatal)", { message: err.message });
  }
}

/** Deletes rows older than `days`. Returns nothing meaningful; throws on D1 failure. */
export async function pruneLlmCalls(db, { days, now = Date.now() }) {
  const cutoff = new Date(now - days * 24 * 3600 * 1000).toISOString();
  await db.prepare(`DELETE FROM llm_calls WHERE created_at < ?`).bind(cutoff).run();
}

const LIST_COLUMNS = `id, created_at, source, job_id, run_id, ticker, label, requested_model, model_used, key_index, status, error_stage, error,
  duration_ms, prompt_chars, response_chars, truncated,
  substr(prompt, 1, ${PREVIEW_CHARS}) AS prompt_preview, substr(response, 1, ${PREVIEW_CHARS}) AS response_preview`;

function rowToSummary(r) {
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

/**
 * Newest-first page of calls, with only a short preview of each prompt/response
 * (the full text can be ~60K chars per row -- the list must not load it; see
 * getLlmCall). Filters are all optional and AND-ed. Keyset pagination on id:
 * pass the previous page's `nextBeforeId` as `beforeId` for the next page.
 * Fetches limit+1 rows to know whether another page exists.
 */
export async function getRecentLlmCalls(db, { limit = 50, source, status, ticker, jobId, runId, beforeId } = {}) {
  const where = [];
  const args = [];
  if (source) { where.push("source = ?"); args.push(source); }
  if (status) { where.push("status = ?"); args.push(status); }
  if (ticker) { where.push("ticker = ?"); args.push(ticker); }
  if (jobId) { where.push("job_id = ?"); args.push(jobId); }
  if (runId) { where.push("run_id = ?"); args.push(runId); }
  if (beforeId) { where.push("id < ?"); args.push(beforeId); }

  const { results } = await db
    .prepare(`SELECT ${LIST_COLUMNS} FROM llm_calls ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`)
    .bind(...args, limit + 1)
    .all();

  const hasMore = results.length > limit;
  const page = hasMore ? results.slice(0, limit) : results;
  return { calls: page.map(rowToSummary), nextBeforeId: hasMore ? page[page.length - 1].id : null };
}

/** One call in full (complete prompt + response + cascade attempts), or null. */
export async function getLlmCall(db, id) {
  const row = await db.prepare(`SELECT * FROM llm_calls WHERE id = ?`).bind(id).first();
  if (!row) return null;
  return {
    ...rowToSummary({ ...row, prompt_preview: "", response_preview: "" }),
    prompt: row.prompt ?? "",
    response: row.response ?? null,
    attempts: parseJsonOrNull(row.attempts) ?? [],
  };
}
