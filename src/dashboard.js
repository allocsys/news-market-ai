// Server-rendered operational dashboard, served live by the Worker itself
// (src/index.js#fetch routes GET /dashboard here) -- reads D1 directly on
// every request, no caching layer, no client-side framework. Combines
// three views the project previously had no way to see outside raw SQL or
// Actions logs: recent trade decisions, current positions, and a rough
// ingestion-health signal. Also renders two chart views (decision activity,
// per-ticker price) as inline server-generated SVG -- no client JS, no
// chart library dependency, fits the zero-build Worker environment.
//
// FILTERS (added after initial ship): decision status/limit, the activity
// chart's day window, and the open-positions row limit are all read from
// the request's query string (?decisionStatus=approved&decisionLimit=50&
// activityDays=30&positionsLimit=25) and rendered as plain GET links/forms
// -- no client JS needed, a filter change is just a normal page navigation
// to a new URL, same zero-build philosophy as the rest of this file.
// parseDashboardParams clamps every value to a small allowed set rather
// than trusting the query string directly, so a malformed/hostile param
// falls back to the default instead of erroring the page.
//
// HONEST SCOPE, read before treating this as a complete operations view:
// 1. Backtest results (migrations/0010_backtest_runs.sql) are now shown,
//    manual-trigger only: a plain <form method="post" action="/backtest/run">
//    button, same zero-client-JS philosophy as every other filter/form on
//    this page -- a click is a normal browser POST navigation, no fetch()/
//    JS needed. NOT automatic -- there is deliberately no cron/scheduled
//    wiring to this (see src/backtest/runBacktest.js's header); every run
//    on the list below was a deliberate, explicit click by someone who
//    typed the shared secret. The "on" side of a run spends real Gemini
//    quota (src/backtest/onSignalRunner.js), so this form is intentionally
//    NOT a one-click no-confirmation action -- it requires the operator to
//    know and enter BACKTEST_API_SECRET, same gate as curl'ing the route
//    directly. A run's own outcome only reflects whatever news is ALREADY
//    backfilled for its window (POST /backfill, a separate manual step) --
//    a window with nothing backfilled will show a thin/empty "on" side, not
//    an error.
// 2. Vendor/ingestion errors are NOT shown per-source -- graph/pipeline.js's
//    failure isolation only console.error()s a skipped source, which isn't
//    queryable from D1. What IS shown (getIngestionHealth) is a weaker but
//    real proxy: last-ingested timestamp + row count per table, now with a
//    simple staleness threshold (STALE_INGESTION_HOURS) that flags a row
//    when its last-ingested time is older than that many hours. That's a
//    fixed heuristic, not a per-source SLA -- it just says "this looks
//    old", not WHICH vendor or WHY without a real error-log table (not
//    built here).
// 3. Realized P&L on closed positions can't be shown -- closePosition
//    never records an exit price (only closed_at/close_reason), so this
//    view shows direction/entry price/close reason/timing, not a return
//    figure. See storage/d1.js#getRecentlyClosedPositions's own header.
// 4. debate_id on every trade_decisions row is STILL always null -- the
//    normalized `debates`/`analyst_opinions` tables (migrations/0001_init.sql)
//    still have no write path (surfaced while building this, see
//    storage/d1.js#insertTradeDecision's header). What changed
//    (migrations/0008_trade_decisions_llm_answers.sql): trade_decisions now
//    also carries `opinions` (the Analyst Team's per-article output) and
//    `debate` (bull/bear/verdict) as JSON columns on the same row, and this
//    dashboard's Decisions section (below) renders them per-row behind a
//    <details> disclosure -- no client JS needed, same zero-build
//    philosophy as the rest of this file. Rows written BEFORE that
//    migration have both columns null and render an honest "not recorded"
//    message instead of a blank/broken panel.
// 5. The price sparkline section (new) plots price_bars.close as ingested
//    -- it's whatever yfinance last reported, not adjusted for splits/divs,
//    and only covers tickers with at least 2 bars on record. A ticker with
//    0-1 bars is skipped from the chart grid rather than shown broken.
// 6. The decision-activity chart buckets by created_at's UTC calendar date
//    (see storage/d1.js#getDecisionStats) -- a decision made at 23:58 UTC
//    and one at 00:02 UTC the next day land in different bars even if only
//    minutes apart. A day with zero decisions is still shown as an empty
//    bar (not omitted), so the x-axis stays a real, evenly-spaced timeline.
//
// All user-controllable/LLM-generated text (ticker strings, rationale,
// reasons) is HTML-escaped before interpolation -- see escapeHtml below.
// This data originates from this project's own LLM cascade and vendor
// ingestion, not from an anonymous public form, but escaping costs nothing
// and this is the one place all of it gets rendered as HTML.

import {
  getRecentTradeDecisions,
  getAllOpenPositions,
  getRecentlyClosedPositions,
  getRecentCheckpoints,
  getIngestionHealth,
  getDecisionStats,
  getRecentPriceBars,
  getRecentBacktestRuns,
} from "./storage/d1.js";

const ESCAPE_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

/** Formats an ISO timestamp for display, or a dash if null/missing -- never throws on a malformed/absent value. */
function fmtTime(iso) {
  if (!iso) return "\u2014";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? escapeHtml(iso) : d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function statusBadge(status) {
  const cls = status === "approved" ? "status-approved" : status === "rejected" ? "status-rejected" : "status-neutral";
  return `<span class="status ${cls}">[${escapeHtml(status)}]</span>`;
}

// --------------------------------------------------------------------
// Query-param filters
// --------------------------------------------------------------------

const ACTIVITY_DAYS_OPTIONS = [7, 14, 30, 60];
const DECISION_STATUS_OPTIONS = ["all", "approved", "rejected"];
const DECISION_LIMIT_OPTIONS = [10, 20, 50, 100];
const POSITIONS_LIMIT_OPTIONS = [10, 25, 50, 100];
const STALE_INGESTION_HOURS = 26; // a bit over one day -- gives a daily cron room without false-alarming on normal jitter

function pickFromOptions(raw, options, fallback) {
  const parsed = Number.isNaN(Number(raw)) ? raw : Number(raw);
  return options.includes(parsed) ? parsed : fallback;
}

/**
 * Reads and clamps every filter to a small allowed set from the request's
 * query string. A missing/unrecognized value silently falls back to the
 * default rather than erroring the page -- a dashboard should never 500 on
 * a hand-edited or stale URL.
 */
export function parseDashboardParams(searchParams) {
  const sp = searchParams ?? new URLSearchParams();
  return {
    activityDays: pickFromOptions(sp.get("activityDays"), ACTIVITY_DAYS_OPTIONS, 14),
    decisionStatus: DECISION_STATUS_OPTIONS.includes(sp.get("decisionStatus")) ? sp.get("decisionStatus") : "all",
    decisionLimit: pickFromOptions(sp.get("decisionLimit"), DECISION_LIMIT_OPTIONS, 20),
    positionsLimit: pickFromOptions(sp.get("positionsLimit"), POSITIONS_LIMIT_OPTIONS, 50),
  };
}

/** Builds a "?a=1&b=2" query string for `params` with `overrides` applied -- used to make filter links/forms that preserve every OTHER current filter. */
function buildQuery(params, overrides = {}) {
  const merged = { ...params, ...overrides };
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(merged)) sp.set(k, String(v));
  return `?${sp.toString()}`;
}

function pillLinks(label, options, current, paramName, params) {
  const links = options
    .map((opt) => {
      const active = String(opt) === String(current);
      return `<a href="${buildQuery(params, { [paramName]: opt })}" class="pill${active ? " pill-active" : ""}">${escapeHtml(String(opt))}</a>`;
    })
    .join("");
  return `<div class="filter-group"><span class="filter-label">${escapeHtml(label)}</span><div class="pill-row">${links}</div></div>`;
}

// --------------------------------------------------------------------
// Section nav
// --------------------------------------------------------------------

const NAV_SECTIONS = [
  ["snapshot", "Snapshot"],
  ["activity", "Activity"],
  ["charts", "Charts"],
  ["health", "Health"],
  ["decisions", "Decisions"],
  ["positions", "Positions"],
  ["pipeline", "Pipeline"],
  ["backtest", "Backtest"],
];

function renderNav() {
  const links = NAV_SECTIONS.map(([id, label]) => `<a href="#${id}">${escapeHtml(label)}</a>`).join("");
  return `<nav class="section-nav">${links}</nav>`;
}

function healthRow(label, stat) {
  const stale = stat.lastIngestedAt ? Date.now() - new Date(stat.lastIngestedAt).getTime() > STALE_INGESTION_HOURS * 3600 * 1000 : true;
  const rowCls = stale ? " class=\"stale-row\"" : "";
  const flag = stale ? `<span class="stale-flag" title="No new rows in over ${STALE_INGESTION_HOURS}h">stale</span>` : `<span class="ok-flag">fresh</span>`;
  return `<tr${rowCls}><td>${escapeHtml(label)}</td><td class="num">${stat.count}</td><td class="num">${fmtTime(stat.lastIngestedAt)}</td><td>${flag}</td></tr>`;
}

// --------------------------------------------------------------------
// LLM answer rendering (migrations/0008_trade_decisions_llm_answers.sql)
// --------------------------------------------------------------------

const OPINION_AGENT_LABELS = { news_event: "News", sentiment: "Sentiment", technical: "Technical" };

/** One line for a single AnalystOpinion (schemas/index.js) -- agent-specific lead-in (eventType/sentiment) where present, then summary + justification. */
function analystOpinionLine(op) {
  const label = OPINION_AGENT_LABELS[op.agent] ?? op.agent;
  const lead = op.agent === "news_event" && op.eventType ? `${op.eventType} \u2014 ` : op.agent === "sentiment" && op.sentiment ? `${op.sentiment} \u2014 ` : "";
  return `<div class="llm-block"><span class="llm-agent">${escapeHtml(label)}</span>${escapeHtml(lead)}${escapeHtml(op.summary)} <span class="llm-justification">(${escapeHtml(op.justification)})</span></div>`;
}

/** Bull + bear + verdict lines for one DebateVerdict (schemas/index.js) -- bull/bear are nested DebateSide objects inside it. */
function debateLines(debate) {
  if (!debate) return "";
  const confidencePct = typeof debate.confidence === "number" ? `${(debate.confidence * 100).toFixed(0)}%` : "\u2014";
  return `<div class="llm-block"><span class="llm-agent llm-agent-bull">Bull</span>${escapeHtml(debate.bull?.argument ?? "\u2014")} <span class="llm-justification">(${escapeHtml(debate.bull?.justification ?? "\u2014")})</span></div>
    <div class="llm-block"><span class="llm-agent llm-agent-bear">Bear</span>${escapeHtml(debate.bear?.argument ?? "\u2014")} <span class="llm-justification">(${escapeHtml(debate.bear?.justification ?? "\u2014")})</span></div>
    <div class="llm-block"><span class="llm-agent">Verdict</span>${escapeHtml(debate.direction ?? "\u2014")}, ${confidencePct} confidence, ${escapeHtml(debate.timeHorizon ?? "\u2014")} horizon <span class="llm-justification">(${escapeHtml(debate.justification ?? "\u2014")})</span></div>`;
}

/** Trader's instrument + rationale (TradeThesis, schemas/index.js) -- always present on a decision row, unlike opinions/debate which may predate migrations/0008. */
function traderLine(thesis) {
  if (!thesis) return "";
  return `<div class="llm-block"><span class="llm-agent">Trader</span>${escapeHtml(thesis.instrument ?? "\u2014")} <span class="llm-justification">(${escapeHtml(thesis.rationale ?? "\u2014")})</span></div>`;
}

/**
 * The full "LLM answer" for one decision row, behind a native <details>
 * disclosure (no client JS -- same zero-build philosophy as the rest of
 * this file): every analyst opinion, the bull/bear debate + judge verdict,
 * and the trader's rationale, in pipeline order. Falls back to an honest
 * "not recorded" message for rows written before migrations/0008 (both
 * opinions and debate null on those).
 */
function llmAnswerDetails(d) {
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

function decisionsTable(decisions) {
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
  return `<table>
    <thead><tr><th>Ticker</th><th>Direction</th><th>Status</th><th>Size</th><th>Reason</th><th>Decided</th><th>LLM reasoning</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function positionsTable(positions, { closed = false } = {}) {
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
  return `<table>
    <thead><tr><th>Ticker</th><th>Direction</th><th>Size</th><th>Entry</th><th>Opened</th>${closed ? "<th>Closed</th><th>Reason</th>" : ""}</tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/**
 * Renders one metric row for the backtest results table -- on/off/delta,
 * each formatted per its own convention (percent for cumulativeReturn/
 * winRate/maxDrawdown, plain 2-decimal for sharpeRatio). `deltaGood` flags
 * whether a positive delta means "good" for this metric -- true for every
 * metric here since signalCompare.js#compareSignalOnOff already normalizes
 * the sign so positive always means "signal looks better" (see that
 * function's own header), so this is really just a display convenience,
 * not a second sign convention.
 */
function backtestMetricRow(label, on, off, delta, { isPercent = true } = {}) {
  const fmt = (v) => (isPercent ? (v * 100).toFixed(1) + "%" : v.toFixed(2));
  const deltaCls = delta > 0 ? "status-approved" : delta < 0 ? "status-rejected" : "status-neutral";
  return `<tr><td>${escapeHtml(label)}</td><td class="num">${fmt(on)}</td><td class="num">${fmt(off)}</td><td class="num ${deltaCls}">${delta > 0 ? "+" : ""}${fmt(delta)}</td></tr>`;
}

/** One completed run's on/off/delta comparison table, from its persisted `result.overall` (signalCompare.js#compareSignalOnOff's shape). */
function backtestResultTable(result) {
  if (!result) return "";
  const { on, off, delta } = result.overall;
  return `<table>
    <thead><tr><th>Metric</th><th>Signal ON</th><th>Signal OFF (buy &amp; hold)</th><th>Delta</th></tr></thead>
    <tbody>
      ${backtestMetricRow("Cumulative return", on.cumulativeReturn, off.cumulativeReturn, delta.cumulativeReturn)}
      ${backtestMetricRow("Sharpe ratio", on.sharpeRatio, off.sharpeRatio, delta.sharpeRatio, { isPercent: false })}
      ${backtestMetricRow("Win rate", on.winRate, off.winRate, delta.winRate)}
      ${backtestMetricRow("Max drawdown", on.maxDrawdown, off.maxDrawdown, delta.maxDrawdown)}
    </tbody>
  </table>
  <p class="note">Positive delta always means "the signal looks better on this metric" (max drawdown's sign is normalized the same way) -- see signalCompare.js#compareSignalOnOff. Pooled across ${result.perWindow.length} walk-forward window${result.perWindow.length === 1 ? "" : "s"}.</p>`;
}

const BACKTEST_STATUS_LABEL = { running: "running…", complete: "complete", failed: "failed" };

/** List of persisted backtest_runs rows, newest first -- each with its own <details> disclosure for the full result table once complete. */
function backtestRunsList(runs) {
  if (runs.length === 0) return `<p class="empty">No backtest runs yet -- use the form above to trigger one.</p>`;
  return runs
    .map((r) => {
      const statusCls = r.status === "complete" ? "status-approved" : r.status === "failed" ? "status-rejected" : "status-neutral";
      const summary = `<span class="ticker">${escapeHtml(r.tickers.join(", "))}</span> &middot; ${fmtTime(r.testStart)} &rarr; ${fmtTime(r.testEnd)} &middot; <span class="status ${statusCls}">[${BACKTEST_STATUS_LABEL[r.status] ?? r.status}]</span>`;
      const body = r.status === "complete"
        ? backtestResultTable(r.result)
        : r.status === "failed"
          ? `<p class="empty">${escapeHtml(r.error ?? "failed with no recorded error message")}</p>`
          : `<p class="empty">Still running as of last page load -- reload to check.</p>`;
      return `<details class="llm-answer" ${r.status !== "running" ? "" : "open"}><summary>${summary}</summary><div class="llm-answer-body" style="max-width:none">${body}</div></details>`;
    })
    .join("\n");
}

/**
 * Plain <form method="post" action="/backtest/run"> -- no client JS, a
 * click is a normal browser POST navigation (src/index.js#fetch's
 * /backtest/run route reads these exact field names from the body when no
 * matching query param is present, see that route's own comment). The
 * secret field is required and unlabeled-safe-default-empty on purpose --
 * nothing here pre-fills or remembers it.
 */
function backtestTriggerForm() {
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  return `<form method="post" action="/backtest/run" class="filter-bar">
    <div class="filter-group">
      <span class="filter-label">Tickers (comma-separated, blank = watchlist)</span>
      <input class="filter-form" type="text" name="tickers" placeholder="AAPL,MSFT" style="background:#10160f;color:#e8e4d9;border:1px solid #263028;border-radius:4px;padding:0.32rem 0.5rem;font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:0.8rem;">
    </div>
    <div class="filter-group">
      <span class="filter-label">Test start</span>
      <input class="filter-form" type="date" name="testStart" value="${monthAgo}" style="background:#10160f;color:#e8e4d9;border:1px solid #263028;border-radius:4px;padding:0.3rem 0.5rem;">
    </div>
    <div class="filter-group">
      <span class="filter-label">Test end</span>
      <input class="filter-form" type="date" name="testEnd" value="${today}" style="background:#10160f;color:#e8e4d9;border:1px solid #263028;border-radius:4px;padding:0.3rem 0.5rem;">
    </div>
    <div class="filter-group">
      <span class="filter-label">Backtest secret</span>
      <input class="filter-form" type="password" name="secret" required style="background:#10160f;color:#e8e4d9;border:1px solid #263028;border-radius:4px;padding:0.3rem 0.5rem;">
    </div>
    <div class="filter-group">
      <span class="filter-label">&nbsp;</span>
      <button type="submit">Run backtest</button>
    </div>
  </form>`;
}

function checkpointsTable(checkpoints) {
  if (checkpoints.length === 0) return `<p class="empty">No pipeline activity recorded yet.</p>`;
  const rows = checkpoints
    .map((c) => `<tr><td class="ticker">${escapeHtml(c.ticker)}</td><td>${escapeHtml(c.stage)}</td><td class="num">${fmtTime(c.updated_at)}</td></tr>`)
    .join("\n");
  return `<table>
    <thead><tr><th>Ticker</th><th>Last Stage</th><th>Updated</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/** One summary-stat card: a big number, a label, an optional muted sub-line, and an accent color to break up an otherwise uniform grid. */
function statCard(value, label, sub = null, accent = "#7d8a7f") {
  return `<div class="stat-card" style="--accent:${accent}">
    <div class="stat-value">${escapeHtml(value)}</div>
    <div class="stat-label">${escapeHtml(label)}</div>
    ${sub ? `<div class="stat-sub">${escapeHtml(sub)}</div>` : ""}
  </div>`;
}

/**
 * Derives the portfolio-snapshot summary cards from data this page already
 * fetched -- no extra D1 reads. openPositions/closedPositions/decisions are
 * the same arrays the tables below render, just aggregated here.
 */
function renderSummaryCards({ openPositions, closedPositions, decisionStats }) {
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
    ${statCard(openPositions.length, "Open positions", `${longCount} long / ${shortCount} short`, "#c9a24b")}
    ${statCard(totalExposurePct.toFixed(1) + "%", "Total open exposure", "sum of position size %", "#6b8f71")}
    ${statCard(approvalRate, "Approval rate (all-time)", `${approved} approved / ${rejected} rejected${otherCount ? ` / ${otherCount} other` : ""}`, "#7d9bb8")}
    ${statCard(closedPositions.length, "Recently closed", `${stopLosses} stop-loss / ${takeProfits} take-profit`, "#a85c4a")}
  </div>`;
}

const CHART_STATUS_COLORS = { approved: "#6b8f71", rejected: "#a85c4a" };
const CHART_STATUS_FALLBACK = "#8b9490";

/**
 * Stacked SVG bar chart: trade decisions per UTC calendar day, split by
 * status. `daily` is storage/d1.js#getDecisionStats's `daily` rows
 * (day, status, count), `days` is how many trailing days to show (fills in
 * zero-bars for days with no rows so the x-axis stays evenly spaced).
 * Pure server-rendered SVG -- no chart library, no client JS.
 */
function decisionsActivityChart(daily, days) {
  const width = 640;
  const height = 180;
  const padLeft = 34;
  const padBottom = 26;
  const padTop = 10;
  const plotW = width - padLeft - 12;
  const plotH = height - padTop - padBottom;

  // Build the last `days` UTC calendar dates, oldest first, so a day with
  // zero decisions still gets its own (empty) bar slot.
  const todayUtc = new Date();
  const dayKeys = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(todayUtc.getUTCFullYear(), todayUtc.getUTCMonth(), todayUtc.getUTCDate() - i));
    dayKeys.push(d.toISOString().slice(0, 10));
  }

  // dayKey -> { status -> count }
  const byDay = new Map(dayKeys.map((k) => [k, {}]));
  const statusesSeen = new Set();
  for (const row of daily) {
    if (!byDay.has(row.day)) continue; // outside the requested window -- shouldn't happen given the SQL, but don't crash on it
    byDay.get(row.day)[row.status] = row.count;
    statusesSeen.add(row.status);
  }

  const dayTotals = dayKeys.map((k) => Object.values(byDay.get(k)).reduce((a, b) => a + b, 0));
  const maxTotal = Math.max(1, ...dayTotals);

  const barSlot = plotW / dayKeys.length;
  const barWidth = Math.max(2, barSlot * 0.62);

  // Stable status draw order: approved, rejected, then anything else
  // (alphabetical) -- keeps stacking order consistent run to run.
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
      // Sparse x-axis labels -- every ~3rd day (or every day if the window is short) to avoid overlapping text on a 640px chart.
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

/**
 * Small SVG line chart of recent closing prices for one ticker. `bars` is
 * storage/d1.js#getRecentPriceBars's chronological (oldest-first) output.
 * Returns an empty-state message instead of a chart if there are fewer
 * than 2 bars -- a single point has no line to draw.
 */
function priceSparkline(bars, { width = 240, height = 64 } = {}) {
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
  const color = up ? "#6b8f71" : "#a85c4a";

  return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" class="sparkline" role="img" aria-label="Recent close price trend">
      <polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round" />
    </svg>
    <div class="sparkline-meta">
      <span class="num">$${last.toFixed(2)}</span>
      <span class="${up ? "status-approved" : "status-rejected"}">${up ? "\u25b2" : "\u25bc"} ${Math.abs(changePct)}%</span>
      <span class="chart-axis-label">(${bars.length}d)</span>
    </div>`;
}

function priceChartsGrid(tickerBars) {
  const entries = Object.entries(tickerBars).filter(([, bars]) => bars && bars.length >= 2);
  if (entries.length === 0) return `<p class="empty">No tickers with enough price history to chart yet.</p>`;

  const cells = entries
    .map(([ticker, bars]) => `<div class="chart-cell"><div class="chart-cell-title">${escapeHtml(ticker)}</div>${priceSparkline(bars)}</div>`)
    .join("\n");

  return `<div class="chart-cell-grid">${cells}</div>`;
}

const STYLE = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    margin: 0; padding: 0 0 4rem;
    background: #0d1210; color: #e8e4d9;
    line-height: 1.4;
  }
  .ticker-strip {
    display: flex; align-items: baseline; gap: 0.9rem;
    padding: 0.85rem 2rem;
    border-bottom: 1px solid #c9a24b;
    background: #10160f;
  }
  .ticker-strip .mark { color: #c9a24b; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.9rem; letter-spacing: 0.02em; }
  h1 { font-size: 1.15rem; font-weight: 600; margin: 0; letter-spacing: 0.01em; }
  .subtitle { color: #7d8a7f; margin: 0; font-size: 0.82rem; font-family: ui-monospace, "SF Mono", Menlo, monospace; }

  .section-nav {
    position: sticky; top: 0; z-index: 10;
    display: flex; flex-wrap: wrap; gap: 1.1rem;
    padding: 0.6rem 2rem; margin-bottom: 2.25rem;
    background: rgba(13,18,16,0.92); backdrop-filter: blur(6px);
    border-bottom: 1px solid #1c231d;
  }
  .section-nav a {
    color: #9aa69b; text-decoration: none; font-size: 0.8rem;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    letter-spacing: 0.02em; padding: 0.2rem 0;
    border-bottom: 1px solid transparent;
    transition: color 0.12s ease, border-color 0.12s ease;
  }
  .section-nav a:hover { color: #c9a24b; border-color: #c9a24b; }

  main { padding: 0 2rem; }
  section { margin-bottom: 2.9rem; scroll-margin-top: 3.2rem; }
  h2 { font-size: 1rem; font-weight: 600; border-bottom: 1px solid #263028; padding-bottom: 0.55rem; margin-bottom: 0.85rem; letter-spacing: 0.01em; }
  .note { color: #7d8a7f; font-size: 0.8rem; margin: 0.25rem 0 1rem; max-width: 66ch; line-height: 1.55; }

  table { width: 100%; border-collapse: collapse; font-size: 0.86rem; }
  th, td {
    text-align: left; padding: 0.55rem 0.7rem;
    border-bottom: 1px solid #1c231d;
  }
  th { color: #7d8a7f; font-weight: 500; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.03em; }
  td.num { font-family: ui-monospace, "SF Mono", Menlo, monospace; color: #cfd6c8; font-size: 0.83rem; }
  td.ticker { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-weight: 600; letter-spacing: 0.02em; color: #f0ede2; }
  tbody tr { transition: background 0.1s ease; }
  tbody tr:hover { background: #131a13; }
  .empty { color: #55605a; font-style: italic; font-size: 0.86rem; }
  .status { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.82rem; }
  .status-approved { color: #6b8f71; }
  .status-rejected { color: #a85c4a; }
  .status-neutral { color: #8b9490; }
  /* MOBILE-FIRST (2026-09-18, live device report): this used to be
     "grid-template-columns: 1fr 1fr 1fr" here with a max-width:900px
     override collapsing it to 1fr -- on a live phone (narrow viewport,
     well under 900px) the 3-column layout was still rendering uncollapsed,
     squeezing every word in the Open Positions / Recently Closed / Recent
     Pipeline Activity cells onto its own line. Root cause not fully
     isolated (device/browser-specific viewport reporting is the leading
     suspect, not a CSS logic error -- the override rule itself was
     correctly written and ordered), but a max-width override is only ever
     as reliable as that reporting. Flipped to mobile-first: the base rule
     below is now the narrow-screen-safe default (single column, always
     correct with zero dependency on a media query actually matching), and
     the min-width override further down opts INTO 3 columns only once a
     wide viewport is confirmed -- an unmatched media query now degrades to
     the safe layout instead of the broken one. */
  .grid { display: grid; grid-template-columns: 1fr; gap: 1.5rem; }
  .grid > section { min-width: 0; } /* lets a wide table's min-content shrink instead of forcing its column past the viewport */

  /* LLM answer disclosure (migrations/0008_trade_decisions_llm_answers.sql) -- native <details>, no client JS */
  .llm-answer summary {
    cursor: pointer; color: #7d9bb8; font-size: 0.8rem;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    list-style: none; width: fit-content;
  }
  .llm-answer summary::-webkit-details-marker { display: none; }
  .llm-answer summary::before { content: "\\25b8 "; }
  .llm-answer[open] summary::before { content: "\\25be "; }
  .llm-answer summary:hover { color: #a9c3db; }
  .llm-answer-body {
    margin-top: 0.5rem; padding: 0.7rem 0.85rem;
    background: #0d1210; border: 1px solid #263028; border-radius: 5px;
    max-width: 52ch; display: flex; flex-direction: column; gap: 0.5rem;
  }
  .llm-block { font-size: 0.8rem; line-height: 1.5; color: #cfd6c8; }
  .llm-agent {
    display: inline-block; font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 0.68rem; font-weight: 600; letter-spacing: 0.03em; text-transform: uppercase;
    color: #0d1210; background: #7d9bb8; border-radius: 3px;
    padding: 0.08rem 0.4rem; margin-right: 0.4rem; vertical-align: middle;
  }
  .llm-agent-bull { background: #6b8f71; }
  .llm-agent-bear { background: #a85c4a; }
  .llm-justification { color: #7d8a7f; font-style: italic; }

  tr.stale-row td { color: #8b8060; }
  .stale-flag {
    font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.72rem;
    color: #0d1210; background: #c9a24b; border-radius: 3px; padding: 0.12rem 0.4rem;
    letter-spacing: 0.03em;
  }
  .ok-flag {
    font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.72rem;
    color: #6b8f71; letter-spacing: 0.03em;
  }

  /* Filters -- plain GET links/forms, no client JS */
  .filter-bar { display: flex; flex-wrap: wrap; gap: 1.75rem; align-items: flex-end; margin-bottom: 1rem; }
  .filter-group { display: flex; flex-direction: column; gap: 0.35rem; }
  .filter-label { font-size: 0.72rem; color: #7d8a7f; text-transform: uppercase; letter-spacing: 0.04em; }
  .pill-row { display: flex; gap: 0.4rem; }
  .pill {
    font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.78rem;
    color: #cfd6c8; text-decoration: none;
    padding: 0.28rem 0.65rem; border-radius: 999px;
    border: 1px solid #263028; background: #10160f;
    transition: border-color 0.12s ease, color 0.12s ease;
  }
  .pill:hover { border-color: #7d8a7f; }
  .pill-active { color: #0d1210; background: #c9a24b; border-color: #c9a24b; font-weight: 600; }
  .filter-form select {
    font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.8rem;
    background: #10160f; color: #e8e4d9; border: 1px solid #263028;
    border-radius: 4px; padding: 0.32rem 0.5rem;
  }
  .filter-form button {
    font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.78rem; font-weight: 600;
    color: #0d1210; background: #c9a24b; border: none; border-radius: 4px;
    padding: 0.35rem 0.8rem; cursor: pointer;
  }
  .filter-form button:hover { background: #ddb75c; }

  /* Summary stat cards */
  .stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; }
  .stat-card {
    background: #10160f; border: 1px solid #263028; border-left: 3px solid var(--accent, #263028);
    border-radius: 6px; padding: 0.95rem 1.05rem;
  }
  .stat-value { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 1.55rem; font-weight: 600; color: #e8e4d9; font-variant-numeric: tabular-nums; }
  .stat-label { font-size: 0.78rem; color: #7d8a7f; margin-top: 0.2rem; }
  .stat-sub { font-size: 0.74rem; color: #55605a; margin-top: 0.4rem; font-family: ui-monospace, "SF Mono", Menlo, monospace; }

  /* Charts (server-rendered inline SVG, no client JS/library) */
  .chart { display: block; background: #10160f; border: 1px solid #263028; border-radius: 6px; }
  .chart-gridline { stroke: #1c231d; stroke-width: 1; }
  .chart-axis-label { fill: #55605a; font-size: 9px; font-family: ui-monospace, "SF Mono", Menlo, monospace; }
  .chart-legend { display: flex; gap: 1.1rem; margin-top: 0.65rem; font-size: 0.78rem; color: #7d8a7f; }
  .legend-item { display: inline-flex; align-items: center; gap: 0.35rem; }
  .legend-swatch { width: 0.65rem; height: 0.65rem; border-radius: 2px; display: inline-block; }
  .chart-cell-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 1.25rem; }
  .chart-cell { background: #10160f; border: 1px solid #263028; border-radius: 6px; padding: 0.85rem 0.95rem; }
  .chart-cell-title { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-weight: 600; letter-spacing: 0.02em; margin-bottom: 0.45rem; font-size: 0.86rem; }
  .sparkline { display: block; }
  .sparkline-meta { display: flex; gap: 0.6rem; align-items: baseline; margin-top: 0.4rem; font-size: 0.78rem; }

  @media (max-width: 900px) {
    .stat-grid { grid-template-columns: 1fr 1fr; }
    main { padding: 0 1.25rem; }
    .ticker-strip { padding: 0.85rem 1.25rem; flex-wrap: wrap; }
    .section-nav { padding: 0.6rem 1.25rem; overflow-x: auto; }
    .filter-bar { gap: 1.1rem; }
  }

  /* Opt INTO the 3-column layout only once a wide viewport is confirmed --
     see the mobile-first note on the base .grid rule above for why this
     replaced a max-width override. */
  @media (min-width: 901px) {
    .grid { grid-template-columns: 1fr 1fr 1fr; }
  }
`;

/**
 * Fetches every section's data in parallel (independent read-only D1
 * queries, no shared transaction needed) and returns a complete, self-
 * contained HTML page. Callers (src/index.js) are responsible for wrapping
 * this in a Response with the right content-type, and for passing the
 * request's URLSearchParams through as `options.searchParams` so filters
 * (see this file's header) work.
 *
 * Price-chart data is a second wave: it needs the distinct tickers from
 * openPositions first, so those getRecentPriceBars calls fire after the
 * first Promise.all resolves, capped at PRICE_CHART_TICKER_LIMIT distinct
 * tickers to bound how many extra D1 reads one dashboard request can
 * trigger.
 */
const PRICE_CHART_TICKER_LIMIT = 8;

export async function renderDashboardHtml(db, { searchParams } = {}) {
  const params = parseDashboardParams(searchParams);

  const [decisions, openPositions, closedPositions, checkpoints, health, decisionStats, backtestRuns] = await Promise.all([
    getRecentTradeDecisions(db, { limit: params.decisionLimit, status: params.decisionStatus === "all" ? undefined : params.decisionStatus }),
    getAllOpenPositions(db, { limit: params.positionsLimit }),
    getRecentlyClosedPositions(db, { limit: 20 }),
    getRecentCheckpoints(db, { limit: 30 }),
    getIngestionHealth(db),
    getDecisionStats(db, { days: params.activityDays }),
    getRecentBacktestRuns(db, { limit: 10 }),
  ]);

  const chartTickers = [...new Set(openPositions.map((p) => p.ticker))].slice(0, PRICE_CHART_TICKER_LIMIT);
  const priceBarsByTicker = Object.fromEntries(
    await Promise.all(chartTickers.map(async (ticker) => [ticker, await getRecentPriceBars(db, { ticker, limit: 30 })]))
  );

  const decisionsFilterBar = `<div class="filter-bar">
    ${pillLinks("Status", DECISION_STATUS_OPTIONS, params.decisionStatus, "decisionStatus", params)}
    ${pillLinks("Rows", DECISION_LIMIT_OPTIONS, params.decisionLimit, "decisionLimit", params)}
  </div>`;

  const activityFilterBar = `<div class="filter-bar">
    ${pillLinks("Window", ACTIVITY_DAYS_OPTIONS.map((d) => `${d}d`), `${params.activityDays}d`, "__activityDaysDisplay", params)}
  </div>`;
  // The pill labels above are display strings ("7d"); build the real links
  // manually since pillLinks assumes label === query value for non-display cases.
  const activityFilterBarReal = `<div class="filter-bar">
    <div class="filter-group">
      <span class="filter-label">Window</span>
      <div class="pill-row">
        ${ACTIVITY_DAYS_OPTIONS.map(
          (d) => `<a href="${buildQuery(params, { activityDays: d })}" class="pill${d === params.activityDays ? " pill-active" : ""}">${d}d</a>`
        ).join("")}
      </div>
    </div>
  </div>`;

  const positionsFilterBar = `<div class="filter-bar">
    ${pillLinks("Rows", POSITIONS_LIMIT_OPTIONS, params.positionsLimit, "positionsLimit", params)}
  </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>news-market-ai dashboard</title>
<style>${STYLE}</style>
</head>
<body>
  <div class="ticker-strip">
    <h1>news-market-ai</h1>
    <span class="mark">&bull;</span>
    <p class="subtitle">live &mdash; generated ${fmtTime(new Date().toISOString())} &mdash; architecture &amp; known gaps in plan.md</p>
  </div>
  ${renderNav()}
  <main>

  <section id="snapshot">
    <h2>Portfolio snapshot</h2>
    ${renderSummaryCards({ openPositions, closedPositions, decisionStats })}
  </section>

  <section id="activity">
    <h2>Decision activity</h2>
    <p class="note">Trade decisions per UTC calendar day, stacked by status. A zero-height day means the pipeline produced no decisions that day -- it doesn't distinguish "quiet market" from "run failed before reaching this stage" (see Recent pipeline activity below for that).</p>
    ${activityFilterBarReal}
    ${decisionsActivityChart(decisionStats.daily, params.activityDays)}
  </section>

  <section id="charts">
    <h2>Price charts</h2>
    <p class="note">Recent daily closes (yfinance, unadjusted) for tickers with an open position, up to ${PRICE_CHART_TICKER_LIMIT} charted. Not point-in-time-gated -- this is "what the price actually is right now", same convention as the rest of this dashboard.</p>
    ${priceChartsGrid(priceBarsByTicker)}
  </section>

  <section id="health">
    <h2>Ingestion health</h2>
    <p class="note">Last-ingested timestamp + row count per source. Not a per-vendor error log (none is persisted yet) -- a stale timestamp is the strongest signal available here. "Stale" below just means no new rows in over ${STALE_INGESTION_HOURS}h, a fixed heuristic, not a per-source SLA.</p>
    <table>
      <thead><tr><th>Source</th><th>Rows</th><th>Last ingested</th><th>Status</th></tr></thead>
      <tbody>
        ${healthRow("News (gdelt/rss/scrape)", health.news)}
        ${healthRow("Price bars (yfinance)", health.priceBars)}
        ${healthRow("Fundamentals (EDGAR)", health.fundamentals)}
      </tbody>
    </table>
  </section>

  <section id="decisions">
    <h2>Recent trade decisions</h2>
    <p class="note">Full decision chain (thesis + risk + portfolio sign-off) for every completed run. Expand "LLM reasoning" on a row to see the Analyst Team's opinions, the bull/bear debate, the judge's verdict, and the trader's rationale that produced it -- rows from before this feature shipped show "not recorded" instead.</p>
    ${decisionsFilterBar}
    ${decisionsTable(decisions)}
  </section>

  <div class="grid">
    <section id="positions">
      <h2>Open positions (${openPositions.length})</h2>
      ${positionsFilterBar}
      ${positionsTable(openPositions)}
    </section>
    <section>
      <h2>Recently closed (${closedPositions.length})</h2>
      <p class="note">No exit price is recorded on close -- realized return can't be shown, only how/when a position closed.</p>
      ${positionsTable(closedPositions, { closed: true })}
    </section>
    <section id="pipeline">
      <h2>Recent pipeline activity</h2>
      <p class="note">Latest completed stage per run. A stuck/crashed run just stops appearing here, not shown as a failure.</p>
      ${checkpointsTable(checkpoints)}
    </section>
  </div>

  <section id="backtest">
    <h2>Backtest results</h2>
    <p class="note">Signal ON (real pipeline over already-backfilled news) vs. signal OFF (naive buy &amp; hold), manually triggered -- never automatic. Requires the shared backtest secret. A window with no backfilled news for it (see <code>POST /backfill</code>) will show a thin/empty "on" side, not an error.</p>
    ${backtestTriggerForm()}
    ${backtestRunsList(backtestRuns)}
  </section>
  </main>
</body>
</html>`;
}
