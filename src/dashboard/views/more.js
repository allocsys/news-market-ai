import { escapeHtml } from "../helpers.js";

// Inline SVG icons for the More page's section cards. Same Lucide-style
// 20x20 stroke icons the sidebar uses, kept here so this page can render
// a richer card per section without re-importing the shell.
const MORE_ICONS = {
  activity: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3v16a2 2 0 0 0 2 2h16"/><rect x="7" y="11" width="3" height="6" rx="0.5"/><rect x="12" y="7" width="3" height="10" rx="0.5"/><rect x="17" y="13" width="3" height="4" rx="0.5"/></svg>`,
  charts: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3v18h18"/><path d="m7 14 3-4 3 3 4-6"/></svg>`,
  llm: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 9h8"/><path d="M8 13h5"/></svg>`,
  backfill: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 13V3"/><path d="m7 8 5-5 5 5"/><path d="M5 21h14a2 2 0 0 0 2-2v-4"/><path d="M3 15h4"/><path d="M3 19h4"/></svg>`,
  backtest: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 3h6"/><path d="M10 3v6.5L5 19a2 2 0 0 0 1.8 3h10.4A2 2 0 0 0 19 19l-5-9.5V3"/><path d="M7 15h10"/></svg>`,
};

const MORE_SECTIONS = [
  { id: "activity", title: "Activity", desc: "Trade decisions per UTC calendar day, stacked by status.", icon: MORE_ICONS.activity },
  { id: "charts", title: "Charts", desc: "Recent daily closes (unadjusted) for watchlist tickers.", icon: MORE_ICONS.charts },
  { id: "llm", title: "LLM calls", desc: "Every prompt sent to Gemini and what came back -- live pipeline and backtests.", icon: MORE_ICONS.llm },
  { id: "backfill", title: "Backfill", desc: "Triggers historical news backfill (Finnhub company-news).", icon: MORE_ICONS.backfill },
  { id: "backtest", title: "Backtest", desc: "Manual backtest harness (Signal ON vs buy & hold).", icon: MORE_ICONS.backtest },
];

export function renderMoreView() {
  const cards = MORE_SECTIONS.map((s) => `<a href="/dashboard/${s.id}" class="more-card">
      <div class="more-card-icon">${s.icon}</div>
      <div class="more-card-text">
        <div class="more-card-title">${escapeHtml(s.title)}</div>
        <div class="more-card-desc">${escapeHtml(s.desc)}</div>
      </div>
    </a>`).join("\n");
  return `<section id="more">
    <h2>More views &amp; actions</h2>
    <p class="note">Additional operational sections and administrative actions not pinned to the mobile bottom nav.</p>
    <div class="more-grid">${cards}</div>
    <style>
      .more-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(260px, 1fr)); gap:1rem; }
      .more-card {
        display:flex; align-items:flex-start; gap:0.85rem;
        padding:1.1rem 1.25rem;
        background: var(--bg-surface);
        border: 1px solid var(--border-color);
        border-radius: var(--radius-md);
        text-decoration: none; color: var(--text-main);
        transition: border-color 200ms ease, transform 200ms ease, background 200ms ease;
      }
      .more-card:hover { border-color: var(--border-strong); transform: translateY(-1px); background: var(--bg-hover); }
      .more-card:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
      .more-card-icon {
        width: 40px; height: 40px; flex-shrink: 0;
        display: inline-flex; align-items: center; justify-content: center;
        background: var(--bg-elevated); color: var(--accent-bright);
        border: 1px solid var(--border-color);
        border-radius: var(--radius-sm);
      }
      .more-card-text { min-width: 0; }
      .more-card-title {
        font-family: var(--font-display); font-weight: 600; font-size: 0.9375rem;
        color: var(--text-main); margin-bottom: 0.25rem;
      }
      .more-card-desc {
        font-size: 0.75rem; color: var(--text-muted); line-height: 1.5;
      }
    </style>
  </section>`;
}
