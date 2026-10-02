import {
  pillLinks, decisionsTable, DECISION_STATUS_OPTIONS, DECISION_LIMIT_OPTIONS, DECISION_APPROVED_STATUS,
  errorState, emptyState, fmtShare, donutChart, escapeHtml,
} from "../helpers.js";

const DECISIONS_INTRO = `<p class="note">Thesis, risk and portfolio sign-off for each decision. Expand "LLM reasoning" on a row for the analyst opinions, bull/bear debate and verdict; older rows show "not recorded".</p>`;

/** One horizontal share bar: label, filled track, "count (share)". Colors are CSS vars; widths/aria carry the numbers. */
function splitBar(name, count, total, color) {
  return `<div class="split-row">
    <span class="split-label">${escapeHtml(name)}</span>
    <div class="split-track" role="img" aria-label="${escapeHtml(name)}: ${count} of ${total} (${fmtShare(count, total)})"><div class="split-fill" style="width:${fmtShare(count, total, 1)};background:${color}"></div></div>
    <span class="split-value">${count} (${fmtShare(count, total)})</span>
  </div>`;
}

export function renderDecisionsView({ decisions, params, error }) {
  const decisionsFilterBar = `<div class="filter-bar">
    ${pillLinks("Status", DECISION_STATUS_OPTIONS, params.decisionStatus, "decisionStatus", params)}
    ${pillLinks("Rows", DECISION_LIMIT_OPTIONS, params.decisionLimit, "decisionLimit", params)}
  </div>`;

  if (error) {
    return `<section id="decisions">
      <h2>Recent trade decisions</h2>
      ${DECISIONS_INTRO}
      ${decisionsFilterBar}
      ${errorState(error)}
    </section>`;
  }

  if (decisions.length === 0) {
    return `<section id="decisions">
      <h2>Recent trade decisions <span class="h2-count">0</span></h2>
      ${DECISIONS_INTRO}
      ${decisionsFilterBar}
      ${emptyState("No decisions match this filter.", { href: "/dashboard/decisions", label: "Clear filters" })}
    </section>`;
  }

  // Tally the visible decisions (not the all-time totals -- this is the slice
  // currently on screen, which changes with the Status/Rows filters above).
  // The subtitle calls this out so the donut isn't misread as the all-time rate
  // (that lives on the Snapshot page).
  const approved = decisions.filter((d) => d.status === DECISION_APPROVED_STATUS).length;
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
      centerValue: approvalPct !== null ? approvalPct + "%" : "\u2014",
      centerLabel: "approved",
      title: "This view",
      subtitle: "of currently visible decisions",
    }
  );

  const longs = decisions.filter((d) => d.thesis?.direction === "long").length;
  const shorts = decisions.filter((d) => d.thesis?.direction === "short").length;
  const neutral = decisions.length - longs - shorts; // neutral OR no thesis recorded
  const total = decisions.length;
  const directionBars =
    splitBar("Long", longs, total, "var(--color-success-text)") +
    splitBar("Short", shorts, total, "var(--color-danger-text)") +
    (neutral > 0 ? splitBar("Neutral", neutral, total, "var(--chart-6)") : "");

  return `<section id="decisions">
    <h2>Recent trade decisions <span class="h2-count">${decisions.length}</span></h2>
    ${DECISIONS_INTRO}
    ${decisionsFilterBar}

    <div class="chart-row-2">
      ${approvalDonut}
      <div class="panel">
        <div class="panel-header"><span class="panel-title">Direction split</span></div>
        <div class="panel-body">${directionBars}</div>
      </div>
    </div>

    ${decisionsTable(decisions)}
  </section>`;
}
