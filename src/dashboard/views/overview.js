// Today screen (phone-first redesign step 2, replaces the old Overview layout).
// One screen = one question: "is everything OK, and what is open right now?"
//   1. Status hero: health pill + the two numbers that matter (open positions,
//      open exposure).
//   2. Attention list: only rendered when something is stale / stuck / failed.
//   3. Latest decision as one card; the full verdict sits behind an expander.
//   4. Everything else (all counts, charts, pipeline pulse) behind expanders.
// Same props as before (data.js#getOverviewData), so no data-layer change.
// An in-flight backfill/backtest job is still not flagged here (it would need a
// 5th D1 read); the landing shell already shows the backtest progress card.
import {
  escapeHtml, fmtTime, errorState, emptyState, renderSummaryCards, renderBookCharts, decisionBadge, verdictCard, envSuffix,
} from "../helpers.js";

const SOURCE_LABEL = { news: "News", priceBars: "Price bars", fundamentals: "Fundamentals" };

/** Everything that needs a look, in one list: {text, danger}. Empty array = all clear. */
export function attentionItems({ health, checkpoints, snapshotError, healthError, pipelineError, latestDecisionError }) {
  const items = [];
  if (snapshotError) items.push({ text: `Positions failed to load: ${snapshotError}`, danger: true });
  if (healthError) items.push({ text: `Health failed to load: ${healthError}`, danger: true });
  if (pipelineError) items.push({ text: `Pipeline failed to load: ${pipelineError}`, danger: true });
  if (latestDecisionError) items.push({ text: `Latest decision failed to load: ${latestDecisionError}`, danger: true });
  if (health) {
    for (const [key, stat] of Object.entries(health)) {
      if (stat && !stat.fresh) items.push({ text: `${SOURCE_LABEL[key] ?? key} ingestion is stale (no new rows in a while)` });
    }
  }
  const stuck = (checkpoints ?? []).filter((c) => c.status === "stale").map((c) => c.ticker);
  if (stuck.length > 0) items.push({ text: `${stuck.length} pipeline checkpoint${stuck.length === 1 ? "" : "s"} stuck: ${stuck.join(", ")}` });
  return items;
}

function renderStatusHero({ items, openPositions, totalExposurePct, snapshotError }) {
  const hasDanger = items.some((i) => i.danger);
  const tone = items.length === 0 ? "ok" : hasDanger ? "bad" : "warn";
  const label = items.length === 0 ? "All clear" : `${items.length} need${items.length === 1 ? "s" : ""} attention`;
  const longCount = openPositions.filter((p) => p.direction === "long").length;
  const shortCount = openPositions.filter((p) => p.direction === "short").length;
  const numbers = snapshotError
    ? `<div class="today-numbers-error">${errorState(snapshotError)}</div>`
    : `<div class="today-numbers">
        <a class="today-big" href="/dashboard/positions">
          <span class="today-big-value">${openPositions.length}</span>
          <span class="today-big-label">Open positions</span>
          <span class="today-big-sub">${longCount} long / ${shortCount} short</span>
        </a>
        <a class="today-big" href="/dashboard/positions">
          <span class="today-big-value">${escapeHtml(totalExposurePct.toFixed(1))}%</span>
          <span class="today-big-label">Open exposure</span>
          <span class="today-big-sub">of portfolio</span>
        </a>
      </div>`;
  return `<div class="panel today-hero">
    <div class="panel-body">
      <div class="today-status today-status--${tone}" role="status"><span class="today-dot" aria-hidden="true"></span>${escapeHtml(label)}</div>
      ${numbers}
    </div>
  </div>`;
}

function renderAttentionList(items) {
  if (items.length === 0) return "";
  const rows = items
    .map(
      (i) => `<li class="today-attn-row">
        <span class="stale-flag${i.danger ? " stale-flag--danger" : ""}">${i.danger ? "error" : "stale"}</span>
        <span class="today-attn-text">${escapeHtml(i.text)}</span>
      </li>`
    )
    .join("");
  return `<div class="panel today-attn"><div class="panel-header"><span class="panel-title">Attention needed</span></div><div class="panel-body"><ul class="today-attn-list">${rows}</ul></div></div>`;
}

function renderLatestDecisionCard(d, error, env) {
  const head = (meta = "") => `<div class="panel-header"><span class="panel-title">Latest decision</span>${meta}</div>`;
  if (error) return `<div class="panel">${head()}<div class="panel-body">${errorState(error)}</div></div>`;
  if (!d) {
    return `<div class="panel">${head()}<div class="panel-body">${emptyState("No decisions recorded yet.", { href: `/dashboard/decisions${envSuffix(env)}`, label: "Open Signals" })}</div></div>`;
  }
  return `<div class="panel">
    ${head(`<span class="today-meta">${fmtTime(d.createdAt)}</span>`)}
    <div class="panel-body">
      <div class="today-decision-row">
        <span class="ticker today-decision-ticker">${escapeHtml(d.ticker)}</span>
        <span class="today-decision-dir">${escapeHtml(d.thesis?.direction ?? "\u2014")}</span>
        ${decisionBadge(d.status)}
      </div>
      <p class="note today-decision-reason">${escapeHtml(d.portfolioDecision?.reason ?? d.riskDecision?.reason ?? "\u2014")}</p>
      <details class="llm-answer"><summary>Full verdict</summary><div class="llm-answer-body maxw-none">${verdictCard(d)}</div></details>
      <a class="today-link" href="/dashboard/decisions${envSuffix(env)}">All decisions &rarr;</a>
    </div>
  </div>`;
}

function renderPipelinePulse(checkpoints, error) {
  if (error) return errorState(error);
  if (checkpoints.length === 0) return emptyState("No pipeline activity recorded yet.", { href: "/dashboard/backtest", label: "Run a backtest" });
  return checkpoints
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
}

function expander(title, bodyHtml) {
  return `<details class="llm-answer today-more"><summary>${escapeHtml(title)}</summary><div class="llm-answer-body maxw-none">${bodyHtml}</div></details>`;
}

export function renderOverviewView({
  openPositions, closedPositions, decisionStats, totalExposurePct, snapshotError,
  health, healthError, checkpoints, pipelineError,
  latestDecision, latestDecisionError, resolvedEnv,
}) {
  const items = attentionItems({ health, checkpoints, snapshotError, healthError, pipelineError, latestDecisionError });
  const snapshotOk = !snapshotError;
  return `<section id="overview" class="today">
    <h2>Today</h2>
    ${renderStatusHero({ items, openPositions, totalExposurePct, snapshotError })}
    ${renderAttentionList(items)}
    ${renderLatestDecisionCard(latestDecision, latestDecisionError, resolvedEnv)}
    ${snapshotOk ? expander("All numbers", renderSummaryCards({ openPositions, closedPositions, decisionStats, totalExposurePct })) : ""}
    ${snapshotOk ? expander("Charts", renderBookCharts({ openPositions, decisionStats, totalExposurePct })) : ""}
    ${expander("Pipeline pulse", renderPipelinePulse(checkpoints, pipelineError))}
  </section>`;
}
