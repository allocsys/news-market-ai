// M4b environment selector: a single dropdown button ("Live" or the active
// backtest's label) that opens a panel listing Live + recent backtest runs,
// swapping `?env=` on the CURRENT url. Native <details>/<summary> (same
// disclosure pattern as .llm-answer elsewhere in this file's stylesheet), so
// it needs no page-specific JS -- only a small global outside-click/Escape
// close handler lives in shell.js, shared by every <details class="env-dropdown">
// on the page.
//
// Replaces the old flat pill-row: with more than a handful of backtest runs
// (this dashboard accumulates one per attempt, complete or not) a pill-per-run
// wrapped into an unreadable wall of chips with no way to tell a live run from
// eight failed attempts at a glance. Now: Live is always pinned first, a
// handful of the most recent NON-failed runs render directly, and failed runs
// collapse behind a nested "N failed runs" disclosure so they don't dominate
// the list -- the active environment is still always reachable even if it's
// failed or fell off the visible list (see `activeExtra` below).
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
// How many non-failed runs render directly in the panel before the rest would
// need scrolling -- generous enough to cover "a few concurrent backtests"
// without reintroducing the wall-of-chips problem this replaces.
const MAX_VISIBLE_RUNS = 6;

const CHEVRON_ICON = `<svg class="env-dropdown-chevron" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;

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

/** Which colored dot a run's status gets in the dropdown; "live" itself is handled separately by the caller since it isn't a run status. */
function statusDotClass(status) {
  if (status === "running") return "env-dot-running";
  if (status === "failed") return "env-dot-failed";
  return "env-dot"; // complete / unknown: neutral
}

function renderOption({ href, label, title, active, dotClass, status }) {
  const statusTag = status && status !== "complete" ? `<span class="env-option-status">${escapeHtml(status)}</span>` : "";
  return `<a href="${escapeHtml(href)}" class="env-option${active ? " active" : ""}" title="${escapeHtml(title)}"><span class="env-dot ${dotClass}"></span><span class="env-option-label">${escapeHtml(label)}</span>${statusTag}</a>`;
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
  const isLive = resolvedEnv === "live";
  const activeRun = runs.find((r) => r.id === resolvedEnv);

  const triggerDotClass = isLive ? "env-dot-live" : statusDotClass(activeRun?.status);
  const triggerLabel = isLive ? "Live" : activeRun ? runLabel(activeRun) : resolvedEnv;

  const liveOption = renderOption({
    href: envSwitchHref(pathname, search, "live"),
    label: "Live",
    title: "Live trading data",
    active: isLive,
    dotClass: "env-dot-live",
  });

  const failedRuns = runs.filter((r) => r.status === "failed");
  const otherRuns = runs.filter((r) => r.status !== "failed");
  const visibleRuns = otherRuns.slice(0, MAX_VISIBLE_RUNS);

  const runOption = (run) =>
    renderOption({
      href: envSwitchHref(pathname, search, run.id),
      label: runLabel(run),
      title: `${run.id} \u2014 ${run.status}`,
      active: run.id === resolvedEnv,
      dotClass: statusDotClass(run.status),
      status: run.status,
    });

  const runOptions = visibleRuns.map(runOption).join("");

  // The lists above are capped/filtered, so an active environment reached via
  // a direct link (older run, or a failed one) might not appear in either --
  // keep it reachable rather than silently invisible.
  const alreadyShown = new Set(visibleRuns.map((r) => r.id));
  const activeExtra =
    !isLive && !alreadyShown.has(resolvedEnv) && !failedRuns.some((r) => r.id === resolvedEnv)
      ? runOption(activeRun ?? { id: resolvedEnv, tickers: [], status: undefined })
      : "";

  const recentGroup =
    runOptions || activeExtra ? `<div class="env-dropdown-group-label">Recent backtests</div>${runOptions}${activeExtra}` : "";

  const failedOptions = failedRuns.map(runOption).join("");
  const failedBlock = failedRuns.length
    ? `<details class="env-dropdown-failed"><summary>${failedRuns.length} failed run${failedRuns.length === 1 ? "" : "s"}</summary>${failedOptions}</details>`
    : "";

  const bar = `<div class="filter-bar" id="env-selector">
    <div class="filter-group">
      <span class="filter-label">Environment</span>
      <details class="env-dropdown">
        <summary><span class="env-dot ${triggerDotClass}"></span><span class="env-dropdown-label">${escapeHtml(triggerLabel)}</span>${CHEVRON_ICON}</summary>
        <div class="env-dropdown-panel">${liveOption}${recentGroup}${failedBlock}</div>
      </details>
    </div>
  </div>`;

  const notes = [];
  if (envError) notes.push(`<p class="note">${escapeHtml(envError)}</p>`);
  if (resolvedEnv !== "live") {
    notes.push(`<p class="note">Viewing backtest <code>${escapeHtml(resolvedEnv)}</code> &mdash; simulated results, not live trading.</p>`);
  }
  return bar + notes.join("");
}
