// M4b environment selector: a pill row ("Live" + the most recent backtests)
// that swaps `?env=` on the CURRENT url. Pure links, no JS, reusing the
// existing .filter-bar/.pill styles -- same look as every other filter on the
// dashboard.
//
// Links are built off the page's own URL (pathname + search), not through
// helpers.js#buildQuery/pillLinks: those serialize a fixed params object,
// whereas here every other param on the page (filters, windows, paging) must
// survive the switch untouched. The one exception is `llmBefore`, an id
// cursor into ONE environment's call log, which means nothing in another.
//
// What's highlighted is `resolvedEnv` -- the environment the SERVER actually
// resolved (data.js#resolveEnv) -- not whatever the URL asked for, so a bogus
// or vanished `?env=` shows Live as active alongside the envError note rather
// than pretending the requested run is on screen.

import { escapeHtml } from "../helpers.js";

const MAX_TICKERS_IN_LABEL = 3;

/** "AAPL, MSFT +2 · 2024-01-01", plus a status suffix for anything not complete. Every part comes from the registry (ticker text originates in the backtest form), so callers escape the result. */
export function runLabel(run) {
  const tickers = Array.isArray(run.tickers) ? run.tickers : [];
  const shown = tickers.slice(0, MAX_TICKERS_IN_LABEL).join(", ");
  const more = tickers.length > MAX_TICKERS_IN_LABEL ? ` +${tickers.length - MAX_TICKERS_IN_LABEL}` : "";
  const date = typeof run.testStart === "string" ? run.testStart.slice(0, 10) : "";
  const base = [shown + more || run.id, date].filter(Boolean).join(" \u00b7 ");
  return run.status && run.status !== "complete" ? `${base} (${run.status})` : base;
}

/** `pathname`+`search` with `env` set to `targetEnv` (removed entirely for live, so the default URL stays clean) and `llmBefore` dropped. */
export function envSwitchHref(pathname, search, targetEnv) {
  const sp = new URLSearchParams(search || "");
  sp.delete("llmBefore");
  if (targetEnv === "live") sp.delete("env");
  else sp.set("env", targetEnv);
  const qs = sp.toString();
  return `${pathname}${qs ? `?${qs}` : ""}`;
}

/**
 * @param {object} args
 * @param {Array} args.runs         backtest registry rows (newest first), as /api/backtest-runs returns them; [] if that lookup failed
 * @param {string} args.resolvedEnv "live" or the backtest id the server resolved
 * @param {string|null} args.envError why the requested env fell back to live, if it did
 * @param {string} args.pathname    e.g. "/dashboard/decisions"
 * @param {string} args.search      the current query string, with or without the leading "?"
 */
export function renderEnvSelector({ runs = [], resolvedEnv = "live", envError = null, pathname, search = "" }) {
  const pill = (targetEnv, label, title) => {
    const active = targetEnv === resolvedEnv;
    return `<a href="${escapeHtml(envSwitchHref(pathname, search, targetEnv))}" class="pill${active ? " pill-active" : ""}" title="${escapeHtml(title)}">${escapeHtml(label)}</a>`;
  };

  const pills = [pill("live", "Live", "Live trading data")];
  for (const run of runs) {
    pills.push(pill(run.id, runLabel(run), `${run.id} \u2014 ${run.status}`));
  }
  // The recent-runs list is capped, so an older backtest opened by direct link
  // wouldn't otherwise appear at all -- keep the active environment visible.
  if (resolvedEnv !== "live" && !runs.some((r) => r.id === resolvedEnv)) {
    pills.push(pill(resolvedEnv, resolvedEnv, resolvedEnv));
  }

  const bar = `<div class="filter-bar" id="env-selector">
    <div class="filter-group">
      <span class="filter-label">Environment</span>
      <div class="pill-row">${pills.join("")}</div>
    </div>
  </div>`;

  const notes = [];
  if (envError) notes.push(`<p class="note">${escapeHtml(envError)}</p>`);
  if (resolvedEnv !== "live") {
    notes.push(`<p class="note">Viewing backtest <code>${escapeHtml(resolvedEnv)}</code> &mdash; simulated results, not live trading.</p>`);
  }
  return bar + notes.join("");
}
