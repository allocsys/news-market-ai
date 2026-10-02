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
//
// Mobile (<768px) reorders the blocks with CSS `order` (see the .ov-* rules
// in shell.js): alert, cards, latest-decision + pulse panels, then charts.
import {
  escapeHtml, fmtTime, errorState, emptyState, renderSummaryCards, renderBookCharts, decisionBadge, verdictCard, envSuffix,
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
    return `<div class="panel ov-alert-panel"><div class="panel-body ov-ok-panel-body">
      <span class="ok-flag">nominal</span>
      <span class="ov-alert-text">All systems nominal -- no stale sources, no stuck checkpoints, no panel errors.</span>
    </div></div>`;
  }
  const rows = items
    .map(
      (i) => `<div class="ov-alert-row">
        <span class="stale-flag${i.danger ? " stale-flag--danger" : ""}">${i.danger ? "error" : "stale"}</span>
        <span class="ov-alert-text">${escapeHtml(i.text)}</span>
      </div>`
    )
    .join("");
  return `<div class="panel ov-alert-panel">
    <div class="panel-header"><span class="panel-title">Attention needed</span></div>
    <div class="panel-body">${rows}</div>
  </div>`;
}

function renderLatestDecisionPanel(d, error, env) {
  if (error) {
    return `<div class="panel"><div class="panel-header"><span class="panel-title">Latest decision</span></div><div class="panel-body">${errorState(error)}</div></div>`;
  }
  if (!d) {
    return `<div class="panel"><div class="panel-header"><span class="panel-title">Latest decision</span></div><div class="panel-body">${emptyState("No decisions recorded yet.", { href: `/dashboard/activity${envSuffix(env)}`, label: "See recent activity" })}</div></div>`;
  }
  return `<div class="panel">
    <div class="panel-header"><span class="panel-title">Latest decision</span><span class="ov-panel-meta">${fmtTime(d.createdAt)}</span></div>
    <div class="panel-body">
      <div class="ov-decision-header-row">
        <span class="ticker ov-decision-ticker">${escapeHtml(d.ticker)}</span>
        <span class="ov-decision-sub">${escapeHtml(d.thesis?.direction ?? "\u2014")}</span>
        ${decisionBadge(d.status)}
      </div>
      <p class="note ov-decision-note">${escapeHtml(d.portfolioDecision?.reason ?? d.riskDecision?.reason ?? "\u2014")}</p>
      ${verdictCard(d)}
    </div>
  </div>`;
}

function renderPipelinePulse(checkpoints, error) {
  if (error) {
    return `<div class="panel"><div class="panel-header"><span class="panel-title">Pipeline pulse</span></div><div class="panel-body">${errorState(error)}</div></div>`;
  }
  if (checkpoints.length === 0) {
    return `<div class="panel"><div class="panel-header"><span class="panel-title">Pipeline pulse</span></div><div class="panel-body">${emptyState("No pipeline activity recorded yet.", { href: "/dashboard/backtest", label: "Run a backtest" })}</div></div>`;
  }
  const rows = checkpoints
    .slice(0, 10)
    .map((c) => {
      const isStale = c.status === "stale";
      return `<div class="ov-pulse-row">
        <span class="ov-pulse-dot ${isStale ? "ov-dot--stale" : "ov-dot--ok"}" title="${isStale ? "stale" : "ok"}"></span>
        <span class="ticker ov-pulse-ticker">${escapeHtml(c.ticker)}</span>
        <span class="ov-pulse-stage">${escapeHtml(c.lastStageLabel)}</span>
        <span class="ov-pulse-time">${fmtTime(c.updated_at)}</span>
      </div>`;
    })
    .join("");
  return `<div class="panel">
    <div class="panel-header"><span class="panel-title">Pipeline pulse</span><span class="ov-panel-meta">${checkpoints.length} recent</span></div>
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
  return `<div class="filter-bar ov-quick-links">${links.map(([href, label]) => `<a href="${href}" class="btn btn-secondary">${escapeHtml(label)} &rarr;</a>`).join("")}</div>`;
}

export function renderOverviewView({
  openPositions, closedPositions, decisionStats, totalExposurePct, snapshotError,
  health, healthError, checkpoints, pipelineError,
  latestDecision, latestDecisionError, resolvedEnv,
}) {
  return `<section id="overview">
    <h2>Overview</h2>
    <p class="note">Open risk, recent decision outcomes, source and pipeline health, and the latest decision. Each panel loads independently.</p>

    <div class="ov-charts">${renderBookCharts({ openPositions, decisionStats, totalExposurePct })}</div>

    <div class="ov-alert">${renderAlertStrip({ health, checkpoints, snapshotError, healthError, pipelineError, latestDecisionError })}</div>

    <div class="ov-cards">${renderSummaryCards({ openPositions, closedPositions, decisionStats, totalExposurePct })}</div>

    <div class="ov-panels chart-row-2">
      ${renderLatestDecisionPanel(latestDecision, latestDecisionError, resolvedEnv)}
      ${renderPipelinePulse(checkpoints, pipelineError)}
    </div>

    <div class="ov-links">${renderQuickLinks(resolvedEnv)}</div>
  </section>`;
}
