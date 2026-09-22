// Overview command-center page (plan.md "Dashboard: Scoped UX Adoption"
// item 5). Visual layout matches prototype-ui-overhaul/src/components/dash/
// views/overview.tsx: an alert strip, the same 4 stat cards + 3-chart row
// Snapshot already renders (renderSummaryCards / donut+gauge+donut -- built
// here from the same data.js#getOverviewData props, not imported from
// snapshot.js, since the two pages are independent views that happen to
// share a visual recipe; not worth a cross-page helper for one screen each),
// a latest-decision panel + pipeline-pulse list side by side, and a
// quick-links strip. The prototype's ticker-spotlight grid is OUT of scope
// here -- it needs a ticker search / price feed, which is plan.md item 6 and
// deferred price-feed work, not this page.
//
// DELIBERATE SCOPE NOTE: the prototype's alert strip also flags an
// in-flight backfill/backtest job ("running job"). That isn't one of the
// four functions data.js#getOverviewData composes (getSnapshotData /
// getHealthData / getPipelineData / getDecisionsData), and pulling in
// getActiveJob here would mean a 5th D1 round trip this page's data
// function doesn't otherwise need. Left for a follow-up if it proves worth
// the extra read -- this alert strip covers stale ingestion sources, stuck
// pipeline checkpoints, and any panel that failed to load.
import {
  escapeHtml, fmtTime, errorState, donutChart, gaugeChart, renderSummaryCards, statusBadge, verdictCard, envSuffix,
} from "../helpers.js";

const SOURCE_LABEL = { news: "News", priceBars: "Price bars", fundamentals: "Fundamentals" };

function renderAlertStrip({ health, checkpoints, snapshotError, healthError, pipelineError, latestDecisionError }) {
  const items = [];
  if (snapshotError) items.push({ text: `Snapshot panel failed to load: ${snapshotError}`, danger: true });
  if (healthError) items.push({ text: `Health panel failed to load: ${healthError}`, danger: true });
  if (pipelineError) items.push({ text: `Pipeline panel failed to load: ${pipelineError}`, danger: true });
  if (latestDecisionError) items.push({ text: `Latest decision failed to load: ${latestDecisionError}`, danger: true });

  if (health) {
    for (const [key, stat] of Object.entries(health)) {
      if (stat && !stat.fresh) items.push({ text: `${SOURCE_LABEL[key] ?? key} ingestion is stale (no new rows in a while)` });
    }
  }
  const staleTickers = checkpoints.filter((c) => c.status === "stale").map((c) => c.ticker);
  if (staleTickers.length > 0) {
    items.push({ text: `${staleTickers.length} pipeline checkpoint${staleTickers.length === 1 ? "" : "s"} stuck: ${staleTickers.join(", ")}` });
  }

  if (items.length === 0) {
    return `<div class="panel" style="margin-bottom:1.75rem"><div class="panel-body" style="display:flex;align-items:center;gap:0.6rem">
      <span class="ok-flag">nominal</span>
      <span style="color:var(--text-muted);font-size:0.8125rem">All systems nominal -- no stale sources, no stuck checkpoints, no panel errors.</span>
    </div></div>`;
  }
  const rows = items
    .map(
      (i) => `<div style="display:flex;align-items:center;gap:0.6rem;padding:0.35rem 0">
        <span class="stale-flag"${i.danger ? ' style="color:var(--color-danger-text);background:var(--color-danger-bg);border-color:rgba(239,68,68,0.28)"' : ""}>${i.danger ? "error" : "stale"}</span>
        <span style="color:var(--text-main);font-size:0.8125rem">${escapeHtml(i.text)}</span>
      </div>`
    )
    .join("");
  return `<div class="panel" style="margin-bottom:1.75rem">
    <div class="panel-header"><span class="panel-title">Attention needed</span></div>
    <div class="panel-body">${rows}</div>
  </div>`;
}

// Same composition Snapshot's donut/gauge row uses (book composition, open
// exposure, decision outcomes) -- see this file's header for why it's
// duplicated here rather than imported from snapshot.js.
function renderChartRow({ openPositions, decisionStats, totalExposurePct }) {
  const longCount = openPositions.filter((p) => p.direction === "long").length;
  const shortCount = openPositions.filter((p) => p.direction === "short").length;
  const otherCount = openPositions.length - longCount - shortCount;
  const compositionSegments = [
    { label: `Long (${longCount})`, value: longCount, color: "var(--color-success-text)" },
    { label: `Short (${shortCount})`, value: shortCount, color: "var(--color-danger-text)" },
    ...(otherCount > 0 ? [{ label: `Other (${otherCount})`, value: otherCount, color: "var(--color-warning-text)" }] : []),
  ];

  const exposureFraction = Math.max(0, Math.min(1, totalExposurePct / 100));
  const exposureAccent =
    totalExposurePct >= 80 ? "var(--color-danger-text)" : totalExposurePct >= 50 ? "var(--color-warning-text)" : "var(--color-success-text)";

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

  return `<div class="chart-row-3">
    ${donutChart(compositionSegments, { centerValue: String(openPositions.length), centerLabel: "open", title: "Book composition", subtitle: "open positions by direction" })}
    ${gaugeChart(exposureFraction, { valueLabel: totalExposurePct.toFixed(1) + "%", label: "total exposure", title: "Open exposure", subtitle: "sum of position size %", accent: exposureAccent })}
    ${donutChart(approvalSegments, { centerValue: approvalRatePct !== null ? approvalRatePct + "%" : "--", centerLabel: "approval", title: "Decision outcomes", subtitle: "all-time, all statuses" })}
  </div>`;
}

function renderLatestDecisionPanel(d, error) {
  if (error) {
    return `<div class="panel"><div class="panel-header"><span class="panel-title">Latest decision</span></div><div class="panel-body">${errorState(error)}</div></div>`;
  }
  if (!d) {
    return `<div class="panel"><div class="panel-header"><span class="panel-title">Latest decision</span></div><div class="panel-body"><p class="empty">No decisions recorded yet.</p></div></div>`;
  }
  return `<div class="panel">
    <div class="panel-header"><span class="panel-title">Latest decision</span><span style="font-family:var(--font-mono);font-size:0.6875rem;color:var(--text-muted)">${fmtTime(d.createdAt)}</span></div>
    <div class="panel-body">
      <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:0.75rem;flex-wrap:wrap">
        <span class="ticker" style="font-family:var(--font-mono);font-weight:600">${escapeHtml(d.ticker)}</span>
        <span style="color:var(--text-muted);font-size:0.8125rem">${escapeHtml(d.thesis?.direction ?? "\u2014")}</span>
        ${statusBadge(d.status)}
      </div>
      <p class="note" style="margin-bottom:0.75rem">${escapeHtml(d.portfolioDecision?.reason ?? d.riskDecision?.reason ?? "\u2014")}</p>
      ${verdictCard(d)}
    </div>
  </div>`;
}

function renderPipelinePulse(checkpoints, error) {
  if (error) {
    return `<div class="panel"><div class="panel-header"><span class="panel-title">Pipeline pulse</span></div><div class="panel-body">${errorState(error)}</div></div>`;
  }
  if (checkpoints.length === 0) {
    return `<div class="panel"><div class="panel-header"><span class="panel-title">Pipeline pulse</span></div><div class="panel-body"><p class="empty">No pipeline activity recorded yet.</p></div></div>`;
  }
  const rows = checkpoints
    .slice(0, 10)
    .map((c) => {
      const dotColor = c.status === "stale" ? "var(--color-warning-text)" : "var(--color-success-text)";
      return `<div style="display:flex;align-items:center;gap:0.6rem;padding:0.4rem 0;border-bottom:1px solid var(--border-subtle)">
        <span style="width:8px;height:8px;border-radius:50%;background:${dotColor};flex-shrink:0" title="${c.status === "stale" ? "stale" : "ok"}"></span>
        <span class="ticker" style="font-family:var(--font-mono);font-weight:600;min-width:64px">${escapeHtml(c.ticker)}</span>
        <span style="flex:1;color:var(--text-muted);font-size:0.8125rem">${escapeHtml(c.lastStageLabel)}</span>
        <span style="font-family:var(--font-mono);font-size:0.75rem;color:var(--text-subtle)">${fmtTime(c.updated_at)}</span>
      </div>`;
    })
    .join("");
  return `<div class="panel">
    <div class="panel-header"><span class="panel-title">Pipeline pulse</span><span style="font-size:0.6875rem;color:var(--text-muted);font-family:var(--font-mono)">${checkpoints.length} recent</span></div>
    <div class="panel-body">${rows}</div>
  </div>`;
}

// "Activity"/"LLM Calls" are env-aware (helpers.js#ENV_SECTIONS), so they carry
// the resolved environment along; "Backtest"/"Health" are env-unaware (see
// ENV_SECTIONS's own comment) and never take an env suffix.
function renderQuickLinks(env) {
  const links = [
    [`/dashboard/activity${envSuffix(env)}`, "Activity"],
    [`/dashboard/llm${envSuffix(env)}`, "LLM Calls"],
    [`/dashboard/backtest`, "Backtest"],
    [`/dashboard/health`, "Health"],
  ];
  return `<div class="filter-bar" style="margin-top:0.25rem">${links.map(([href, label]) => `<a href="${href}" class="btn btn-secondary">${escapeHtml(label)} &rarr;</a>`).join("")}</div>`;
}

export function renderOverviewView({
  openPositions, closedPositions, decisionStats, totalExposurePct, snapshotError,
  health, healthError, checkpoints, pipelineError,
  latestDecision, latestDecisionError, resolvedEnv,
}) {
  return `<section id="overview">
    <h2>Overview</h2>
    <p class="note">Command-center read of the live book: open risk, recent decision outcomes, source and pipeline health, and the most recent decision the system made. Every panel below reads independently, so one panel failing to load doesn't blank the rest -- see the alert strip for what's wrong, if anything.</p>

    ${renderAlertStrip({ health, checkpoints, snapshotError, healthError, pipelineError, latestDecisionError })}

    ${renderSummaryCards({ openPositions, closedPositions, decisionStats, totalExposurePct })}

    ${renderChartRow({ openPositions, decisionStats, totalExposurePct })}

    <div class="chart-row-2">
      ${renderLatestDecisionPanel(latestDecision, latestDecisionError)}
      ${renderPipelinePulse(checkpoints, pipelineError)}
    </div>

    ${renderQuickLinks(resolvedEnv)}
  </section>`;
}
