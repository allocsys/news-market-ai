import { pillLinks, decisionsTable, DECISION_STATUS_OPTIONS, DECISION_LIMIT_OPTIONS, errorState } from "../helpers.js";

export function renderDecisionsView({ decisions, params, error }) {
  const decisionsFilterBar = `<div class="filter-bar">
    ${pillLinks("Status", DECISION_STATUS_OPTIONS, params.decisionStatus, "decisionStatus", params)}
    ${pillLinks("Rows", DECISION_LIMIT_OPTIONS, params.decisionLimit, "decisionLimit", params)}
  </div>`;

  return `<section id="decisions">
    <h2>Recent trade decisions</h2>
    <p class="note">Full decision chain (thesis + risk + portfolio sign-off) for every completed run. Expand "LLM reasoning" on a row to see the Analyst Team's opinions, the bull/bear debate, the judge's verdict, and the trader's rationale that produced it -- rows from before this feature shipped show "not recorded" instead.</p>
    ${decisionsFilterBar}
    ${error ? errorState(error) : decisionsTable(decisions)}
  </section>`;
}
