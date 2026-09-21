// Helper functions, constants, query-param parsing, and component renderers
// extracted from dashboard.js for Phase 1 structural split.

const ESCAPE_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

export function fmtTime(iso) {
  if (!iso) return "\u2014";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? escapeHtml(iso) : d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export function errorState(message) {
  return `<p class="empty error-inline">Couldn't load this section${message ? `: ${escapeHtml(message)}` : ""}.</p>`;
}

// `status` drives the color/icon (must be "approved", "rejected", or anything else for
// neutral); `label` is the text actually shown and defaults to `status` for call sites
// (like decisions) where the raw status doubles as the display text. Callers with their
// own status vocabulary (e.g. backtest's complete/running/failed) must map to
// approved/rejected/neutral explicitly rather than passing their label through as
// `status` -- passing a label through as status is exactly what silently collapsed
// every backtest run to the same "neutral / \u2014" badge previously.
export function statusBadge(status, label = status) {
  const cls = status === "approved" ? "status-approved" : status === "rejected" ? "status-rejected" : "status-neutral";
  const icon = status === "approved" ? "\u2713" : status === "rejected" ? "\u2715" : "\u2014";
  return `<span class="status ${cls}"><span>${icon}</span> ${escapeHtml(label)}</span>`;
}

export const ACTIVITY_DAYS_OPTIONS = [7, 14, 30, 60];
export const DECISION_STATUS_OPTIONS = ["all", "approved", "rejected"];
export const DECISION_LIMIT_OPTIONS = [10, 20, 50, 100];
export const POSITIONS_LIMIT_OPTIONS = [10, 25, 50, 100];
export const RANGE_PRESET_DAYS = [7, 14, 30, 90];
export const STALE_INGESTION_HOURS = 26;
export const PRICE_CHART_TICKER_LIMIT = 8;

function pickFromOptions(raw, options, fallback) {
  const parsed = Number.isNaN(Number(raw)) ? raw : Number(raw);
  return options.includes(parsed) ? parsed : fallback;
}

// M4b environment selector. Shape matches index.js#newJobId("backtest"):
// `backtest-<ms timestamp>-<base36 suffix>`. This is a FORMAT check only --
// `raw` still has to be looked up against the SIM_DB registry (data.js#resolveEnv)
// to confirm the run actually exists; a well-formed but unknown id also falls
// back to live there. Exported so data.js's resolver uses the identical pattern
// rather than a second copy that could drift.
export const BACKTEST_ID_RE = /^backtest-\d+-[a-z0-9]+$/;

/** `?env=` -- "live" (default) or a plausibly-shaped backtest id. Anything else silently falls back to "live" here; existence of a well-formed id is checked downstream in data.js#resolveEnv, not here (this function has no DB access). */
export function parseEnvParam(searchParams) {
  const sp = searchParams ?? new URLSearchParams();
  const raw = (sp.get("env") ?? "").trim();
  if (raw === "" || raw === "live") return "live";
  return BACKTEST_ID_RE.test(raw) ? raw : "live";
}

/** Sections whose data is scoped by `?env=` (the environment selector shows on these, and the nav keeps the chosen env across them). Charts/health/backfill/backtest/more stay env-unaware: price bars and ingestion health are shared market data, and the last three are about launching/listing runs, not viewing one. */
export const ENV_SECTIONS = ["snapshot", "activity", "decisions", "positions", "pipeline", "llm"];

/** "?env=<id>" for a non-live environment, "" for live -- for links that must carry the selected environment along. `env` is already vetted by parseEnvParam/resolveEnv (BACKTEST_ID_RE), so nothing here needs more than encoding. */
export function envSuffix(env) {
  return env && env !== "live" ? `?env=${encodeURIComponent(env)}` : "";
}

export function parseDashboardParams(searchParams) {
  const sp = searchParams ?? new URLSearchParams();
  return {
    activityDays: pickFromOptions(sp.get("activityDays"), ACTIVITY_DAYS_OPTIONS, 14),
    decisionStatus: DECISION_STATUS_OPTIONS.includes(sp.get("decisionStatus")) ? sp.get("decisionStatus") : "all",
    decisionLimit: pickFromOptions(sp.get("decisionLimit"), DECISION_LIMIT_OPTIONS, 20),
    positionsLimit: pickFromOptions(sp.get("positionsLimit"), POSITIONS_LIMIT_OPTIONS, 50),
    env: parseEnvParam(sp),
  };
}

// ---- LLM calls page (/dashboard/llm) ----
// Its own param set, parsed separately from parseDashboardParams: those are
// shared by three other pages and pillLinks/buildQuery serialize every key
// they hold into every link, which would leak these into unrelated pages'
// URLs. Every param is validated here -- llmTicker/llmJob/llmRun end up in
// SQL bind values (never interpolated), but bounding them keeps junk out of
// the query and the rendered links.
export const LLM_SOURCE_OPTIONS = ["all", "pipeline", "backtest", "exit_check"];
export const LLM_STATUS_OPTIONS = ["all", "ok", "error"];
export const LLM_LIMIT_OPTIONS = [25, 50, 100];
const LLM_DEFAULTS = { llmSource: "all", llmStatus: "all", llmLimit: 50, env: "live" };

function cleanId(raw) {
  const s = (raw ?? "").trim();
  return s.length > 0 && s.length <= 200 ? s : "";
}

export function parseLlmParams(searchParams) {
  const sp = searchParams ?? new URLSearchParams();
  const ticker = (sp.get("llmTicker") ?? "").trim().toUpperCase();
  const before = Number(sp.get("llmBefore"));
  return {
    llmSource: LLM_SOURCE_OPTIONS.includes(sp.get("llmSource")) ? sp.get("llmSource") : LLM_DEFAULTS.llmSource,
    llmStatus: LLM_STATUS_OPTIONS.includes(sp.get("llmStatus")) ? sp.get("llmStatus") : LLM_DEFAULTS.llmStatus,
    llmLimit: pickFromOptions(sp.get("llmLimit"), LLM_LIMIT_OPTIONS, LLM_DEFAULTS.llmLimit),
    llmTicker: /^[A-Z0-9.\-]{1,12}$/.test(ticker) ? ticker : "",
    llmJob: cleanId(sp.get("llmJob")),
    llmRun: cleanId(sp.get("llmRun")),
    llmBefore: Number.isInteger(before) && before > 0 ? before : null,
    env: parseEnvParam(sp),
  };
}

/** "?..." for the LLM page with `overrides` applied, omitting anything at its default so links stay short. `llmBefore` is dropped on any filter change (an older-page cursor means nothing under a different filter) unless the override sets it. */
export function llmQuery(params, overrides = {}) {
  const merged = { ...params, ...("llmBefore" in overrides ? {} : { llmBefore: null }), ...overrides };
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(merged)) {
    if (value === null || value === undefined || value === "") continue;
    if (key in LLM_DEFAULTS && value === LLM_DEFAULTS[key]) continue;
    sp.set(key, String(value));
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}

export function buildQuery(params, overrides = {}) {
  const merged = { ...params, ...overrides };
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(merged)) {
    // A non-live `env` rides along on every filter link so changing a filter
    // never silently drops back to live; the live default is left out so
    // default links stay clean.
    if (k === "env" && (v === "live" || v === undefined || v === null || v === "")) continue;
    sp.set(k, String(v));
  }
  return `?${sp.toString()}`;
}

export function pillLinks(label, options, current, paramName, params) {
  const links = options
    .map((opt) => {
      const active = String(opt) === String(current);
      return `<a href="${buildQuery(params, { [paramName]: opt })}" class="pill${active ? " pill-active" : ""}">${escapeHtml(String(opt))}</a>`;
    })
    .join("");
  return `<div class="filter-group"><span class="filter-label">${escapeHtml(label)}</span><div class="pill-row">${links}</div></div>`;
}

export function healthRow(label, stat) {
  const stale = stat.lastIngestedAt ? Date.now() - new Date(stat.lastIngestedAt).getTime() > STALE_INGESTION_HOURS * 3600 * 1000 : true;
  const rowCls = stale ? " class=\"stale-row\"" : "";
  const flag = stale ? `<span class="stale-flag" title="No new rows in over ${STALE_INGESTION_HOURS}h">stale</span>` : `<span class="ok-flag">fresh</span>`;
  return `<tr${rowCls}><td class="cell-title">${escapeHtml(label)}</td><td class="num" data-label="Rows">${stat.count}</td><td class="num cell-wide" data-label="Last ingested">${fmtTime(stat.lastIngestedAt)}</td><td data-label="Status">${flag}</td></tr>`;
}

const OPINION_AGENT_LABELS = { news_event: "News", sentiment: "Sentiment", technical: "Technical" };

export function analystOpinionLine(op) {
  const label = OPINION_AGENT_LABELS[op.agent] ?? op.agent;
  const lead = op.agent === "news_event" && op.eventType ? `${op.eventType} \u2014 ` : op.agent === "sentiment" && op.sentiment ? `${op.sentiment} \u2014 ` : "";
  return `<div class="llm-block"><span class="llm-agent">${escapeHtml(label)}</span>${escapeHtml(lead)}${escapeHtml(op.summary)} <span class="llm-justification">(${escapeHtml(op.justification)})</span></div>`;
}

export function debateLines(debate) {
  if (!debate) return "";
  const confidencePct = typeof debate.confidence === "number" ? `${(debate.confidence * 100).toFixed(0)}%` : "\u2014";
  return `<div class="llm-block"><span class="llm-agent llm-agent-bull">Bull</span>${escapeHtml(debate.bull?.argument ?? "\u2014")} <span class="llm-justification">(${escapeHtml(debate.bull?.justification ?? "\u2014")})</span></div>
    <div class="llm-block"><span class="llm-agent llm-agent-bear">Bear</span>${escapeHtml(debate.bear?.argument ?? "\u2014")} <span class="llm-justification">(${escapeHtml(debate.bear?.justification ?? "\u2014")})</span></div>
    <div class="llm-block"><span class="llm-agent">Verdict</span>${escapeHtml(debate.direction ?? "\u2014")}, ${confidencePct} confidence, ${escapeHtml(debate.timeHorizon ?? "\u2014")} horizon <span class="llm-justification">(${escapeHtml(debate.justification ?? "\u2014")})</span></div>`;
}

export function traderLine(thesis) {
  if (!thesis) return "";
  return `<div class="llm-block"><span class="llm-agent">Trader</span>${escapeHtml(thesis.instrument ?? "\u2014")} <span class="llm-justification">(${escapeHtml(thesis.rationale ?? "\u2014")})</span></div>`;
}

export function llmAnswerDetails(d) {
  if (!d.opinions && !d.debate) {
    return `<details class="llm-answer"><summary>view</summary><p class="empty">Not recorded for this decision (predates LLM-answer logging).</p></details>`;
  }
  const opinionLines = (d.opinions ?? []).map(analystOpinionLine).join("\n");
  return `<details class="llm-answer">
    <summary>view</summary>
    <div class="llm-answer-body">
      ${opinionLines}
      ${debateLines(d.debate)}
      ${traderLine(d.thesis)}
    </div>
  </details>`;
}

export function decisionsTable(decisions) {
  if (decisions.length === 0) return `<p class="empty">No decisions match this filter.</p>`;
  const rows = decisions
    .map(
      (d) => `<tr>
        <td class="ticker cell-title">${escapeHtml(d.ticker)}</td>
        <td data-label="Direction">${escapeHtml(d.thesis?.direction ?? "\u2014")}</td>
        <td data-label="Status">${statusBadge(d.status)}</td>
        <td class="num" data-label="Size">${d.riskDecision?.positionSizePct != null ? (d.riskDecision.positionSizePct * 100).toFixed(1) + "%" : "\u2014"}</td>
        <td class="cell-wide" data-label="Reason">${escapeHtml(d.portfolioDecision?.reason ?? d.riskDecision?.reason ?? "\u2014")}</td>
        <td class="num" data-label="Decided">${fmtTime(d.createdAt)}</td>
        <td class="cell-wide" data-label="LLM reasoning">${llmAnswerDetails(d)}</td>
      </tr>`
    )
    .join("\n");
  return `<div class="table-wrap"><table>
    <thead><tr><th>Ticker</th><th>Direction</th><th>Status</th><th>Size</th><th>Reason</th><th>Decided</th><th>LLM reasoning</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

export function positionsTable(positions, { closed = false } = {}) {
  if (positions.length === 0) return `<p class="empty">None.</p>`;
  const rows = positions
    .map(
      (p) => `<tr>
        <td class="ticker cell-title">${escapeHtml(p.ticker)}</td>
        <td data-label="Direction">${escapeHtml(p.direction ?? "\u2014")}</td>
        <td class="num" data-label="Size">${(p.positionSizePct * 100).toFixed(1)}%</td>
        <td class="num" data-label="Entry">${p.entryPrice != null ? "$" + Number(p.entryPrice).toFixed(2) : "\u2014"}</td>
        ${closed ? `<td class="num" data-label="Exit">${p.exitPrice != null ? "$" + Number(p.exitPrice).toFixed(2) : "\u2014"}</td>` : ""}
        <td class="num" data-label="Opened">${fmtTime(p.openedAt)}</td>
        ${closed ? `<td class="num" data-label="Closed">${fmtTime(p.closedAt)}</td><td data-label="Reason">${escapeHtml(p.closeReason ?? "\u2014")}</td>` : ""}
      </tr>`
    )
    .join("\n");
  return `<div class="table-wrap"><table>
    <thead><tr><th>Ticker</th><th>Direction</th><th>Size</th><th>Entry</th>${closed ? "<th>Exit</th>" : ""}<th>Opened</th>${closed ? "<th>Closed</th><th>Reason</th>" : ""}</tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

export function backtestMetricRow(label, on, off, delta, { isPercent = true } = {}) {
  const fmt = (v) => (isPercent ? (v * 100).toFixed(1) + "%" : v.toFixed(2));
  const deltaCls = delta > 0 ? "status-approved" : delta < 0 ? "status-rejected" : "status-neutral";
  return `<tr class="rt-tiles"><td class="cell-title">${escapeHtml(label)}</td><td class="num" data-label="Signal ON">${fmt(on)}</td><td class="num" data-label="Signal OFF">${fmt(off)}</td><td class="num ${deltaCls}" data-label="Delta">${delta > 0 ? "+" : ""}${fmt(delta)}</td></tr>`;
}

export function backtestResultTable(result) {
  if (!result) return "";
  const { on, off, delta } = result.overall;
  // Runs saved before the daily-equity-curve scoring (plan.md step D) have no `portfolio`.
  const p = result.portfolio;
  const scoring = p
    ? `Scored on ${p.days} daily portfolio return${p.days === 1 ? "" : "s"} (${escapeHtml(p.from)} to ${escapeHtml(p.to)}) over ${escapeHtml(p.tickers.join(", "))}. Signal ON = the positions the pipeline opened, sized by the risk rules, the rest in cash (average ${(p.on.avgExposure * 100).toFixed(1)}% invested, ${p.on.positionsTraded} position${p.on.positionsTraded === 1 ? "" : "s"}${p.on.positionsIgnored ? `, ${p.on.positionsIgnored} could not be replayed` : ""}). Signal OFF = equal-weight buy &amp; hold of the same tickers, fully invested. `
    : "";
  return `<div class="table-wrap"><table>
    <thead><tr><th>Metric</th><th>Signal ON</th><th>Signal OFF (buy &amp; hold)</th><th>Delta</th></tr></thead>
    <tbody>
      ${backtestMetricRow("Cumulative return", on.cumulativeReturn, off.cumulativeReturn, delta.cumulativeReturn)}
      ${backtestMetricRow("Sharpe ratio", on.sharpeRatio, off.sharpeRatio, delta.sharpeRatio, { isPercent: false })}
      ${backtestMetricRow(p ? "Up days" : "Win rate", on.winRate, off.winRate, delta.winRate)}
      ${backtestMetricRow("Max drawdown", on.maxDrawdown, off.maxDrawdown, delta.maxDrawdown)}
    </tbody>
  </table></div>
  <p class="note">${scoring}Positive delta always means "the signal looks better on this metric" (max drawdown's sign is normalized the same way) -- see signalCompare.js#compareSignalOnOff. Pooled across ${result.perWindow.length} walk-forward window${result.perWindow.length === 1 ? "" : "s"}.</p>`;
}

export const BACKTEST_STATUS_LABEL = { running: "running…", complete: "complete", failed: "failed" };

export function backtestRunsList(runs) {
  if (runs.length === 0) return `<p class="empty">No backtest runs yet -- use the form above to trigger one.</p>`;
  return runs
    .map((r) => {
      const semanticStatus = r.status === "complete" ? "approved" : r.status === "failed" ? "rejected" : "neutral";
      const summary = `<span class="ticker">${escapeHtml(r.tickers.join(", "))}</span> &middot; ${fmtTime(r.testStart)} &rarr; ${fmtTime(r.testEnd)} &middot; ${statusBadge(semanticStatus, BACKTEST_STATUS_LABEL[r.status] ?? r.status)}`;
      const body = r.status === "complete"
        ? backtestResultTable(r.result)
        : r.status === "failed"
          ? `<p class="empty">${escapeHtml(r.error ?? "failed with no recorded error message")}</p>`
          : `<p class="empty">Still running as of last page load -- reload to check.</p>`;
      const llmLink = `<p class="note"><a href="/dashboard/llm${llmQuery({ ...parseLlmParams(null), env: r.id }, { llmJob: r.id })}">View every LLM call this run made &rarr;</a></p>`;
      return `<details class="llm-answer" ${r.status !== "running" ? "" : "open"}><summary>${summary}</summary><div class="llm-answer-body" style="max-width:none">${llmLink}${body}</div></details>`;
    })
    .join("\n");
}

// Compact row of big-number stats used inside panels (Exit quality, Window totals).
// items: [{ value, label, color? }]; cols = column count on phones (desktop auto-fits).
export function miniStats(items, { cols = 2 } = {}) {
  return `<div class="mini-stats" style="--cols:${Number(cols) || 2}">${items
    .map((i) => `<div class="mini-stat"><div class="mini-stat-value" style="color:${i.color ?? "var(--text-main)"}">${escapeHtml(i.value)}</div><div class="mini-stat-label">${escapeHtml(i.label)}</div></div>`)
    .join("")}</div>`;
}

// Replaced inline style string with class name "date-input" (defined in shell.js STYLE).
// Call sites in views will switch from style="${DATE_INPUT_STYLE}" to class="date-input" as needed.
export const DATE_INPUT_STYLE = "date-input";

export function rangePresetButtons(fromId, toId) {
  const buttons = RANGE_PRESET_DAYS.map((d) => `<button type="button" class="pill" onclick="setDateRange('${fromId}','${toId}',${d})">${d}d</button>`).join("");
  return `<div class="filter-group">
    <span class="filter-label">Quick range</span>
    <div class="pill-row">${buttons}</div>
  </div>`;
}

export function checkpointsTable(checkpoints) {
  if (checkpoints.length === 0) return `<p class="empty">No pipeline activity recorded yet.</p>`;
  const rows = checkpoints
    .map((c) => `<tr><td class="ticker cell-title">${escapeHtml(c.ticker)}</td><td data-label="Last stage">${escapeHtml(c.stage)}</td><td class="num" data-label="Updated">${fmtTime(c.updated_at)}</td></tr>`)
    .join("\n");
  return `<div class="table-wrap"><table>
    <thead><tr><th>Ticker</th><th>Last Stage</th><th>Updated</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

export function statCard(value, label, sub = null, accent = "var(--accent)") {
  // Maps a named accent token to a matching soft glow color used for the
  // radial spotlight in the top-right of the card (see .stat-card::after in
  // shell.js). Without this, the spotlight would always be blue even on a
  // "danger" or "success" themed card, which read as inconsistent.
  const glowMap = {
    "var(--accent)": "var(--accent-glow)",
    "var(--color-success-text)": "rgba(16, 185, 129, 0.18)",
    "var(--color-danger-text)": "rgba(239, 68, 68, 0.18)",
    "var(--color-warning-text)": "rgba(245, 158, 11, 0.18)",
    "var(--color-info-text)": "var(--accent-glow)",
  };
  const glow = glowMap[accent] ?? "var(--accent-glow)";
  return `<div class="stat-card" style="--stat-accent:${accent}; --stat-accent-glow:${glow}">
    <div class="stat-value">${escapeHtml(value)}</div>
    <div class="stat-label">${escapeHtml(label)}</div>
    ${sub ? `<div class="stat-sub">${escapeHtml(sub)}</div>` : ""}
  </div>`;
}

// `totalExposurePct` is passed in (from storage/run_store.js#RunStore.getOpenExposureTotal,
// an unbounded aggregate) rather than derived from `openPositions` here -- that array
// is capped by the Rows filter, so summing it client-side understated total exposure
// once real open-position count exceeded the filter (plan.md Step 1).
export function renderSummaryCards({ openPositions, closedPositions, decisionStats, totalExposurePct }) {
  const longCount = openPositions.filter((p) => p.direction === "long").length;
  const shortCount = openPositions.filter((p) => p.direction === "short").length;

  const approved = decisionStats.totals.approved ?? 0;
  const rejected = decisionStats.totals.rejected ?? 0;
  const otherStatuses = Object.entries(decisionStats.totals).filter(([status]) => status !== "approved" && status !== "rejected");
  const otherCount = otherStatuses.reduce((sum, [, count]) => sum + count, 0);
  const decidedTotal = approved + rejected;
  const approvalRate = decidedTotal > 0 ? ((approved / decidedTotal) * 100).toFixed(0) + "%" : "\u2014";

  const stopLosses = closedPositions.filter((p) => p.closeReason === "stop_loss").length;
  const takeProfits = closedPositions.filter((p) => p.closeReason === "take_profit").length;

  return `<div class="stat-grid">
    ${statCard(openPositions.length, "Open positions", `${longCount} long / ${shortCount} short`, "var(--accent)")}
    ${statCard(totalExposurePct.toFixed(1) + "%", "Total open exposure", "sum of position size %", "var(--color-success-text)")}
    ${statCard(approvalRate, "Approval rate (all-time)", `${approved} approved / ${rejected} rejected${otherCount ? ` / ${otherCount} other` : ""}`, "var(--color-info-text)")}
    ${statCard(closedPositions.length, "Recently closed", `${stopLosses} stop-loss / ${takeProfits} take-profit`, "var(--color-danger-text)")}
  </div>`;
}

export const CHART_STATUS_COLORS = { approved: "var(--color-success-text)", rejected: "var(--color-danger-text)" };
export const CHART_STATUS_FALLBACK = "var(--text-muted)";

export function decisionsActivityChart(daily, days) {
  const width = 640;
  const height = 180;
  const padLeft = 34;
  const padBottom = 26;
  const padTop = 10;
  const plotW = width - padLeft - 12;
  const plotH = height - padTop - padBottom;

  const todayUtc = new Date();
  const dayKeys = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(todayUtc.getUTCFullYear(), todayUtc.getUTCMonth(), todayUtc.getUTCDate() - i));
    dayKeys.push(d.toISOString().slice(0, 10));
  }

  const byDay = new Map(dayKeys.map((k) => [k, {}]));
  const statusesSeen = new Set();
  for (const row of daily) {
    if (!byDay.has(row.day)) continue;
    byDay.get(row.day)[row.status] = row.count;
    statusesSeen.add(row.status);
  }

  const dayTotals = dayKeys.map((k) => Object.values(byDay.get(k)).reduce((a, b) => a + b, 0));
  const maxTotal = Math.max(1, ...dayTotals);

  const barSlot = plotW / dayKeys.length;
  const barWidth = Math.max(2, barSlot * 0.62);

  const statuses = ["approved", "rejected", ...[...statusesSeen].filter((s) => s !== "approved" && s !== "rejected").sort()];

  const bars = dayKeys
    .map((day, i) => {
      const counts = byDay.get(day);
      const x = padLeft + i * barSlot + (barSlot - barWidth) / 2;
      let yCursor = padTop + plotH;
      // Render each segment. The top segment (last drawn, highest on the bar)
      // gets rounded top corners via rx=2 so the bar reads as a single shape
      // even when stacked. We achieve this by tracking whether we're on the
      // last non-empty segment of this bar.
      const nonEmptyStatuses = statuses.filter((s) => (counts[s] ?? 0) > 0);
      const rects = statuses
        .map((status) => {
          const count = counts[status] ?? 0;
          if (count === 0) return "";
          const segH = (count / maxTotal) * plotH;
          yCursor -= segH;
          const color = CHART_STATUS_COLORS[status] ?? CHART_STATUS_FALLBACK;
          const isTop = status === nonEmptyStatuses[nonEmptyStatuses.length - 1];
          const rx = isTop ? Math.min(2, segH / 2, barWidth / 2) : 0;
          return `<rect x="${x.toFixed(1)}" y="${yCursor.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${segH.toFixed(1)}" fill="${color}" rx="${rx.toFixed(1)}"><title>${escapeHtml(day)}: ${count} ${escapeHtml(status)}</title></rect>`;
        })
        .join("");
      const labelStride = days > 10 ? Math.ceil(days / 10) : 1;
      const label = i % labelStride === 0 ? `<text x="${(x + barWidth / 2).toFixed(1)}" y="${height - 6}" class="chart-axis-label" text-anchor="middle">${escapeHtml(day.slice(5))}</text>` : "";
      return rects + label;
    })
    .join("\n");

  const gridlines = [0, 0.5, 1]
    .map((frac) => {
      const y = padTop + plotH * (1 - frac);
      const val = Math.round(maxTotal * frac);
      return `<line x1="${padLeft}" y1="${y.toFixed(1)}" x2="${width - 12}" y2="${y.toFixed(1)}" class="chart-gridline" />
        <text x="${padLeft - 6}" y="${(y + 3).toFixed(1)}" class="chart-axis-label" text-anchor="end">${val}</text>`;
    })
    .join("\n");

  const legend = statuses
    .map((status) => `<span class="legend-item"><span class="legend-swatch" style="background:${CHART_STATUS_COLORS[status] ?? CHART_STATUS_FALLBACK}"></span>${escapeHtml(status)}</span>`)
    .join("");

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" class="chart" role="img" aria-label="Trade decisions per day, last ${days} days">
    ${gridlines}
    ${bars}
  </svg>
  <div class="chart-legend">${legend}</div>`;
}

// Small non-cryptographic string hash (FNV-1a, 32-bit) -- used only to derive a stable SVG element id.
function shortHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export function priceSparkline(bars, { width = 240, height = 72 } = {}) {
  if (!bars || bars.length < 2) return `<p class="empty">not enough price history</p>`;

  const closes = bars.map((b) => b.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const range = max - min || 1;
  const padY = 6;
  const stepX = width / (closes.length - 1);

  const points = closes
    .map((c, i) => {
      const x = (i * stepX).toFixed(1);
      const y = (height - padY - ((c - min) / range) * (height - padY * 2)).toFixed(1);
      return `${x},${y}`;
    })
    .join(" ");

  const first = closes[0];
  const last = closes[closes.length - 1];
  const up = last >= first;
  const changePct = first !== 0 ? (((last - first) / first) * 100).toFixed(1) : "0.0";
  const color = up ? "var(--color-success-text)" : "var(--color-danger-text)";
  const fillColor = up ? "rgba(16, 185, 129, 0.14)" : "rgba(239, 68, 68, 0.14)";
  const gradId = `spark-${shortHash(points + fillColor)}`;
  // Area fill polygon: line points + bottom-right + bottom-left of plot area
  const lastX = ((closes.length - 1) * stepX).toFixed(1);
  const areaPoints = `0,${height - padY} ${points} ${lastX},${height - padY}`;

  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" width="100%" height="${height}" class="sparkline" role="img" aria-label="Recent close price trend">
      <defs>
        <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${fillColor}" />
          <stop offset="100%" stop-color="transparent" />
        </linearGradient>
      </defs>
      <polygon points="${areaPoints}" fill="url(#${gradId})" stroke="none" />
      <polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
    </svg>
    <div class="sparkline-meta">
      <span class="num">$${last.toFixed(2)}</span>
      <span class="${up ? "status-approved" : "status-rejected"}">${up ? "\u25b2" : "\u25bc"} ${Math.abs(changePct)}%</span>
      <span class="chart-axis-label">(${bars.length}d)</span>
    </div>`;
}

export function priceChartsGrid(tickerBars) {
  const entries = Object.entries(tickerBars).filter(([, bars]) => bars && bars.length >= 2);
  if (entries.length === 0) return `<p class="empty">No tickers with enough price history to chart yet.</p>`;

  const cells = entries
    .map(([ticker, bars]) => {
      const closes = bars.map((b) => b.close);
      const last = closes[closes.length - 1];
      const first = closes[0];
      const changePct = first !== 0 ? (((last - first) / first) * 100).toFixed(1) : "0.0";
      const up = last >= first;
      return `<div class="chart-cell"><div class="chart-cell-title"><span>${escapeHtml(ticker)}</span><span class="ticker-pill">${up ? "+" : ""}${changePct}%</span></div>${priceSparkline(bars)}</div>`;
    })
    .join("\n");

  return `<div class="chart-cell-grid">${cells}</div>`;
}

// ---------------------------------------------------------------------------
// Circular chart helpers (donut + gauge) -- pure SVG, no chart library.
// Used on Snapshot (portfolio composition, exposure gauge), Health (fresh vs
// stale sources), Decisions (approval rate), Positions (close reasons).
// ---------------------------------------------------------------------------

// Categorical palette -- 6 steps, mirrors shell.js's --chart-* tokens so the
// donut's legend swatches line up with what the CSS would paint if we let it.
const DONUT_PALETTE = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
];

// Convert a fraction (0..1) on a circle of radius r centered at (cx,cy) into
// cartesian (x,y). SVG arcs go clockwise from 12 o'clock -- callers don't need
// to think about this, just pass startFraction/endFraction in [0,1].
function polar(cx, cy, r, fraction) {
  const angle = fraction * 2 * Math.PI - Math.PI / 2;
  return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
}

// Build a single <path d="..."> for one donut "slice" spanning
// [startFraction, endFraction] on a ring of innerR..outerR around (cx,cy).
// Large-arc-flag is 1 if the slice covers >50% of the circle.
function donutSlicePath(cx, cy, innerR, outerR, startFraction, endFraction) {
  const sweep = endFraction - startFraction;
  if (sweep <= 0 || sweep >= 1) {
    // Full ring (rare in this dashboard but cheap to handle) -- two arcs back
    // to back along inner and outer radius, joined.
    const o1 = polar(cx, cy, outerR, 0);
    const o2 = polar(cx, cy, outerR, 0.5);
    const i1 = polar(cx, cy, innerR, 0.5);
    const i2 = polar(cx, cy, innerR, 0);
    return `M ${o1.x.toFixed(2)} ${o1.y.toFixed(2)} A ${outerR} ${outerR} 0 0 1 ${o2.x.toFixed(2)} ${o2.y.toFixed(2)} A ${outerR} ${outerR} 0 0 1 ${o1.x.toFixed(2)} ${o1.y.toFixed(2)} M ${i1.x.toFixed(2)} ${i1.y.toFixed(2)} A ${innerR} ${innerR} 0 0 0 ${i2.x.toFixed(2)} ${i2.y.toFixed(2)} A ${innerR} ${innerR} 0 0 0 ${i1.x.toFixed(2)} ${i1.y.toFixed(2)} Z`;
  }
  const largeArc = sweep > 0.5 ? 1 : 0;
  const p1 = polar(cx, cy, outerR, startFraction);
  const p2 = polar(cx, cy, outerR, endFraction);
  const p3 = polar(cx, cy, innerR, endFraction);
  const p4 = polar(cx, cy, innerR, startFraction);
  return `M ${p1.x.toFixed(2)} ${p1.y.toFixed(2)} A ${outerR} ${outerR} 0 ${largeArc} 1 ${p2.x.toFixed(2)} ${p2.y.toFixed(2)} L ${p3.x.toFixed(2)} ${p3.y.toFixed(2)} A ${innerR} ${innerR} 0 ${largeArc} 0 ${p4.x.toFixed(2)} ${p4.y.toFixed(2)} Z`;
}

/**
 * Render a donut chart with N segments + a center label and a side legend.
 *
 * @param {Array<{label:string, value:number, color?:string}>} segments - one per slice.
 *   If a segment's color is omitted, palette rotates through DONUT_PALETTE.
 *   Zero-value segments are skipped (no slice, no legend row) -- this matches
 *   what most chart libraries do and keeps the legend uncluttered.
 * @param {object} opts
 * @param {string} opts.centerValue - text shown large in the donut hole (e.g. "12").
 * @param {string} opts.centerLabel - small label under the center value (e.g. "open positions").
 * @param {string} opts.title - panel title above the donut.
 * @param {string} [opts.subtitle] - optional small subtitle.
 */
export function donutChart(segments, { centerValue, centerLabel, title, subtitle = null } = {}) {
  const total = segments.reduce((s, seg) => s + Math.max(0, seg.value), 0);
  // Empty-state: no data at all. Render a hollow ring + "no data" center so
  // the layout doesn't collapse to nothing on a fresh D1.
  if (total === 0) {
    return `<div class="donut-cell">
      ${title ? `<div class="donut-cell-title">${escapeHtml(title)}</div>` : ""}
      ${subtitle ? `<div class="donut-cell-subtitle">${escapeHtml(subtitle)}</div>` : ""}
      <div class="donut-wrap">
        <svg viewBox="0 0 160 160" width="160" height="160" class="donut-svg" role="img" aria-label="${escapeHtml(title ?? "donut chart")} (no data)">
          <circle cx="80" cy="80" r="58" fill="none" stroke="var(--bg-elevated)" stroke-width="18" />
          <text x="80" y="78" text-anchor="middle" class="donut-center-value" font-size="22">--</text>
          <text x="80" y="96" text-anchor="middle" class="donut-center-label">no data</text>
        </svg>
      </div>
    </div>`;
  }

  const cx = 80, cy = 80, outerR = 64, innerR = 46;
  let cursor = 0;
  const slices = [];
  const legendRows = [];
  segments.forEach((seg, i) => {
    if (seg.value <= 0) return;
    const fraction = seg.value / total;
    const startF = cursor;
    const endF = cursor + fraction;
    cursor = endF;
    const color = seg.color ?? DONUT_PALETTE[i % DONUT_PALETTE.length];
    const pctTxt = (fraction * 100).toFixed(fraction < 0.1 ? 1 : 0);
    slices.push(`<path d="${donutSlicePath(cx, cy, innerR, outerR, startF, endF)}" fill="${color}" stroke="var(--bg-surface)" stroke-width="1.5"><title>${escapeHtml(seg.label)}: ${seg.value} (${pctTxt}%)</title></path>`);
    legendRows.push(`<div class="donut-legend-row"><span class="donut-legend-swatch" style="background:${color}"></span><span class="donut-legend-label">${escapeHtml(seg.label)}</span><span class="donut-legend-value">${seg.value} &middot; ${pctTxt}%</span></div>`);
  });

  return `<div class="donut-cell">
    ${title ? `<div class="donut-cell-title">${escapeHtml(title)}</div>` : ""}
    ${subtitle ? `<div class="donut-cell-subtitle">${escapeHtml(subtitle)}</div>` : ""}
    <div class="donut-wrap">
      <svg viewBox="0 0 160 160" width="160" height="160" class="donut-svg" role="img" aria-label="${escapeHtml(title ?? "donut chart")}">
        <circle cx="${cx}" cy="${cy}" r="${(outerR + innerR) / 2}" fill="none" stroke="var(--bg-elevated)" stroke-width="${outerR - innerR}" />
        ${slices.join("\n        ")}
        <text x="${cx}" y="${cy - 2}" text-anchor="middle" class="donut-center-value" font-size="26">${escapeHtml(centerValue ?? "")}</text>
        <text x="${cx}" y="${cy + 16}" text-anchor="middle" class="donut-center-label">${escapeHtml(centerLabel ?? "")}</text>
      </svg>
      <div class="donut-legend">${legendRows.join("\n        ")}</div>
    </div>
  </div>`;
}

/**
 * Render a semi-circular gauge showing a 0..1 value with a colored needle arc.
 *
 * @param {number} value - in [0,1]. Clamped. Negative becomes 0; >1 becomes 1.
 * @param {object} opts
 * @param {string} opts.valueLabel - text shown big below the gauge (e.g. "62.5%").
 * @param {string} opts.label - small label under the value (e.g. "total exposure").
 * @param {string} opts.title - panel title.
 * @param {string} [opts.subtitle] - optional small subtitle.
 * @param {string} [opts.accent] - color of the filled arc (default: accent blue).
 *   Callers pass success/danger tokens to color-code the same shape.
 * @param {string} [opts.minLabel="0%"], [opts.maxLabel="100%"] - tick labels under the gauge.
 */
export function gaugeChart(value, { valueLabel, label, title, subtitle = null, accent = "var(--accent-bright)", minLabel = "0%", maxLabel = "100%" } = {}) {
  const v = Math.max(0, Math.min(1, value));
  // Semi-circle geometry: arc spans 180 degrees from (10,80) to (150,80),
  // passing through (80, 10). Filled arc covers fraction v of that.
  const cx = 80, cy = 80, r = 64;
  // 0 -> leftmost (180deg), 1 -> rightmost (0deg). Angle measured clockwise from positive x.
  // polar() above uses "fraction of full circle starting at 12 o'clock going clockwise" -- for a
  // half-circle from 9 o'clock to 3 o'clock over the top, that's fractions [0.75 .. 1.25] (polar() just wraps past 1).
  const startF = 0.75;
  const endF = 0.75 + 0.5 * v;

  const trackStart = polar(cx, cy, r, startF);
  const trackEnd = polar(cx, cy, r, 1.25);
  const fillEnd = polar(cx, cy, r, endF);
  // The fill spans at most 180deg (half the ring), so it is never the "large" arc.
  const largeArc = 0;

  // Tick label baseline
  return `<div class="gauge-cell">
    ${title ? `<div class="gauge-cell-title">${escapeHtml(title)}</div>` : ""}
    ${subtitle ? `<div class="gauge-cell-subtitle">${escapeHtml(subtitle)}</div>` : ""}
    <svg viewBox="0 0 160 96" width="100%" height="96" role="img" aria-label="${escapeHtml(title ?? "gauge")}: ${escapeHtml(valueLabel ?? "")}">
      <!-- Track -->
      <path d="M ${trackStart.x.toFixed(2)} ${trackStart.y.toFixed(2)} A ${r} ${r} 0 0 1 ${trackEnd.x.toFixed(2)} ${trackEnd.y.toFixed(2)}"
            fill="none" stroke="var(--bg-elevated)" stroke-width="14" stroke-linecap="round" />
      ${v > 0.001 ? `<!-- Filled arc -->
      <path d="M ${trackStart.x.toFixed(2)} ${trackStart.y.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${fillEnd.x.toFixed(2)} ${fillEnd.y.toFixed(2)}"
            fill="none" stroke="${accent}" stroke-width="14" stroke-linecap="round" />` : ""}
      <!-- Center value -->
      <text x="${cx}" y="${cy - 14}" text-anchor="middle" class="gauge-value" font-size="26">${escapeHtml(valueLabel ?? "")}</text>
      <text x="${cx}" y="${cy + 2}" text-anchor="middle" class="gauge-label">${escapeHtml(label ?? "")}</text>
      <!-- Tick labels -->
      <text x="10" y="92" text-anchor="middle" class="chart-axis-label">${escapeHtml(minLabel)}</text>
      <text x="150" y="92" text-anchor="middle" class="chart-axis-label">${escapeHtml(maxLabel)}</text>
    </svg>
  </div>`;
}
