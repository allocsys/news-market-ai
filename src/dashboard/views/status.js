// Post-confirmation "run accepted" status view (design.md's Components ->
// Costly-action confirmation / Loading-error-empty states -> "In-progress"
// requirement): after the operator hits "Confirm and run", they must land
// on a page that says the run was accepted and is in progress, not a bare
// redirect back to an unchanged page. Backfill/backtest runs are kicked off
// via ctx.waitUntil in src/index.js so this page can respond immediately
// rather than blocking on the full run (which can be long and would
// otherwise risk a request timeout on a large date range).

import { escapeHtml } from "../helpers.js";

export function renderRunAcceptedPage({ title, detail, backLink, backLabel }) {
  return `<section id="run-accepted">
    <h2>${escapeHtml(title)} accepted</h2>
    <p class="note">${escapeHtml(detail)}</p>
    <p class="note">The run is in progress in the background -- this page does not wait for it to finish, so nothing further will happen here.</p>
    <p class="note">Check back on <a href="${escapeHtml(backLink)}" style="color:#6f92b8;">${escapeHtml(backLabel)}</a> in a minute or two; results will appear there once the run completes.</p>
  </section>`;
}
