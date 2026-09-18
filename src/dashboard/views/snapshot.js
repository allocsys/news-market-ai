import { renderSummaryCards, donutChart, gaugeChart, errorState, escapeHtml, fmtTime } from "../helpers.js";

export function renderSnapshotView({ openPositions, closedPositions, decisionStats, error }) {
  if (error) {
    return `<section id="snapshot">
      <h2>Portfolio snapshot</h2>
      ${errorState(error)}
    </section>`;
  }

  // --- Donut data: portfolio composition (long / short / cash) -----------------
  const longCount = openPositions.filter((p) => p.direction === "long").length;
  const shortCount = openPositions.filter((p) => p.direction === "short").length;
  const otherCount = openPositions.length - longCount - shortCount;
  const totalExposurePct = openPositions.reduce((sum, p) => sum + (p.positionSizePct ?? 0), 0) * 100;
  // Cash is the implied remainder of the book -- "no position" is the default state,
  // so we surface it here as its own slice so the donut always has a meaningful shape
  // even when the book is light.
  const cashPctEquivalent = Math.max(0, 100 - totalExposurePct);
  // Convert the percentage-point "cash" into a count-equivalent so the donut's units
  // are consistent (counts of book slots, not raw exposure %). This is documented in
  // the subtitle so the reader knows what they're looking at.
  const compositionSegments = [
    { label: `Long (${longCount})`, value: longCount, color: "var(--color-success-text)" },
    { label: `Short (${shortCount})`, value: shortCount, color: "var(--color-danger-text)" },
    ...(otherCount > 0 ? [{ label: `Other (${otherCount})`, value: otherCount, color: "var(--color-warning-text)" }] : []),
    { label: `Cash (slots)`, value: Math.max(1, Math.round(cashPctEquivalent / 10)), color: "var(--chart-6)" },
  ];

  // --- Gauge data: total exposure ----------------------------------------------
  // Color-code by exposure band: <50% green, 50-80% amber, >80% red. The thresholds
  // are heuristic -- there's no formal risk policy in the system yet, this is just
  // a visual nudge.
  const exposureFraction = Math.max(0, Math.min(1, totalExposurePct / 100));
  const exposureAccent =
    totalExposurePct >= 80 ? "var(--color-danger-text)" :
    totalExposurePct >= 50 ? "var(--color-warning-text)" :
    "var(--color-success-text)";

  // --- Donut data: approval rate (all-time) ------------------------------------
  const approved = decisionStats.totals.approved ?? 0;
  const rejected = decisionStats.totals.rejected ?? 0;
  const otherStatusEntries = Object.entries(decisionStats.totals).filter(([status]) => status !== "approved" && status !== "rejected");
  const otherDecisions = otherStatusEntries.reduce((sum, [, count]) => sum + count, 0);
  const decidedTotal = approved + rejected;
  const approvalRatePct = decidedTotal > 0 ? Math.round((approved / decidedTotal) * 100) : null;
  const approvalSegments = [
    { label: "Approved", value: approved, color: "var(--color-success-text)" },
    { label: "Rejected", value: rejected, color: "var(--color-danger-text)" },
    ...(otherDecisions > 0 ? [{ label: "Other", value: otherDecisions, color: "var(--chart-6)" }] : []),
  ];

  return `<section id="snapshot">
    <h2>Portfolio snapshot</h2>
    <p class="note">Live state of the book right now: open positions, total exposure, and the all-time approval rate of trade decisions. All three panels read D1 directly on each page load, so the Refresh link in the toolbar above is what re-fetches them.</p>

    ${renderSummaryCards({ openPositions, closedPositions, decisionStats })}

    <div class="chart-row-3">
      ${donutChart(compositionSegments, {
        centerValue: String(openPositions.length),
        centerLabel: "open",
        title: "Book composition",
        subtitle: "long / short / cash slots",
      })}
      ${gaugeChart(exposureFraction, {
        valueLabel: totalExposurePct.toFixed(1) + "%",
        label: "total exposure",
        title: "Open exposure",
        subtitle: "sum of position size %",
        accent: exposureAccent,
      })}
      ${donutChart(approvalSegments, {
        centerValue: approvalRatePct !== null ? approvalRatePct + "%" : "--",
        centerLabel: "approval",
        title: "Decision outcomes",
        subtitle: "all-time, all statuses",
      })}
    </div>

    <section>
      <h2>Recently closed <span class="h2-count">${closedPositions.length}</span></h2>
      <p class="note">Last 20 exits. No exit price is recorded on close -- realized return can't be shown, only how and when a position closed.</p>
      ${closedPositions.length === 0
        ? `<p class="empty">None.</p>`
        : `<div class="table-wrap"><table>
          <thead><tr><th>Ticker</th><th>Direction</th><th>Size</th><th>Entry</th><th>Opened</th><th>Closed</th><th>Reason</th></tr></thead>
          <tbody>${closedPositions.map((p) => `<tr>
            <td class="ticker">${escapeHtml(p.ticker)}</td>
            <td>${escapeHtml(p.direction ?? "\u2014")}</td>
            <td class="num">${(p.positionSizePct * 100).toFixed(1)}%</td>
            <td class="num">${p.entryPrice != null ? "$" + Number(p.entryPrice).toFixed(2) : "\u2014"}</td>
            <td class="num">${fmtTime(p.openedAt)}</td>
            <td class="num">${fmtTime(p.closedAt)}</td>
            <td>${escapeHtml(p.closeReason ?? "\u2014")}</td>
          </tr>`).join("\n")}</tbody>
        </table></div>`}
    </section>
  </section>`;
}
