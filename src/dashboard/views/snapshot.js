import { errorState, emptyState, positionsTable } from "../helpers.js";

// Book landing page. The summary cards and the composition / exposure / decision-outcome
// chart row live on Overview only (helpers.js#renderSummaryCards, #renderBookCharts) --
// they used to be duplicated here verbatim. Open positions are on the Positions page.
// Props other than closedPositions/error are still passed by the data layer and ignored here.
const SNAPSHOT_INTRO = `<p class="note">Last 20 exits, newest first. A dash in Exit means no price was recorded. Open risk and decision outcomes are on Overview; open positions are on Positions. Use Refresh in the toolbar to re-fetch.</p>`;

export function renderSnapshotView({ closedPositions, error }) {
  if (error) {
    return `<section id="snapshot">
      <h2>Recently closed</h2>
      ${SNAPSHOT_INTRO}
      ${errorState(error)}
    </section>`;
  }

  return `<section id="snapshot">
    <h2>Recently closed <span class="h2-count">${closedPositions.length}</span></h2>
    ${SNAPSHOT_INTRO}
    ${closedPositions.length === 0
      ? emptyState("No closed positions yet.")
      : positionsTable(closedPositions, { closed: true })}
  </section>`;
}
