// News replay comparison (backtest/newsReplay.js) -- the trigger flow lives
// across two pages, same Post/Redirect/Get-friendly two-step shape as
// /dashboard/backtest/confirm: pick a ticker + date here (renderReplayTriggerForm,
// embedded in the Backtest page, src/dashboard/views/backtest.js), GET
// /dashboard/backtest/replay/news to see that day's news items
// (renderReplayPickerPage below), then POST /backtest/replay/run to start the
// comparison. Unlike the plain backtest confirm page, step 2 here needs real
// backend data (the news items themselves), so it's rendered by
// dashboard-worker.js's own route handler rather than being pure UI.

import { escapeHtml, errorState } from "../helpers.js";

/** Step 1: ticker + date, GET-submits to /dashboard/backtest/replay/news (step 2, below). Embedded in the Backtest page (src/dashboard/views/backtest.js) rather than its own page, since it's a short two-field form. */
export function replayTriggerForm() {
  const today = new Date().toISOString().slice(0, 10);
  return `<form method="get" action="/dashboard/backtest/replay/news" class="filter-bar">
    <div class="filter-group">
      <span class="filter-label">Ticker</span>
      <input class="filter-form" type="text" name="ticker" placeholder="AAPL" required>
    </div>
    <div class="filter-group">
      <span class="filter-label">News date</span>
      <input class="filter-form date-input" type="date" name="date" value="${today}" required>
    </div>
    <div class="filter-group">
      <span class="filter-label">&nbsp;</span>
      <button type="submit" class="btn">Find news items to replay</button>
    </div>
  </form>`;
}

const MAX_REPLAY_NEWS_ITEMS = 5;

/**
 * Step 2: the news items found for `ticker` on `date` (backend's GET
 * /backtest/replay/news, `items`: [{id, publishedAt, title}]), as checkboxes
 * -- pick 1-5 (MAX_REPLAY_NEWS_ITEMS mirrors src/index.js's own constant;
 * the real limit is enforced server-side by POST /backtest/replay/run, this
 * is just an operator-facing hint), plus an optional `asOf` override that
 * applies uniformly to every selected item instead of each one's own
 * published_at (newsReplay.js's own convention -- see its header). Submits
 * to POST /backtest/replay/run, which 303s back to /dashboard/backtest where
 * the job's progress (and, once complete, its result) appears in the
 * "Recent replay comparisons" panel (helpers.js#replayJobsList).
 *
 * `error` is a backend fetch failure (network/5xx) -- shown instead of the
 * items list, same errorState() every other panel on this dashboard uses. An
 * empty (but successful) `items` list gets its own message rather than an
 * empty form with nothing to check.
 */
export function renderReplayPickerPage({ ticker, date, items, error }) {
  const heading = `<h2>Select news items to replay</h2>
    <p class="note">Runs each selected item through BOTH the pre-#132 parallel analyst path and the current batched path, and shows the two resulting trade decisions side by side. Makes real Gemini API calls -- read-only otherwise, nothing is written to positions or trade decisions.</p>`;

  if (error) {
    return `<section id="backtest-replay-picker">${heading}${errorState(error)}</section>`;
  }

  if (!items || items.length === 0) {
    return `<section id="backtest-replay-picker">${heading}
      <p class="empty">No ingested news items found for <span class="ticker">${escapeHtml(ticker)}</span> on ${escapeHtml(date)}. Try a different date, or backfill news for this range first.</p>
      <p class="note"><a href="/dashboard/backtest" style="color:var(--color-info-text);">&larr; Back to Backtest</a></p>
    </section>`;
  }

  const checkboxes = items
    .map(
      (it, i) => `<label class="filter-group" style="display:flex;align-items:flex-start;gap:0.6rem;cursor:pointer">
        <input type="checkbox" name="newsItemIds" value="${escapeHtml(it.id)}" ${i === 0 ? "checked" : ""} style="margin-top:0.3rem">
        <span><span style="display:block;font-weight:600">${escapeHtml(it.title || "(untitled)")}</span><span class="chart-axis-label">${escapeHtml(it.publishedAt ?? "")} &middot; id ${escapeHtml(it.id)}</span></span>
      </label>`
    )
    .join("\n");

  return `<section id="backtest-replay-picker">${heading}
    <p class="note">${items.length} news item${items.length === 1 ? "" : "s"} found for <span class="ticker">${escapeHtml(ticker)}</span> on ${escapeHtml(date)}. Pick 1-${MAX_REPLAY_NEWS_ITEMS}.</p>
    <form method="post" action="/backtest/replay/run" class="filter-bar" style="flex-direction:column;align-items:flex-start;gap:0.9rem">
      <input type="hidden" name="ticker" value="${escapeHtml(ticker)}">
      <div style="display:flex;flex-direction:column;gap:0.6rem">${checkboxes}</div>
      <div class="filter-group">
        <span class="filter-label">asOf override (optional, ISO timestamp -- blank uses each item's own publish time)</span>
        <input class="filter-form" type="text" name="asOf" placeholder="2026-01-15T14:30:00.000Z">
      </div>
      <div class="filter-group">
        <button type="submit" class="btn">Run replay comparison</button>
      </div>
    </form>
    <p class="note"><a href="/dashboard/backtest" style="color:var(--color-info-text);">&larr; Back to Backtest</a></p>
  </section>`;
}
