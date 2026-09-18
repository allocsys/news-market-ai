import { buildQuery, ACTIVITY_DAYS_OPTIONS, decisionsActivityChart, errorState } from "../helpers.js";

export function renderActivityView({ decisionStats, params, error }) {
  const activityFilterBarReal = `<div class="filter-bar">
    <div class="filter-group">
      <span class="filter-label">Window</span>
      <div class="pill-row">
        ${ACTIVITY_DAYS_OPTIONS.map(
          (d) => `<a href="${buildQuery(params, { activityDays: d })}" class="pill${d === params.activityDays ? " pill-active" : ""}">${d}d</a>`
        ).join("")}
      </div>
    </div>
  </div>`;

  return `<section id="activity">
    <h2>Decision activity</h2>
    <p class="note">Trade decisions per UTC calendar day, stacked by status. A zero-height day means the pipeline produced no decisions that day -- it doesn't distinguish "quiet market" from "run failed before reaching this stage" (see Recent pipeline activity below for that).</p>
    ${activityFilterBarReal}
    ${error ? errorState(error) : decisionsActivityChart(decisionStats.daily, params.activityDays)}
  </section>`;
}
