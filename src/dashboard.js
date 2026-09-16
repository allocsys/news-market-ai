// Server-rendered operational dashboard, served live by the Worker itself
// (src/index.js#fetch routes GET /dashboard here) -- reads D1 directly on
// every request, no caching layer, no client-side framework. Combines
// three views the project previously had no way to see outside raw SQL or
// Actions logs: recent trade decisions, current positions, and a rough
// ingestion-health signal.
//
// HONEST SCOPE, read before treating this as a complete operations view:
// 1. Backtest results are NOT shown here -- there is no persisted table for
//    a completed backtest run (src/backtest/*.js is a pure computation
//    library today, plan.md's own "signal on/off" checklist item is
//    explicit that it computes comparisons given return series, it doesn't
//    run and store one). Rather than fake a section, this dashboard omits
//    backtest results entirely until that persistence layer exists.
// 2. Vendor/ingestion errors are NOT shown per-source -- graph/pipeline.js's
//    failure isolation only console.error()s a skipped source, which isn't
//    queryable from D1. What IS shown (getIngestionHealth) is a weaker but
//    real proxy: last-ingested timestamp + row count per table. A stale
//    timestamp is a real signal something's wrong; it just can't say WHICH
//    vendor or WHY without adding a real error-log table (not built here).
// 3. Realized P&L on closed positions can't be shown -- closePosition
//    never records an exit price (only closed_at/close_reason), so this
//    view shows direction/entry price/close reason/timing, not a return
//    figure. See storage/d1.js#getRecentlyClosedPositions's own header.
// 4. debate_id on every trade_decisions row is always null -- the debates
//    table has no write path either (surfaced while building this, see
//    storage/d1.js#insertTradeDecision's header). This dashboard shows the
//    bull/bear reasoning as it exists today: nowhere, since it's not
//    persisted -- only the thesis that came out the other end.
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

function healthRow(label, stat) {
  return `<tr><td>${escapeHtml(label)}</td><td class="num">${stat.count}</td><td class="num">${fmtTime(stat.lastIngestedAt)}</td></tr>`;
}

function decisionsTable(decisions) {
  if (decisions.length === 0) return `<p class="empty">No decisions recorded yet.</p>`;
  const rows = decisions
    .map(
      (d) => `<tr>
        <td class="ticker">${escapeHtml(d.ticker)}</td>
        <td>${escapeHtml(d.thesis?.direction ?? "\u2014")}</td>
        <td>${statusBadge(d.status)}</td>
        <td class="num">${d.riskDecision?.positionSizePct != null ? (d.riskDecision.positionSizePct * 100).toFixed(1) + "%" : "\u2014"}</td>
        <td>${escapeHtml(d.portfolioDecision?.reason ?? d.riskDecision?.reason ?? "\u2014")}</td>
        <td class="num">${fmtTime(d.createdAt)}</td>
      </tr>`
    )
    .join("\n");
  return `<table>
    <thead><tr><th>Ticker</th><th>Direction</th><th>Status</th><th>Size</th><th>Reason</th><th>Decided</th></tr></thead>
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

const STYLE = `
  :root { color-scheme: dark; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    margin: 0; padding: 0 0 3rem;
    background: #0d1210; color: #e8e4d9;
  }
  .ticker-strip {
    display: flex; align-items: baseline; gap: 0.9rem;
    padding: 0.85rem 2rem; margin-bottom: 2rem;
    border-bottom: 1px solid #c9a24b;
    background: #10160f;
  }
  .ticker-strip .mark { color: #c9a24b; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.9rem; letter-spacing: 0.02em; }
  h1 { font-size: 1.15rem; font-weight: 600; margin: 0; }
  .subtitle { color: #7d8a7f; margin: 0; font-size: 0.82rem; font-family: ui-monospace, "SF Mono", Menlo, monospace; }
  main { padding: 0 2rem; }
  section { margin-bottom: 2.75rem; }
  h2 { font-size: 0.98rem; font-weight: 600; border-bottom: 1px solid #263028; padding-bottom: 0.5rem; margin-bottom: 0.75rem; }
  .note { color: #7d8a7f; font-size: 0.8rem; margin: 0.25rem 0 0.9rem; max-width: 62ch; line-height: 1.5; }
  table { width: 100%; border-collapse: collapse; font-size: 0.86rem; }
  th, td {
    text-align: left; padding: 0.5rem 0.7rem;
    border-bottom: 1px solid #1c231d;
  }
  th { color: #7d8a7f; font-weight: 500; font-size: 0.78rem; }
  td.num, th:nth-child(n) ~ th { font-variant-numeric: tabular-nums; }
  td.num { font-family: ui-monospace, "SF Mono", Menlo, monospace; color: #cfd6c8; font-size: 0.83rem; }
  td.ticker { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-weight: 600; letter-spacing: 0.02em; }
  .empty { color: #55605a; font-style: italic; font-size: 0.86rem; }
  .status { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.82rem; }
  .status-approved { color: #6b8f71; }
  .status-rejected { color: #a85c4a; }
  .status-neutral { color: #8b9490; }
  .grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 1.5rem; }
  @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } main { padding: 0 1.25rem; } .ticker-strip { padding: 0.85rem 1.25rem; flex-wrap: wrap; } }
`;

/**
 * Fetches every section's data in parallel (independent read-only D1
 * queries, no shared transaction needed) and returns a complete, self-
 * contained HTML page. Callers (src/index.js) are responsible for wrapping
 * this in a Response with the right content-type.
 */
export async function renderDashboardHtml(db) {
  const [decisions, openPositions, closedPositions, checkpoints, health] = await Promise.all([
    getRecentTradeDecisions(db, { limit: 20 }),
    getAllOpenPositions(db, { limit: 50 }),
    getRecentlyClosedPositions(db, { limit: 20 }),
    getRecentCheckpoints(db, { limit: 30 }),
    getIngestionHealth(db),
  ]);

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
  <main>

  <section>
    <h2>Ingestion health</h2>
    <p class="note">Last-ingested timestamp + row count per source. Not a per-vendor error log (none is persisted yet) -- a stale timestamp is the strongest signal available here.</p>
    <table>
      <thead><tr><th>Source</th><th>Rows</th><th>Last ingested</th></tr></thead>
      <tbody>
        ${healthRow("News (gdelt/rss/scrape)", health.news)}
        ${healthRow("Price bars (yfinance)", health.priceBars)}
        ${healthRow("Fundamentals (EDGAR)", health.fundamentals)}
      </tbody>
    </table>
  </section>

  <section>
    <h2>Recent trade decisions</h2>
    <p class="note">Full decision chain (thesis + risk + portfolio sign-off) for every completed run. Bull/bear debate reasoning isn't shown -- not persisted anywhere yet, see this page's own module header.</p>
    ${decisionsTable(decisions)}
  </section>

  <div class="grid">
    <section>
      <h2>Open positions (${openPositions.length})</h2>
      ${positionsTable(openPositions)}
    </section>
    <section>
      <h2>Recently closed (${closedPositions.length})</h2>
      <p class="note">No exit price is recorded on close -- realized return can't be shown, only how/when a position closed.</p>
      ${positionsTable(closedPositions, { closed: true })}
    </section>
    <section>
      <h2>Recent pipeline activity</h2>
      <p class="note">Latest completed stage per run. A stuck/crashed run just stops appearing here, not shown as a failure.</p>
      ${checkpointsTable(checkpoints)}
    </section>
  </div>

  <section>
    <h2>Backtest results</h2>
    <p class="note">Not shown -- no backtest run's output is persisted yet (src/backtest/*.js is a computation library, not a stored-results table). See plan.md.</p>
  </section>
  </main>
</body>
</html>`;
}
