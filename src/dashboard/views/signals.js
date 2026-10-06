import {
  pillLinks, DECISION_STATUS_OPTIONS, DECISION_APPROVED_STATUS,
  errorState, escapeHtml, fmtShare, decisionsActivityChart
} from "../helpers.js";
import { decisionCards } from "../decision_cards.js";

/**
 * Renders a stacked bar chart with inline legend.
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

/**
 * Renders the compact stack-bar direction/outcome summary panel.
 */
function renderSummaryPanel(decisions) {
  const total = decisions.length;
  if (total === 0) return "";

  const approved = decisions.filter((d) => d.status === DECISION_APPROVED_STATUS).length;
  const rejected = decisions.filter((d) => d.status === "rejected").length;
  const otherCount = total - approved - rejected;
  const longs = decisions.filter((d) => d.thesis?.direction === "long").length;
  const shorts = decisions.filter((d) => d.thesis?.direction === "short").length;
  const neutral = total - longs - shorts;

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

  return `<div class="panel decisions-summary">
    <div class="panel-header"><span class="panel-title">This view</span></div>
    <div class="panel-body">${outcomeBar}${directionBar}</div>
  </div>`;
}

/**
 * Signals view (overhaul step 4/6). Shows pipeline stage strip,
 * decision filters, stack-bar summary panel, phone-first decision feed,
 * and collapsed daily activity chart.
 */
export function renderSignalsView({ decisions = [], tickerStages = [], checkpoints = [], decisionStats, params = {}, error }) {
  // Aggregate counts per stage
  const stageCounts = new Map();
  if (tickerStages && tickerStages.length > 0) {
    for (const r of tickerStages) {
      if (!r) continue;
      const stage = r.stage ?? "unknown";
      const n = Number(r.count) || 0;
      stageCounts.set(stage, (stageCounts.get(stage) ?? 0) + n);
    }
  } else if (checkpoints && checkpoints.length > 0) {
    for (const c of checkpoints) {
      if (!c) continue;
      const stage = c.stage ?? "unknown";
      stageCounts.set(stage, (stageCounts.get(stage) ?? 0) + 1);
    }
  }

  const sortedStages = [...stageCounts.entries()].sort((a, b) => b[1] - a[1]);
  const chipsHtml = sortedStages
    .map(([stage, count]) => `<span class="sig-chip">${escapeHtml(stage)} ${count}</span>`)
    .join("\n");

  const stripHtml = `<div class="sig-strip">${chipsHtml}</div>`;

  // Decision filter pills with class "filter-bar filter-bar-scroll" preserved
  const filterBarHtml = `<div class="filter-bar filter-bar-scroll">
    ${pillLinks("Status", DECISION_STATUS_OPTIONS, params.decisionStatus || "all", "decisionStatus", params)}
  </div>`;

  let feedAndSummary = "";
  if (error) {
    feedAndSummary = errorState(error);
  } else if (decisions.length === 0) {
    feedAndSummary = decisionCards([]);
  } else {
    const summaryPanel = renderSummaryPanel(decisions);
    const feed = decisionCards(decisions);
    feedAndSummary = `${summaryPanel}\n${feed}`;
  }

  let activityExpander = "";
  if (!error && decisionStats?.daily) {
    const activityDays = params.activityDays ?? 14;
    const chartHtml = decisionsActivityChart(decisionStats.daily, activityDays);
    activityExpander = `<details class="sig-activity">
      <summary>Daily activity</summary>
      <div class="panel-body">
        ${chartHtml}
      </div>
    </details>`;
  }

  return `<section id="signals">
    <h2>Signals</h2>
    ${stripHtml}
    ${filterBarHtml}
    ${feedAndSummary}
    ${activityExpander}
  </section>`;
}
