// Shared page chrome (shell, desktop sidebar nav, mobile header & bottom tab bar, CSS style).

import { escapeHtml, fmtTime } from "./helpers.js";

const STYLE = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }

  body {
    font-family: Georgia, "Iowan Old Style", "Palatino Linotype", "Book Antiqua", serif;
    margin: 0; padding: 0;
    background: #0a0d12; color: #d9d4c4;
    line-height: 1.45;
  }

  .shell { display: flex; min-height: 100vh; }

  /* ---- Left index rail ---- */
  .rail {
    flex: 0 0 240px;
    position: sticky; top: 0; align-self: flex-start;
    height: 100vh; overflow-y: auto;
    background: #0d1118;
    border-right: 1px solid #232b35;
    padding: 1.75rem 1.5rem;
    display: flex; flex-direction: column; gap: 2rem;
  }
  .wordmark { display: flex; flex-direction: column; gap: 0.15rem; }
  .wordmark-main {
    font-size: 1.15rem; font-weight: 600; letter-spacing: 0.01em;
    color: #efe9d8; border-bottom: 2px double #b8944f; padding-bottom: 0.55rem;
  }
  .wordmark-sub {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 0.68rem; letter-spacing: 0.08em; text-transform: uppercase;
    color: #6e7787; margin-top: 0.5rem;
  }

  .section-nav { display: flex; flex-direction: column; gap: 0.15rem; }
  .section-nav a {
    display: flex; align-items: baseline; gap: 0.6rem;
    color: #9aa3b0; text-decoration: none;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 0.82rem; letter-spacing: 0.01em;
    padding: 0.4rem 0.1rem;
    border-bottom: 1px solid #171d26;
    transition: color 0.12s ease, padding-left 0.12s ease;
  }
  .section-nav a:hover, .section-nav a.active { color: #eadfb8; padding-left: 0.3rem; }
  .section-nav a.active { color: #efe9d8; font-weight: 600; background: #141b24; border-left: 2px solid #b8944f; }
  .nav-index { color: #4a5566; font-size: 0.72rem; }

  .rail-meta {
    margin-top: auto;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 0.68rem; line-height: 1.7; color: #4a5566;
    border-top: 1px solid #1c232c; padding-top: 1rem;
  }

  .content { flex: 1 1 auto; min-width: 0; }
  main { padding: 2.75rem 3rem 6rem; max-width: 1180px; }

  section { margin-bottom: 3.4rem; scroll-margin-top: 1.5rem; }
  h2 {
    font-family: Georgia, "Iowan Old Style", serif;
    font-size: 1.3rem; font-weight: 400; font-style: italic;
    color: #efe9d8;
    border-bottom: 1px solid #232b35; padding-bottom: 0.6rem; margin: 0 0 1rem;
  }
  .note {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: #7c8698; font-size: 0.82rem; margin: 0 0 1.1rem; max-width: 68ch; line-height: 1.6;
  }

  .table-wrap { width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; margin-bottom: 1rem; }
  table { width: 100%; border-collapse: collapse; font-size: 0.86rem; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  th, td { text-align: left; padding: 0.62rem 0.75rem; border-bottom: 1px solid #171d26; }
  th {
    color: #6e7787; font-weight: 600; font-size: 0.68rem;
    text-transform: uppercase; letter-spacing: 0.06em;
    border-bottom: 1px solid #2c3644;
  }
  td.num { font-family: ui-monospace, "SF Mono", Menlo, monospace; color: #c7cbd4; font-size: 0.83rem; font-variant-numeric: tabular-nums; }
  td.ticker { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-weight: 600; letter-spacing: 0.02em; color: #f2ecd8; }
  tbody tr { transition: background 0.1s ease; }
  tbody tr:hover { background: #10151d; }
  .empty { color: #4a5566; font-style: italic; font-size: 0.86rem; font-family: Georgia, serif; }

  .status { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.82rem; }
  .status-approved { color: #4f9d6e; }
  .status-rejected { color: #c1502e; }
  .status-neutral { color: #8b93a0; }

  .grid { display: grid; grid-template-columns: 1fr; gap: 1.75rem; }
  .grid > section { min-width: 0; margin-bottom: 0; }

  /* LLM answer disclosure (migrations/0008_trade_decisions_llm_answers.sql) -- native <details>, no client JS */
  .llm-answer summary {
    cursor: pointer; color: #6f92b8; font-size: 0.8rem;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    list-style: none; width: fit-content;
  }
  .llm-answer summary::-webkit-details-marker { display: none; }
  .llm-answer summary::before { content: "\\25b8 "; }
  .llm-answer[open] summary::before { content: "\\25be "; }
  .llm-answer summary:hover { color: #9bb8d6; }
  .llm-answer-body {
    margin-top: 0.55rem; padding: 0.8rem 0.95rem;
    background: #0d1118; border: 1px solid #232b35; border-left: 2px solid #2c3644;
    max-width: 54ch; width: 100%; box-sizing: border-box;
    display: flex; flex-direction: column; gap: 0.55rem;
  }
  .llm-block { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 0.8rem; line-height: 1.55; color: #c7cbd4; }
  .llm-agent {
    display: inline-block; font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 0.66rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
    color: #0a0d12; background: #6f92b8;
    padding: 0.1rem 0.42rem; margin-right: 0.45rem; vertical-align: middle;
  }
  .llm-agent-bull { background: #4f9d6e; }
  .llm-agent-bear { background: #c1502e; }
  .llm-justification { color: #6e7787; font-style: italic; }

  tr.stale-row td { color: #a68a52; }
  .stale-flag {
    font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.7rem;
    color: #0a0d12; background: #b8944f; padding: 0.14rem 0.42rem; letter-spacing: 0.04em;
  }
  .ok-flag { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.7rem; color: #4f9d6e; letter-spacing: 0.03em; }

  /* Filters -- plain GET links/forms, no client JS */
  .filter-bar { display: flex; flex-wrap: wrap; gap: 2rem; align-items: flex-end; margin-bottom: 1.1rem; }
  .filter-group { display: flex; flex-direction: column; gap: 0.4rem; }
  .filter-label {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 0.68rem; color: #6e7787; text-transform: uppercase; letter-spacing: 0.05em;
  }
  .pill-row { display: flex; gap: 0.4rem; flex-wrap: wrap; }
  .pill {
    font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.78rem;
    color: #c7cbd4; text-decoration: none;
    padding: 0.3rem 0.7rem;
    border: 1px solid #2c3644; background: #0d1118;
    cursor: pointer; appearance: none;
    transition: border-color 0.12s ease, color 0.12s ease, background 0.12s ease;
  }
  .pill:hover { border-color: #6e7787; }
  .pill-active { color: #0a0d12; background: #b8944f; border-color: #b8944f; font-weight: 600; }
  .filter-form select {
    font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.8rem;
    background: #0d1118; color: #d9d4c4; border: 1px solid #2c3644;
    padding: 0.34rem 0.5rem;
  }
  .filter-form button {
    font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.78rem; font-weight: 600;
    color: #0a0d12; background: #b8944f; border: none;
    padding: 0.38rem 0.85rem; cursor: pointer;
  }
  .filter-form button:hover { background: #cba764; }

  /* ---- Summary "ledger line" cards ---- */
  .stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0; border-top: 1px solid #2c3644; border-left: 1px solid #232b35; }
  .stat-card {
    border-right: 1px solid #232b35; border-bottom: 1px solid #232b35;
    padding: 1.1rem 1.3rem 1.25rem;
    position: relative;
  }
  .stat-card::before {
    content: ""; position: absolute; top: -1px; left: 0; right: 0; height: 2px;
    background: var(--accent, #2c3644);
  }
  .stat-value {
    font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 1.9rem; font-weight: 600;
    color: #efe9d8; font-variant-numeric: tabular-nums; line-height: 1;
  }
  .stat-label {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 0.8rem; color: #9aa3b0; margin-top: 0.5rem;
  }
  .stat-sub {
    font-size: 0.72rem; color: #545e6d; margin-top: 0.5rem;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
  }

  /* Charts */
  .chart { display: block; background: #0d1118; border: 1px solid #232b35; }
  .chart-gridline { stroke: #1c232c; stroke-width: 1; }
  .chart-axis-label { fill: #545e6d; font-size: 9px; font-family: ui-monospace, "SF Mono", Menlo, monospace; }
  .chart-legend { display: flex; gap: 1.2rem; margin-top: 0.7rem; font-size: 0.78rem; color: #7c8698; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .legend-item { display: inline-flex; align-items: center; gap: 0.4rem; }
  .legend-swatch { width: 0.62rem; height: 0.62rem; display: inline-block; }
  .chart-cell-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 0; border-top: 1px solid #232b35; border-left: 1px solid #232b35; }
  .chart-cell { border-right: 1px solid #232b35; border-bottom: 1px solid #232b35; padding: 1rem 1.1rem; }
  .chart-cell-title {
    font-family: ui-monospace, "SF Mono", Menlo, monospace; font-weight: 600; letter-spacing: 0.02em;
    margin-bottom: 0.5rem; font-size: 0.86rem; color: #efe9d8;
  }
  .sparkline { display: block; }
  .sparkline-meta { display: flex; gap: 0.65rem; align-items: baseline; margin-top: 0.45rem; font-size: 0.78rem; }

  /* Mobile header (hidden on desktop) */
  .mobile-header { display: none; }
  .bottom-nav { display: none; }

  @media (max-width: 900px) {
    .shell { flex-direction: column; }
    .rail { display: none; }
    .mobile-header {
      display: block;
      background: #0d1118;
      border-bottom: 1px solid #232b35;
      padding: 1rem 1.25rem;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }
    .mobile-header .wordmark {
      flex-direction: row;
      align-items: baseline;
      gap: 0.6rem;
    }
    .mobile-header .wordmark-main {
      border-bottom: none;
      padding-bottom: 0;
    }
    .mobile-header .rail-meta {
      display: block;
      margin-top: 0;
      border-top: none;
      padding-top: 0;
    }
    .content { width: 100%; }
    main { padding: 1.75rem 1.25rem 6rem; }
    .stat-grid { grid-template-columns: 1fr 1fr; }
    .filter-bar { gap: 1.2rem; }

    /* Fixed bottom navigation bar */
    .bottom-nav {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      z-index: 100;
      background: #0d1118;
      border-top: 1px solid #232b35;
      display: flex;
      overflow-x: auto;
      white-space: nowrap;
      -webkit-overflow-scrolling: touch;
      padding: 0 0.5rem;
    }
    .bottom-nav::-webkit-scrollbar {
      height: 3px;
    }
    .bottom-nav::-webkit-scrollbar-thumb {
      background: #2c3644;
    }
    .bottom-nav a {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      color: #9aa3b0;
      text-decoration: none;
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      font-size: 0.78rem;
      padding: 0 0.85rem;
      min-height: 48px;
      border-bottom: none;
      flex-shrink: 0;
      transition: color 0.12s ease, background 0.12s ease;
    }
    .bottom-nav a:hover, .bottom-nav a.active {
      color: #eadfb8;
      background: #10151d;
    }
    .bottom-nav a.active {
      color: #efe9d8;
      font-weight: 600;
      border-top: 2px solid #b8944f;
    }
    .bottom-nav .nav-index {
      color: #4a5566;
      font-size: 0.68rem;
    }
  }

  @media (max-width: 480px) {
    .stat-grid { grid-template-columns: 1fr; }
    .chart-cell-grid { grid-template-columns: 1fr; }
    .filter-bar { flex-direction: column; align-items: stretch; gap: 1rem; }
    .filter-form input[type="text"],
    .filter-form input[type="password"],
    .filter-form input[type="date"],
    .filter-form select {
      width: 100%;
    }
    .pill, .filter-form button {
      min-height: 40px;
      padding: 0.5rem 0.8rem;
    }
  }

  @media (min-width: 901px) {
    .mobile-header { display: none; }
    .bottom-nav { display: none; }
    .grid { grid-template-columns: 1fr 1fr 1fr; }
  }
`;

export const NAV_SECTIONS = [
  ["snapshot", "Snapshot"],
  ["activity", "Activity"],
  ["charts", "Charts"],
  ["health", "Health"],
  ["decisions", "Decisions"],
  ["positions", "Positions"],
  ["pipeline", "Pipeline"],
  ["backfill", "Backfill"],
  ["backtest", "Backtest"],
];

function renderNav(activeSection) {
  const links = NAV_SECTIONS.map(([id, label], i) => {
    const n = String(i + 1).padStart(2, "0");
    const active = activeSection === id;
    return `<a href="/dashboard/${id}"${active ? ' class="active"' : ""}><span class="nav-index">${n}</span>${escapeHtml(label)}</a>`;
  }).join("");
  return `<nav class="section-nav">${links}</nav>`;
}

const MOBILE_NAV_SECTIONS = [
  ["snapshot", "Snapshot", "01"],
  ["decisions", "Decisions", "05"],
  ["positions", "Positions", "06"],
  ["pipeline", "Pipeline", "07"],
  ["health", "Health", "04"],
  ["more", "More", "09"],
];

function renderBottomNav(activeSection) {
  const moreIds = ["activity", "charts", "backfill", "backtest", "more"];
  const links = MOBILE_NAV_SECTIONS.map(([id, label, n]) => {
    let active = activeSection === id;
    if (id === "more" && moreIds.includes(activeSection)) {
      active = true;
    }
    return `<a href="/dashboard/${id}"${active ? ' class="active"' : ""}><span class="nav-index">${n}</span>${escapeHtml(label)}</a>`;
  }).join("");
  return `<nav class="bottom-nav">${links}</nav>`;
}

function renderMobileHeader(sessionUsername) {
  return `<div class="mobile-header">
    <div class="wordmark">
      <span class="wordmark-main">news-market-ai</span>
      <span class="wordmark-sub">operations ledger</span>
    </div>
    <div class="rail-meta">generated ${fmtTime(new Date().toISOString())}${sessionUsername ? `<br>logged in as ${escapeHtml(sessionUsername)} &middot; <a href="/logout" style="color:#6f92b8;">log out</a>` : ""}</div>
  </div>`;
}

export function renderShell({ activeSection, sessionUsername, bodyHtml }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>news-market-ai dashboard (${escapeHtml(activeSection)})</title>
<style>${STYLE}</style>
<script>
  function setDateRange(fromId, toId, days) {
    const to = new Date();
    const from = new Date(Date.now() - days * 86400000);
    document.getElementById(toId).value = to.toISOString().slice(0, 10);
    document.getElementById(fromId).value = from.toISOString().slice(0, 10);
  }
</script>
</head>
<body>
  ${renderMobileHeader(sessionUsername)}
  <div class="shell">
    <aside class="rail">
      <div class="wordmark">
        <span class="wordmark-main">news-market-ai</span>
        <span class="wordmark-sub">operations ledger</span>
      </div>
      ${renderNav(activeSection)}
      <div class="rail-meta">generated ${fmtTime(new Date().toISOString())}<br>architecture &amp; known gaps in plan.md${sessionUsername ? `<br>logged in as ${escapeHtml(sessionUsername)} &middot; <a href="/logout" style="color:#6f92b8;">log out</a>` : ""}</div>
    </aside>
    <div class="content">
      <main>
      ${bodyHtml}
      </main>
    </div>
  </div>
  ${renderBottomNav(activeSection)}
</body>
</html>`;
}
