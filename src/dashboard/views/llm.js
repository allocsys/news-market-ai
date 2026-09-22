// "LLM calls" page: what was sent to Gemini and what came back, for the
// automatic pipeline, manual backtests and exit-check reflections alike.
// Data comes from storage/llm_calls.js via backend's /api/llm-calls (list) and
// /api/llm-calls/:id (one call in full) -- the list carries only short
// previews, since a stored prompt/response can be tens of thousands of chars.

import {
  escapeHtml, fmtTime, errorState, statusBadge,
  LLM_SOURCE_OPTIONS, LLM_STATUS_OPTIONS, LLM_LIMIT_OPTIONS, llmQuery, envSuffix,
} from "../helpers.js";

const SOURCE_LABEL = { pipeline: "live pipeline", backtest: "backtest", exit_check: "exit check" };

function sourceLabel(source) {
  return SOURCE_LABEL[source] ?? source;
}

function fmtDuration(ms) {
  if (ms === null || ms === undefined) return "\u2014";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/** "gemini-x" normally; "gemini-y (fell back from gemini-x)" when the cascade stepped down; the requested model marked as never-answered when the call failed before any model responded. */
function modelCell(call) {
  if (call.modelUsed && call.requestedModel && call.modelUsed !== call.requestedModel) {
    return `${escapeHtml(call.modelUsed)} <span style="color:var(--color-warning-text, var(--text-muted))">(fell back from ${escapeHtml(call.requestedModel)})</span>`;
  }
  if (call.modelUsed) return escapeHtml(call.modelUsed);
  return call.requestedModel ? `${escapeHtml(call.requestedModel)} <span style="color:var(--text-muted)">(no answer)</span>` : "\u2014";
}

function callStatusBadge(call) {
  const label = call.status === "ok" ? "ok" : `failed${call.errorStage ? ` \u00b7 ${call.errorStage}` : ""}`;
  return statusBadge(call.status === "ok" ? "approved" : "rejected", label);
}

function preview(text) {
  return text ? `${escapeHtml(text)}${text.length >= 240 ? "\u2026" : ""}` : `<span style="color:var(--text-muted)">\u2014</span>`;
}

// Filter pills. Own copy of helpers.js#pillLinks because that one serializes
// dashboard params, not this page's (see helpers.js#parseLlmParams).
function llmPills(label, options, current, paramName, params) {
  const links = options
    .map((opt) => {
      const active = String(opt) === String(current);
      return `<a href="${llmQuery(params, { [paramName]: opt })}" class="pill${active ? " pill-active" : ""}">${escapeHtml(String(opt))}</a>`;
    })
    .join("");
  return `<div class="filter-group"><span class="filter-label">${escapeHtml(label)}</span><div class="pill-row">${links}</div></div>`;
}

function hiddenFilterInputs(params) {
  const keep = { llmSource: params.llmSource, llmStatus: params.llmStatus, llmLimit: params.llmLimit, llmJob: params.llmJob, llmRun: params.llmRun, env: params.env };
  const defaults = { llmSource: "all", llmStatus: "all", llmLimit: 50, env: "live" };
  return Object.entries(keep)
    .filter(([key, value]) => value !== "" && value !== defaults[key])
    .map(([key, value]) => `<input type="hidden" name="${key}" value="${escapeHtml(value)}">`)
    .join("");
}

function scopeNote(params) {
  const chips = [];
  if (params.llmJob) chips.push(`backtest <code>${escapeHtml(params.llmJob)}</code>`);
  if (params.llmRun) chips.push(`run <code>${escapeHtml(params.llmRun)}</code>`);
  const scoped = chips.length ? `<p class="note">Showing only calls for ${chips.join(" and ")}. <a href="/dashboard/llm${llmQuery(params, { llmJob: "", llmRun: "" })}">Show all calls</a></p>` : "";
  return scoped + backtestLoggingNote(params);
}

// Backtests run with LLM call logging OFF BY DEFAULT (wrangler.backtest.toml's
// LLM_LOG_ENABLED="false" -- saves D1 write budget on the Free plan; there is
// no per-run opt-in yet). So this page will always show 0 calls for a
// backtest env, running or finished -- that's expected, not a bug or a
// filtering issue, and worth saying plainly rather than leaving someone to
// wonder if the calls will "show up once it's done".
function backtestLoggingNote(params) {
  if (!params.env || params.env === "live") return "";
  return `<p class="note">LLM call logging is off by default for backtest runs, to save D1 write budget on the Free plan &mdash; so calls made by <code>${escapeHtml(params.env)}</code> won't appear here, whether it's still running or already finished. This applies to every backtest today; there's no per-run way to turn logging on yet.</p>`;
}

function callsTable(calls, env) {
  if (calls.length === 0) {
    return `<p class="empty">No LLM calls match these filters. Calls from the live pipeline and exit-check reflections are logged as they happen; rows older than the retention window (14 days by default) are pruned.</p>`;
  }
  const rows = calls
    .map((c) => {
      const href = `/dashboard/llm/${c.id}${envSuffix(env)}`;
      const responseCell = c.status === "error" && !c.responsePreview
        ? `<span style="color:var(--color-danger-text)">${escapeHtml(c.error ?? "failed")}</span>`
        : preview(c.responsePreview);
      return `<tr>
        <td class="ticker cell-title"><a href="${href}">${escapeHtml(c.ticker ?? "\u2014")}</a> <span style="font-weight:400;color:var(--text-muted)">${escapeHtml(c.label)}</span></td>
        <td data-label="Source">${escapeHtml(sourceLabel(c.source))}</td>
        <td data-label="Status">${callStatusBadge(c)}</td>
        <td data-label="Model">${modelCell(c)}</td>
        <td class="num" data-label="Took">${fmtDuration(c.durationMs)}</td>
        <td class="num" data-label="When">${fmtTime(c.createdAt)}</td>
        <td class="cell-wide" data-label="Sent"><span style="font-family:var(--font-mono);font-size:0.75rem;white-space:pre-wrap;overflow-wrap:anywhere">${preview(c.promptPreview)}</span></td>
        <td class="cell-wide" data-label="Got back"><span style="font-family:var(--font-mono);font-size:0.75rem;white-space:pre-wrap;overflow-wrap:anywhere">${responseCell}</span></td>
        <td class="cell-wide" data-label=""><a href="${href}">Open full prompt &amp; response &rarr;</a></td>
      </tr>`;
    })
    .join("\n");
  return `<div class="table-wrap"><table>
    <thead><tr><th>Ticker / agent</th><th>Source</th><th>Status</th><th>Model</th><th>Took</th><th>When</th><th>Sent</th><th>Got back</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function pager(params, nextBeforeId) {
  const newer = params.llmBefore ? `<a class="btn btn-secondary" href="/dashboard/llm${llmQuery(params, { llmBefore: null })}">&larr; Newest</a>` : "";
  const older = nextBeforeId ? `<a class="btn btn-secondary" href="/dashboard/llm${llmQuery(params, { llmBefore: nextBeforeId })}">Older &rarr;</a>` : "";
  return newer || older ? `<div class="filter-bar" style="margin-top:1rem">${newer}${older}</div>` : "";
}

export function renderLlmView({ calls, nextBeforeId, params, error }) {
  const filterBar = `<div class="filter-bar">
    ${llmPills("Source", LLM_SOURCE_OPTIONS, params.llmSource, "llmSource", params)}
    ${llmPills("Status", LLM_STATUS_OPTIONS, params.llmStatus, "llmStatus", params)}
    ${llmPills("Rows", LLM_LIMIT_OPTIONS, params.llmLimit, "llmLimit", params)}
    <form method="get" action="/dashboard/llm" class="filter-group">
      <span class="filter-label">Ticker</span>
      <div class="pill-row">
        ${hiddenFilterInputs(params)}
        <input class="filter-form" type="text" name="llmTicker" value="${escapeHtml(params.llmTicker)}" placeholder="e.g. AAPL" maxlength="12" autocapitalize="characters" style="width:7.5rem">
        <button type="submit" class="btn btn-secondary">Filter</button>
      </div>
    </form>
  </div>`;

  return `<section id="llm">
    <h2>LLM calls${error ? "" : ` <span class="h2-count">${calls.length}${nextBeforeId ? "+" : ""}</span>`}</h2>
    <p class="note">Every prompt sent to Gemini and the raw text that came back, newest first &mdash; from the live pipeline and exit-check reflections. Failed calls (Gemini errors, unparseable JSON, schema mismatches) are logged too. A call that reused a checkpoint on retry isn't repeated here. Backtest runs aren't logged by default (see the note below when viewing one).</p>
    ${filterBar}
    ${scopeNote(params)}
    ${error ? errorState(error) : `${callsTable(calls, params.env)}${pager(params, nextBeforeId)}`}
  </section>`;
}

// ---------------- detail page ----------------

function stripFence(text) {
  return text.trim().replace(/^```(?:json)?\n?/, "").replace(/```$/, "").trim();
}

/** Pretty-printed JSON when the response parses as JSON (fences stripped), else null -- the caller then shows the raw text untouched. */
function prettyJson(text) {
  if (!text) return null;
  try {
    return JSON.stringify(JSON.parse(stripFence(text)), null, 2);
  } catch {
    return null;
  }
}

const PRE_STYLE = "margin:0;padding:0.9rem 1rem;background:var(--bg-elevated);border:1px solid var(--border-color);border-radius:var(--radius-sm);font-family:var(--font-mono);font-size:0.75rem;line-height:1.55;color:var(--text-main);white-space:pre-wrap;overflow-wrap:anywhere;max-height:34rem;overflow:auto";

function metaRow(label, valueHtml) {
  return `<div style="display:flex;justify-content:space-between;gap:1rem;padding:0.4rem 0;border-bottom:1px solid var(--border-color)"><span style="color:var(--text-muted);font-size:0.75rem">${escapeHtml(label)}</span><span style="font-family:var(--font-mono);font-size:0.75rem;text-align:right;overflow-wrap:anywhere">${valueHtml}</span></div>`;
}

function attemptsPanel(attempts) {
  if (!attempts || attempts.length === 0) return "";
  const rows = attempts
    .map((a, i) => `<tr>
      <td class="num" data-label="#">${i + 1}</td>
      <td data-label="Model">${escapeHtml(a.model ?? "\u2014")}</td>
      <td class="num" data-label="Key">${a.keyIndex ?? "\u2014"}</td>
      <td data-label="Outcome">${statusBadge(a.outcome === "ok" ? "approved" : a.outcome === "skipped" ? "neutral" : "rejected", a.outcome + (a.status ? ` ${a.status}` : ""))}</td>
      <td class="cell-wide" data-label="Detail">${escapeHtml(a.detail ?? "")}</td>
    </tr>`)
    .join("\n");
  return `<div class="panel" style="margin-bottom:1.5rem">
    <div class="panel-header"><span class="panel-title">Cascade attempts</span><span style="font-size:0.6875rem;color:var(--text-muted)">${attempts.length} model/key attempt${attempts.length === 1 ? "" : "s"}, in order</span></div>
    <div class="panel-body panel-body-flush"><div class="table-wrap"><table>
      <thead><tr><th>#</th><th>Model</th><th>Key</th><th>Outcome</th><th>Detail</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div></div>
  </div>`;
}

function textPanel(title, text, { note = "" } = {}) {
  return `<div class="panel" style="margin-bottom:1.5rem">
    <div class="panel-header"><span class="panel-title">${escapeHtml(title)}</span>${note ? `<span style="font-size:0.6875rem;color:var(--text-muted)">${escapeHtml(note)}</span>` : ""}</div>
    <div class="panel-body"><pre style="${PRE_STYLE}">${escapeHtml(text)}</pre></div>
  </div>`;
}

export function renderLlmCallView({ call, error, env = "live" }) {
  const back = `<p class="note"><a href="/dashboard/llm${envSuffix(env)}">&larr; All LLM calls</a></p>`;
  if (error) return `<section id="llm-call"><h2>LLM call</h2>${back}${errorState(error)}</section>`;
  if (!call) return `<section id="llm-call"><h2>LLM call</h2>${back}<p class="empty">Call not found &mdash; it may have been pruned by the retention window.</p></section>`;

  const scopeLinks = [
    call.runId ? `<a href="/dashboard/llm${llmQuery({ env }, { llmRun: call.runId })}">All calls in this run</a>` : "",
    call.jobId ? `<a href="/dashboard/llm${llmQuery({ env }, { llmJob: call.jobId })}">All calls in this backtest</a>` : "",
  ].filter(Boolean).join(" &middot; ");

  const meta = [
    metaRow("When", fmtTime(call.createdAt)),
    metaRow("Source", escapeHtml(sourceLabel(call.source))),
    metaRow("Ticker", escapeHtml(call.ticker ?? "\u2014")),
    metaRow("Requested model", escapeHtml(call.requestedModel ?? "\u2014")),
    metaRow("Answered by", call.modelUsed ? `${escapeHtml(call.modelUsed)}${call.keyIndex !== null ? ` (key #${call.keyIndex})` : ""}` : "no model answered"),
    metaRow("Took", fmtDuration(call.durationMs)),
    metaRow("Prompt size", `${call.promptChars.toLocaleString("en-US")} chars`),
    metaRow("Response size", `${call.responseChars.toLocaleString("en-US")} chars`),
    call.runId ? metaRow("Run id", escapeHtml(call.runId)) : "",
    call.jobId ? metaRow("Backtest id", escapeHtml(call.jobId)) : "",
  ].join("");

  const errorPanel = call.error
    ? `<div class="panel" style="margin-bottom:1.5rem"><div class="panel-header"><span class="panel-title">Error</span><span style="font-size:0.6875rem;color:var(--text-muted)">${escapeHtml(call.errorStage ?? "")}</span></div><div class="panel-body"><pre style="${PRE_STYLE};color:var(--color-danger-text)">${escapeHtml(call.error)}</pre></div></div>`
    : "";

  const truncNote = call.truncated ? "Stored text was clipped at the LLM_LOG_MAX_CHARS limit; the sizes above are the true lengths." : "";
  const pretty = prettyJson(call.response);
  const responsePanel = call.response === null
    ? `<div class="panel" style="margin-bottom:1.5rem"><div class="panel-header"><span class="panel-title">Response received</span></div><div class="panel-body"><p class="empty">Nothing came back &mdash; the call failed before any model answered (see the error and cascade attempts).</p></div></div>`
    : textPanel("Response received", pretty ?? call.response, { note: pretty ? "JSON, re-indented for reading" : "raw text" });

  return `<section id="llm-call">
    <h2>${escapeHtml(call.label)}${call.ticker ? ` &middot; ${escapeHtml(call.ticker)}` : ""} ${callStatusBadge(call)}</h2>
    ${back}
    ${scopeLinks ? `<p class="note">${scopeLinks}</p>` : ""}
    ${truncNote ? `<p class="note">${escapeHtml(truncNote)}</p>` : ""}
    <div class="panel" style="margin-bottom:1.5rem"><div class="panel-body">${meta}</div></div>
    ${errorPanel}
    ${attemptsPanel(call.attempts)}
    ${textPanel("Prompt sent", call.prompt)}
    ${responsePanel}
  </section>`;
}
