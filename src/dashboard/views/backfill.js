import { escapeHtml, rangePresetButtons, DATE_INPUT_STYLE } from "../helpers.js";

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

export function renderBackfillView() {
  return `<section id="backfill">
    <h2>Historical news backfill</h2>
    <p class="note">Triggers <code>POST /backfill</code> -- real Finnhub <code>/company-news</code> calls (spends free-tier quota) for the whole watchlist over the chosen range, persisted the same way live ingestion is. Requires a logged-in dashboard session -- log in from the dashboard's login page to use this. rss/scrape sources can't be backfilled this way (see graph/pipeline.js#backfillHistoricalNews's own header for why) -- only Finnhub-covered history fills in.</p>
    ${backfillTriggerForm()}
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
