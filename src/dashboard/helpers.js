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

export function parseDashboardParams(searchParams) {
  const sp = searchParams ?? new URLSearchParams();
  return {
    activityDays: pickFromOptions(sp.get("activityDays"), ACTIVITY_DAYS_OPTIONS, 14),
    decisionStatus: DECISION_STATUS_OPTIONS.includes(sp.get("decisionStatus")) ? sp.get("decisionStatus") : "all",
    decisionLimit: pickFromOptions(sp.get("decisionLimit"), DECISION_LIMIT_OPTIONS, 20),
    positionsLimit: pickFromOptions(sp.get("positionsLimit"), POSITIONS_LIMIT_OPTIONS, 50),
  };
}

export function buildQuery(params, overrides = {}) {
  const merged = { ...params, ...overrides };
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(merged)) sp.set(k, String(v));
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
  return `<tr${rowCls}><td>${escapeHtml(label)}</td><td class="num">${stat.count}</td><td class="num">${fmtTime(stat.lastIngestedAt)}</td><td>${flag}</td></tr>`;
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
        <td class="ticker">${escapeHtml(d.ticker)}</td>
        <td>${escapeHtml(d.thesis?.direction ?? "\u2014")}</td>
        <td>${statusBadge(d.status)}</td>
        <td class="num">${d.riskDecision?.positionSizePct != null ? (d.riskDecision.positionSizePct * 100).toFixed(1) + "%" : "\u2014"}</td>
        <td>${escapeHtml(d.portfolioDecision?.reason ?? d.riskDecision?.reason ?? "\u2014")}</td>
        <td class="num">${fmtTime(d.createdAt)}</td>
        <td>${llmAnswerDetails(d)}</td>
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
        <td class="ticker">${escapeHtml(p.ticker)}</td>
        <td>${escapeHtml(p.direction ?? "\u2014")}</td>
        <td class="num">${(p.positionSizePct * 100).toFixed(1)}%</td>
        <td class="num">${p.entryPrice != null ? "$" + Number(p.entryPrice).toFixed(2) : "\u2014"}</td>
        <td class="num">${fmtTime(p.openedAt)}</td>
        ${closed ? `<td class="num">${fmtTime(p.closedAt)}</td><td>${escapeHtml(p.closeReason ?? "\u2014")}</td>` : ""}
      </tr>`
    )
    .join("\n");
  return `<div class="table-wrap"><table>
    <thead><tr><th>Ticker</th><th>Direction</th><th>Size</th><th>Entry</th><th>Opened</th>${closed ? "<th>Closed</th><th>Reason</th>" : ""}</tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

export function backtestMetricRow(label, on, off, delta, { isPercent = true } = {}) {
  const fmt = (v) => (isPercent ? (v * 100).toFixed(1) + "%" : v.toFixed(2));
  const deltaCls = delta > 0 ? "status-approved" : delta < 0 ? "status-rejected" : "status-neutral";
  return `<tr><td>${escapeHtml(label)}</td><td class="num">${fmt(on)}</td><td class="num">${fmt(off)}</td><td class="num ${deltaCls}">${delta > 0 ? "+" : ""}${fmt(delta)}</td></tr>`;
}

export function backtestResultTable(result) {
  if (!result) return "";
  const { on, off, delta } = result.overall;
  return `<div class="table-wrap"><table>
    <thead><tr><th>Metric</th><th>Signal ON</th><th>Signal OFF (buy &amp; hold)</th><th>Delta</th></tr></thead>
    <tbody>
      ${backtestMetricRow("Cumulative return", on.cumulativeReturn, off.cumulativeReturn, delta.cumulativeReturn)}
      ${backtestMetricRow("Sharpe ratio", on.sharpeRatio, off.sharpeRatio, delta.sharpeRatio, { isPercent: false })}
      ${backtestMetricRow("Win rate", on.winRate, off.winRate, delta.winRate)}
      ${backtestMetricRow("Max drawdown", on.maxDrawdown, off.maxDrawdown, delta.maxDrawdown)}
    </tbody>
  </table></div>
  <p class="note">Positive delta always means "the signal looks better on this metric" (max drawdown's sign is normalized the same way) -- see signalCompare.js#compareSignalOnOff. Pooled across ${result.perWindow.length} walk-forward window${result.perWindow.length === 1 ? "" : "s"}.</p>`;
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
      return `<details class="llm-answer" ${r.status !== "running" ? "" : "open"}><summary>${summary}</summary><div class="llm-answer-body" style="max-width:none">${body}</div></details>`;
    })
    .join("\n");
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
    .map((c) => `<tr><td class="ticker">${escapeHtml(c.ticker)}</td><td>${escapeHtml(c.stage)}</td><td class="num">${fmtTime(c.updated_at)}</td></tr>`)
    .join("\n");
  return `<div class="table-wrap"><table>
    <thead><tr><th>Ticker</th><th>Last Stage</th><th>Updated</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

export function statCard(value, label, sub = null, accent = "var(--accent)") {
  return `<div class="stat-card" style="--accent:${accent}">
    <div class="stat-value">${escapeHtml(value)}</div>
    <div class="stat-label">${escapeHtml(label)}</div>
    ${sub ? `<div class="stat-sub">${escapeHtml(sub)}</div>` : ""}
  </div>`;
}

export function renderSummaryCards({ openPositions, closedPositions, decisionStats }) {
  const totalExposurePct = openPositions.reduce((sum, p) => sum + (p.positionSizePct ?? 0), 0) * 100;
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
      const rects = statuses
        .map((status) => {
          const count = counts[status] ?? 0;
          if (count === 0) return "";
          const segH = (count / maxTotal) * plotH;
          yCursor -= segH;
          const color = CHART_STATUS_COLORS[status] ?? CHART_STATUS_FALLBACK;
          return `<rect x="${x.toFixed(1)}" y="${yCursor.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${segH.toFixed(1)}" fill="${color}"><title>${escapeHtml(day)}: ${count} ${escapeHtml(status)}</title></rect>`;
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

export function priceSparkline(bars, { width = 240, height = 64 } = {}) {
  if (!bars || bars.length < 2) return `<p class="empty">not enough price history</p>`;

  const closes = bars.map((b) => b.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const range = max - min || 1;
  const padY = 4;
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

  return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" class="sparkline" role="img" aria-label="Recent close price trend">
      <polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round" />
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
    .map(([ticker, bars]) => `<div class="chart-cell"><div class="chart-cell-title">${escapeHtml(ticker)}</div>${priceSparkline(bars)}</div>`)
    .join("\n");

  return `<div class="chart-cell-grid">${cells}</div>`;
}
