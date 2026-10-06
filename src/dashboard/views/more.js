import { escapeHtml } from "../helpers.js";

// Inline SVG icons for the More page's rows. Same Lucide-style stroke icons
// the nav uses, kept here so this page can render without re-importing the shell.
const svg = (inner, size = 22) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

const MORE_ICONS = {
  controls: svg(`<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>`),
  llm: svg(`<path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 9h8"/><path d="M8 13h5"/>`),
  backfill: svg(`<path d="M12 13V3"/><path d="m7 8 5-5 5 5"/><path d="M5 21h14a2 2 0 0 0 2-2v-4"/><path d="M3 15h4"/><path d="M3 19h4"/>`),
  backtest: svg(`<path d="M9 3h6"/><path d="M10 3v6.5L5 19a2 2 0 0 0 1.8 3h10.4A2 2 0 0 0 19 19l-5-9.5V3"/><path d="M7 15h10"/>`),
};
const CHEVRON = svg(`<path d="m9 18 6-6-6-6"/>`, 18);

// Grouped so the phone list reads as three short blocks. Activity lives in Signals and Charts in Book, so they are not repeated here.
const MORE_GROUPS = [
  {
    title: "Operate",
    items: [{ id: "controls", title: "Pause switches", desc: "Pause ingestion, trading, LLM calls or backtests.", icon: MORE_ICONS.controls }],
  },
  {
    title: "Research",
    items: [
      { id: "llm", title: "LLM calls", desc: "Every Gemini prompt and response (live only).", icon: MORE_ICONS.llm },
    ],
  },
  {
    title: "Backtest & data",
    items: [
      { id: "backtest", title: "Backtest", desc: "Manual run: strategy vs buy & hold.", icon: MORE_ICONS.backtest },
      { id: "backfill", title: "Backfill", desc: "Historical news backfill (Finnhub).", icon: MORE_ICONS.backfill },
    ],
  },
];

export function renderMoreView() {
  const groups = MORE_GROUPS.map((g) => {
    const rows = g.items
      .map(
        (s) => `<a href="/dashboard/${s.id}" class="more-row">
        <span class="more-row-icon">${s.icon}</span>
        <span class="more-row-text">
          <span class="more-row-title">${escapeHtml(s.title)}</span>
          <span class="more-row-desc">${escapeHtml(s.desc)}</span>
        </span>
        <span class="more-row-chevron">${CHEVRON}</span>
      </a>`
      )
      .join("\n");
    return `<div class="more-group">
      <h3 class="more-group-title">${escapeHtml(g.title)}</h3>
      <div class="more-list">${rows}</div>
    </div>`;
  }).join("\n");

  return `<section id="more">
    <h2>More</h2>
    ${groups}
    <style>
      .more-group { margin-bottom: 1.25rem; }
      .more-group-title { margin: 0 0 0.5rem; padding: 0 0.25rem; font-size: 0.75rem; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-subtle); }
      .more-list { display: grid; grid-template-columns: 1fr; gap: 0.5rem; }
      @media (min-width: 768px) { .more-list { grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); } }
      .more-row {
        display: flex; align-items: center; gap: 0.75rem;
        min-height: 64px; padding: 0.75rem 1rem;
        background: var(--bg-surface);
        border: 1px solid var(--border-color);
        border-radius: var(--radius-md);
        text-decoration: none; color: var(--text-main);
        transition: border-color 200ms ease, background 200ms ease;
      }
      .more-row:hover { border-color: var(--border-strong); background: var(--bg-hover); }
      .more-row:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
      .more-row-icon {
        width: 40px; height: 40px; flex-shrink: 0;
        display: inline-flex; align-items: center; justify-content: center;
        background: var(--bg-elevated); color: var(--accent-bright);
        border: 1px solid var(--border-color);
        border-radius: var(--radius-sm);
      }
      .more-row-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.15rem; }
      .more-row-title { font-weight: 600; font-size: 1rem; color: var(--text-main); }
      .more-row-desc { font-size: 0.8125rem; color: var(--text-muted); line-height: 1.4; }
      .more-row-chevron { flex-shrink: 0; color: var(--text-subtle); display: inline-flex; }
    </style>
  </section>`;
}
