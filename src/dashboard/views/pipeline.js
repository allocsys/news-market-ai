import { checkpointsTable, errorState, escapeHtml } from "../helpers.js";

export function renderPipelineView({ checkpoints, error }) {
  // Per-stage distribution -- the table shows latest stage per ticker, but
  // summarizing the same data as a per-stage tally gives the operator a quick
  // "where in the pipeline is everyone right now" read.
  const stageCounts = new Map();
  if (!error) {
    for (const c of checkpoints) {
      const stage = c.stage ?? "unknown";
      stageCounts.set(stage, (stageCounts.get(stage) ?? 0) + 1);
    }
  }
  const stageRows = [...stageCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([stage, count]) => {
      const total = checkpoints.length || 1;
      const pct = (count / total * 100).toFixed(0);
      return `<div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:0.55rem">
        <span style="font-family:var(--font-mono);font-size:0.75rem;color:var(--text-main);min-width:140px;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(stage)}</span>
        <div style="flex:1;height:6px;background:var(--bg-elevated);border-radius:3px;overflow:hidden"><div style="width:${pct}%;height:100%;background:var(--accent-bright);border-radius:3px"></div></div>
        <span style="font-family:var(--font-mono);font-size:0.75rem;color:var(--text-muted);min-width:36px;text-align:right">${count}</span>
      </div>`;
    }).join("");

  const stagePanel = checkpoints.length === 0 ? "" : `<div class="panel" style="margin-bottom:1.5rem">
    <div class="panel-header"><span class="panel-title">Stage distribution</span><span style="font-size:0.6875rem;color:var(--text-muted);font-family:var(--font-mono)">${checkpoints.length} recent checkpoint${checkpoints.length === 1 ? "" : "s"}</span></div>
    <div class="panel-body">${stageRows || `<p class="empty">No checkpoints recorded.</p>`}</div>
  </div>`;

  return `<section id="pipeline">
    <h2>Recent pipeline activity</h2>
    <p class="note">Latest completed stage per run. A stuck/crashed run just stops appearing here, not shown as a failure.</p>
    ${error ? errorState(error) : `${stagePanel}${checkpointsTable(checkpoints)}`}
  </section>`;
}
