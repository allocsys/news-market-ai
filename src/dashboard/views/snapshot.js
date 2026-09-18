import { renderSummaryCards, errorState } from "../helpers.js";

export function renderSnapshotView({ openPositions, closedPositions, decisionStats, error }) {
  return `<section id="snapshot">
    <h2>Portfolio snapshot</h2>
    ${error ? errorState(error) : renderSummaryCards({ openPositions, closedPositions, decisionStats })}
  </section>`;
}
