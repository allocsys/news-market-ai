// Ticker pickers for the dashboard forms: tap to choose from the watchlist
// instead of typing symbols. Pure markup helpers, no client script, so a
// picker works the same on a phone, after an auto-refresh, and with JS off.
//
// The option list is the backend watchlist (GET /api/watchlist, fetched
// best-effort by dashboard-worker.js#watchlistTickersFor). Every caller falls
// back to its original text input when that list is empty, so a failed lookup
// never leaves a form unusable.
//
// Auto-refresh (shell.js captureFormState) restores fields by id when there
// is one, otherwise by name, and a name shared by several checkboxes would
// collapse into one entry -- so every checkbox here gets its own unique id.

import { escapeHtml } from "./helpers.js";

/** Every value (repeated params and/or comma lists) as a deduped, upper-cased array. */
export function parseTickerList(values) {
  const out = [];
  for (const value of values ?? []) {
    for (const part of String(value ?? "").split(",")) {
      const ticker = part.trim().toUpperCase();
      if (ticker && !out.includes(ticker)) out.push(ticker);
    }
  }
  return out;
}

/**
 * "AAPL,MSFT" from every `key` value of a query string, or null when none is
 * given. Accepts both shapes a form can send: repeated `tickers=AAPL&tickers=MSFT`
 * (checkbox picker) and the older `tickers=AAPL,MSFT`.
 */
export function tickersFromParams(searchParams, key = "tickers") {
  const list = parseTickerList(searchParams.getAll(key));
  return list.length > 0 ? list.join(",") : null;
}

const CHIP_STYLE =
  "display:inline-flex;align-items:center;gap:0.4rem;padding:0.45rem 0.75rem;border:1px solid var(--border-color);border-radius:var(--radius-sm);background:var(--bg-base);color:var(--text-main);cursor:pointer;font-family:var(--font-mono);font-size:0.8125rem;line-height:1";

/**
 * Multi-select as a row of checkboxes, all submitted under `name` (so the
 * server sees repeated params). Nothing ticked submits nothing. `idPrefix`
 * must be unique on the page. `labelId` = id of the visible text that names
 * the group (screen readers announce that instead of the generic "Tickers").
 */
export function tickerChecklist({ name, idPrefix, options, selected = [], labelId = "" }) {
  const chosen = new Set(parseTickerList(Array.isArray(selected) ? selected : [selected]));
  const chips = options
    .map((ticker) => {
      const id = `${idPrefix}-${ticker}`;
      return `<label for="${escapeHtml(id)}" style="${CHIP_STYLE}"><input type="checkbox" id="${escapeHtml(id)}" name="${escapeHtml(name)}" value="${escapeHtml(ticker)}"${chosen.has(ticker) ? " checked" : ""}><span>${escapeHtml(ticker)}</span></label>`;
    })
    .join("");
  const groupName = labelId ? `aria-labelledby="${escapeHtml(labelId)}"` : `aria-label="Tickers"`;
  return `<div role="group" ${groupName} style="display:flex;flex-wrap:wrap;gap:0.4rem">${chips}</div>`;
}

/**
 * Single-select dropdown. With `allLabel` the first option is an empty "all"
 * choice; without it the first ticker is preselected. A `selected` value that
 * is not in `options` (e.g. a deep link) is appended so it stays selected.
 * Wrapped in `.filter-form`, which is what styles a <select> in this dashboard.
 */
export function tickerSelect({ name, id, options, selected = "", allLabel = null, required = false }) {
  const current = String(selected ?? "").trim().toUpperCase();
  const list = current && !options.includes(current) ? [...options, current] : [...options];
  const all = allLabel === null ? "" : `<option value=""${current ? "" : " selected"}>${escapeHtml(allLabel)}</option>`;
  const items = list
    .map((ticker) => `<option value="${escapeHtml(ticker)}"${ticker === current ? " selected" : ""}>${escapeHtml(ticker)}</option>`)
    .join("");
  return `<div class="filter-form" style="min-width:9rem"><select name="${escapeHtml(name)}"${id ? ` id="${escapeHtml(id)}"` : ""}${required ? " required" : ""}>${all}${items}</select></div>`;
}
