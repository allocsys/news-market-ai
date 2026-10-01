import { errorState, positionsTable } from "../helpers.js";

// Book landing page. The summary cards and the composition / exposure / decision-outcome
// chart row live on Overview only (helpers.js#renderSummaryCards, #renderBookCharts) --
// they used to be duplicated here verbatim. Open positions are on the Positions page.
// Props other than closedPositions/error are still passed by the data layer and ignored here.
export function renderSnapshotView({ closedPositions, error }) {
  if (error) {
    return `<section id="snapshot">
      <h2>Portfolio snapshot</h2>
      ${errorState(error)}
    </section>`;
  }

  return `<section id="snapshot">
    <h2>Portfolio snapshot</h2>
    <p class="note">Book activity: the most recent exits. For open risk, exposure and decision outcomes see Overview; for open positions see Positions. Reads D1 directly on each page load, so the Refresh link in the toolbar above is what re-fetches it.</p>

    <section>
      <h2>Recently closed <span class="h2-count">${closedPositions.length}</span></h2>
      <p class="note">Last 20 exits. The exit price is recorded on close (a dash means none was available).</p>
      ${positionsTable(closedPositions, { closed: true })}
    </section>
  </section>`;
}
