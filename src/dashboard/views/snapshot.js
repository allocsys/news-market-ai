import { renderSummaryCards } from "../helpers.js";

export function renderSnapshotView({ openPositions, closedPositions, decisionStats }) {
  return `<section id="snapshot">
    <h2>Portfolio snapshot</h2>
    ${renderSummaryCards({ openPositions, closedPositions, decisionStats })}
  </section>`;
}
