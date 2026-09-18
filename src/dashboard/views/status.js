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
  // A pulsing status dot conveys "in progress" without JS animation logic --
  // it's pure CSS, so still safe inside Cloudflare's HTML response.
  return `<section id="run-accepted">
    <h2>${escapeHtml(title)} accepted</h2>
    <div class="panel" style="margin-bottom:1.5rem">
      <div class="panel-body" style="display:flex;align-items:center;gap:0.85rem">
        <span style="width:10px;height:10px;border-radius:50%;background:var(--color-success-text);box-shadow:0 0 0 0 var(--color-success-strong);animation:runPulse 1.6s ease-out infinite;flex-shrink:0"></span>
        <div>
          <div style="font-weight:600;color:var(--text-main)">${escapeHtml(detail)}</div>
          <div style="font-size:0.75rem;color:var(--text-muted);margin-top:0.2rem">Run is in progress in the background.</div>
        </div>
      </div>
    </div>
    <p class="note">This page does not wait for the run to finish, so nothing further will happen here.</p>
    <p class="note">Check back on <a href="${escapeHtml(backLink)}" style="color:var(--color-info-text);">${escapeHtml(backLabel)}</a> in a minute or two; results will appear there once the run completes.</p>
    <style>
      @keyframes runPulse {
        0%   { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.55); }
        70%  { box-shadow: 0 0 0 12px rgba(16, 185, 129, 0); }
        100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
      }
      @media (prefers-reduced-motion: reduce) {
        .panel-body span { animation: none !important; }
      }
    </style>
  </section>`;
}
