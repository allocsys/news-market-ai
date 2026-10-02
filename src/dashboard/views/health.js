import { healthRow, STALE_INGESTION_HOURS, errorState } from "../helpers.js";

export function renderHealthView({ health, error }) {
  if (error) {
    return `<section id="health">
      <h2>Ingestion health</h2>
      ${errorState(error)}
    </section>`;
  }

  // Each source counts as 1 unit: fresh if it ingested within the stale window.
  // The one-line summary replaces the old donut (a 2-slice ring that took a
  // whole screen on a phone to say "N of 3 fresh").
  const sources = [
    { label: "News (gdelt/rss/scrape)", stat: health.news },
    { label: "Price bars (yfinance)", stat: health.priceBars },
    { label: "Fundamentals (EDGAR)", stat: health.fundamentals },
  ];
  const freshCount = sources.filter((s) => s.stat && s.stat.lastIngestedAt &&
    Date.now() - new Date(s.stat.lastIngestedAt).getTime() <= STALE_INGESTION_HOURS * 3600 * 1000
  ).length;
  const staleCount = sources.length - freshCount;
  const summaryClass = staleCount === 0 ? "ok-flag" : "stale-flag";

  return `<section id="health">
    <h2>Ingestion health <span class="${summaryClass}">${freshCount}/${sources.length} fresh</span></h2>
    <p class="note">Last ingest and row count per source. Stale = no new rows in over ${STALE_INGESTION_HOURS}h (a fixed heuristic, not an SLA); no per-vendor error log is kept.</p>
    <div class="panel">
      <div class="panel-body panel-body-flush">
        <table>
          <thead><tr><th>Source</th><th>Rows</th><th>Last ingested</th><th>Status</th></tr></thead>
          <tbody>
            ${sources.map((s) => healthRow(s.label, s.stat)).join("\n        ")}
          </tbody>
        </table>
      </div>
    </div>
  </section>`;
}
