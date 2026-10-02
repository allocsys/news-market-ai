import { tickerStageCards, errorState, emptyState, escapeHtml, fmtShare } from "../helpers.js";

export function renderPipelineView({ checkpoints, tickerStages = [], error }) {
  // Per-stage distribution. Prefers the uncapped per-(ticker, stage) aggregate;
  // if that query failed (tickerStages empty) it falls back to tallying the
  // 30 most recent raw checkpoints so the panel still says something.
  const stageCounts = new Map();
  let total = 0;
  if (!error) {
    if (tickerStages.length > 0) {
      for (const r of tickerStages) {
        const stage = r.stage ?? "unknown";
        const n = Number(r.count) || 0;
        stageCounts.set(stage, (stageCounts.get(stage) ?? 0) + n);
        total += n;
      }
    } else {
      for (const c of checkpoints) {
        const stage = c.stage ?? "unknown";
        stageCounts.set(stage, (stageCounts.get(stage) ?? 0) + 1);
        total += 1;
      }
    }
  }
  const stageRows = [...stageCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([stage, count]) => {
      const pct = fmtShare(count, total || 1);
      return `<div class="stage-row">
        <span class="stage-name" title="${escapeHtml(stage)}">${escapeHtml(stage)}</span>
        <div class="stage-track" role="img" aria-label="${escapeHtml(stage)}: ${count} of ${total} (${pct})"><div class="stage-fill" style="width:${pct}"></div></div>
        <span class="stage-count">${count}</span>
      </div>`;
    }).join("");

  const stagePanel = total === 0 ? "" : `<div class="panel stage-panel">
    <div class="panel-header"><span class="panel-title">Stage distribution</span><span style="font-size:0.6875rem;color:var(--text-muted);font-family:var(--font-mono)">${total} checkpoint${total === 1 ? "" : "s"}</span></div>
    <div class="panel-body">${stageRows || emptyState("No checkpoints recorded.", { href: "/dashboard/backtest", label: "Run a backtest" })}</div>
  </div>`;

  return `<section id="pipeline">
    <h2>Recent pipeline activity</h2>
    <p class="note">Checkpoints per ticker by stage. A stuck run just stops adding to the counts; it isn't shown as a failure.</p>
    ${error ? errorState(error) : `${stagePanel}${tickerStageCards(tickerStages)}`}
  </section>`;
}
