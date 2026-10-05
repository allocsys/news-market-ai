import { escapeHtml, rangePresetButtons, DATE_INPUT_STYLE, backtestRunsList, replayJobsList, errorState } from "../helpers.js";
import { replayTriggerForm } from "./replay.js";
import { tickerChecklist } from "../ticker_picker.js";

/** `tickerOptions` = the watchlist, as tappable checkboxes (none ticked = the whole watchlist, same as a blank text field was). Empty = the old comma-separated text field, e.g. when the watchlist lookup failed. */
export function backtestTriggerForm(tickerOptions = []) {
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  return `<form method="get" action="/dashboard/backtest/confirm" class="filter-bar">
    <div class="filter-group">
      ${
        tickerOptions.length > 0
          ? `<span class="filter-label">Tickers (none selected = whole watchlist)</span>
      ${tickerChecklist({ name: "tickers", idPrefix: "backtestTicker", options: tickerOptions })}`
          : `<label class="filter-label" for="backtestTickers">Tickers (comma-separated, blank = watchlist)</label>
      <input class="filter-form" id="backtestTickers" type="text" name="tickers" placeholder="AAPL,MSFT">`
      }
    </div>
    ${rangePresetButtons("backtestStart", "backtestEnd")}
    <div class="filter-group">
      <label class="filter-label" for="backtestStart">Test start</label>
      <input class="filter-form ${DATE_INPUT_STYLE}" id="backtestStart" type="date" name="testStart" value="${monthAgo}">
    </div>
    <div class="filter-group">
      <label class="filter-label" for="backtestEnd">Test end</label>
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
      <label class="filter-label" for="cleanupOlderThanDays">Older than (days)</label>
      <input class="filter-form w-6rem" id="cleanupOlderThanDays" type="number" name="olderThanDays" value="30" min="1" step="1">
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

export function renderBacktestView({ backtestRuns, error, replayJobs, replayError, tickerOptions = [] }) {
  return `<section id="backtest">
    <h2>Backtest results</h2>
    <p class="note">Each run compares the strategy (real pipeline) against buy &amp; hold. The price-impact gate is a separate per-run option on the confirm page. Manual only; needs login. No backfilled news in the window = empty strategy side.</p>

    <div class="panel" style="margin-bottom:1.5rem">
      <div class="panel-header"><span class="panel-title">Trigger a new run</span></div>
      <div class="panel-body">
        ${backtestTriggerForm(tickerOptions)}
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
        <p class="note">Compare old parallel vs. current batched analyst calls on ingested news items. Read-only.</p>
        ${replayTriggerForm(tickerOptions)}
      </div>
    </div>

    <div class="panel" style="margin-top:1.5rem">
      <div class="panel-header"><span class="panel-title">Recent replay comparisons</span></div>
      <div class="panel-body">
        ${replayError ? errorState(replayError) : replayJobsList(replayJobs)}
      </div>
    </div>

    <details class="panel" style="margin-top:1.5rem">
      <summary class="panel-header"><span class="panel-title">Maintenance: delete old run data</span></summary>
      <div class="panel-body">
        <p class="note">Deletes per-trade data of finished runs; summaries stay. Running runs are never touched.</p>
        ${backtestCleanupForm()}
        <p class="note" style="margin-top:1rem">Or remove failed/cancelled runs entirely, including error history.</p>
        ${backtestPurgeForm()}
      </div>
    </details>
  </section>`;
}

export function renderBacktestConfirmPage({ testStart, testEnd, tickers, graceDays }) {
  return `<section id="backtest-confirm">
    <h2>Confirm manual backtest</h2>
    <p class="note">Manual backtest parameters:</p>
    <div class="llm-answer-body" style="max-width:none; margin-bottom: 1.5rem;">
      <div class="llm-block"><span class="llm-agent">Tickers</span> <span class="ticker">${escapeHtml(tickers ?? "Watchlist")}</span></div>
      <div class="llm-block"><span class="llm-agent">Test Start</span> <span class="num">${escapeHtml(testStart)}</span></div>
      <div class="llm-block"><span class="llm-agent">Test End</span> <span class="num">${escapeHtml(testEnd)}</span></div>
      ${graceDays ? `<div class="llm-block"><span class="llm-agent">Grace Days</span> <span class="num">${escapeHtml(graceDays)}</span></div>` : ""}
    </div>
    <p class="note" style="color: var(--color-danger-text); font-weight: 600;">Cost warning: This action makes real Gemini API calls and spends model quota.</p>
    <form method="post" action="/backtest/run" class="filter-bar" style="flex-direction:column;align-items:flex-start;gap:0.9rem">
      <input type="hidden" name="testStart" value="${escapeHtml(testStart)}">
      <input type="hidden" name="testEnd" value="${escapeHtml(testEnd)}">
      ${tickers ? `<input type="hidden" name="tickers" value="${escapeHtml(tickers)}">` : ""}
      ${graceDays ? `<input type="hidden" name="graceDays" value="${escapeHtml(graceDays)}">` : ""}
      <label class="filter-group" style="display:flex;align-items:center;gap:0.5rem;cursor:pointer">
        <input type="checkbox" name="enableLlmLog" value="1">
        <span>Enable LLM call logging <span class="chart-axis-label">(off by default to save D1 writes)</span></span>
      </label>
      <label class="filter-group" style="display:flex;align-items:center;gap:0.5rem;cursor:pointer">
        <input type="checkbox" name="disableGate" value="1">
        <span>Disable price-impact gate <span class="chart-axis-label">(this run only; unchecked = default, gate on)</span></span>
      </label>
      <div class="filter-group">
        <button type="submit" class="btn">Confirm and run backtest</button>
      </div>
    </form>
  </section>`;
}
