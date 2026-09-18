import { healthRow, STALE_INGESTION_HOURS, errorState } from "../helpers.js";

export function renderHealthView({ health, error }) {
  return `<section id="health">
    <h2>Ingestion health</h2>
    <p class="note">Last-ingested timestamp + row count per source. Not a per-vendor error log (none is persisted yet) -- a stale timestamp is the strongest signal available here. "Stale" below just means no new rows in over ${STALE_INGESTION_HOURS}h, a fixed heuristic, not a per-source SLA.</p>
    ${error ? errorState(error) : `<div class="table-wrap"><table>
      <thead><tr><th>Source</th><th>Rows</th><th>Last ingested</th><th>Status</th></tr></thead>
      <tbody>
        ${healthRow("News (gdelt/rss/scrape)", health.news)}
        ${healthRow("Price bars (yfinance)", health.priceBars)}
        ${healthRow("Fundamentals (EDGAR)", health.fundamentals)}
      </tbody>
    </table></div>`}
  </section>`;
}
