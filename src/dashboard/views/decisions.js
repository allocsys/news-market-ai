import {
  pillLinks, decisionsTable, DECISION_STATUS_OPTIONS, DECISION_LIMIT_OPTIONS, DECISION_APPROVED_STATUS,
  errorState, emptyState, fmtShare, escapeHtml,
} from "../helpers.js";

const DECISIONS_INTRO = `<p class="note">Thesis, risk and portfolio sign-off per decision. Expand a row for the LLM reasoning.</p>`;

/**
 * One stacked share bar with an inline legend underneath. Segments with a zero
 * count are skipped. Colors are CSS vars; widths/aria carry the numbers.
 */
function stackBar(title, parts, total) {
  const live = parts.filter((p) => p.count > 0);
  const segs = live
    .map((p) => `<div class="stack-seg" style="width:${fmtShare(p.count, total, 1)};background:${p.color}" role="img" aria-label="${escapeHtml(p.name)}: ${p.count} of ${total} (${fmtShare(p.count, total)})"></div>`)
    .join("");
  const legend = live
    .map((p) => `<span class="stack-key"><span class="stack-dot" style="background:${p.color}"></span>${escapeHtml(p.name)} <b>${p.count}</b> <span class="stack-pct">${fmtShare(p.count, total)}</span></span>`)
    .join("");
  return `<div class="stack">
    <div class="stack-title">${escapeHtml(title)}</div>
    <div class="stack-bar">${segs}</div>
    <div class="stack-legend">${legend}</div>
  </div>`;
}

export function renderDecisionsView({ decisions, params, error }) {
  const decisionsFilterBar = `<div class="filter-bar filter-bar-scroll">
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

  // Tally the visible decisions (not all-time totals -- this is the slice
  // currently on screen, which changes with the Status/Rows filters above).
  // Every share below is out of the same visible total so the numbers agree.
  const total = decisions.length;
  const approved = decisions.filter((d) => d.status === DECISION_APPROVED_STATUS).length;
  const rejected = decisions.filter((d) => d.status === "rejected").length;
  const otherCount = total - approved - rejected;
  const longs = decisions.filter((d) => d.thesis?.direction === "long").length;
  const shorts = decisions.filter((d) => d.thesis?.direction === "short").length;
  const neutral = total - longs - shorts; // neutral OR no thesis recorded

  const outcomeBar = stackBar(
    "Outcome",
    [
      { name: "Approved", count: approved, color: "var(--color-success-text)" },
      { name: "Rejected", count: rejected, color: "var(--color-danger-text)" },
      { name: "Other", count: otherCount, color: "var(--chart-6)" },
    ],
    total
  );
  const directionBar = stackBar(
    "Direction",
    [
      { name: "Long", count: longs, color: "var(--color-success-text)" },
      { name: "Short", count: shorts, color: "var(--color-danger-text)" },
      { name: "Neutral", count: neutral, color: "var(--chart-6)" },
    ],
    total
  );

  return `<section id="decisions">
    <h2>Recent trade decisions <span class="h2-count">${total}</span></h2>
    ${DECISIONS_INTRO}
    ${decisionsFilterBar}

    <div class="panel decisions-summary">
      <div class="panel-header"><span class="panel-title">This view <span class="summary-count">${total}</span></span></div>
      <div class="panel-body">${outcomeBar}${directionBar}</div>
    </div>

    ${decisionsTable(decisions)}
  </section>`;
}
