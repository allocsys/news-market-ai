import { escapeHtml } from "../helpers.js";
import { tickerChecklist } from "../ticker_picker.js";
import { PAUSE_KEYS, PAUSE_LABELS } from "../../storage/pause_flags.js";

// What each switch stops. Kept next to the view so the page states exactly
// what a switch does (and what it never touches).
const PAUSE_DESCRIPTIONS = {
  ingestion: "Live news, price and fundamentals fetching (the */15 fan-out and its queue consumers).",
  trading: "Exit checks and the analyze/decision pipeline. News stored while paused is not analyzed later.",
  llm: "Every Gemini-calling path (analyze, exit checks) and new backtest runs.",
  backtests: "Starting new backtest runs. Runs already in flight finish.",
};

// Resume prompts for the switches whose restart places trades or spends model quota. Static text, no apostrophes (it sits inside an onsubmit attribute).
const RESUME_CONFIRM = {
  trading: "Resume trading? Exit checks and the analyze/decision pipeline start running again.",
  llm: "Resume LLM calls? Every Gemini-calling path and new backtest runs start again and spend model quota.",
};
const RESUME_ALL_CONFIRM = "Resume everything? Ingestion, trading, LLM calls and backtests all start again.";

/** Banner shown on every dashboard page while any switch is on. "" when nothing is paused. */
export function renderPausedBanner(flags) {
  const on = PAUSE_KEYS.filter((k) => flags?.[k]);
  if (on.length === 0) return "";
  const names = on.map((k) => escapeHtml(PAUSE_LABELS[k])).join(", ");
  return `<div class="paused-banner" role="status"><strong>PAUSED:</strong> ${names}. <a href="/dashboard/controls">Manage switches</a></div>
  <style>
    .paused-banner { background: var(--bg-elevated); border: 1px solid var(--border-strong); border-left: 4px solid var(--color-warning-strong); border-radius: var(--radius-sm); padding: 0.6rem 0.9rem; margin-bottom: 1rem; font-size: 0.875rem; color: var(--text-main); }
    .paused-banner a { color: var(--accent-bright); margin-left: 0.4rem; }
    @media (max-width: 767px) {
      .paused-banner { padding: 0.4rem 0.65rem; margin-bottom: 0.5rem; font-size: 0.75rem; line-height: 1.35; }
    }
  </style>`;
}

function switchForm(key, paused) {
  // Pausing stays one tap (it is the kill switch). Resuming the paths that spend money or place trades asks first.
  const resumeMsg = paused ? RESUME_CONFIRM[key] : undefined;
  const onsubmit = resumeMsg ? ` onsubmit="return confirm('${resumeMsg}');"` : "";
  return `<form method="POST" action="/controls/set" class="pause-form"${onsubmit}>
      <input type="hidden" name="key" value="${escapeHtml(key)}" />
      <input type="hidden" name="paused" value="${paused ? "0" : "1"}" />
      <button type="submit" class="pause-btn ${paused ? "is-paused" : "is-running"}">${paused ? "Resume" : "Pause"}</button>
    </form>`;
}

/**
 * "Live tickers" card: tick the tickers the live pipeline (ingestion + analysis) runs for. `selection` is
 * backend's GET /api/active-tickers body (`{ watchlist, active, disabled, meta, error }`); "" without a
 * watchlist (a failed lookup must not break the page). Backtests are not affected by this.
 */
function renderTickerSelection(selection) {
  const watchlist = Array.isArray(selection?.watchlist) ? selection.watchlist : [];
  if (watchlist.length === 0) return "";
  const active = Array.isArray(selection.active) ? selection.active : watchlist;
  const off = watchlist.filter((t) => !active.includes(t));
  const errorNote = selection.error ? `<p class="note">Could not read the ticker selection (${escapeHtml(selection.error)}); showing every ticker as active.</p>` : "";
  const state = off.length === 0 ? "All tickers are active." : `Active: ${escapeHtml(active.join(", ") || "none")}. Off: ${escapeHtml(off.join(", "))}.`;
  const countText = `${active.length} of ${watchlist.length} active`;
  return `<details class="sw-exp"${off.length > 0 ? " open" : ""}>
    <summary><span id="liveTickersTitle">Live tickers</span><span class="sw-exp-sub">${countText}</span></summary>
    <div class="sw-exp-body">
    <p class="note">Which tickers the live pipeline fetches and analyzes. Open positions and pending entries keep being managed, and backtests are not affected.</p>
    ${errorNote}
    <div class="sw-tickers">
      <div class="pause-desc" style="margin:0">${state}</div>
      <form method="POST" action="/controls/tickers" style="display:flex;flex-direction:column;gap:0.75rem;width:100%">
        ${tickerChecklist({ name: "tickers", idPrefix: "live-ticker", options: watchlist, selected: active, labelId: "liveTickersTitle" })}
        <div><button type="submit" class="pause-btn is-running">Save selection</button></div>
      </form>
      ${off.length > 0 ? `<form method="POST" action="/controls/tickers"><input type="hidden" name="tickers" value="all" /><button type="submit" class="pause-btn">Select all</button></form>` : ""}
    </div>
    </div>
  </details>`;
}

/** `data` is backend's GET /api/controls body: `{ flags, meta, error }`; `tickerSelection` is GET /api/active-tickers (null when unavailable). */
export function renderControlsView({ flags = {}, meta = {}, error = null, tickerSelection = null } = {}) {
  const rows = PAUSE_KEYS.map((key) => {
    const paused = flags[key] === true;
    const m = meta[key];
    const changed = m?.updatedAt ? `<div class="pause-meta">Last changed ${escapeHtml(m.updatedAt)}${m.updatedBy ? ` by ${escapeHtml(m.updatedBy)}` : ""}</div>` : "";
    return `<div class="pause-row">
      <div class="pause-text">
        <div class="pause-title">${escapeHtml(PAUSE_LABELS[key])} <span class="pause-state ${paused ? "is-paused" : "is-running"}">${paused ? "PAUSED" : "Running"}</span></div>
        <div class="pause-desc">${escapeHtml(PAUSE_DESCRIPTIONS[key])}</div>
        ${changed}
      </div>
      ${switchForm(key, paused)}
    </div>`;
  }).join("\n");

  const anyPaused = PAUSE_KEYS.some((k) => flags[k] === true);
  const allPaused = PAUSE_KEYS.every((k) => flags[k] === true);
  const masterForms = `<div class="pause-master">
      ${allPaused ? "" : `<form method="POST" action="/controls/set"><input type="hidden" name="key" value="all" /><input type="hidden" name="paused" value="1" /><button type="submit" class="pause-btn is-running">Pause all</button></form>`}
      ${anyPaused ? `<form method="POST" action="/controls/set" onsubmit="return confirm('${RESUME_ALL_CONFIRM}');"><input type="hidden" name="key" value="all" /><input type="hidden" name="paused" value="0" /><button type="submit" class="pause-btn is-paused">Resume all</button></form>` : ""}
    </div>`;

  const errorNote = error ? `<p class="note">Could not read the switches (${escapeHtml(error)}); showing everything as running.</p>` : "";
  const pausedCount = PAUSE_KEYS.filter((k) => flags[k] === true).length;
  const statusLine = `<div class="sw-status ${pausedCount > 0 ? "is-paused" : "is-running"}" role="status">${pausedCount === 0 ? "Everything is running" : `${pausedCount} of ${PAUSE_KEYS.length} paused`}</div>`;

  return `<section id="controls">
    <h2>Pause switches</h2>
    <p class="note">Independent kill switches to free headroom. The intraday backfill, the retention purge and manual backfills are never paused.</p>
    ${errorNote}
    ${statusLine}
    <div class="pause-list">${rows}</div>
    ${masterForms}
    ${renderTickerSelection(tickerSelection)}
    <style>
      .sw-status { display:inline-flex; align-items:center; min-height:32px; padding:0 0.8rem; margin:0.25rem 0 0.9rem; border-radius:999px; border:1px solid var(--border-color); background:var(--bg-elevated); font-size:0.8125rem; font-weight:600; }
      .sw-status.is-running { color:var(--color-success-text); }
      .sw-status.is-paused { color:var(--color-warning-text); border-color:var(--color-warning-strong); }
      .pause-master { display:flex; gap:0.6rem; margin:1rem 0 1.25rem; flex-wrap:wrap; }
      .pause-master form { flex:1 1 0; min-width:9rem; }
      .pause-master .pause-btn { width:100%; }
      .pause-list { display:flex; flex-direction:column; gap:0.75rem; }
      .pause-row { display:flex; align-items:center; justify-content:space-between; gap:1rem; padding:1rem 1.1rem; background:var(--bg-surface); border:1px solid var(--border-color); border-radius:var(--radius-md); }
      @media (max-width: 767px) {
        .pause-row { flex-direction:column; align-items:stretch; gap:0.75rem; }
        .pause-row .pause-form, .pause-row .pause-btn { width:100%; }
      }
      .pause-text { min-width:0; }
      .pause-title { font-family:var(--font-display); font-weight:600; color:var(--text-main); }
      .pause-desc, .pause-meta { font-size:0.75rem; color:var(--text-muted); line-height:1.5; margin-top:0.2rem; }
      .pause-state { font-size:0.6875rem; font-weight:700; letter-spacing:0.05em; margin-left:0.4rem; }
      .pause-state.is-paused { color:var(--color-warning-text); }
      .pause-state.is-running { color:var(--text-subtle); }
      .pause-btn { min-height:48px; padding:0 1.1rem; border-radius:var(--radius-sm); border:1px solid var(--border-strong); background:var(--bg-elevated); color:var(--text-main); font-weight:600; cursor:pointer; }
      .pause-btn.is-paused { border-color:var(--color-warning-strong); }
      .pause-btn:hover { background:var(--bg-hover); }
      .pause-btn:focus-visible { outline:2px solid var(--focus-ring); outline-offset:2px; }
      details.sw-exp { margin-top:1.25rem; }
      details.sw-exp > summary { display:flex; align-items:center; justify-content:space-between; gap:0.75rem; min-height:48px; padding:0 1rem; background:var(--bg-surface); border:1px solid var(--border-color); border-radius:var(--radius-md); cursor:pointer; font-weight:600; list-style:none; user-select:none; }
      details.sw-exp > summary::-webkit-details-marker { display:none; }
      details.sw-exp[open] > summary { border-radius:var(--radius-md) var(--radius-md) 0 0; }
      .sw-exp-sub { font-size:0.8125rem; font-weight:400; color:var(--text-muted); }
      .sw-exp-body { padding:1rem; background:var(--bg-surface); border:1px solid var(--border-color); border-top:none; border-radius:0 0 var(--radius-md) var(--radius-md); }
      .sw-tickers { display:flex; flex-direction:column; align-items:flex-start; gap:0.75rem; }
    </style>
  </section>`;
}
