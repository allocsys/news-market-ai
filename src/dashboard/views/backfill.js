import { escapeHtml, rangePresetButtons, DATE_INPUT_STYLE } from "../helpers.js";

/** UTC "YYYY-MM-DD HH:MM:SS UTC", same format the page-toolbar's own "Loaded ..." stamp uses (shell.js) -- null/invalid input renders as "unknown time" rather than "Invalid Date". */
function formatUtc(iso) {
  if (!iso) return "unknown time";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown time";
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 19)} UTC`;
}

/**
 * The Backfill page's "Last run" panel: how the most recently FINISHED
 * backfill job (RunStore#getLatestFinishedJob via /api/jobs/latest, job_progress
 * shape -- storage/jobs.js#jobFromRow) ended, once its own progress bar has
 * aged out of the active-job window (or the operator simply navigated away
 * and came back). `job` is null when none has ever finished -- renders
 * nothing then, so callers can prepend the result unconditionally, same
 * convention as status.js#renderActiveJobPanel.
 *
 * `job.detail` already carries a complete one-line summary by the time a
 * backfill job reaches 'complete' (ingest-worker.js's queue() forces it:
 * "Inserted N articles[, M vendor errors]") or 'failed' (whatever phase
 * detail was last written, e.g. "Saved 325/733 articles", plus job.error) --
 * this panel reads those rather than re-deriving counts from job.result,
 * so it can never drift out of sync with what the progress panel itself
 * showed while the job was running.
 */
function renderLastRunPanel(job, { title = "Last run" } = {}) {
  if (!job || !job.id) return "";
  const p = job.params || {};
  const range = p.from && p.to ? `${p.from} to ${p.to}` : "unknown range";
  const finished = formatUtc(job.finishedAt);
  const failed = job.status === "failed";

  return `<div class="panel" style="margin-bottom:1.5rem">
    <div class="panel-header"><span class="panel-title">${escapeHtml(title)}</span></div>
    <div class="panel-body">
      <p class="note" style="${failed ? "color: var(--color-danger-text); font-weight: 600;" : ""}">${failed ? "Failed" : "Complete"} &mdash; ${escapeHtml(range)}, finished ${escapeHtml(finished)}.</p>
      <p class="note">${escapeHtml(job.detail || (failed ? job.error || "unknown error" : ""))}</p>
      ${failed && job.error && job.error !== job.detail ? `<p class="note" style="color: var(--color-danger-text);">${escapeHtml(job.error)}</p>` : ""}
    </div>
  </div>`;
}

export function backfillTriggerForm() {
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  return `<form method="get" action="/dashboard/backfill/confirm" class="filter-bar">
    ${rangePresetButtons("backfillFrom", "backfillTo")}
    <div class="filter-group">
      <span class="filter-label">From</span>
      <input class="filter-form ${DATE_INPUT_STYLE}" id="backfillFrom" type="date" name="from" value="${monthAgo}">
    </div>
    <div class="filter-group">
      <span class="filter-label">To</span>
      <input class="filter-form ${DATE_INPUT_STYLE}" id="backfillTo" type="date" name="to" value="${today}">
    </div>
    <div class="filter-group">
      <span class="filter-label">&nbsp;</span>
      <button type="submit" class="btn">Review &amp; run backfill</button>
    </div>
  </form>`;
}

/** Form for the historical price-bar backfill: a range (default: the last year), whole watchlist. GET to the confirm page, like the news form. */
export function priceBackfillTriggerForm() {
  const today = new Date().toISOString().slice(0, 10);
  const yearAgo = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
  return `<form method="get" action="/dashboard/backfill-prices/confirm" class="filter-bar">
    ${rangePresetButtons("priceBackfillFrom", "priceBackfillTo")}
    <div class="filter-group">
      <span class="filter-label">From</span>
      <input class="filter-form ${DATE_INPUT_STYLE}" id="priceBackfillFrom" type="date" name="from" value="${yearAgo}">
    </div>
    <div class="filter-group">
      <span class="filter-label">To</span>
      <input class="filter-form ${DATE_INPUT_STYLE}" id="priceBackfillTo" type="date" name="to" value="${today}">
    </div>
    <div class="filter-group">
      <span class="filter-label">&nbsp;</span>
      <button type="submit" class="btn">Review &amp; run price backfill</button>
    </div>
  </form>`;
}

export function renderBackfillView({ lastRun, lastPriceRun } = {}) {
  return `<section id="backfill">
    <h2>Historical news backfill</h2>
    <p class="note">Triggers <code>POST /backfill</code> -- real Finnhub <code>/company-news</code> calls (spends free-tier quota) for the whole watchlist over the chosen range, persisted the same way live ingestion is. Requires a logged-in dashboard session -- log in from the dashboard's login page to use this. rss/scrape sources can't be backfilled this way (see ingestion/ingest.js#backfillHistoricalNews's own header for why) -- only Finnhub-covered history fills in.</p>

    ${renderLastRunPanel(lastRun)}

    <div class="panel">
      <div class="panel-header"><span class="panel-title">Backfill parameters</span></div>
      <div class="panel-body">
        ${backfillTriggerForm()}
      </div>
    </div>

    <h2 style="margin-top:2rem">Historical price bars</h2>
    <p class="note">Triggers <code>POST /backfill-prices</code> -- one Yahoo Finance daily-bars request per watchlist ticker for the chosen range, saved the same way live ingestion saves bars. Backtests need this: with no price history a backtest can't open positions outside the last few days. Yahoo has been answering 429 to every ticker from Cloudflare Workers, so this can fail; a failed job says which tickers and why.</p>

    ${renderLastRunPanel(lastPriceRun, { title: "Last price backfill" })}

    <div class="panel">
      <div class="panel-header"><span class="panel-title">Price backfill parameters</span></div>
      <div class="panel-body">
        ${priceBackfillTriggerForm()}
      </div>
    </div>
  </section>`;
}

export function renderPriceBackfillConfirmPage({ from, to }) {
  return `<section id="price-backfill-confirm">
    <h2>Confirm historical price backfill</h2>
    <p class="note">You are about to backfill daily price bars for the whole watchlist with the following range:</p>
    <div class="llm-answer-body" style="max-width:none; margin-bottom: 1.5rem;">
      <div class="llm-block"><span class="llm-agent">From</span> <span class="num">${escapeHtml(from)}</span></div>
      <div class="llm-block"><span class="llm-agent">To</span> <span class="num">${escapeHtml(to)}</span></div>
    </div>
    <p class="note">This makes one request per watchlist ticker to Yahoo Finance's unofficial chart API. It ignores the live ingest's 429 cooldown; if Yahoo answers 429 the job fails and names the tickers. No paid quota is used.</p>
    <form method="post" action="/backfill-prices" class="filter-bar">
      <input type="hidden" name="from" value="${escapeHtml(from)}">
      <input type="hidden" name="to" value="${escapeHtml(to)}">
      <div class="filter-group">
        <button type="submit" class="btn">Confirm and run price backfill</button>
      </div>
    </form>
  </section>`;
}

export function renderBackfillConfirmPage({ from, to }) {
  return `<section id="backfill-confirm">
    <h2>Confirm historical news backfill</h2>
    <p class="note">You are about to run a historical news backfill with the following parameters:</p>
    <div class="llm-answer-body" style="max-width:none; margin-bottom: 1.5rem;">
      <div class="llm-block"><span class="llm-agent">From</span> <span class="num">${escapeHtml(from)}</span></div>
      <div class="llm-block"><span class="llm-agent">To</span> <span class="num">${escapeHtml(to)}</span></div>
    </div>
    <p class="note" style="color: var(--color-danger-text); font-weight: 600;">Cost warning: This action makes real Finnhub API calls and spends free-tier quota.</p>
    <form method="post" action="/backfill" class="filter-bar">
      <input type="hidden" name="from" value="${escapeHtml(from)}">
      <input type="hidden" name="to" value="${escapeHtml(to)}">
      <div class="filter-group">
        <button type="submit" class="btn">Confirm and run backfill</button>
      </div>
    </form>
  </section>`;
}
