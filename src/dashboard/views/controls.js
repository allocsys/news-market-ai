import { escapeHtml } from "../helpers.js";
import { PAUSE_KEYS, PAUSE_LABELS } from "../../storage/pause_flags.js";

// What each switch stops. Kept next to the view so the page states exactly
// what a switch does (and what it never touches).
const PAUSE_DESCRIPTIONS = {
  ingestion: "Live news, price and fundamentals fetching (the */15 fan-out and its queue consumers).",
  trading: "Exit checks and the analyze/decision pipeline. News stored while paused is not analyzed later.",
  llm: "Every Gemini-calling path (analyze, exit checks) and new backtest runs.",
  backtests: "Starting new backtest runs. Runs already in flight finish.",
};

/** Banner shown on every dashboard page while any switch is on. "" when nothing is paused. */
export function renderPausedBanner(flags) {
  const on = PAUSE_KEYS.filter((k) => flags?.[k]);
  if (on.length === 0) return "";
  const names = on.map((k) => escapeHtml(PAUSE_LABELS[k])).join(", ");
  return `<div class="paused-banner" role="status"><strong>PAUSED:</strong> ${names}. <a href="/dashboard/controls">Manage switches</a></div>
  <style>
    .paused-banner { background: var(--bg-elevated); border: 1px solid var(--border-strong); border-left: 4px solid #d97706; border-radius: var(--radius-sm); padding: 0.6rem 0.9rem; margin-bottom: 1rem; font-size: 0.875rem; color: var(--text-main); }
    .paused-banner a { color: var(--accent-bright); margin-left: 0.4rem; }
  </style>`;
}

function switchForm(key, paused) {
  return `<form method="POST" action="/controls/set" class="pause-form">
      <input type="hidden" name="key" value="${escapeHtml(key)}" />
      <input type="hidden" name="paused" value="${paused ? "0" : "1"}" />
      <button type="submit" class="pause-btn ${paused ? "is-paused" : "is-running"}" aria-pressed="${paused ? "true" : "false"}">${paused ? "Resume" : "Pause"}</button>
    </form>`;
}

/** `data` is backend's GET /api/controls body: `{ flags, meta, error }`. */
export function renderControlsView({ flags = {}, meta = {}, error = null } = {}) {
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
      ${anyPaused ? `<form method="POST" action="/controls/set"><input type="hidden" name="key" value="all" /><input type="hidden" name="paused" value="0" /><button type="submit" class="pause-btn is-paused">Resume all</button></form>` : ""}
    </div>`;

  const errorNote = error ? `<p class="note">Could not read the switches (${escapeHtml(error)}); showing everything as running.</p>` : "";

  return `<section id="controls">
    <h2>Pause switches</h2>
    <p class="note">Independent kill switches to free headroom. The intraday backfill, the retention purge and manual backfills are never paused.</p>
    ${errorNote}
    ${masterForms}
    <div class="pause-list">${rows}</div>
    <style>
      .pause-master { display:flex; gap:0.6rem; margin:0.75rem 0 1rem; flex-wrap:wrap; }
      .pause-list { display:flex; flex-direction:column; gap:0.75rem; }
      .pause-row { display:flex; align-items:center; justify-content:space-between; gap:1rem; padding:0.9rem 1.1rem; background:var(--bg-surface); border:1px solid var(--border-color); border-radius:var(--radius-md); }
      .pause-text { min-width:0; }
      .pause-title { font-family:var(--font-display); font-weight:600; color:var(--text-main); }
      .pause-desc, .pause-meta { font-size:0.75rem; color:var(--text-muted); line-height:1.5; margin-top:0.2rem; }
      .pause-state { font-size:0.6875rem; font-weight:700; letter-spacing:0.05em; margin-left:0.4rem; }
      .pause-state.is-paused { color:#d97706; }
      .pause-state.is-running { color:var(--text-subtle); }
      .pause-btn { min-height:44px; padding:0 1.1rem; border-radius:var(--radius-sm); border:1px solid var(--border-strong); background:var(--bg-elevated); color:var(--text-main); font-weight:600; cursor:pointer; }
      .pause-btn.is-paused { border-color:#d97706; }
      .pause-btn:hover { background:var(--bg-hover); }
      .pause-btn:focus-visible { outline:2px solid var(--focus-ring); outline-offset:2px; }
    </style>
  </section>`;
}
