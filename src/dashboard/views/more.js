import { escapeHtml } from "../helpers.js";

export function renderMoreView() {
  return `<section id="more">
    <h2>More views &amp; actions</h2>
    <p class="note">Additional operational sections and administrative actions.</p>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Section</th><th>Description</th></tr></thead>
        <tbody>
          <tr><td class="ticker"><a href="/dashboard/activity" style="color: #f2ecd8; text-decoration: none;">Activity</a></td><td>Trade decisions per UTC calendar day, stacked by status.</td></tr>
          <tr><td class="ticker"><a href="/dashboard/charts" style="color: #f2ecd8; text-decoration: none;">Charts</a></td><td>Recent daily closes (unadjusted) for watchlist tickers.</td></tr>
          <tr><td class="ticker"><a href="/dashboard/backfill" style="color: #f2ecd8; text-decoration: none;">Backfill</a></td><td>Triggers historical news backfill (Finnhub company-news).</td></tr>
          <tr><td class="ticker"><a href="/dashboard/backtest" style="color: #f2ecd8; text-decoration: none;">Backtest</a></td><td>Manual backtest harness (Signal ON vs buy &amp; hold).</td></tr>
        </tbody>
      </table>
    </div>
  </section>`;
}
