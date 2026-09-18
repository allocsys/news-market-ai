import {
  pillLinks, decisionsTable, DECISION_STATUS_OPTIONS, DECISION_LIMIT_OPTIONS,
  errorState, donutChart, escapeHtml,
} from "../helpers.js";

export function renderDecisionsView({ decisions, params, error }) {
  const decisionsFilterBar = `<div class="filter-bar">
    ${pillLinks("Status", DECISION_STATUS_OPTIONS, params.decisionStatus, "decisionStatus", params)}
    ${pillLinks("Rows", DECISION_LIMIT_OPTIONS, params.decisionLimit, "decisionLimit", params)}
  </div>`;

  if (error) {
    return `<section id="decisions">
      <h2>Recent trade decisions</h2>
      <p class="note">Full decision chain (thesis + risk + portfolio sign-off) for every completed run. Expand "LLM reasoning" on a row to see the Analyst Team's opinions, the bull/bear debate, the judge's verdict, and the trader's rationale that produced it -- rows from before this feature shipped show "not recorded" instead.</p>
      ${decisionsFilterBar}
      ${errorState(error)}
    </section>`;
  }

  // Tally the visible decisions (not the all-time totals -- this is the slice
  // currently on screen, which changes with the Status/Rows filters above).
  // The subtitle calls this out so the donut isn't misread as the all-time rate
  // (that lives on the Snapshot page).
  const approved = decisions.filter((d) => d.status === "approved").length;
  const rejected = decisions.filter((d) => d.status === "rejected").length;
  const otherCount = decisions.length - approved - rejected;
  const decidedTotal = approved + rejected;
  const approvalPct = decidedTotal > 0 ? Math.round((approved / decidedTotal) * 100) : null;

  const approvalDonut = donutChart(
    [
      { label: "Approved", value: approved, color: "var(--color-success-text)" },
      { label: "Rejected", value: rejected, color: "var(--color-danger-text)" },
      ...(otherCount > 0 ? [{ label: "Other", value: otherCount, color: "var(--chart-6)" }] : []),
    ],
    {
      centerValue: approvalPct !== null ? approvalPct + "%" : "--",
      centerLabel: "approved",
      title: "This view",
      subtitle: "of currently visible decisions",
    }
  );

  return `<section id="decisions">
    <h2>Recent trade decisions <span class="h2-count">${decisions.length}</span></h2>
    <p class="note">Full decision chain (thesis + risk + portfolio sign-off) for every completed run. Expand "LLM reasoning" on a row to see the Analyst Team's opinions, the bull/bear debate, the judge's verdict, and the trader's rationale that produced it -- rows from before this feature shipped show "not recorded" instead.</p>
    ${decisionsFilterBar}

    <div class="chart-row-2">
      ${approvalDonut}
      <div class="panel">
        <div class="panel-header"><span class="panel-title">Direction split</span></div>
        <div class="panel-body">
          ${decisions.length === 0 ? `<p class="empty">No decisions match this filter.</p>` : (() => {
            const longs = decisions.filter((d) => d.thesis?.direction === "long").length;
            const shorts = decisions.filter((d) => d.thesis?.direction === "short").length;
            const neutral = decisions.length - longs - shorts;
            const total = decisions.length || 1;
            const bar = (count, color) => `<div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:0.6rem"><span style="font-size:0.75rem;color:var(--text-muted);min-width:60px">${escapeHtml(color === "var(--color-success-text)" ? "Long" : color === "var(--color-danger-text)" ? "Short" : "Neutral")}</span><div style="flex:1;height:8px;background:var(--bg-elevated);border-radius:4px;overflow:hidden"><div style="width:${(count/total*100).toFixed(1)}%;height:100%;background:${color};border-radius:4px"></div></div><span style="font-family:var(--font-mono);font-size:0.75rem;color:var(--text-main);min-width:48px;text-align:right">${count} (${(count/total*100).toFixed(0)}%)</span></div>`;
            return bar(longs, "var(--color-success-text)") + bar(shorts, "var(--color-danger-text)") + (neutral > 0 ? bar(neutral, "var(--chart-6)") : "");
          })()}
        </div>
      </div>
    </div>

    ${decisionsTable(decisions)}
  </section>`;
}
