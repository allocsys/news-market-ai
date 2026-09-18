// Shared page chrome (shell, desktop sidebar nav, mobile header & bottom tab bar, CSS style).
//
// Design system:
//   - Premium fintech dark theme. Surfaces use a subtle elevation ladder
//     (--bg-base -> --bg-surface -> --bg-elevated) instead of a single flat panel.
//   - Typography: Inter Tight for headings (tighter display weight), Inter for
//     body, ui-monospace for tabular numerics. Loaded via Google Fonts.
//   - Sidebar: 248px on desktop, 72px icon-rail on tablet, hidden on mobile
//     (replaced by a top app bar + bottom tab bar with Lucide-style stroke icons).
//   - Cards have a 1px hairline border + faint top highlight (premium feel),
//     no heavy shadows (Cloudflare Worker HTML stays print-friendly).
//   - All animations honor prefers-reduced-motion.

import { escapeHtml, fmtTime } from "./helpers.js";

// ---- Inline SVG icon set (Lucide-style stroke icons, 20x20, currentColor) ----
// Stored as raw <svg> strings so they can be dropped into nav links, badges,
// and section headers without an external icon font. Each is a single path or
// small group of paths using stroke="currentColor" so the link's color cascades.
const ICONS = {
  snapshot: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"/><path d="M13.4 10.6 19 5"/><path d="M19 5h-3"/><path d="M19 5v3"/><path d="M10.6 13.4 5 19"/><path d="M5 19h3"/><path d="M5 19v-3"/><path d="M13.4 13.4 19 19"/><path d="M19 19v-3"/><path d="M19 19h-3"/><path d="M10.6 10.6 5 5"/><path d="M5 5h3"/><path d="M5 5v3"/></svg>`,
  activity: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3v16a2 2 0 0 0 2 2h16"/><rect x="7" y="11" width="3" height="6" rx="0.5"/><rect x="12" y="7" width="3" height="10" rx="0.5"/><rect x="17" y="13" width="3" height="4" rx="0.5"/></svg>`,
  charts: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3v18h18"/><path d="m7 14 3-4 3 3 4-6"/></svg>`,
  health: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12h3l2-5 4 10 2-5h7"/></svg>`,
  decisions: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M6 8.5v3a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3v-3"/><path d="M12 14.5V15.5"/></svg>`,
  positions: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M3 12h18"/></svg>`,
  pipeline: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="12" r="2.5"/><path d="M6 8.5v7"/><path d="M6 12h6a3 3 0 0 0 3-3V8.5"/></svg>`,
  backfill: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 13V3"/><path d="m7 8 5-5 5 5"/><path d="M5 21h14a2 2 0 0 0 2-2v-4"/><path d="M3 15h4"/><path d="M3 19h4"/></svg>`,
  backtest: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 3h6"/><path d="M10 3v6.5L5 19a2 2 0 0 0 1.8 3h10.4A2 2 0 0 0 19 19l-5-9.5V3"/><path d="M7 15h10"/></svg>`,
  more: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>`,
  refresh: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg>`,
  logout: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/></svg>`,
};

const STYLE = `
  :root {
    color-scheme: dark;

    /* Elevation ladder -- each step is a slightly lighter shade of the same
       navy hue, so layered surfaces read as depth instead of as separate colors. */
    --bg-base: #070b14;
    --bg-surface: #0d1320;
    --bg-elevated: #131b2e;
    --bg-hover: #1a2238;
    --bg-active: #1e2940;

    /* Hairline borders, deliberately faint -- the elevation ladder carries
       the separation, borders just keep edges crisp at 1x device pixel. */
    --border-color: #1f2a44;
    --border-subtle: #161e30;
    --border-strong: #2c3a5a;

    --text-main: #f1f5f9;
    --text-muted: #94a3b8;
    --text-subtle: #64748b;
    --text-inverse: #0b1020;

    /* Accent: blue, with a lighter step (--accent-bright) for highlights and
       darker steps (--accent-hover, --accent-deep) for hover/pressed states. */
    --accent: #3b82f6;
    --accent-hover: #2563eb;
    --accent-bright: #60a5fa;
    --accent-deep: #1d4ed8;
    --accent-subtle: rgba(59, 130, 246, 0.14);
    --accent-glow: rgba(96, 165, 250, 0.22);
    --focus-ring: #60a5fa;

    --color-success-bg: rgba(16, 185, 129, 0.12);
    --color-success-text: #34d399;
    --color-success-strong: #10b981;
    --color-danger-bg: rgba(239, 68, 68, 0.12);
    --color-danger-text: #f87171;
    --color-danger-strong: #ef4444;
    --color-warning-bg: rgba(245, 158, 11, 0.12);
    --color-warning-text: #fbbf24;
    --color-warning-strong: #f59e0b;
    --color-info-bg: rgba(59, 130, 246, 0.12);
    --color-info-text: #60a5fa;

    /* Chart palette -- 6-step categorical scale used by the donut/gauge helpers. */
    --chart-1: #60a5fa;
    --chart-2: #34d399;
    --chart-3: #fbbf24;
    --chart-4: #f87171;
    --chart-5: #a78bfa;
    --chart-6: #94a3b8;

    --font-sans: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    --font-display: "Inter Tight", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    --font-mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace;

    --radius-sm: 6px;
    --radius-md: 10px;
    --radius-lg: 14px;
    --radius-xl: 18px;

    --shadow-card: 0 1px 0 rgba(255, 255, 255, 0.04) inset, 0 8px 24px -12px rgba(0, 0, 0, 0.5);
    --shadow-pop: 0 12px 32px -8px rgba(0, 0, 0, 0.55);
  }

  * { box-sizing: border-box; }

  html, body { height: 100%; }
  body {
    font-family: var(--font-sans);
    margin: 0; padding: 0;
    background: var(--bg-base);
    /* Subtle radial glow at the top so the page doesn't read as a flat slab.
       Fixed so it stays put on scroll, like a desk lamp. */
    background-image: radial-gradient(900px 480px at 12% -8%, rgba(59, 130, 246, 0.08), transparent 70%),
                      radial-gradient(700px 360px at 88% 0%, rgba(167, 139, 250, 0.05), transparent 70%);
    background-attachment: fixed;
    color: var(--text-main);
    line-height: 1.5;
    font-size: 0.875rem;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }

  .shell { display: flex; min-height: 100vh; }

  /* ---- Left index rail / Sidebar ---- */
  .rail {
    flex: 0 0 248px;
    position: sticky; top: 0; align-self: flex-start;
    height: 100vh; overflow-y: auto;
    background: linear-gradient(180deg, var(--bg-surface) 0%, var(--bg-base) 100%);
    border-right: 1px solid var(--border-color);
    padding: 1.5rem 1rem;
    display: flex; flex-direction: column; gap: 1.75rem;
  }
  .rail::-webkit-scrollbar { width: 6px; }
  .rail::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 3px; }

  .wordmark { display: flex; align-items: center; gap: 0.75rem; padding: 0.25rem 0.5rem 0; }
  .wordmark-mark {
    width: 36px; height: 36px; border-radius: 10px;
    background: linear-gradient(135deg, var(--accent-bright) 0%, var(--accent) 100%);
    display: flex; align-items: center; justify-content: center;
    color: #fff; font-weight: 700; font-family: var(--font-display);
    font-size: 0.95rem; letter-spacing: -0.04em;
    box-shadow: 0 4px 12px -2px var(--accent-glow);
    flex-shrink: 0;
  }
  .wordmark-text { display: flex; flex-direction: column; gap: 0.1rem; min-width: 0; }
  .wordmark-main {
    font-family: var(--font-display);
    font-size: 0.9375rem; font-weight: 600; letter-spacing: -0.015em;
    color: var(--text-main); line-height: 1.2;
  }
  .wordmark-sub {
    font-size: 0.6875rem; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--text-subtle); font-weight: 500;
  }

  .section-nav { display: flex; flex-direction: column; gap: 0.15rem; }
  .section-nav a {
    display: flex; align-items: center; gap: 0.75rem;
    color: var(--text-muted); text-decoration: none;
    font-size: 0.8125rem; font-weight: 500;
    padding: 0.5rem 0.625rem;
    border-radius: var(--radius-sm);
    position: relative;
    transition: color 150ms ease, background 150ms ease, transform 100ms ease;
  }
  .section-nav a:hover { color: var(--text-main); background: var(--bg-hover); }
  .section-nav a:active { transform: scale(0.99); }
  .section-nav a.active {
    color: var(--text-main); font-weight: 600;
    background: linear-gradient(90deg, var(--accent-subtle) 0%, transparent 100%);
  }
  .section-nav a.active::before {
    content: ""; position: absolute; left: 0; top: 0.4rem; bottom: 0.4rem;
    width: 3px; border-radius: 2px;
    background: var(--accent-bright);
  }
  .nav-icon {
    display: inline-flex; align-items: center; justify-content: center;
    width: 20px; height: 20px; flex-shrink: 0;
    color: inherit; opacity: 0.85;
  }
  .section-nav a.active .nav-icon { color: var(--accent-bright); opacity: 1; }
  .nav-label { flex: 1; min-width: 0; }
  .nav-index {
    color: var(--text-subtle); font-size: 0.6875rem; font-weight: 500;
    font-family: var(--font-mono); letter-spacing: 0.04em;
  }
  .section-nav a.active .nav-index { color: var(--accent-bright); }

  .rail-meta {
    margin-top: auto;
    font-size: 0.6875rem; line-height: 1.7; color: var(--text-subtle);
    border-top: 1px solid var(--border-color); padding: 1rem 0.5rem 0.25rem;
  }
  .rail-meta-row { display: flex; align-items: center; gap: 0.4rem; margin-top: 0.4rem; }
  .rail-meta-row a {
    color: var(--color-info-text); text-decoration: none;
    display: inline-flex; align-items: center; gap: 0.3rem;
  }
  .rail-meta-row a:hover { text-decoration: underline; }

  /* ---- Content + main ---- */
  .content { flex: 1 1 auto; min-width: 0; }
  main {
    padding: 1.25rem 2.5rem 6rem;
    max-width: 1320px; margin: 0 auto;
  }

  section { margin-bottom: 2.5rem; scroll-margin-top: 1.5rem; }

  h2 {
    font-family: var(--font-display);
    font-size: 1.125rem; font-weight: 600; letter-spacing: -0.015em;
    color: var(--text-main); line-height: 1.25;
    margin: 0 0 0.9rem;
    display: flex; align-items: baseline; gap: 0.75rem;
  }
  h2 .h2-count {
    font-family: var(--font-mono);
    font-size: 0.8125rem; font-weight: 500;
    color: var(--accent-bright);
    background: var(--accent-subtle);
    padding: 0.125rem 0.5rem; border-radius: 999px;
    letter-spacing: 0;
  }

  .note {
    color: var(--text-muted); font-size: 0.8125rem;
    margin: 0 0 1.25rem; max-width: 72ch; line-height: 1.6;
  }
  .note code, code {
    font-family: var(--font-mono); font-size: 0.8125em;
    background: var(--bg-elevated); padding: 0.1rem 0.35rem;
    border-radius: 4px; color: var(--text-main);
    border: 1px solid var(--border-subtle);
  }

  /* ---- Cards / surfaces ---- */
  .panel {
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-card);
    overflow: hidden;
  }
  .panel-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 0.9rem 1.125rem;
    border-bottom: 1px solid var(--border-color);
    background: linear-gradient(180deg, var(--bg-elevated) 0%, var(--bg-surface) 100%);
  }
  .panel-title {
    font-family: var(--font-display);
    font-size: 0.8125rem; font-weight: 600; letter-spacing: 0.02em;
    text-transform: uppercase; color: var(--text-muted);
  }
  .panel-body { padding: 1.125rem; }

  /* ---- Tables ---- */
  .table-wrap {
    width: 100%;
    overflow-x: auto;
    overflow-y: auto;
    max-height: 70vh;
    -webkit-overflow-scrolling: touch;
    margin-bottom: 1.25rem;
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    background: var(--bg-surface);
    box-shadow: var(--shadow-card);
  }
  table { width: 100%; border-collapse: collapse; font-size: 0.8125rem; }
  th, td { text-align: left; padding: 0.7rem 1rem; border-bottom: 1px solid var(--border-subtle); }
  tbody tr:last-child td { border-bottom: none; }
  th {
    position: sticky; top: 0; z-index: 10;
    background: var(--bg-elevated);
    color: var(--text-muted); font-weight: 600; font-size: 0.6875rem;
    text-transform: uppercase; letter-spacing: 0.07em;
    border-bottom: 1px solid var(--border-color);
  }
  td.num { font-family: var(--font-mono); color: var(--text-main); font-variant-numeric: tabular-nums; }
  td.ticker { font-family: var(--font-mono); font-weight: 600; letter-spacing: 0.02em; color: var(--text-main); }
  tbody tr { transition: background 120ms ease; }
  tbody tr:hover { background: var(--bg-hover); }
  .empty { color: var(--text-subtle); font-size: 0.8125rem; font-style: italic; padding: 1rem 0; display: block; }

  /* ---- Status Badges ---- */
  .status {
    display: inline-flex; align-items: center; gap: 0.3rem;
    font-size: 0.6875rem; font-weight: 600;
    padding: 0.2rem 0.6rem; border-radius: 999px;
    letter-spacing: 0.02em; text-transform: uppercase;
    border: 1px solid transparent;
  }
  .status-approved {
    background: var(--color-success-bg); color: var(--color-success-text);
    border-color: rgba(16, 185, 129, 0.28);
  }
  .status-rejected {
    background: var(--color-danger-bg); color: var(--color-danger-text);
    border-color: rgba(239, 68, 68, 0.28);
  }
  .status-neutral {
    background: rgba(100, 116, 139, 0.14); color: var(--text-muted);
    border-color: rgba(100, 116, 139, 0.25);
  }

  .grid { display: grid; grid-template-columns: 1fr; gap: 1.25rem; }
  .grid > section { min-width: 0; margin-bottom: 0; }

  /* ---- LLM answer disclosure ---- */
  .llm-answer summary {
    cursor: pointer; color: var(--color-info-text); font-size: 0.8125rem;
    font-weight: 500; list-style: none; width: fit-content;
    transition: color 150ms ease;
    display: inline-flex; align-items: center; gap: 0.3rem;
  }
  .llm-answer summary::-webkit-details-marker { display: none; }
  .llm-answer summary::before { content: "\\25b8 "; opacity: 0.7; }
  .llm-answer[open] summary::before { content: "\\25be "; }
  .llm-answer summary:hover { color: var(--text-main); }
  .llm-answer-body {
    margin-top: 0.75rem; padding: 1rem 1.125rem;
    background: var(--bg-surface); border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    max-width: 64ch; width: 100%;
    display: flex; flex-direction: column; gap: 0.75rem;
  }
  .llm-block { font-size: 0.8125rem; line-height: 1.55; color: var(--text-main); }
  .llm-agent {
    display: inline-block; font-size: 0.625rem; font-weight: 700; letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--text-main);
    background: var(--bg-active);
    padding: 0.18rem 0.5rem; border-radius: 4px;
    margin-right: 0.5rem; vertical-align: middle;
    border: 1px solid var(--border-color);
  }
  .llm-agent-bull { background: rgba(16, 185, 129, 0.18); color: var(--color-success-text); border-color: rgba(16, 185, 129, 0.3); }
  .llm-agent-bear { background: rgba(239, 68, 68, 0.18); color: var(--color-danger-text); border-color: rgba(239, 68, 68, 0.3); }
  .llm-justification { color: var(--text-muted); font-style: italic; }

  tr.stale-row td { color: var(--color-warning-text); }
  .stale-flag, .ok-flag {
    font-size: 0.6875rem; font-weight: 600;
    padding: 0.18rem 0.5rem; border-radius: 999px;
    letter-spacing: 0.04em; text-transform: uppercase;
    border: 1px solid transparent;
  }
  .stale-flag {
    color: var(--color-warning-text); background: var(--color-warning-bg);
    border-color: rgba(245, 158, 11, 0.28);
  }
  .ok-flag {
    color: var(--color-success-text); background: var(--color-success-bg);
    border-color: rgba(16, 185, 129, 0.28);
  }

  /* ---- Filters ---- */
  .filter-bar { display: flex; flex-wrap: wrap; gap: 1.25rem; align-items: flex-end; margin-bottom: 1.25rem; }
  .filter-group { display: flex; flex-direction: column; gap: 0.45rem; }
  .filter-label {
    font-size: 0.6875rem; color: var(--text-muted);
    text-transform: uppercase; letter-spacing: 0.07em; font-weight: 600;
  }
  .pill-row { display: flex; gap: 0.4rem; flex-wrap: wrap; }
  .pill {
    font-size: 0.8125rem; font-weight: 500;
    color: var(--text-muted); text-decoration: none;
    padding: 0.375rem 0.85rem;
    border: 1px solid var(--border-color); background: var(--bg-surface);
    border-radius: 999px;
    cursor: pointer; appearance: none;
    transition: border-color 150ms ease, color 150ms ease, background 150ms ease;
  }
  .pill:hover { border-color: var(--border-strong); color: var(--text-main); background: var(--bg-hover); }
  .pill-active {
    color: #fff; background: linear-gradient(135deg, var(--accent) 0%, var(--accent-hover) 100%);
    border-color: var(--accent); font-weight: 600;
    box-shadow: 0 2px 8px -2px var(--accent-glow);
  }

  .filter-form { display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; }
  .filter-form select, input.filter-form, .date-input {
    font-size: 0.8125rem;
    background: var(--bg-base); color: var(--text-main);
    border: 1px solid var(--border-color);
    padding: 0.5rem 0.75rem; border-radius: var(--radius-sm);
    width: 100%; box-sizing: border-box;
    transition: border-color 150ms ease, box-shadow 150ms ease;
    font-family: var(--font-sans);
  }
  .filter-form select:focus, input.filter-form:focus, .date-input:focus {
    outline: none; border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-subtle);
  }
  .filter-form button, .btn {
    font-size: 0.8125rem; font-weight: 600;
    color: #fff;
    background: linear-gradient(135deg, var(--accent) 0%, var(--accent-hover) 100%);
    border: none;
    padding: 0.5rem 1rem; border-radius: var(--radius-sm);
    cursor: pointer; height: 38px;
    display: inline-flex; align-items: center; justify-content: center; gap: 0.45rem;
    transition: background 150ms ease, opacity 150ms ease, box-shadow 150ms ease, transform 100ms ease;
    box-shadow: 0 2px 8px -2px var(--accent-glow);
    text-decoration: none;
  }
  .filter-form button:hover, .btn:hover {
    background: linear-gradient(135deg, var(--accent-hover) 0%, var(--accent-deep) 100%);
  }
  .filter-form button:active, .btn:active { transform: translateY(1px); }
  .filter-form button:focus-visible, .btn:focus-visible {
    outline: 2px solid var(--focus-ring); outline-offset: 2px;
  }
  .btn:disabled { opacity: 0.55; cursor: not-allowed; box-shadow: none; }

  .btn-secondary {
    background: var(--bg-elevated); color: var(--text-main);
    border: 1px solid var(--border-color); box-shadow: none;
  }
  .btn-secondary:hover {
    background: var(--bg-hover); border-color: var(--border-strong);
    background: var(--bg-hover);
  }

  .btn-tertiary { background: transparent; color: var(--text-muted); border: none; box-shadow: none; }
  .btn-tertiary:hover { color: var(--text-main); background: var(--bg-surface); }

  .btn-destructive {
    background: var(--color-danger-bg); color: var(--color-danger-text);
    border: 1px solid rgba(239, 68, 68, 0.4); box-shadow: none;
  }
  .btn-destructive:hover { background: rgba(239, 68, 68, 0.2); }

  .error-inline { color: var(--color-danger-text) !important; }

  a.btn { text-decoration: none; }

  /* ---- Per-page toolbar ---- */
  .page-toolbar {
    display: flex; align-items: center; justify-content: flex-end; gap: 0.6rem;
    margin-bottom: 0.75rem;
  }
  .page-toolbar .btn {
    height: 28px; padding: 0 0.65rem; gap: 0.3rem;
    font-size: 0.75rem; font-weight: 500;
  }
  .page-toolbar-updated {
    font-family: var(--font-mono); font-size: 0.6875rem;
    color: var(--text-muted); font-variant-numeric: tabular-nums;
    letter-spacing: 0.02em;
    display: inline-flex; align-items: center; gap: 0.4rem;
  }
  .page-toolbar-updated::before {
    content: ""; width: 6px; height: 6px; border-radius: 50%;
    background: var(--color-success-text);
    box-shadow: 0 0 6px var(--color-success-strong);
  }

  /* ---- Summary stat cards ---- */
  .stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin-bottom: 1.75rem; }
  .stat-card {
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    padding: 1.1rem 1.25rem;
    position: relative;
    overflow: hidden;
    box-shadow: var(--shadow-card);
    transition: border-color 200ms ease, transform 200ms ease;
  }
  .stat-card:hover { border-color: var(--border-strong); transform: translateY(-1px); }
  .stat-card::before {
    content: ""; position: absolute; top: 0; left: 0; right: 0; height: 2px;
    background: var(--stat-accent, var(--accent));
    opacity: 0.85;
  }
  .stat-card::after {
    content: ""; position: absolute; top: -40px; right: -40px;
    width: 120px; height: 120px; border-radius: 50%;
    background: radial-gradient(circle, var(--stat-accent-glow, var(--accent-glow)) 0%, transparent 70%);
    opacity: 0.4; pointer-events: none;
  }
  .stat-value {
    font-family: var(--font-display); font-size: 1.875rem; font-weight: 600;
    color: var(--text-main); font-variant-numeric: tabular-nums;
    line-height: 1.15; letter-spacing: -0.02em;
    position: relative; z-index: 1;
  }
  .stat-label {
    font-size: 0.75rem; font-weight: 600; color: var(--text-muted);
    margin-top: 0.35rem; letter-spacing: 0.02em;
    position: relative; z-index: 1;
  }
  .stat-sub {
    font-size: 0.6875rem; color: var(--text-subtle); margin-top: 0.4rem;
    font-family: var(--font-mono); letter-spacing: 0;
    position: relative; z-index: 1;
  }

  /* ---- Charts (bar chart + sparklines) ---- */
  .chart {
    display: block;
    background: linear-gradient(180deg, var(--bg-elevated) 0%, var(--bg-surface) 100%);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-card);
  }
  .chart-gridline { stroke: var(--border-color); stroke-width: 1; stroke-dasharray: 2 3; }
  .chart-axis-label { fill: var(--text-subtle); font-size: 10px; font-family: var(--font-mono); }
  .chart-legend {
    display: flex; flex-wrap: wrap; gap: 0.85rem; margin-top: 0.85rem;
    font-size: 0.75rem; color: var(--text-muted);
  }
  .legend-item { display: inline-flex; align-items: center; gap: 0.4rem; }
  .legend-swatch { width: 0.6rem; height: 0.6rem; border-radius: 2px; display: inline-block; }
  .chart-cell-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 1rem; }
  .chart-cell {
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    padding: 1.1rem 1.25rem;
    box-shadow: var(--shadow-card);
    transition: border-color 200ms ease, transform 200ms ease;
  }
  .chart-cell:hover { border-color: var(--border-strong); transform: translateY(-1px); }
  .chart-cell-title {
    font-family: var(--font-display); font-weight: 600; letter-spacing: -0.01em;
    margin-bottom: 0.6rem; font-size: 0.9375rem; color: var(--text-main);
    display: flex; align-items: center; justify-content: space-between;
  }
  .chart-cell-title .ticker-pill {
    font-family: var(--font-mono); font-size: 0.625rem; font-weight: 600;
    background: var(--bg-elevated); color: var(--text-muted);
    padding: 0.1rem 0.45rem; border-radius: 4px;
    border: 1px solid var(--border-color);
  }
  .sparkline { display: block; }
  .sparkline-meta {
    display: flex; gap: 0.65rem; align-items: baseline; margin-top: 0.5rem;
    font-size: 0.75rem; font-family: var(--font-mono);
  }

  /* ---- Circular chart: donut + center label ---- */
  .donut-cell {
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    padding: 1.25rem;
    box-shadow: var(--shadow-card);
    display: flex; flex-direction: column; gap: 1rem;
  }
  .donut-cell-title {
    font-family: var(--font-display); font-weight: 600; letter-spacing: -0.01em;
    font-size: 0.9375rem; color: var(--text-main);
  }
  .donut-cell-subtitle {
    font-size: 0.6875rem; color: var(--text-muted);
    text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600;
    margin-top: -0.5rem;
  }
  .donut-wrap {
    display: flex; align-items: center; gap: 1.25rem; flex-wrap: wrap;
  }
  .donut-svg { flex-shrink: 0; }
  .donut-center-value {
    font-family: var(--font-display); font-weight: 600;
    fill: var(--text-main); font-variant-numeric: tabular-nums;
  }
  .donut-center-label {
    fill: var(--text-muted); font-size: 9px;
    text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600;
  }
  .donut-legend {
    display: flex; flex-direction: column; gap: 0.45rem;
    flex: 1; min-width: 120px;
  }
  .donut-legend-row {
    display: flex; align-items: center; gap: 0.5rem;
    font-size: 0.75rem; color: var(--text-main);
  }
  .donut-legend-swatch {
    width: 0.625rem; height: 0.625rem; border-radius: 3px; flex-shrink: 0;
  }
  .donut-legend-label { flex: 1; min-width: 0; }
  .donut-legend-value {
    font-family: var(--font-mono); color: var(--text-muted);
    font-variant-numeric: tabular-nums; font-size: 0.75rem;
  }

  /* ---- Semi-circular gauge ---- */
  .gauge-cell {
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    padding: 1.25rem;
    box-shadow: var(--shadow-card);
    display: flex; flex-direction: column; gap: 0.5rem;
    text-align: center;
  }
  .gauge-cell-title {
    font-family: var(--font-display); font-weight: 600; letter-spacing: -0.01em;
    font-size: 0.9375rem; color: var(--text-main);
  }
  .gauge-cell-subtitle {
    font-size: 0.6875rem; color: var(--text-muted);
    text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600;
  }
  .gauge-value {
    font-family: var(--font-display); font-weight: 600;
    fill: var(--text-main); font-variant-numeric: tabular-nums;
  }
  .gauge-label {
    fill: var(--text-muted); font-size: 9px;
    text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600;
  }

  /* ---- Chart layout grids ---- */
  .chart-row-2 {
    display: grid; grid-template-columns: repeat(2, 1fr); gap: 1rem;
    margin-bottom: 1.75rem;
  }
  .chart-row-3 {
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem;
    margin-bottom: 1.75rem;
  }

  /* Mobile header & bottom nav (hidden on desktop) */
  .mobile-header { display: none; }
  .bottom-nav { display: none; }

  /* Tablet icon rail (768px - 1023px) */
  @media (min-width: 768px) and (max-width: 1023px) {
    .rail {
      flex: 0 0 72px; width: 72px;
      padding: 1.25rem 0.5rem;
      align-items: center;
      gap: 1.5rem;
      overflow: visible;
    }
    .rail .wordmark { padding: 0; justify-content: center; }
    .rail .wordmark-text { display: none; }
    .rail .rail-meta { display: none; }
    .rail .section-nav { width: 100%; align-items: center; gap: 0.3rem; }
    .rail .section-nav a {
      justify-content: center; width: 48px; height: 48px;
      padding: 0; border-radius: var(--radius-md);
      position: relative;
    }
    .rail .section-nav a.active { background: var(--bg-active); }
    .rail .section-nav a.active::before { display: none; }
    .rail .section-nav a.active { border: 1px solid var(--accent); }
    .rail .section-nav a .nav-index, .rail .section-nav a .nav-label { display: none; }
    .rail .section-nav a .nav-icon { opacity: 1; }
    .rail .section-nav a:hover .nav-icon,
    .rail .section-nav a.active .nav-icon { color: var(--text-main); }
    .rail .section-nav a.active .nav-icon { color: var(--accent-bright); }
    .rail .section-nav a::after {
      content: attr(data-label);
      position: absolute; left: calc(100% + 12px); top: 50%;
      transform: translateY(-50%);
      background: var(--bg-elevated); color: var(--text-main);
      padding: 0.4rem 0.75rem; border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      font-size: 0.8125rem; font-weight: 500;
      white-space: nowrap; opacity: 0; pointer-events: none;
      transition: opacity 150ms ease;
      z-index: 1000; box-shadow: var(--shadow-pop);
    }
    .rail .section-nav a:hover::after,
    .rail .section-nav a:focus::after { opacity: 1; }
    main { padding: 1.25rem 1.5rem 6rem; }
    .stat-grid { grid-template-columns: repeat(2, 1fr); }
    .chart-row-3 { grid-template-columns: 1fr; }
    .chart-row-2 { grid-template-columns: 1fr; }
  }

  /* Mobile (< 768px) */
  @media (max-width: 767px) {
    .shell { flex-direction: column; }
    .rail { display: none; }
    .mobile-header {
      display: flex;
      flex-direction: row; align-items: center; justify-content: space-between; gap: 0.75rem;
      background: var(--bg-surface);
      border-bottom: 1px solid var(--border-color);
      padding: 0.5rem 1rem;
      position: sticky; top: 0; z-index: 50;
      backdrop-filter: blur(10px);
    }
    .mobile-header .wordmark {
      flex-direction: row; align-items: center; gap: 0.5rem; padding: 0;
    }
    .mobile-header .wordmark-mark {
      width: 26px; height: 26px; border-radius: 8px; font-size: 0.8rem;
    }
    .mobile-header .wordmark-text { display: flex; }
    .mobile-header .wordmark-sub { display: none; }
    .mobile-header .rail-meta {
      display: block; margin: 0; border-top: none; padding: 0;
      font-size: 0.75rem; line-height: 1;
    }
    .content { width: 100%; }
    main { padding: 0.85rem 1rem 6rem; }
    .stat-grid { grid-template-columns: 1fr 1fr; gap: 0.75rem; }
    .stat-card { padding: 0.9rem 1rem; }
    .stat-value { font-size: 1.5rem; }
    .filter-bar { gap: 0.85rem; }
    .page-toolbar { justify-content: space-between; gap: 0.5rem; margin-bottom: 0.6rem; }
    .page-toolbar .btn { height: 32px; padding: 0 0.7rem; }
    .chart-row-2, .chart-row-3 { grid-template-columns: 1fr; }
    .donut-wrap { flex-direction: column; align-items: stretch; }
    .donut-svg { align-self: center; }
    h2 { font-size: 1.0625rem; }

    /* Fixed bottom navigation bar (min 44x44px touch targets) */
    .bottom-nav {
      position: fixed; bottom: 0; left: 0; right: 0; z-index: 100;
      background: rgba(13, 19, 32, 0.92);
      border-top: 1px solid var(--border-color);
      display: flex;
      overflow-x: auto; white-space: nowrap;
      -webkit-overflow-scrolling: touch;
      padding: 0.4rem 0.5rem;
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      /* iOS safe area */
      padding-bottom: calc(0.4rem + env(safe-area-inset-bottom, 0px));
    }
    .bottom-nav::-webkit-scrollbar { height: 3px; }
    .bottom-nav::-webkit-scrollbar-thumb { background: var(--border-strong); }
    .bottom-nav a {
      display: inline-flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 0.18rem; color: var(--text-muted); text-decoration: none;
      font-size: 0.6875rem; font-weight: 500;
      padding: 0.25rem 0.5rem; min-height: 48px; min-width: 56px;
      border-bottom: none; flex-shrink: 0;
      border-top: 2px solid transparent;
      transition: color 150ms ease;
    }
    .bottom-nav a:hover, .bottom-nav a.active {
      color: var(--text-main);
    }
    .bottom-nav a.active {
      color: var(--accent-bright); font-weight: 600;
      border-top-color: var(--accent-bright);
    }
    .bottom-nav a .nav-icon { opacity: 1; }
    .bottom-nav .nav-index { display: none; }
  }

  /* ---- Mini stat rows (big number + label, used inside panels) ---- */
  .mini-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: 1rem 1.5rem; }
  .mini-stat { min-width: 0; }
  .mini-stat-value {
    font-family: var(--font-display); font-size: 1.5rem; font-weight: 600;
    font-variant-numeric: tabular-nums; line-height: 1.2; color: var(--text-main);
  }
  .mini-stat-label {
    font-size: 0.6875rem; color: var(--text-muted); margin-top: 0.15rem;
    text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600;
  }
  .panel-body-flush { padding: 0; }

  /* ---- Mobile: tables become stacked cards -------------------------------------
     Below 768px a 5-7 column table can't fit, and horizontal scrolling hides the
     columns that matter. Instead every row (.table-wrap tables and the health
     table in .panel-body-flush) renders as a card: the .cell-title cell (ticker /
     source / metric) is the heading, and every other cell is a label + value pair
     in a 2-column grid. Labels come from each td's data-label (the header row is
     visually hidden but kept for screen readers). .cell-wide spans both columns;
     grid-auto-flow: dense back-fills gaps left by wide cells. Pure CSS, no JS. */
  @media (max-width: 767px) {
    .table-wrap {
      max-height: none; overflow: visible;
      border: none; border-radius: 0; background: transparent; box-shadow: none;
      margin-bottom: 1rem;
    }
    :is(.table-wrap, .panel-body-flush) table,
    :is(.table-wrap, .panel-body-flush) tbody { display: block; width: 100%; }
    :is(.table-wrap, .panel-body-flush) thead {
      position: absolute; width: 1px; height: 1px; overflow: hidden;
      clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap;
    }
    :is(.table-wrap, .panel-body-flush) tr {
      --card-bg: var(--bg-surface);
      display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
      grid-auto-flow: row dense; align-items: start; gap: 0.75rem 1rem;
      padding: 0.9rem 1rem; margin-bottom: 0.75rem;
      background: var(--card-bg); border: 1px solid var(--border-color);
      border-radius: var(--radius-md); box-shadow: var(--shadow-card);
    }
    /* Cards nested inside another surface (panel / expanded backtest run) step up one shade. */
    .panel :is(.table-wrap, .panel-body-flush) tr,
    .llm-answer-body :is(.table-wrap, .panel-body-flush) tr { --card-bg: var(--bg-elevated); box-shadow: none; }
    :is(.table-wrap, .panel-body-flush) tbody tr:hover { background: var(--card-bg); }
    :is(.table-wrap, .panel-body-flush) tr.stale-row { border-color: rgba(245, 158, 11, 0.35); }
    .panel-body-flush { padding: 0.75rem 0.75rem 0.05rem; }

    :is(.table-wrap, .panel-body-flush) td {
      display: block; padding: 0; border: none; min-width: 0; overflow-wrap: anywhere;
    }
    :is(.table-wrap, .panel-body-flush) td[data-label]::before {
      content: attr(data-label); display: block; margin-bottom: 0.2rem;
      font-family: var(--font-sans); font-size: 0.625rem; font-weight: 600;
      letter-spacing: 0.07em; text-transform: uppercase; color: var(--text-muted);
    }
    :is(.table-wrap, .panel-body-flush) td.cell-wide { grid-column: 1 / -1; }
    :is(.table-wrap, .panel-body-flush) td.cell-title {
      grid-column: 1 / -1; padding-bottom: 0.65rem;
      border-bottom: 1px solid var(--border-subtle);
      font-size: 1rem; font-weight: 600;
    }

    /* Backtest metric rows: Metric title + ON / OFF / Delta as three tiles. */
    :is(.table-wrap, .panel-body-flush) tr.rt-tiles { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    :is(.table-wrap, .panel-body-flush) td.status-approved,
    :is(.table-wrap, .panel-body-flush) td.status-rejected,
    :is(.table-wrap, .panel-body-flush) td.status-neutral { padding: 0.3rem 0.5rem; border-radius: var(--radius-sm); }
    :is(.table-wrap, .panel-body-flush) td.status-approved::before,
    :is(.table-wrap, .panel-body-flush) td.status-rejected::before,
    :is(.table-wrap, .panel-body-flush) td.status-neutral::before { color: inherit; opacity: 0.75; }

    /* Full-width, thumb-sized disclosure rows (LLM reasoning, backtest runs). */
    .llm-answer summary {
      display: flex; flex-wrap: wrap; align-items: center;
      gap: 0.3rem 0.5rem; width: 100%; min-height: 44px;
    }

    /* Mini stats: fixed column count on phones (set per call site via --cols). */
    .mini-stats { grid-template-columns: repeat(var(--cols, 2), minmax(0, 1fr)); gap: 0.85rem 0.75rem; }
    .mini-stat-value { font-size: 1.375rem; }
  }

  @media (min-width: 1024px) {
    .mobile-header { display: none; }
    .bottom-nav { display: none; }
    .grid { grid-template-columns: repeat(3, 1fr); }
  }

  @media (prefers-reduced-motion: reduce) {
    *, ::before, ::after {
      transition-duration: 0.01ms !important;
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
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
  ["more", "More", "MR"],
];

function renderNav(activeSection) {
  const links = NAV_SECTIONS.map(([id, label, abbr], i) => {
    const n = String(i + 1).padStart(2, "0");
    const active = activeSection === id;
    const icon = ICONS[id] ?? "";
    return `<a href="/dashboard/${id}"${active ? ' class="active"' : ""} data-label="${escapeHtml(label)}"><span class="nav-index">${n}</span><span class="nav-icon">${icon}</span><span class="nav-label">${escapeHtml(label)}</span></a>`;
  }).join("");
  return `<nav class="section-nav">${links}</nav>`;
}

// Mobile bottom nav is a curated subset of the most-used sections, with "More"
// as the overflow. This is intentionally different from the desktop nav so
// mobile users get single-tap access to the five sections they're most
// likely to check on a phone.
const MOBILE_NAV_SECTIONS = [
  ["snapshot", "Snapshot", "01"],
  ["decisions", "Decisions", "05"],
  ["positions", "Positions", "06"],
  ["pipeline", "Pipeline", "07"],
  ["health", "Health", "04"],
  ["more", "More", "10"],
];

function renderBottomNav(activeSection) {
  const moreIds = ["activity", "charts", "backfill", "backtest", "more"];
  const links = MOBILE_NAV_SECTIONS.map(([id, label, n]) => {
    let active = activeSection === id;
    if (id === "more" && moreIds.includes(activeSection)) {
      active = true;
    }
    const icon = ICONS[id] ?? "";
    return `<a href="/dashboard/${id}"${active ? ' class="active"' : ""}><span class="nav-icon">${icon}</span><span>${escapeHtml(label)}</span></a>`;
  }).join("");
  return `<nav class="bottom-nav">${links}</nav>`;
}

function renderMobileHeader(sessionUsername) {
  return `<div class="mobile-header">
    <div class="wordmark">
      <span class="wordmark-mark">N</span>
      <span class="wordmark-text">
        <span class="wordmark-main">news-market-ai</span>
        <span class="wordmark-sub">operations ledger</span>
      </span>
    </div>
    <div class="rail-meta">${sessionUsername ? `<span class="rail-meta-row" style="margin:0;display:inline-flex;" title="Logged in as ${escapeHtml(sessionUsername)}"><a href="/logout">${ICONS.logout} log out</a></span>` : ""}</div>
  </div>`;
}

function renderPageToolbar(refreshHref) {
  if (!refreshHref) return "";
  return `<div class="page-toolbar">
        <span class="page-toolbar-updated">Loaded ${fmtTime(new Date().toISOString())}</span>
        <a href="${escapeHtml(refreshHref)}" class="btn btn-secondary" title="Reload this page with the latest data"><span aria-hidden="true">\u21bb</span> Refresh</a>
      </div>`;
}

export function renderShell({ activeSection, sessionUsername, bodyHtml, refreshHref }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="theme-color" content="#070b14">
<title>news-market-ai dashboard (${escapeHtml(activeSection)})</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Inter+Tight:wght@500;600;700&display=swap" rel="stylesheet">
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
        <span class="wordmark-mark">N</span>
        <span class="wordmark-text">
          <span class="wordmark-main">news-market-ai</span>
          <span class="wordmark-sub">operations ledger</span>
        </span>
      </div>
      ${renderNav(activeSection)}
      <div class="rail-meta">generated ${fmtTime(new Date().toISOString())}<br>architecture &amp; known gaps in plan.md${sessionUsername ? `<div class="rail-meta-row">logged in as ${escapeHtml(sessionUsername)} &middot; ${ICONS.logout}<a href="/logout">log out</a></div>` : ""}</div>
    </aside>
    <div class="content">
      <main>
      ${renderPageToolbar(refreshHref)}
      ${bodyHtml}
      </main>
    </div>
  </div>
  ${renderBottomNav(activeSection)}
</body>
</html>`;
}
