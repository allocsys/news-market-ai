// Shared page chrome (shell, desktop sidebar nav, mobile header & bottom tab bar, CSS style).
//
// Design system:
//   - Premium fintech theme, light by default, full dark mode available.
//     Surfaces use a subtle elevation ladder (--bg-base -> --bg-surface ->
//     --bg-elevated) instead of a single flat panel, in both themes.
//   - Typography (plan.md "Dashboard: Heavy Polish, Redesign & Reorganization"
//     Step 1, 2026-09-22): Fraunces (display serif) for headings, verdict/
//     thesis callouts and big stat numbers; IBM Plex Sans for body/UI chrome;
//     IBM Plex Mono for tickers/IDs/timestamps/tabular figures. Loaded via
//     Google Fonts. Replaces the prior Inter Tight/Inter/system-mono set.
//   - Sidebar: 248px on desktop, 72px icon-rail on tablet, hidden on mobile
//     (replaced by a top app bar + bottom tab bar with Lucide-style stroke icons).
//   - Cards have a 1px hairline border + faint top highlight (premium feel),
//     no heavy shadows (Cloudflare Worker HTML stays print-friendly).
//   - All animations honor prefers-reduced-motion.
//
// Theming: every color is a CSS custom property on :root, defined once for
// light (the default) and overridden identically under both
// `@media (prefers-color-scheme: dark)` (guarded so an explicit light choice
// still wins) and `:root[data-theme="dark"]` (the explicit toggle, see
// renderThemeToggle below). No JS framework, no rebuild -- same
// vanilla-JS/template-string approach as the rest of this dashboard.
// `renderShell`'s `theme` param, when known, is what dashboard-worker.js read
// from the `theme` cookie server-side, so first paint already has the right
// `data-theme` attribute and there's no flash of the wrong theme.

import { escapeHtml, fmtTime, ENV_SECTIONS, envSuffix } from "./helpers.js";

// ---- Inline SVG icon set (Lucide-style stroke icons, 20x20, currentColor) ----
// Stored as raw <svg> strings so they can be dropped into nav links, badges,
// and section headers without an external icon font. Each is a single path or
// small group of paths using stroke="currentColor" so the link's color cascades.
const ICONS = {
  overview: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/></svg>`,
  snapshot: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"/><path d="M13.4 10.6 19 5"/><path d="M19 5h-3"/><path d="M19 5v3"/><path d="M10.6 13.4 5 19"/><path d="M5 19h3"/><path d="M5 19v-3"/><path d="M13.4 13.4 19 19"/><path d="M19 19v-3"/><path d="M19 19h-3"/><path d="M10.6 10.6 5 5"/><path d="M5 5h3"/><path d="M5 5v3"/></svg>`,
  activity: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3v16a2 2 0 0 0 2 2h16"/><rect x="7" y="11" width="3" height="6" rx="0.5"/><rect x="12" y="7" width="3" height="10" rx="0.5"/><rect x="17" y="13" width="3" height="4" rx="0.5"/></svg>`,
  charts: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3v18h18"/><path d="m7 14 3-4 3 3 4-6"/></svg>`,
  health: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12h3l2-5 4 10 2-5h7"/></svg>`,
  decisions: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M6 8.5v3a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3v-3"/><path d="M12 14.5V15.5"/></svg>`,
  positions: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M3 12h18"/></svg>`,
  pipeline: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="12" r="2.5"/><path d="M6 8.5v7"/><path d="M6 12h6a3 3 0 0 0 3-3V8.5"/></svg>`,
  llm: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 9h8"/><path d="M8 13h5"/></svg>`,
  backfill: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 13V3"/><path d="m7 8 5-5 5 5"/><path d="M5 21h14a2 2 0 0 0 2-2v-4"/><path d="M3 15h4"/><path d="M3 19h4"/></svg>`,
  backtest: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 3h6"/><path d="M10 3v6.5L5 19a2 2 0 0 0 1.8 3h10.4A2 2 0 0 0 19 19l-5-9.5V3"/><path d="M7 15h10"/></svg>`,
  more: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>`,
  refresh: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg>`,
  logout: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/></svg>`,
  sun: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>`,
  moon: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z"/></svg>`,
  search: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`,
};

// Every dark-theme value lives once, here, and is reused verbatim by both the
// `prefers-color-scheme: dark` block (default dark, unless the operator
// explicitly picked light) and the `[data-theme="dark"]` block (explicit
// toggle). Keeping one source avoids the two ever drifting apart.
const DARK_VARS = `
    --bg-base: #14171f;
    --bg-surface: #1c2029;
    --bg-elevated: #242935;
    --bg-hover: #2b3140;
    --bg-active: #333b4d;

    --border-color: #313846;
    --border-subtle: #262b36;
    --border-strong: #3f4759;

    --text-main: #edeae2;
    --text-muted: #a8a398;
    --text-subtle: #7d7a72;
    --text-inverse: #14171f;

    --accent: #d98e3c;
    --accent-hover: #c67d2e;
    --accent-bright: #e8a458;
    --accent-deep: #a8631f;
    --accent-subtle: rgba(217, 142, 60, 0.14);
    --accent-glow: rgba(232, 164, 88, 0.22);
    --focus-ring: #e8a458;

    --color-success-bg: rgba(16, 185, 129, 0.12);
    --color-success-text: #34d399;
    --color-success-strong: #10b981;
    --color-danger-bg: rgba(239, 68, 68, 0.12);
    --color-danger-text: #f87171;
    --color-danger-strong: #ef4444;
    --color-warning-bg: rgba(245, 158, 11, 0.12);
    --color-warning-text: #fbbf24;
    --color-warning-strong: #f59e0b;
    --color-info-bg: rgba(217, 142, 60, 0.12);
    --color-info-text: #e8a458;

    /* Bull/bear semantics (plan.md Step 1 introduces the tokens; Step 4's
       verdict card is the first consumer). Deliberately separate from the
       general success/danger tokens above -- a rejected decision isn't the
       same concept as a bear argument, even though today's UI has no
       bear-argument surface yet. */
    --bull: #4e9b6b;
    --bull-bg: rgba(78, 155, 107, 0.14);
    --bear: #c1523f;
    --bear-bg: rgba(193, 82, 63, 0.14);

    --chart-1: #d98e3c;
    --chart-2: #4e9b6b;
    --chart-3: #c9a227;
    --chart-4: #c1523f;
    --chart-5: #8b6f9e;
    --chart-6: #8b93a1;

    --surface-translucent: rgba(28, 32, 41, 0.92);
    --bg-glow-1: rgba(217, 142, 60, 0.08);
    --bg-glow-2: rgba(139, 111, 158, 0.05);

    --shadow-card: 0 1px 0 rgba(255, 255, 255, 0.04) inset, 0 8px 24px -12px rgba(0, 0, 0, 0.5);
    --shadow-pop: 0 12px 32px -8px rgba(0, 0, 0, 0.55);
`;

const STYLE = `
  :root {
    color-scheme: light dark;

    /* Light theme (default). Same elevation-ladder / hairline-border /
       two-step-accent structure as dark, just re-tuned for a white surface. */
    --bg-base: #f6f8fb;
    --bg-surface: #ffffff;
    --bg-elevated: #eef2f8;
    --bg-hover: #e7ecf5;
    --bg-active: #dbe7fc;

    --border-color: #e1e7f0;
    --border-subtle: #ebeff5;
    --border-strong: #c7d1e0;

    --text-main: #0f1729;
    --text-muted: #55627a;
    --text-subtle: #7c879c;
    --text-inverse: #f1f5f9;

    --accent: #2f6fed;
    --accent-hover: #2158c9;
    --accent-bright: #4d8bff;
    --accent-deep: #1d4ed8;
    --accent-subtle: rgba(47, 111, 237, 0.08);
    --accent-glow: rgba(77, 139, 255, 0.16);
    --focus-ring: #2f6fed;

    --color-success-bg: rgba(16, 185, 129, 0.10);
    --color-success-text: #0a8f63;
    --color-success-strong: #10b981;
    --color-danger-bg: rgba(239, 68, 68, 0.10);
    --color-danger-text: #d43f3f;
    --color-danger-strong: #ef4444;
    --color-warning-bg: rgba(245, 158, 11, 0.12);
    --color-warning-text: #9a6208;
    --color-warning-strong: #f59e0b;
    --color-info-bg: rgba(47, 111, 237, 0.10);
    --color-info-text: #2f6fed;

    /* Chart palette -- 6-step categorical scale used by the donut/gauge helpers. */
    --chart-1: #2f6fed;
    --chart-2: #0a8f63;
    --chart-3: #b3790b;
    --chart-4: #d43f3f;
    --chart-5: #7c5cd1;
    --chart-6: #7c879c;

    /* Translucent surface used by the mobile header / bottom nav backdrop-filter
       blur, and the subtle top-of-page glow -- both theme-dependent, so they're
       vars rather than hardcoded rgba(). */
    --surface-translucent: rgba(255, 255, 255, 0.88);
    --bg-glow-1: rgba(47, 111, 237, 0.05);
    --bg-glow-2: rgba(124, 92, 209, 0.04);

    --font-sans: "IBM Plex Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    --font-display: "Fraunces", Georgia, "Times New Roman", serif;
    --font-mono: "IBM Plex Mono", ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace;

    --radius-sm: 6px;
    --radius-md: 10px;
    --radius-lg: 14px;
    --radius-xl: 18px;

    --shadow-card: 0 1px 0 rgba(255, 255, 255, 0.6) inset, 0 8px 24px -12px rgba(15, 23, 42, 0.12);
    --shadow-pop: 0 12px 32px -8px rgba(15, 23, 42, 0.18);
  }

  /* Dark theme: applied automatically when the OS/browser prefers dark AND
     the operator hasn't explicitly picked light (the :not guard), OR
     unconditionally when the operator explicitly picked dark via the toggle
     (the [data-theme="dark"] rule below). Both blocks share DARK_VARS so
     they can never drift out of sync. */
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {${DARK_VARS}    }
  }
  :root[data-theme="dark"] {${DARK_VARS}  }

  * { box-sizing: border-box; }

  html, body { height: 100%; }
  body {
    font-family: var(--font-sans);
    margin: 0; padding: 0;
    background: var(--bg-base);
    /* Subtle radial glow at the top so the page doesn't read as a flat slab.
       Fixed so it stays put on scroll, like a desk lamp. Colors are theme
       vars so the glow re-tunes itself in dark mode instead of overpowering
       a light surface. */
    background-image: radial-gradient(900px 480px at 12% -8%, var(--bg-glow-1), transparent 70%),
                      radial-gradient(700px 360px at 88% 0%, var(--bg-glow-2), transparent 70%);
    background-attachment: fixed;
    color: var(--text-main);
    line-height: 1.5;
    font-size: 0.875rem;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
    transition: background-color 150ms ease, color 150ms ease;
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

  /* Group header above a multi-section group's links (plan.md Step 2 nav
     reorg, 2026-09-22) -- replaces the old per-link numbered badge (01, 02...)
     dropped this step since the nav isn't a sequence. Single-section groups
     (Overview, Backtest) render with no header at all, see renderNav. */
  .section-nav-group-label {
    margin: 0.85rem 0 0.15rem; padding: 0 0.625rem;
    font-size: 0.6875rem; font-weight: 700; letter-spacing: 0.08em;
    text-transform: uppercase; color: var(--text-subtle);
  }
  .section-nav-group-label:first-child { margin-top: 0; }

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

  /* ---- Theme toggle ---- */
  .theme-toggle {
    display: inline-flex; align-items: center; justify-content: center;
    width: 30px; height: 30px; flex-shrink: 0;
    background: var(--bg-elevated); color: var(--text-muted);
    border: 1px solid var(--border-color); border-radius: var(--radius-sm);
    cursor: pointer; padding: 0;
    transition: color 150ms ease, background 150ms ease, border-color 150ms ease;
  }
  .theme-toggle:hover { color: var(--text-main); background: var(--bg-hover); border-color: var(--border-strong); }
  .theme-toggle:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
  .theme-toggle .icon-sun, .theme-toggle .icon-moon { display: none; }
  /* Show the icon for the theme NOT currently active (i.e. what clicking
     switches to), matching the common sun/moon toggle convention. */
  .theme-toggle .icon-moon { display: inline-flex; }
  [data-theme="dark"] .theme-toggle .icon-sun { display: inline-flex; }
  [data-theme="dark"] .theme-toggle .icon-moon { display: none; }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) .theme-toggle .icon-sun { display: inline-flex; }
    :root:not([data-theme="light"]) .theme-toggle .icon-moon { display: none; }
  }
  .rail-meta-row .theme-toggle { margin-left: auto; }

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

  /* ---- Tables: hairline-ruled ledger treatment (plan.md Step 3, 2026-09-22) ----
     Reads as a financial ledger, not a card: no drop shadow, no rounded
     corners, no elevated gradient header block. Just a hairline top/bottom
     rule around the whole table and a hairline rule under the header and
     between every row -- the rule itself is the design. Applies to every
     table on the dashboard (decisionsTable, positionsTable, checkpointsTable,
     the LLM-calls table) since they all already share these classes -- no
     markup change needed, this is CSS only. Numeric/ticker columns keep the
     mono font at tabular-nums so figures line up down the column. */
  .table-wrap {
    width: 100%;
    overflow-x: auto;
    overflow-y: auto;
    max-height: 70vh;
    -webkit-overflow-scrolling: touch;
    margin-bottom: 1.25rem;
    border-top: 1px solid var(--border-strong);
    border-bottom: 1px solid var(--border-strong);
    background: var(--bg-surface);
  }
  table { width: 100%; border-collapse: collapse; font-size: 0.8125rem; }
  th, td { text-align: left; padding: 0.6rem 1rem; border-bottom: 1px solid var(--border-subtle); }
  tbody tr:last-child td { border-bottom: none; }
  th {
    position: sticky; top: 0; z-index: 10;
    background: var(--bg-surface);
    color: var(--text-muted); font-weight: 600; font-size: 0.6875rem;
    text-transform: uppercase; letter-spacing: 0.07em;
    border-bottom: 1px solid var(--border-strong);
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
  .auto-refresh-toggle {
    font-family: var(--font-mono); font-size: 0.6875rem; font-weight: 500;
    color: var(--text-muted); background: var(--bg-surface);
    border: 1px solid var(--border-color); border-radius: 999px;
    padding: 0.3rem 0.65rem; cursor: pointer; appearance: none;
    display: inline-flex; align-items: center; gap: 0.35rem;
    transition: border-color 150ms ease, color 150ms ease, background 150ms ease;
  }
  .auto-refresh-toggle:hover { border-color: var(--border-strong); color: var(--text-main); background: var(--bg-hover); }
  .auto-refresh-toggle[data-on="true"] { color: var(--color-success-text); border-color: rgba(16, 185, 129, 0.35); }
  .auto-refresh-dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: var(--text-subtle); flex-shrink: 0;
    transition: background 150ms ease, box-shadow 150ms ease;
  }
  .auto-refresh-toggle[data-on="true"] .auto-refresh-dot {
    background: var(--color-success-text); box-shadow: 0 0 6px var(--color-success-strong);
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
    .rail .section-nav-group-label { display: none; }
    .rail .section-nav a .nav-label { display: none; }
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
      display: flex; align-items: center; gap: 0.6rem;
      margin: 0; border-top: none; padding: 0;
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
      background: var(--surface-translucent);
      border-top: 1px solid var(--border-color);
      display: flex; align-items: stretch;
      padding: 0.4rem 0.25rem;
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      /* iOS safe area */
      padding-bottom: calc(0.4rem + env(safe-area-inset-bottom, 0px));
    }
    /* Every tab gets an equal share of the bar (flex: 1 1 0), so the six items
       are evenly spaced edge to edge regardless of label length, and the active
       indicator always spans the same width. No horizontal scrolling: labels
       truncate with an ellipsis on very narrow screens instead. */
    .bottom-nav a {
      display: flex; flex: 1 1 0; min-width: 0;
      flex-direction: column; align-items: center; justify-content: center;
      gap: 0.18rem; color: var(--text-muted); text-decoration: none;
      font-size: 0.6875rem; font-weight: 500; text-align: center;
      padding: 0.25rem 0.125rem; min-height: 48px;
      border-bottom: none;
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
    .bottom-nav a > span:not(.nav-icon) {
      max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }

    /* ---- Mobile "More" bottom sheet (plan.md "Dashboard: Scoped UX Adoption" item 4) ----
       Tapping "More" opens this in-page overlay instead of a full-page nav
       to /dashboard/more (see renderMobileMoreSheet + renderBottomNav's
       #mobile-more-trigger below). The href stays a real fallback for no-JS
       clients; the click handler near the end of this script only
       intercepts it once the sheet markup is confirmed present. */
    .mobile-more-backdrop {
      position: fixed; inset: 0; z-index: 150;
      background: rgba(15, 23, 42, 0.45);
      opacity: 0; visibility: hidden;
      transition: opacity 200ms ease, visibility 0s linear 200ms;
    }
    .mobile-more-backdrop[data-open="true"] {
      opacity: 1; visibility: visible;
      transition: opacity 200ms ease, visibility 0s linear 0s;
    }
    .mobile-more-sheet {
      position: fixed; left: 0; right: 0; bottom: 0; z-index: 151;
      max-height: 80vh; overflow-y: auto;
      background: var(--bg-surface);
      border-top: 1px solid var(--border-color);
      border-radius: var(--radius-lg) var(--radius-lg) 0 0;
      box-shadow: var(--shadow-pop);
      padding: 0.5rem 1.25rem calc(1.25rem + env(safe-area-inset-bottom, 0px));
      transform: translateY(100%);
      visibility: hidden;
      transition: transform 220ms ease, visibility 0s linear 220ms;
    }
    .mobile-more-sheet[data-open="true"] {
      transform: translateY(0);
      visibility: visible;
      transition: transform 220ms ease, visibility 0s linear 0s;
    }
    .mobile-more-sheet-handle {
      width: 36px; height: 4px; border-radius: 2px;
      background: var(--border-strong);
      margin: 0.5rem auto 0.75rem;
    }
    .mobile-more-sheet-header {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 0.85rem;
    }
    .mobile-more-sheet-title {
      font-family: var(--font-display); font-weight: 600; font-size: 1rem;
      color: var(--text-main);
    }
    .mobile-more-sheet-close {
      display: inline-flex; align-items: center; justify-content: center;
      width: 32px; height: 32px; border-radius: var(--radius-sm);
      background: var(--bg-elevated); color: var(--text-muted);
      border: 1px solid var(--border-color);
      font-size: 1.25rem; line-height: 1; cursor: pointer; padding: 0;
    }
    .mobile-more-sheet-close:hover { color: var(--text-main); background: var(--bg-hover); }
    .mobile-more-sheet-grid {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.75rem;
    }
    .mobile-more-card {
      display: flex; flex-direction: column; align-items: center; gap: 0.4rem;
      padding: 0.9rem 0.5rem;
      background: var(--bg-elevated); border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      text-decoration: none; color: var(--text-muted);
      font-size: 0.75rem; font-weight: 500; text-align: center;
      min-height: 44px;
      transition: color 150ms ease, background 150ms ease, border-color 150ms ease;
    }
    .mobile-more-card:hover, .mobile-more-card.active {
      color: var(--text-main); background: var(--bg-hover); border-color: var(--border-strong);
    }
    .mobile-more-card .nav-icon { opacity: 1; display: inline-flex; }
  }

  /* ---- Ticker search palette (plan.md "Dashboard: Scoped UX Adoption" item 6) ----
     Unlike the mobile More sheet, this overlay isn't gated to the mobile media
     query -- a command palette is equally useful with a keyboard on desktop
     (Ctrl/Cmd+K), so the same centered-overlay markup renders at every
     breakpoint instead of a bottom-sheet-on-mobile / dropdown-on-desktop split. */
  .search-backdrop {
    position: fixed; inset: 0; z-index: 200;
    background: rgba(15, 23, 42, 0.45);
    opacity: 0; visibility: hidden;
    transition: opacity 200ms ease, visibility 0s linear 200ms;
  }
  .search-backdrop[data-open="true"] { opacity: 1; visibility: visible; transition: opacity 200ms ease, visibility 0s linear 0s; }
  .search-palette {
    position: fixed; top: 12vh; left: 50%; transform: translateX(-50%);
    z-index: 201; width: min(480px, 92vw); max-height: 60vh;
    display: flex; flex-direction: column;
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-pop);
    overflow: hidden;
    opacity: 0; visibility: hidden;
    transition: opacity 180ms ease, visibility 0s linear 180ms;
  }
  .search-palette[data-open="true"] { opacity: 1; visibility: visible; transition: opacity 180ms ease, visibility 0s linear 0s; }
  .search-palette-input-row {
    display: flex; align-items: center; gap: 0.6rem;
    padding: 0.75rem 1rem; border-bottom: 1px solid var(--border-color);
    flex-shrink: 0;
  }
  .search-palette-input-row .nav-icon { color: var(--text-subtle); }
  .search-palette-input {
    flex: 1; min-width: 0; border: none; outline: none; background: transparent;
    font-size: 0.9375rem; color: var(--text-main); font-family: var(--font-sans);
  }
  .search-palette-input::placeholder { color: var(--text-subtle); }
  .search-palette-kbd {
    font-family: var(--font-mono); font-size: 0.6875rem; color: var(--text-subtle);
    background: var(--bg-elevated); border: 1px solid var(--border-color);
    border-radius: 4px; padding: 0.1rem 0.4rem; flex-shrink: 0;
  }
  .search-palette-results { overflow-y: auto; padding: 0.4rem; }
  .search-result {
    display: flex; align-items: center; justify-content: space-between;
    padding: 0.6rem 0.75rem; border-radius: var(--radius-sm);
    color: var(--text-main); text-decoration: none;
    font-family: var(--font-mono); font-weight: 600; letter-spacing: 0.02em;
    cursor: pointer;
  }
  .search-result:hover, .search-result.active { background: var(--bg-hover); }
  .search-empty { padding: 1.25rem 1rem; color: var(--text-subtle); font-size: 0.8125rem; text-align: center; }
  @media (max-width: 767px) {
    .search-palette { top: 6vh; width: 92vw; max-height: 78vh; }
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
      background: var(--card-bg); border: 1px solid var(--border-strong);
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
  ["overview", "Overview", "OV"],
  ["snapshot", "Snapshot", "SN"],
  ["activity", "Activity", "AC"],
  ["charts", "Charts", "CH"],
  ["health", "Health", "HE"],
  ["decisions", "Decisions", "DC"],
  ["positions", "Positions", "PO"],
  ["pipeline", "Pipeline", "PL"],
  ["llm", "LLM Calls", "LC"],
  ["backfill", "Backfill", "BF"],
  ["backtest", "Backtest", "BT"],
  ["more", "More", "MR"],
];

// Nav reorg (plan.md "Dashboard: Heavy Polish..." Step 2, 2026-09-22):
// collapses the 12 flat sections above into 5 groups for the desktop rail,
// tablet icon rail and mobile bottom-nav. This is a NAV-LEVEL grouping only
// -- every section keeps its own route/renderer/data fetch, nothing here
// merges page content or data (that's explicitly out of scope for this
// step). A group with one section renders as a plain link (no header); a
// group with several renders a small uppercase header followed by its
// section links. Each multi-section group also gets a landing route (see
// dashboard-worker.js's /dashboard/book, /research, /operations) that 302s
// to its first section, so the group is a single click, not just a label.
// Decided 2026-09-22: old per-section URLs (/dashboard/snapshot etc.) are
// UNCHANGED and keep working exactly as before -- nothing to redirect there,
// since nothing was renamed. Only the new group-landing URLs are additions.
export const NAV_GROUPS = [
  { id: "overview", label: "Overview", sections: ["overview"] },
  { id: "book", label: "Book", sections: ["snapshot", "positions", "charts"] },
  { id: "research", label: "Research", sections: ["decisions", "llm"] },
  { id: "operations", label: "Operations", sections: ["pipeline", "health", "backfill"] },
  { id: "backtest", label: "Backtest", sections: ["backtest"] },
];

// `env` (the resolved environment, "live" by default) is appended to the links
// of env-aware sections only, so a chosen backtest survives flipping between
// snapshot/decisions/positions/... without the operator re-picking it.
const navHref = (id, env) => `/dashboard/${id}${ENV_SECTIONS.includes(id) ? envSuffix(env) : ""}`;

const SECTION_LABEL_BY_ID = Object.fromEntries(NAV_SECTIONS.map(([id, label]) => [id, label]));

function renderNavLink(id, activeSection, env) {
  const active = activeSection === id;
  const icon = ICONS[id] ?? "";
  const label = SECTION_LABEL_BY_ID[id] ?? id;
  return `<a href="${escapeHtml(navHref(id, env))}"${active ? ' class="active"' : ""} data-label="${escapeHtml(label)}"><span class="nav-icon">${icon}</span><span class="nav-label">${escapeHtml(label)}</span></a>`;
}

function renderNav(activeSection, env) {
  const groups = NAV_GROUPS.map((g) => {
    const links = g.sections.map((id) => renderNavLink(id, activeSection, env)).join("");
    if (g.sections.length === 1) return links;
    return `<div class="section-nav-group-label">${escapeHtml(g.label)}</div>${links}`;
  }).join("");
  return `<nav class="section-nav">${groups}</nav>`;
}

// Mobile bottom nav mirrors the 5 desktop nav groups (plan.md Step 2 nav
// reorg, 2026-09-22, see NAV_GROUPS) plus "More" for overflow -- one tap per
// group, landing on that group's first section (the same page its
// /dashboard/<group> redirect targets, see dashboard-worker.js). Derived
// from NAV_GROUPS directly so this can't drift from the desktop nav's
// structure the way the old hand-curated list could.
const MOBILE_NAV_SECTIONS = NAV_GROUPS.map((g) => [g.sections[0], g.label]).concat([["more", "More"]]);

/**
 * "More" sheet overlay (plan.md "Dashboard: Scoped UX Adoption" item 4).
 * Renders the backdrop + slide-up panel that the mobile "More" tab opens
 * in-page, instead of navigating to /dashboard/more. Built from the same
 * NAV_SECTIONS list the desktop rail nav uses (see renderNav above), filtered
 * to the ids NOT already pinned in MOBILE_NAV_SECTIONS -- so this list can
 * never drift out of sync with the desktop nav or the bottom bar. Markup is
 * hidden by default (the `hidden` attribute); the click-handling IIFE near
 * the bottom of renderShell's <script> toggles it via a `data-open`
 * attribute instead of removing `hidden` outright, so CSS can transition it
 * in/out (see the '.mobile-more-sheet' rules under the mobile media query
 * in STYLE).
 */
function renderMobileMoreSheet(activeSection, env) {
  // Overflow = every section not already pinned to a bottom-nav tab (plan.md
  // Step 2 nav reorg, 2026-09-22 -- MOBILE_NAV_SECTIONS is now derived from
  // NAV_GROUPS, one tab per group, so this is computed as whatever's left
  // over rather than hand-maintained, avoiding the two drifting apart).
  const pinnedIds = new Set(MOBILE_NAV_SECTIONS.map(([id]) => id));
  const overflowIds = NAV_SECTIONS.map(([id]) => id).filter((id) => id !== "more" && !pinnedIds.has(id));
  const cards = NAV_SECTIONS.filter(([id]) => overflowIds.includes(id))
    .map(([id, label]) => {
      const active = activeSection === id;
      const icon = ICONS[id] ?? "";
      return `<a href="${escapeHtml(navHref(id, env))}" class="mobile-more-card${active ? " active" : ""}"><span class="nav-icon">${icon}</span><span>${escapeHtml(label)}</span></a>`;
    })
    .join("");
  return `<div class="mobile-more-backdrop" id="mobile-more-backdrop" hidden></div><div class="mobile-more-sheet" id="mobile-more-sheet" role="dialog" aria-modal="true" aria-label="All sections" hidden><div class="mobile-more-sheet-handle"></div><div class="mobile-more-sheet-header"><span class="mobile-more-sheet-title">All sections</span><button type="button" class="mobile-more-sheet-close" id="mobile-more-close" aria-label="Close">&times;</button></div><div class="mobile-more-sheet-grid">${cards}</div></div>`;
}

/**
 * Mobile bottom nav is a curated subset of the most-used sections, with
 * "More" as the overflow -- see MOBILE_NAV_SECTIONS above. The "More" tab
 * (#mobile-more-trigger) keeps a real href to /dashboard/more as a no-JS
 * fallback; the click-intercept + sheet-open logic lives in renderShell's
 * inline script, which only wires up once it confirms #mobile-more-sheet is
 * present in the DOM (see renderMobileMoreSheet above).
 */
function renderBottomNav(activeSection, env) {
  // "More" tab reads as active whenever the current page is one of the
  // overflow sections (same set renderMobileMoreSheet computes) -- kept as
  // its own computation here since this function doesn't call that one.
  const pinnedIds = new Set(MOBILE_NAV_SECTIONS.map(([id]) => id));
  const moreIds = NAV_SECTIONS.map(([id]) => id).filter((id) => id !== "more" && !pinnedIds.has(id));
  const links = MOBILE_NAV_SECTIONS.map(([id, label, n]) => {
    let active = activeSection === id;
    if (id === "more" && moreIds.includes(activeSection)) {
      active = true;
    }
    const icon = ICONS[id] ?? "";
    const moreAttrs = id === "more" ? ` id="mobile-more-trigger" aria-haspopup="dialog" aria-expanded="false"` : "";
    return `<a href="${escapeHtml(navHref(id, env))}"${active ? ' class="active"' : ""}${moreAttrs}><span class="nav-icon">${icon}</span><span>${escapeHtml(label)}</span></a>`;
  }).join("");
  return `<nav class="bottom-nav">${links}</nav>${renderMobileMoreSheet(activeSection, env)}`;
}

/**
 * Theme toggle button, per-browser preference (no D1/session-table change --
 * this repo has no multi-user model, see src/auth/session.js). Both icons are
 * always in the markup; CSS shows whichever one represents what clicking
 * switches TO (sun while dark, moon while light), so no server-side theme
 * knowledge is needed here -- it self-corrects visually via the same
 * data-theme/prefers-color-scheme rules the rest of the page uses.
 * `toggleTheme()` (defined in renderShell's inline script) does the actual
 * flip: sets `data-theme` on <html>, and mirrors the choice to both
 * localStorage and a `theme` cookie so the next SSR render already knows.
 */
function renderThemeToggle() {
  return `<button type="button" class="theme-toggle" onclick="toggleTheme()" aria-label="Toggle light/dark theme" title="Toggle theme"><span class="icon-sun">${ICONS.sun}</span><span class="icon-moon">${ICONS.moon}</span></button>`;
}

/** Icon-button trigger, same shape as renderThemeToggle -- opens the search palette (see renderSearchPalette). One instance goes in the desktop rail, one in the mobile header; both share the `.search-trigger` class the client script binds to. */
function renderSearchTrigger() {
  return `<button type="button" class="theme-toggle search-trigger" aria-label="Search tickers" title="Search tickers (Ctrl/Cmd+K)">${ICONS.search}</button>`;
}

/**
 * Global ticker-search palette (plan.md "Dashboard: Scoped UX Adoption" item 6).
 * Markup only -- rendered once per page (see renderShell), opened by either
 * renderSearchTrigger button or the Ctrl/Cmd+K shortcut, both wired in
 * renderShell's inline script below. The ticker universe is fetched lazily
 * on first open from GET /dashboard/tickers (a thin proxy to backend's
 * GET /api/tickers, data.js#getTickersData -- RunStore#listKnownTickers,
 * DISTINCT ticker across positions/trade_decisions/pipeline_checkpoints for
 * the resolved environment), not embedded server-side, so a page load never
 * pays for a query nobody may use. Selecting a result navigates to
 * /dashboard/llm?llmTicker=<ticker> -- the one existing page that already
 * knows how to filter by ticker (helpers.js#parseLlmParams) -- rather than
 * inventing a new per-ticker page; a dedicated ticker detail view is out of
 * scope for "land the search-by-known-ticker version first" (plan.md).
 */
function renderSearchPalette() {
  return `<div class="search-backdrop" id="search-backdrop" hidden></div><div class="search-palette" id="search-palette" role="dialog" aria-modal="true" aria-label="Search tickers" hidden><div class="search-palette-input-row"><span class="nav-icon">${ICONS.search}</span><input type="text" id="search-input" class="search-palette-input" placeholder="Search tickers\u2026" autocomplete="off" spellcheck="false"><span class="search-palette-kbd">Esc</span></div><div class="search-palette-results" id="search-results"></div></div>`;
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
    <div class="rail-meta">${sessionUsername ? `<span class="rail-meta-row" style="margin:0;display:inline-flex;" title="Logged in as ${escapeHtml(sessionUsername)}"><a href="/logout">${ICONS.logout} log out</a></span>` : ""}${renderSearchTrigger()}${renderThemeToggle()}</div>
  </div>`;
}

/**
 * Per-page toolbar: manual "Refresh" link, auto-refresh toggle (plan.md
 * "Dashboard: Scoped UX Adoption" item 1), and Export CSV/JSON buttons
 * (item 4). Export works off the exact JSON this page's SSR render already
 * fetched -- see renderShell's `exportData` param and the
 * #dashboard-export-data script tag it emits -- so these buttons only do
 * anything once that data has loaded; the client-side script disables them
 * otherwise (missing tag, or a CSV click with no tabular data found).
 * `activeSection` names the downloaded file (e.g. "decisions-2026-09-22.csv").
 */
function renderPageToolbar(refreshHref, activeSection) {
  if (!refreshHref) return "";
  return `<div class="page-toolbar">
        <span class="page-toolbar-updated">Loaded ${fmtTime(new Date().toISOString())}</span>
        <button type="button" class="btn btn-tertiary" id="dashboard-export-csv-btn" data-section="${escapeHtml(activeSection)}" title="Export this page's data as CSV">Export CSV</button>
        <button type="button" class="btn btn-tertiary" id="dashboard-export-json-btn" data-section="${escapeHtml(activeSection)}" title="Export this page's data as JSON">Export JSON</button>
        <button type="button" class="auto-refresh-toggle" id="auto-refresh-toggle" data-on="true" title="Toggle auto-refresh"><span class="auto-refresh-dot"></span><span id="auto-refresh-toggle-label">Auto-refresh on</span></button>
        <a href="${escapeHtml(refreshHref)}" class="btn btn-secondary" title="Reload this page with the latest data"><span aria-hidden="true">\u21bb</span> Refresh</a>
      </div>`;
}

/**
 * `theme`: "light" | "dark" | undefined, resolved server-side by
 * dashboard-worker.js from the `theme` cookie (see getThemeCookie there).
 * undefined means no explicit choice yet -- `data-theme` is omitted so
 * `prefers-color-scheme` decides, same as a first-ever visit. Passing a
 * known value here (rather than always defaulting to one theme) is what
 * avoids a flash of the wrong theme on first paint once the operator has
 * toggled at least once.
 */
export function renderShell({ activeSection, sessionUsername, bodyHtml, refreshHref, env = "live", theme, exportData }) {
  const themeAttr = theme === "light" || theme === "dark" ? ` data-theme="${theme}"` : "";
  const themeColorMeta =
    theme === "light"
      ? `<meta name="theme-color" content="#f6f8fb">`
      : theme === "dark"
        ? `<meta name="theme-color" content="#14171f">`
        : `<meta name="theme-color" content="#f6f8fb" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#14171f" media="(prefers-color-scheme: dark)">`;
  return `<!DOCTYPE html>
<html lang="en"${themeAttr}>
<head>
<meta charset="UTF-8">
<script>
  // Runs before the stylesheet, so a theme picked on an earlier visit (stored
  // in localStorage) can win over a stale/missing server-rendered data-theme
  // attribute before first paint -- e.g. if the cookie got cleared but
  // localStorage didn't. If they agree (the common case, since toggleTheme
  // below always writes both together) this is a no-op.
  (function () {
    try {
      var stored = localStorage.getItem("theme");
      if (stored === "light" || stored === "dark") document.documentElement.setAttribute("data-theme", stored);
    } catch (e) {}
  })();
</script>
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
${themeColorMeta}
<title>news-market-ai dashboard (${escapeHtml(activeSection)})</title>
<script>window.__DASHBOARD_ENV__ = ${JSON.stringify(env)};</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;0,9..144,600;0,9..144,700;1,9..144,500;1,9..144,600&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>${STYLE}</style>
<script>
  function setDateRange(fromId, toId, days) {
    const to = new Date();
    const from = new Date(Date.now() - days * 86400000);
    document.getElementById(toId).value = to.toISOString().slice(0, 10);
    document.getElementById(fromId).value = from.toISOString().slice(0, 10);
  }

  // Explicit theme toggle (wired to the button(s) from renderThemeToggle).
  // Persists to BOTH localStorage (read by the early script above, on this
  // browser only) and a 'theme' cookie (read server-side by
  // dashboard-worker.js's getThemeCookie, so the next full page load already
  // renders the right data-theme attribute -- no flash).
  function currentTheme() {
    var attr = document.documentElement.getAttribute("data-theme");
    if (attr === "light" || attr === "dark") return attr;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  function toggleTheme() {
    var next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("theme", next); } catch (e) {}
    document.cookie = "theme=" + next + "; path=/; max-age=31536000; SameSite=Lax";
  }

  // ---- Auto-refresh (plan.md "Dashboard: Scoped UX Adoption" item 1) ----
  // Re-fetches this exact page's own URL on an interval and swaps in the
  // freshly-rendered #dashboard-main content, so the SAME server-side
  // template-string renderers (src/dashboard/views/*.js, reached via
  // dashboard-worker.js's renderSection) that built the page on first load
  // build every refresh too -- no renderer logic is duplicated client-side,
  // and no new backend route is needed (this is the exact request a manual
  // click of "Refresh" already makes).
  //
  // Only wired up when both #dashboard-main and the toggle button exist --
  // i.e. section-view pages that pass refreshHref (see renderPageToolbar).
  // Confirm pages, /dashboard/more, and the llm/backtest-detail permalinks
  // render neither and get no auto-refresh.
  //
  // Paused while the tab is hidden (visibilitychange) to avoid burning
  // background D1 reads against the free-tier budget (plan.md "Free-plan
  // budgets"), and paused on any tick where a #active-job progress panel is
  // present (src/dashboard/views/status.js) -- that panel already polls
  // itself every 1.5s via DOM references captured at parse time, and an
  // innerHTML swap here would detach those references mid-poll and freeze
  // the bar. That job's own poller calls location.reload() on completion,
  // which naturally resumes normal auto-refresh afterward.
  //
  // KNOWN LIMITATION: swapping #dashboard-main's innerHTML discards any
  // in-progress, not-yet-submitted state inside it -- an open <details> (LLM
  // answer disclosure), a half-filled filter-form, exact scroll position on
  // a very different-height page. Acceptable for a first cut; revisit if it
  // proves annoying in practice.
  (function () {
    var INTERVAL_MS = 30000;
    var main = document.getElementById("dashboard-main");
    var toggle = document.getElementById("auto-refresh-toggle");
    var toggleLabel = document.getElementById("auto-refresh-toggle-label");
    if (!main || !toggle) return;

    var STORAGE_KEY = "autoRefreshOn";
    var on = true;
    try {
      if (localStorage.getItem(STORAGE_KEY) === "false") on = false;
    } catch (e) {}

    var timer = null;
    var inFlight = false;

    function setToggleUi() {
      toggle.setAttribute("data-on", String(on));
      if (toggleLabel) toggleLabel.textContent = on ? "Auto-refresh on" : "Auto-refresh off";
    }

    function schedule() {
      if (timer) clearTimeout(timer);
      timer = null;
      if (!on || document.visibilityState === "hidden") return;
      timer = setTimeout(tick, INTERVAL_MS);
    }

    function tick() {
      if (!on || document.visibilityState === "hidden" || inFlight || document.getElementById("active-job")) {
        schedule();
        return;
      }
      inFlight = true;
      fetch(window.location.href, { credentials: "same-origin" })
        .then(function (res) {
          if (!res.ok) throw new Error("status " + res.status);
          return res.text();
        })
        .then(function (html) {
          var doc = new DOMParser().parseFromString(html, "text/html");
          var freshMain = doc.getElementById("dashboard-main");
          if (freshMain) main.innerHTML = freshMain.innerHTML;
          var freshStamp = doc.querySelector(".page-toolbar-updated");
          var stamp = document.querySelector(".page-toolbar-updated");
          if (freshStamp && stamp) stamp.textContent = freshStamp.textContent;
        })
        .catch(function () {
          // A transient failure just tries again next tick -- never show a
          // scary error over a momentary network blip, same rule
          // status.js's job poller (above) follows.
        })
        .then(function () {
          inFlight = false;
          schedule();
        });
    }

    toggle.addEventListener("click", function () {
      on = !on;
      try { localStorage.setItem(STORAGE_KEY, String(on)); } catch (e) {}
      setToggleUi();
      schedule();
    });

    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") schedule();
      else if (timer) { clearTimeout(timer); timer = null; }
    });

    setToggleUi();
    schedule();
  })();

  // ---- CSV/JSON export (plan.md "Dashboard: Scoped UX Adoption" item 4) ----
  // Reads the JSON this page's SSR render already fetched from backend's
  // /api/* route, embedded server-side into #dashboard-export-data (see
  // dashboard-worker.js#renderSection's 'exportData' -- exactly the 'data'
  // object each render*View already consumed, not a second fetch). No new
  // backend route, no server-side file generation.
  (function () {
    var csvBtn = document.getElementById("dashboard-export-csv-btn");
    var jsonBtn = document.getElementById("dashboard-export-json-btn");
    if (!csvBtn && !jsonBtn) return;

    var section = (csvBtn || jsonBtn).getAttribute("data-section") || "dashboard";
    var dataEl = document.getElementById("dashboard-export-data");
    var data = null;
    if (dataEl) {
      try { data = JSON.parse(dataEl.textContent); } catch (e) {}
    }

    function isPlainObjArray(v) {
      return Array.isArray(v) && v.length > 0 && v.every(function (x) { return x && typeof x === "object" && !Array.isArray(x); });
    }

    // One level deep only, by design: covers every current section shape
    // (a top-level array like decisions.decisions/pipeline.checkpoints, or a
    // top-level object holding one like snapshot.openPositions +
    // .closedPositions). A dict-of-arrays keyed by something other than a
    // row's own field (charts' priceBarsByTicker, keyed by ticker) is
    // deliberately NOT picked up here -- it isn't row-shaped, so CSV export
    // just reports "nothing to export" and JSON export still has the raw data.
    function collectTables(obj) {
      var tables = [];
      if (!obj || typeof obj !== "object") return tables;
      Object.keys(obj).forEach(function (key) {
        var val = obj[key];
        if (isPlainObjArray(val)) { tables.push({ name: key, rows: val }); return; }
        if (val && typeof val === "object" && !Array.isArray(val)) {
          Object.keys(val).forEach(function (subKey) {
            var subVal = val[subKey];
            if (isPlainObjArray(subVal)) tables.push({ name: key + "." + subKey, rows: subVal });
          });
        }
      });
      return tables;
    }

    function csvCell(v) {
      var s = v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }

    // Multiple tables (e.g. openPositions + closedPositions) are unioned into
    // one CSV with a leading _table column rather than one file per table --
    // keeps this a single-click download instead of needing a picker UI.
    function tablesToCsv(tables) {
      var multi = tables.length > 1;
      var columns = [];
      var seen = {};
      if (multi) { columns.push("_table"); seen._table = true; }
      tables.forEach(function (t) {
        t.rows.forEach(function (row) {
          Object.keys(row).forEach(function (k) {
            if (!seen[k]) { seen[k] = true; columns.push(k); }
          });
        });
      });
      var lines = [columns.map(csvCell).join(",")];
      tables.forEach(function (t) {
        t.rows.forEach(function (row) {
          lines.push(columns.map(function (col) { return csvCell(col === "_table" ? t.name : row[col]); }).join(","));
        });
      });
      return lines.join("\r\n");
    }

    function download(filename, content, mime) {
      var blob = new Blob([content], { type: mime });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }

    var todayStamp = new Date().toISOString().slice(0, 10);

    if (!data) {
      if (csvBtn) { csvBtn.disabled = true; csvBtn.title = "No data loaded to export yet"; }
      if (jsonBtn) { jsonBtn.disabled = true; jsonBtn.title = "No data loaded to export yet"; }
      return;
    }

    if (jsonBtn) {
      jsonBtn.addEventListener("click", function () {
        download(section + "-" + todayStamp + ".json", JSON.stringify(data, null, 2), "application/json;charset=utf-8");
      });
    }

    if (csvBtn) {
      var tables = collectTables(data);
      if (tables.length === 0) {
        csvBtn.disabled = true;
        csvBtn.title = "No tabular data on this page to export as CSV";
      } else {
        csvBtn.addEventListener("click", function () {
          download(section + "-" + todayStamp + ".csv", tablesToCsv(tables), "text/csv;charset=utf-8");
        });
      }
    }
  })();

  // ---- Mobile "More" bottom sheet (plan.md "Dashboard: Scoped UX Adoption" item 4) ----
  // Intercepts a click on the mobile bottom nav's "More" tab and opens the
  // in-page sheet (renderMobileMoreSheet's markup) instead of letting the
  // browser navigate to the tab's real href ('/dashboard/more' -- kept as a
  // no-JS fallback, see renderBottomNav). Only wires up once every element it
  // needs is confirmed present, so a page that somehow renders without the
  // sheet markup just falls back to the plain link with no JS error.
  (function () {
    var trigger = document.getElementById("mobile-more-trigger");
    var sheet = document.getElementById("mobile-more-sheet");
    var backdrop = document.getElementById("mobile-more-backdrop");
    var closeBtn = document.getElementById("mobile-more-close");
    if (!trigger || !sheet || !backdrop || !closeBtn) return;

    var isOpen = false;

    function focusables() {
      return sheet.querySelectorAll('a[href], button:not([disabled])');
    }

    function open() {
      if (isOpen) return;
      isOpen = true;
      sheet.hidden = false;
      backdrop.hidden = false;
      // Two rAFs so the browser paints the 'hidden' removal first, then the
      // data-open transition actually animates instead of jumping straight
      // to its end state.
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          sheet.setAttribute("data-open", "true");
          backdrop.setAttribute("data-open", "true");
        });
      });
      trigger.setAttribute("aria-expanded", "true");
      document.body.style.overflow = "hidden";
      var first = focusables()[0];
      if (first) first.focus();
      document.addEventListener("keydown", onKeydown);
    }

    function close() {
      if (!isOpen) return;
      isOpen = false;
      sheet.removeAttribute("data-open");
      backdrop.removeAttribute("data-open");
      trigger.setAttribute("aria-expanded", "false");
      document.body.style.overflow = "";
      document.removeEventListener("keydown", onKeydown);
      // Wait for the CSS transition (see '.mobile-more-sheet's 220ms rule in
      // STYLE) before re-adding 'hidden', so it slides down instead of
      // vanishing instantly.
      setTimeout(function () {
        if (!isOpen) { sheet.hidden = true; backdrop.hidden = true; }
      }, 240);
      trigger.focus();
    }

    function onKeydown(e) {
      if (e.key === "Escape") { close(); return; }
      if (e.key !== "Tab") return;
      // Minimal focus trap: wrap Tab/Shift+Tab between the sheet's first and
      // last focusable elements while open.
      var items = focusables();
      if (!items.length) return;
      var first = items[0];
      var last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
      }
    }

    trigger.addEventListener("click", function (e) {
      e.preventDefault();
      if (isOpen) { close(); } else { open(); }
    });
    closeBtn.addEventListener("click", close);
    backdrop.addEventListener("click", close);
  })();

  // ---- Ticker search palette (plan.md "Dashboard: Scoped UX Adoption" item 6) ----
  // Opened by any .search-trigger button (desktop rail + mobile header, see
  // renderSearchTrigger) or Ctrl/Cmd+K from anywhere on the page. The ticker
  // universe is fetched once per page load, lazily on first open, from
  // GET /dashboard/tickers (proxies backend's GET /api/tickers --
  // data.js#getTickersData); typing filters the cached list client-side, no
  // per-keystroke request. Selecting a result (click or Enter) navigates to
  // /dashboard/llm?llmTicker=<ticker> -- see renderSearchPalette's own header
  // for why that page and not a new one. Same backdrop/panel open-close
  // choreography as the mobile More sheet above (two rAFs so the transition
  // actually animates, 'hidden' re-added only after the CSS transition ends).
  (function () {
    var triggers = document.querySelectorAll(".search-trigger");
    var backdrop = document.getElementById("search-backdrop");
    var palette = document.getElementById("search-palette");
    var input = document.getElementById("search-input");
    var results = document.getElementById("search-results");
    if (!triggers.length || !backdrop || !palette || !input || !results) return;

    var tickers = null; // null = not yet loaded
    var loading = false;
    var isOpen = false;

    function tickerHref(ticker) {
      var env = window.__DASHBOARD_ENV__ || "live";
      var qs = "llmTicker=" + encodeURIComponent(ticker);
      if (env && env !== "live") qs += "&env=" + encodeURIComponent(env);
      return "/dashboard/llm?" + qs;
    }

    function setActive(items, index) {
      for (var i = 0; i < items.length; i++) items[i].classList.toggle("active", i === index);
      if (index >= 0 && items[index]) items[index].scrollIntoView({ block: "nearest" });
    }

    function render(list) {
      if (list.length === 0) {
        results.innerHTML = '<div class="search-empty">' + (tickers === null ? "Loading tickers\u2026" : "No matching tickers") + "</div>";
        return;
      }
      results.innerHTML = list
        .map(function (t, i) {
          return '<a href="' + tickerHref(t) + '" class="search-result' + (i === 0 ? " active" : "") + '">' + t + "</a>";
        })
        .join("");
    }

    function filterAndRender() {
      var q = input.value.trim().toUpperCase();
      if (tickers === null) { render([]); return; }
      var list = q ? tickers.filter(function (t) { return t.indexOf(q) !== -1; }) : tickers;
      render(list.slice(0, 50));
    }

    function loadTickers() {
      if (tickers !== null || loading) return;
      loading = true;
      var env = window.__DASHBOARD_ENV__ || "live";
      var qs = env && env !== "live" ? "?env=" + encodeURIComponent(env) : "";
      fetch("/dashboard/tickers" + qs, { credentials: "same-origin" })
        .then(function (res) { return res.ok ? res.json() : { tickers: [] }; })
        .then(function (data) { tickers = data.tickers || []; })
        .catch(function () { tickers = []; })
        .then(function () { loading = false; filterAndRender(); });
    }

    function open() {
      if (isOpen) return;
      isOpen = true;
      palette.hidden = false;
      backdrop.hidden = false;
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          palette.setAttribute("data-open", "true");
          backdrop.setAttribute("data-open", "true");
        });
      });
      document.body.style.overflow = "hidden";
      input.value = "";
      filterAndRender();
      loadTickers();
      input.focus();
      document.addEventListener("keydown", onKeydown);
    }

    function close() {
      if (!isOpen) return;
      isOpen = false;
      palette.removeAttribute("data-open");
      backdrop.removeAttribute("data-open");
      document.body.style.overflow = "";
      document.removeEventListener("keydown", onKeydown);
      setTimeout(function () {
        if (!isOpen) { palette.hidden = true; backdrop.hidden = true; }
      }, 200);
    }

    function onKeydown(e) {
      if (e.key === "Escape") { close(); return; }
      var items = results.querySelectorAll(".search-result");
      var current = -1;
      for (var i = 0; i < items.length; i++) if (items[i].classList.contains("active")) current = i;
      if (e.key === "ArrowDown") {
        if (!items.length) return;
        e.preventDefault();
        setActive(items, Math.min(current + 1, items.length - 1));
      } else if (e.key === "ArrowUp") {
        if (!items.length) return;
        e.preventDefault();
        setActive(items, Math.max(current - 1, 0));
      } else if (e.key === "Enter") {
        if (current >= 0 && items[current]) { window.location.href = items[current].getAttribute("href"); }
      }
    }

    document.addEventListener("keydown", function (e) {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        if (isOpen) { close(); } else { open(); }
      }
    });

    for (var t = 0; t < triggers.length; t++) triggers[t].addEventListener("click", open);
    backdrop.addEventListener("click", close);
    input.addEventListener("input", filterAndRender);
  })();
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
      ${renderNav(activeSection, env)}
      <div class="rail-meta">generated ${fmtTime(new Date().toISOString())}<br>architecture &amp; known gaps in plan.md${sessionUsername ? `<div class="rail-meta-row">logged in as ${escapeHtml(sessionUsername)} &middot; ${ICONS.logout}<a href="/logout">log out</a></div>` : ""}<div class="rail-meta-row">search ${renderSearchTrigger()}</div><div class="rail-meta-row">theme ${renderThemeToggle()}</div></div>
    </aside>
    <div class="content">
      <main id="dashboard-main">
      ${renderPageToolbar(refreshHref, activeSection)}
      ${bodyHtml}
      </main>
    </div>
  </div>
  ${renderBottomNav(activeSection, env)}
  ${renderSearchPalette()}
  ${exportData !== undefined ? `<script type="application/json" id="dashboard-export-data">${JSON.stringify(exportData).replace(/<\/script/gi, "<\\/script")}</script>` : ""}
</body>
</html>`;
}
