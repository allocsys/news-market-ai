import { buildQuery, ACTIVITY_DAYS_OPTIONS, DECISION_APPROVED_STATUS, decisionsActivityChart, errorState, miniStats } from "../helpers.js";

export function renderActivityView({ decisionStats, params, error }) {
  const activityFilterBarReal = `<div class="filter-bar filter-bar-scroll">
    <div class="filter-group">
      <span class="filter-label">Window</span>
      <div class="pill-row">
        ${ACTIVITY_DAYS_OPTIONS.map(
          (d) => `<a href="${buildQuery(params, { activityDays: d })}" class="pill${d === params.activityDays ? " pill-active" : ""}">${d}d</a>`
        ).join("")}
      </div>
    </div>
  </div>`;

  // All-time totals -- these come back from getDecisionStats as `totals`,
  // keyed by status. Same shape the Snapshot page uses for its approval-rate
  // card. Surfacing them here gives the operator a quick read alongside the
  // per-day chart without flipping pages.
  const totals = decisionStats.totals ?? {};
  const approved = totals[DECISION_APPROVED_STATUS] ?? 0;
  const rejected = totals.rejected ?? 0;
  const decidedTotal = approved + rejected;
  const approvalPct = decidedTotal > 0 ? Math.round((approved / decidedTotal) * 100) : null;
  const dailyTotal = (decisionStats.daily ?? []).reduce((sum, row) => sum + (row.count ?? 0), 0);

  const summaryPanel = `<div class="panel">
    <div class="panel-body">
      ${miniStats(
        [
          { value: dailyTotal, label: "Decisions (window)" },
          { value: approved, label: "Approved (all-time)", color: "var(--color-success-text)" },
          { value: rejected, label: "Rejected (all-time)", color: "var(--color-danger-text)" },
          { value: approvalPct !== null ? approvalPct + "%" : "--", label: "Approval (all-time)", color: "var(--accent-bright)" },
        ],
        { cols: 2 }
      )}
    </div>
  </div>`;

  return `<section id="activity">
    <h2>Decision activity</h2>
    <p class="note">Decisions per UTC day, stacked by status. An empty day means none were produced, not necessarily a failure.</p>
    ${activityFilterBarReal}
    ${error ? errorState(error) : `
      <div class="activity-summary">${summaryPanel}</div>
      ${decisionsActivityChart(decisionStats.daily, params.activityDays)}
    `}
  </section>`;
}
