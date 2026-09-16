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
  const cls = status === "approved" ? "badge-approved" : status === "rejected" ? "badge-rejected" : "badge-neutral";
  return `<span class="badge ${cls}">${escapeHtml(status)}</span>`;
}

function healthRow(label, stat) {
  return `<tr><td>${escapeHtml(label)}</td><td>${stat.count}</td><td>${fmtTime(stat.lastIngestedAt)}</td></tr>`;
}

function decisionsTable(decisions) {
  if (decisions.length === 0) return `<p class="empty">No decisions recorded yet.</p>`;
  const rows = decisions
    .map(
      (d) => `<tr>
        <td>${escapeHtml(d.ticker)}</td>
        <td>${escapeHtml(d.thesis?.direction ?? "\u2014")}</td>
        <td>${statusBadge(d.status)}</td>
        <td>${d.riskDecision?.positionSizePct != null ? (d.riskDecision.positionSizePct * 100).toFixed(1) + "%" : "\u2014"}</td>
        <td>${escapeHtml(d.portfolioDecision?.reason ?? d.riskDecision?.reason ?? "\u2014")}</td>
        <td>${fmtTime(d.createdAt)}</td>
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
        <td>${escapeHtml(p.ticker)}</td>
        <td>${escapeHtml(p.direction ?? "\u2014")}</td>
        <td>${(p.positionSizePct * 100).toFixed(1)}%</td>
        <td>${p.entryPrice != null ? "$" + Number(p.entryPrice).toFixed(2) : "\u2014"}</td>
        <td>${fmtTime(p.openedAt)}</td>
        ${closed ? `<td>${fmtTime(p.closedAt)}</td><td>${escapeHtml(p.closeReason ?? "\u2014")}</td>` : ""}
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
    .map((c) => `<tr><td>${escapeHtml(c.ticker)}</td><td>${escapeHtml(c.stage)}</td><td>${fmtTime(c.updated_at)}</td></tr>`)
    .join("\n");
  return `<table>
    <thead><tr><th>Ticker</th><th>Last Stage</th><th>Updated</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

const STYLE = `
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 2rem; background: #0b0d10; color: #e6e8eb; }
  h1 { font-size: 1.4rem; margin-bottom: 0.25rem; }
  .subtitle { color: #9aa4af; margin-top: 0; margin-bottom: 2rem; font-size: 0.9rem; }
  section { margin-bottom: 2.5rem; }
  h2 { font-size: 1.05rem; border-bottom: 1px solid #2a2e33; padding-bottom: 0.4rem; margin-bottom: 0.75rem; }
  .note { color: #9aa4af; font-size: 0.82rem; margin: 0.25rem 0 0.75rem; }
  table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
  th, td { text-align: left; padding: 0.45rem 0.6rem; border-bottom: 1px solid #23262b; }
  th { color: #9aa4af; font-weight: 600; }
  .empty { color: #6b7280; font-style: italic; }
  .badge { padding: 0.15rem 0.55rem; border-radius: 999px; font-size: 0.78rem; font-weight: 600; }
  .badge-approved { background: #103a1e; color: #4ade80; }
  .badge-rejected { background: #3a1010; color: #f87171; }
  .badge-neutral { background: #2a2e33; color: #cbd5e1; }
  .grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 1rem; }
  @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
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
  <h1>news-market-ai</h1>
  <p class="subtitle">Live view, generated ${fmtTime(new Date().toISOString())}. Architecture and known gaps live in plan.md.</p>

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
</body>
</html>`;
}
