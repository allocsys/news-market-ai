import { pillLinks, positionsTable, POSITIONS_LIMIT_OPTIONS, errorState } from "../helpers.js";

export function renderPositionsView({ openPositions, openPositionsError, closedPositions, closedPositionsError, params }) {
  const positionsFilterBar = `<div class="filter-bar">
    ${pillLinks("Rows", POSITIONS_LIMIT_OPTIONS, params.positionsLimit, "positionsLimit", params)}
  </div>`;

  return `<div class="grid">
    <section id="positions">
      <h2>Open positions${openPositionsError ? "" : ` (${openPositions.length})`}</h2>
      ${positionsFilterBar}
      ${openPositionsError ? errorState(openPositionsError) : positionsTable(openPositions)}
    </section>
    <section>
      <h2>Recently closed${closedPositionsError ? "" : ` (${closedPositions.length})`}</h2>
      <p class="note">No exit price is recorded on close -- realized return can't be shown, only how/when a position closed.</p>
      ${closedPositionsError ? errorState(closedPositionsError) : positionsTable(closedPositions, { closed: true })}
    </section>
  </div>`;
}
