import { checkpointsTable } from "../helpers.js";

export function renderPipelineView({ checkpoints }) {
  return `<section id="pipeline">
    <h2>Recent pipeline activity</h2>
    <p class="note">Latest completed stage per run. A stuck/crashed run just stops appearing here, not shown as a failure.</p>
    ${checkpointsTable(checkpoints)}
  </section>`;
}
