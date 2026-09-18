import { healthRow, STALE_INGESTION_HOURS, errorState, donutChart, escapeHtml, fmtTime } from "../helpers.js";

export function renderHealthView({ health, error }) {
  if (error) {
    return `<section id="health">
      <h2>Ingestion health</h2>
      ${errorState(error)}
    </section>`;
  }

  // Build the donut from the same per-source stat the table uses. Each source
  // counts as 1 unit; "fresh" and "stale" are the two slices. When every source
  // is fresh this collapses to a single green ring, which is the right signal.
  const sources = [
    { label: "News (gdelt/rss/scrape)", stat: health.news },
    { label: "Price bars (yfinance)", stat: health.priceBars },
    { label: "Fundamentals (EDGAR)", stat: health.fundamentals },
  ];
  const freshCount = sources.filter((s) => s.stat && s.stat.lastIngestedAt &&
    Date.now() - new Date(s.stat.lastIngestedAt).getTime() <= STALE_INGESTION_HOURS * 3600 * 1000
  ).length;
  const staleCount = sources.length - freshCount;

  const healthDonut = donutChart(
    [
      { label: `Fresh (${freshCount})`, value: freshCount, color: "var(--color-success-text)" },
      { label: `Stale (${staleCount})`, value: staleCount, color: "var(--color-warning-text)" },
    ],
    {
      centerValue: `${freshCount}/${sources.length}`,
      centerLabel: "fresh",
      title: "Source freshness",
      subtitle: `last ${STALE_INGESTION_HOURS}h window`,
    }
  );

  return `<section id="health">
    <h2>Ingestion health</h2>
    <p class="note">Last-ingested timestamp + row count per source. Not a per-vendor error log (none is persisted yet) -- a stale timestamp is the strongest signal available here. "Stale" below just means no new rows in over ${STALE_INGESTION_HOURS}h, a fixed heuristic, not a per-source SLA.</p>

    <div class="chart-row-2">
      ${healthDonut}
      <div class="panel">
        <div class="panel-header"><span class="panel-title">Per-source detail</span></div>
        <div class="panel-body panel-body-flush">
          <table>
            <thead><tr><th>Source</th><th>Rows</th><th>Last ingested</th><th>Status</th></tr></thead>
            <tbody>
              ${sources.map((s) => healthRow(s.label, s.stat)).join("\n        ")}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </section>`;
}
