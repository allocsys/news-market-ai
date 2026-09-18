// Shared page chrome (shell, desktop sidebar nav, mobile header & bottom tab bar, CSS style).

import { escapeHtml, fmtTime } from "./helpers.js";

const STYLE = `
  :root {
    color-scheme: dark;
    --gray-50: #f8fafc;
    --gray-100: #f1f5f9;
    --gray-200: #e2e8f0;
    --gray-300: #cbd5e1;
    --gray-400: #94a3b8;
    --gray-500: #64748b;
    --gray-600: #475569;
    --gray-700: #334155;
    --gray-800: #1e293b;
    --gray-900: #0f172a;
    --gray-950: #090d16;

    --bg-base: var(--gray-950);
    --bg-surface: var(--gray-900);
    --bg-surface-hover: var(--gray-800);
    --bg-active: var(--gray-800);
    --border-color: var(--gray-800);
    --border-subtle: var(--gray-900);
    --text-main: var(--gray-100);
    --text-muted: var(--gray-400);
    --text-subtle: var(--gray-500);

    --accent: #3b82f6;
    --accent-hover: #2563eb;
    --accent-subtle: rgba(59, 130, 246, 0.15);

    --color-success-bg: rgba(16, 185, 129, 0.12);
    --color-success-text: #34d399;
    --color-danger-bg: rgba(239, 68, 68, 0.12);
    --color-danger-text: #f87171;
    --color-warning-bg: rgba(245, 158, 11, 0.12);
    --color-warning-text: #fbbf24;
    --color-info-bg: rgba(59, 130, 246, 0.12);
    --color-info-text: #60a5fa;

    --font-sans: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    --font-mono: ui-monospace, "SF Mono", Menlo, monospace;
  }

  * { box-sizing: border-box; }

  body {
    font-family: var(--font-sans);
    margin: 0; padding: 0;
    background: var(--bg-base);
    color: var(--text-main);
    line-height: 1.5;
    font-size: 0.875rem; /* 14px body default */
  }

  .shell { display: flex; min-height: 100vh; }

  /* ---- Left index rail / Sidebar ---- */
  .rail {
    flex: 0 0 260px;
    position: sticky; top: 0; align-self: flex-start;
    height: 100vh; overflow-y: auto;
    background: var(--bg-surface);
    border-right: 1px solid var(--border-color);
    padding: 1.75rem 1.5rem;
    display: flex; flex-direction: column; gap: 2rem;
  }
  .wordmark { display: flex; flex-direction: column; gap: 0.2rem; }
  .wordmark-main {
    font-size: 1rem; font-weight: 600; letter-spacing: -0.01em;
    color: var(--text-main); border-bottom: 1px solid var(--border-color); padding-bottom: 0.75rem;
  }
  .wordmark-sub {
    font-family: var(--font-sans);
    font-size: 0.75rem; letter-spacing: 0.04em; text-transform: uppercase;
    color: var(--text-muted); margin-top: 0.35rem;
  }

  .section-nav { display: flex; flex-direction: column; gap: 0.2rem; }
  .section-nav a {
    display: flex; align-items: center; gap: 0.75rem;
    color: var(--text-muted); text-decoration: none;
    font-family: var(--font-sans);
    font-size: 0.875rem; font-weight: 500;
    padding: 0.5rem 0.75rem;
    border-radius: 6px;
    transition: color 150ms ease, background 150ms ease, padding-left 150ms ease;
  }
  .section-nav a:hover { color: var(--text-main); background: var(--bg-surface-hover); }
  .section-nav a.active {
    color: var(--text-main); font-weight: 600;
    background: var(--bg-active);
    border-left: 3px solid var(--accent);
    padding-left: calc(0.75rem - 3px);
  }
  .nav-index {
    color: var(--text-subtle); font-size: 0.75rem; font-weight: 500;
    font-family: var(--font-mono);
  }
  .section-nav a.active .nav-index { color: var(--accent); }
  .nav-icon { display: none; }

  .rail-meta {
    margin-top: auto;
    font-family: var(--font-sans);
    font-size: 0.75rem; line-height: 1.6; color: var(--text-subtle);
    border-top: 1px solid var(--border-color); padding-top: 1rem;
  }

  .content { flex: 1 1 auto; min-width: 0; }
  main { padding: 2.5rem 3rem 6rem; max-width: 1280px; margin: 0 auto; }

  section { margin-bottom: 3rem; scroll-margin-top: 1.5rem; }
  h2 {
    font-family: var(--font-sans);
    font-size: 1.25rem; /* 20px step */
    font-weight: 600; font-style: normal;
    color: var(--text-main);
    border-bottom: 1px solid var(--border-color);
    padding-bottom: 0.75rem; margin: 0 0 1.25rem;
    line-height: 1.3;
  }
  .note {
    font-family: var(--font-sans);
    color: var(--text-muted); font-size: 0.875rem; margin: 0 0 1.25rem; max-width: 68ch; line-height: 1.5;
  }

  .table-wrap {
    width: 100%;
    overflow-x: auto;
    overflow-y: auto;
    max-height: 70vh;
    -webkit-overflow-scrolling: touch;
    margin-bottom: 1.25rem;
    border: 1px solid var(--border-color);
    border-radius: 8px;
    background: var(--bg-surface);
  }
  table { width: 100%; border-collapse: collapse; font-size: 0.875rem; font-family: var(--font-sans); }
  th, td { text-align: left; padding: 0.75rem 1rem; border-bottom: 1px solid var(--border-color); }
  th {
    position: sticky; top: 0; z-index: 10;
    background: var(--bg-surface);
    color: var(--text-muted); font-weight: 600; font-size: 0.75rem; /* 12px metadata label */
    text-transform: uppercase; letter-spacing: 0.05em;
    border-bottom: 1px solid var(--border-color);
  }
  td.num { font-family: var(--font-mono); color: var(--text-main); font-size: 0.875rem; font-variant-numeric: tabular-nums; }
  td.ticker { font-family: var(--font-mono); font-weight: 600; letter-spacing: 0.02em; color: var(--text-main); }
  tbody tr { transition: background 150ms ease; }
  tbody tr:hover { background: var(--bg-surface-hover); }
  .empty { color: var(--text-subtle); font-style: normal; font-size: 0.875rem; font-family: var(--font-sans); }

  /* Status Badges */
  .status {
    display: inline-flex; align-items: center; gap: 0.35rem;
    font-family: var(--font-sans); font-size: 0.75rem; font-weight: 500;
    padding: 0.2rem 0.65rem; border-radius: 999px;
  }
  .status-approved { background: var(--color-success-bg); color: var(--color-success-text); }
  .status-rejected { background: var(--color-danger-bg); color: var(--color-danger-text); }
  .status-neutral { background: var(--gray-800); color: var(--text-muted); }

  .grid { display: grid; grid-template-columns: 1fr; gap: 1.5rem; }
  .grid > section { min-width: 0; margin-bottom: 0; }

  /* LLM answer disclosure */
  .llm-answer summary {
    cursor: pointer; color: var(--color-info-text); font-size: 0.8125rem;
    font-family: var(--font-sans); font-weight: 500;
    list-style: none; width: fit-content;
    transition: color 150ms ease;
  }
  .llm-answer summary::-webkit-details-marker { display: none; }
  .llm-answer summary::before { content: "\\25b8 "; }
  .llm-answer[open] summary::before { content: "\\25be "; }
  .llm-answer summary:hover { color: var(--text-main); }
  .llm-answer-body {
    margin-top: 0.75rem; padding: 1rem 1.25rem;
    background: var(--bg-surface); border: 1px solid var(--border-color); border-radius: 8px;
    max-width: 60ch; width: 100%; box-sizing: border-box;
    display: flex; flex-direction: column; gap: 0.75rem;
  }
  .llm-block { font-family: var(--font-sans); font-size: 0.875rem; line-height: 1.5; color: var(--text-main); }
  .llm-agent {
    display: inline-block; font-family: var(--font-sans);
    font-size: 0.75rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
    color: var(--text-main); background: var(--gray-700);
    padding: 0.15rem 0.5rem; border-radius: 4px; margin-right: 0.5rem; vertical-align: middle;
  }
  .llm-agent-bull { background: rgba(16, 185, 129, 0.2); color: var(--color-success-text); }
  .llm-agent-bear { background: rgba(239, 68, 68, 0.2); color: var(--color-danger-text); }
  .llm-justification { color: var(--text-muted); font-style: normal; }

  tr.stale-row td { color: var(--color-warning-text); }
  .stale-flag {
    font-family: var(--font-sans); font-size: 0.75rem; font-weight: 500;
    color: var(--color-warning-text); background: var(--color-warning-bg);
    padding: 0.2rem 0.5rem; border-radius: 999px; letter-spacing: 0.02em;
  }
  .ok-flag {
    font-family: var(--font-sans); font-size: 0.75rem; font-weight: 500;
    color: var(--color-success-text); background: var(--color-success-bg);
    padding: 0.2rem 0.5rem; border-radius: 999px; letter-spacing: 0.02em;
  }

  /* Filters */
  .filter-bar { display: flex; flex-wrap: wrap; gap: 1.5rem; align-items: flex-end; margin-bottom: 1.25rem; }
  .filter-group { display: flex; flex-direction: column; gap: 0.5rem; }
  .filter-label {
    font-family: var(--font-sans);
    font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;
  }
  .pill-row { display: flex; gap: 0.5rem; flex-wrap: wrap; }
  .pill {
    font-family: var(--font-sans); font-size: 0.8125rem; font-weight: 500;
    color: var(--text-muted); text-decoration: none;
    padding: 0.375rem 0.875rem;
    border: 1px solid var(--border-color); background: var(--bg-surface);
    border-radius: 6px;
    cursor: pointer; appearance: none;
    transition: border-color 150ms ease, color 150ms ease, background 150ms ease;
  }
  .pill:hover { border-color: var(--gray-500); color: var(--text-main); background: var(--bg-surface-hover); }
  .pill-active { color: #ffffff; background: var(--accent); border-color: var(--accent); font-weight: 600; }
  
  .filter-form { display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; }
  /* ".filter-form select" covers a <select> nested in a .filter-form container (not
     currently used by any view). Backfill/backtest's trigger forms instead apply
     "filter-form" directly to each <input> -- so "input.filter-form" is also needed
     here, sharing this rule with .date-input so every input on these forms (text or
     date) looks identical, which is what the forms already visually assume. */
  .filter-form select, input.filter-form, .date-input {
    font-family: var(--font-sans); font-size: 0.875rem;
    background: var(--bg-surface); color: var(--text-main); border: 1px solid var(--border-color);
    padding: 0.5rem 0.75rem; border-radius: 6px; width: 100%; box-sizing: border-box;
    transition: border-color 150ms ease, box-shadow 150ms ease;
  }
  .filter-form select:focus, input.filter-form:focus, .date-input:focus {
    outline: none; border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent-subtle);
  }
  .filter-form button, .btn {
    font-family: var(--font-sans); font-size: 0.875rem; font-weight: 600;
    color: #ffffff; background: var(--accent); border: none;
    padding: 0.5rem 1rem; border-radius: 6px; cursor: pointer;
    height: 38px; display: inline-flex; align-items: center; justify-content: center; gap: 0.5rem;
    transition: background 150ms ease, opacity 150ms ease, box-shadow 150ms ease;
  }
  .filter-form button:hover, .btn:hover { background: var(--accent-hover); }
  .filter-form button:focus-visible, .btn:focus-visible {
    outline: none; box-shadow: 0 0 0 2px var(--accent-subtle);
  }
  .btn:disabled { opacity: 0.6; cursor: not-allowed; }

  .btn-secondary {
    background: var(--bg-surface); color: var(--text-main); border: 1px solid var(--border-color);
  }
  .btn-secondary:hover { background: var(--bg-surface-hover); border-color: var(--gray-500); }

  .btn-tertiary {
    background: transparent; color: var(--text-muted); border: none;
  }
  .btn-tertiary:hover { color: var(--text-main); background: var(--bg-surface); }

  .btn-destructive {
    background: var(--color-danger-bg); color: var(--color-danger-text); border: 1px solid var(--color-danger-text);
  }
  .btn-destructive:hover { background: rgba(239, 68, 68, 0.2); }

  .error-inline { color: var(--color-danger-text) !important; }

  /* ---- Summary stat cards ---- */
  .stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin-bottom: 2rem; }
  .stat-card {
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    padding: 1.25rem 1.5rem;
    position: relative;
    overflow: hidden;
  }
  .stat-card::before {
    content: ""; position: absolute; top: 0; left: 0; bottom: 0; width: 4px;
    background: var(--accent, var(--gray-700));
  }
  .stat-value {
    font-family: var(--font-mono); font-size: 1.75rem; font-weight: 600;
    color: var(--text-main); font-variant-numeric: tabular-nums; line-height: 1.2;
  }
  .stat-label {
    font-family: var(--font-sans);
    font-size: 0.8125rem; font-weight: 500; color: var(--text-muted); margin-top: 0.35rem;
  }
  .stat-sub {
    font-size: 0.75rem; color: var(--text-subtle); margin-top: 0.35rem;
    font-family: var(--font-mono);
  }

  /* Charts */
  .chart { display: block; background: var(--bg-surface); border: 1px solid var(--border-color); border-radius: 8px; }
  .chart-gridline { stroke: var(--border-color); stroke-width: 1; }
  .chart-axis-label { fill: var(--text-subtle); font-size: 10px; font-family: var(--font-mono); }
  .chart-legend { display: flex; gap: 1.5rem; margin-top: 0.75rem; font-size: 0.8125rem; color: var(--text-muted); font-family: var(--font-sans); }
  .legend-item { display: inline-flex; align-items: center; gap: 0.5rem; }
  .legend-swatch { width: 0.75rem; height: 0.75rem; border-radius: 3px; display: inline-block; }
  .chart-cell-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 1rem; }
  .chart-cell { background: var(--bg-surface); border: 1px solid var(--border-color); border-radius: 10px; padding: 1.25rem; }
  .chart-cell-title {
    font-family: var(--font-sans); font-weight: 600; letter-spacing: -0.01em;
    margin-bottom: 0.75rem; font-size: 0.9375rem; color: var(--text-main);
  }
  .sparkline { display: block; }
  .sparkline-meta { display: flex; gap: 0.75rem; align-items: baseline; margin-top: 0.5rem; font-size: 0.8125rem; }

  /* Mobile header & bottom nav */
  .mobile-header { display: none; }
  .bottom-nav { display: none; }

  /* Tablet icon rail (768px - 1023px) */
  @media (min-width: 768px) and (max-width: 1023px) {
    .rail {
      flex: 0 0 72px;
      width: 72px;
      padding: 1.25rem 0.5rem;
      align-items: center;
      gap: 1.5rem;
      /* Base .rail sets overflow-y: auto, which per spec forces overflow-x to compute
         as auto too (a UA can't scroll one axis and show the other outside its box) --
         that silently clips the hover/focus tooltip below, which is positioned outside
         the 72px rail via left: calc(100% + 12px). At this icon-only width the nav list
         (9 items) comfortably fits without scrolling, so overflow: visible is safe here
         and is what actually lets the tooltip render instead of being clipped. */
      overflow: visible;
    }
    .rail .wordmark, .rail .rail-meta, .rail .section-nav a .nav-label { display: none; }
    .rail .section-nav { width: 100%; align-items: center; gap: 0.35rem; }
    .rail .section-nav a {
      display: flex;
      justify-content: center;
      align-items: center;
      width: 48px;
      height: 48px;
      padding: 0;
      border-radius: 8px;
      position: relative;
      border-left: none;
    }
    .rail .section-nav a.active {
      background: var(--bg-active);
      border-left: none;
      border: 1px solid var(--accent);
      padding-left: 0;
    }
    .rail .section-nav a .nav-index { display: none; }
    .rail .section-nav a .nav-icon {
      display: inline-block;
      font-family: var(--font-sans);
      font-size: 0.8125rem;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
    }
    .rail .section-nav a:hover .nav-icon,
    .rail .section-nav a.active .nav-icon {
      color: var(--text-main);
    }
    .rail .section-nav a::after {
      content: attr(data-label);
      position: absolute;
      left: calc(100% + 12px);
      top: 50%;
      transform: translateY(-50%);
      background: var(--bg-surface);
      color: var(--text-main);
      padding: 0.4rem 0.75rem;
      border-radius: 6px;
      border: 1px solid var(--border-color);
      font-size: 0.8125rem;
      font-weight: 500;
      white-space: nowrap;
      opacity: 0;
      pointer-events: none;
      transition: opacity 150ms ease;
      z-index: 1000;
      box-shadow: 0 4px 16px rgba(0,0,0,0.4);
    }
    .rail .section-nav a:hover::after,
    .rail .section-nav a:focus::after {
      opacity: 1;
    }
    main { padding: 2rem 2rem 6rem; }
    .stat-grid { grid-template-columns: repeat(2, 1fr); }
  }

  /* Mobile (< 768px) */
  @media (max-width: 767px) {
    .shell { flex-direction: column; }
    .rail { display: none; }
    .mobile-header {
      display: block;
      background: var(--bg-surface);
      border-bottom: 1px solid var(--border-color);
      padding: 1rem 1.25rem;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }
    .mobile-header .wordmark {
      flex-direction: row;
      align-items: baseline;
      gap: 0.75rem;
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
    main { padding: 1.5rem 1rem 6rem; }
    .stat-grid { grid-template-columns: 1fr; }
    .filter-bar { gap: 1rem; }

    /* Fixed bottom navigation bar (min 44x44px touch targets per design.md) */
    .bottom-nav {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      z-index: 100;
      background: var(--bg-surface);
      border-top: 1px solid var(--border-color);
      display: flex;
      overflow-x: auto;
      white-space: nowrap;
      -webkit-overflow-scrolling: touch;
      padding: 0 0.5rem;
      height: 60px;
    }
    .bottom-nav::-webkit-scrollbar {
      height: 3px;
    }
    .bottom-nav::-webkit-scrollbar-thumb {
      background: var(--gray-700);
    }
    .bottom-nav a {
      display: inline-flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 0.15rem;
      color: var(--text-muted);
      text-decoration: none;
      font-family: var(--font-sans);
      font-size: 0.75rem;
      padding: 0 0.85rem;
      min-height: 44px;
      min-width: 44px;
      border-bottom: none;
      flex-shrink: 0;
      transition: color 150ms ease, background 150ms ease;
    }
    .bottom-nav a:hover, .bottom-nav a.active {
      color: var(--text-main);
      background: var(--bg-surface-hover);
    }
    .bottom-nav a.active {
      color: var(--text-main);
      font-weight: 600;
      border-top: 2px solid var(--accent);
    }
    .bottom-nav .nav-index { display: none; }
  }

  @media (min-width: 1024px) {
    .mobile-header { display: none; }
    .bottom-nav { display: none; }
    .grid { grid-template-columns: repeat(3, 1fr); }
  }

  /* Motion and reduced motion */
  @media (prefers-reduced-motion: reduce) {
    *, ::before, ::after {
      transition-duration: 0.01ms !important;
      animation-duration: 0.01ms !important;
    }
  }
`;

export const NAV_SECTIONS = [
  ["snapshot", "Snapshot", "SN"],
  ["activity", "Activity", "AC"],
  ["charts", "Charts", "CH"],
  ["health", "Health", "HE"],
  ["decisions", "Decisions", "DC"],
  ["positions", "Positions", "PO"],
  ["pipeline", "Pipeline", "PL"],
  ["backfill", "Backfill", "BF"],
  ["backtest", "Backtest", "BT"],
];

function renderNav(activeSection) {
  // Each section's rail abbreviation is an explicit, hand-picked two-letter code (not a
  // mechanical label.slice(0,2)) specifically so no two sections ever collide on the
  // tablet icon rail -- e.g. "Backfill"/"Backtest" would otherwise both reduce to "BA".
  const links = NAV_SECTIONS.map(([id, label, abbr], i) => {
    const n = String(i + 1).padStart(2, "0");
    const active = activeSection === id;
    return `<a href="/dashboard/${id}"${active ? ' class="active"' : ""} data-label="${escapeHtml(label)}"><span class="nav-index">${n}</span><span class="nav-icon">${escapeHtml(abbr)}</span><span class="nav-label">${escapeHtml(label)}</span></a>`;
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
    <div class="rail-meta">generated ${fmtTime(new Date().toISOString())}${sessionUsername ? `<br>logged in as ${escapeHtml(sessionUsername)} &middot; <a href="/logout" style="color:var(--color-info-text);">log out</a>` : ""}</div>
  </div>`;
}

export function renderShell({ activeSection, sessionUsername, bodyHtml }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>news-market-ai dashboard (${escapeHtml(activeSection)})</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
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
      <div class="rail-meta">generated ${fmtTime(new Date().toISOString())}<br>architecture &amp; known gaps in plan.md${sessionUsername ? `<br>logged in as ${escapeHtml(sessionUsername)} &middot; <a href="/logout" style="color:var(--color-info-text);">log out</a>` : ""}</div>
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
