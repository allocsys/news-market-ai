import { escapeHtml, rangePresetButtons, DATE_INPUT_STYLE, backtestRunsList, replayJobsList, errorState } from "../helpers.js";
import { replayTriggerForm } from "./replay.js";

export function backtestTriggerForm() {
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  return `<form method="get" action="/dashboard/backtest/confirm" class="filter-bar">
    <div class="filter-group">
      <span class="filter-label">Tickers (comma-separated, blank = watchlist)</span>
      <input class="filter-form" id="backtestTickers" type="text" name="tickers" placeholder="AAPL,MSFT">
    </div>
    ${rangePresetButtons("backtestStart", "backtestEnd")}
    <div class="filter-group">
      <span class="filter-label">Test start</span>
      <input class="filter-form ${DATE_INPUT_STYLE}" id="backtestStart" type="date" name="testStart" value="${monthAgo}">
    </div>
    <div class="filter-group">
      <span class="filter-label">Test end</span>
      <input class="filter-form ${DATE_INPUT_STYLE}" id="backtestEnd" type="date" name="testEnd" value="${today}">
    </div>
    <div class="filter-group">
      <span class="filter-label">&nbsp;</span>
      <button type="submit" class="btn">Review &amp; run backtest</button>
    </div>
  </form>`;
}

/**
 * "Clean up old runs" form -- POST /backtest/cleanup (src/index.js), bulk-
 * deletes the trade-level data of old, already-finished (complete/failed/
 * cancelled) runs, keeping each run's registry row and result summary. A
 * still-running run is never touched by this -- use "Terminate run" (see
 * helpers.js#terminateRunForm) for one of those instead. Defaults to 30
 * days and lets the operator override it. Confirmed client-side since the
 * per-trade detail (the "View trade timeline" page) can't be recovered
 * afterward for whatever it catches.
 */
function backtestCleanupForm() {
  return `<form method="post" action="/backtest/cleanup" class="filter-bar" onsubmit="return confirm('Delete trade-level data for terminal (complete/failed/cancelled) runs older than the chosen window? Each run\u2019s summary result is kept, but its trade timeline is deleted and can\u2019t be recovered.');">
    <div class="filter-group">
      <span class="filter-label">Older than (days)</span>
      <input class="filter-form" type="number" name="olderThanDays" value="30" min="1" step="1" style="width:6rem">
    </div>
    <div class="filter-group">
      <span class="filter-label">&nbsp;</span>
      <button type="submit" class="btn btn-destructive">Clean up old runs</button>
    </div>
  </form>`;
}

/**
 * "Delete failed & cancelled runs" form -- POST /backtest/purge (src/index.js).
 * Unlike "Clean up old runs" this removes the registry row too, so the runs
 * disappear from Recent runs and their error history is gone. Complete and
 * running runs are never touched.
 */
function backtestPurgeForm() {
  return `<form method="post" action="/backtest/purge" class="filter-bar" onsubmit="return confirm('Permanently delete ALL failed and cancelled runs, including their error history? They will disappear from Recent runs and can\u2019t be recovered. Complete and running runs are not touched.');">
    <div class="filter-group">
      <span class="filter-label">&nbsp;</span>
      <button type="submit" class="btn btn-destructive">Delete failed &amp; cancelled runs</button>
    </div>
  </form>`;
}

export function renderBacktestView({ backtestRuns, error, replayJobs, replayError }) {
  return `<section id="backtest">
    <h2>Backtest results</h2>
    <p class="note">Signal ON (real pipeline over already-backfilled news) vs. signal OFF (naive buy &amp; hold), manually triggered -- never automatic. Requires a logged-in dashboard session -- log in from the dashboard's login page to use this. A window with no backfilled news for it (see <code>POST /backfill</code>) will show a thin/empty "on" side, not an error.</p>

    <div class="panel" style="margin-bottom:1.5rem">
      <div class="panel-header"><span class="panel-title">Trigger a new run</span></div>
      <div class="panel-body">
        ${backtestTriggerForm()}
      </div>
    </div>

    <div class="panel" style="margin-bottom:1.5rem">
      <div class="panel-header"><span class="panel-title">Clean up old runs</span></div>
      <div class="panel-body">
        <p class="note">Frees D1 storage by deleting positions/decisions/LLM-call data for old finished runs. Each run's headline result and its "running"/"complete"/"failed"/"cancelled" status stay in the Recent runs list below -- only the per-trade timeline is removed, and only for runs that already finished. A currently-running run is never touched here; terminate it from its own entry below instead.</p>
        ${backtestCleanupForm()}
        <p class="note" style="margin-top:1rem">To remove failed and cancelled runs completely -- their rows in Recent runs and their error history too -- use the button below. Complete and running runs are never touched.</p>
        ${backtestPurgeForm()}
      </div>
    </div>

    <div class="panel">
      <div class="panel-header"><span class="panel-title">Recent runs</span></div>
      <div class="panel-body">
        ${error ? errorState(error) : backtestRunsList(backtestRuns)}
      </div>
    </div>

    <div class="panel" style="margin-top:1.5rem">
      <div class="panel-header"><span class="panel-title">News replay comparison</span></div>
      <div class="panel-body">
        <p class="note">Pick one or a few already-ingested news items and see, side by side, what the pre-#132 parallel analyst calls versus the current batched call would each have decided for the resulting trade -- a way to check #132's cost/quality trade-off against real historical items instead of only the test suite. Read-only: no position or trade decision is ever written.</p>
        ${replayTriggerForm()}
      </div>
    </div>

    <div class="panel" style="margin-top:1.5rem">
      <div class="panel-header"><span class="panel-title">Recent replay comparisons</span></div>
      <div class="panel-body">
        ${replayError ? errorState(replayError) : replayJobsList(replayJobs)}
      </div>
    </div>
  </section>`;
}

export function renderBacktestConfirmPage({ testStart, testEnd, tickers, graceDays }) {
  return `<section id="backtest-confirm">
    <h2>Confirm manual backtest</h2>
    <p class="note">You are about to run a manual backtest with the following parameters:</p>
    <div class="llm-answer-body" style="max-width:none; margin-bottom: 1.5rem;">
      <div class="llm-block"><span class="llm-agent">Tickers</span> <span class="ticker">${escapeHtml(tickers ?? "Watchlist")}</span></div>
      <div class="llm-block"><span class="llm-agent">Test Start</span> <span class="num">${escapeHtml(testStart)}</span></div>
      <div class="llm-block"><span class="llm-agent">Test End</span> <span class="num">${escapeHtml(testEnd)}</span></div>
      ${graceDays ? `<div class="llm-block"><span class="llm-agent">Grace Days</span> <span class="num">${escapeHtml(graceDays)}</span></div>` : ""}
    </div>
    <p class="note" style="color: var(--color-danger-text); font-weight: 600;">Cost warning: This action makes real Gemini API calls and spends model quota.</p>
    <form method="post" action="/backtest/run" class="filter-bar">
      <input type="hidden" name="testStart" value="${escapeHtml(testStart)}">
      <input type="hidden" name="testEnd" value="${escapeHtml(testEnd)}">
      ${tickers ? `<input type="hidden" name="tickers" value="${escapeHtml(tickers)}">` : ""}
      ${graceDays ? `<input type="hidden" name="graceDays" value="${escapeHtml(graceDays)}">` : ""}
      <div class="filter-group">
        <button type="submit" class="btn">Confirm and run backtest</button>
      </div>
    </form>
  </section>`;
}
