import { escapeHtml, fmtTime, decisionBadge, directionPill, llmAnswerDetails, emptyState } from "./helpers.js";

/**
 * Creates list of cards for decisions, phone-first.
 * One card per decision: ticker, direction, status, decided time, position size, and reason.
 */
export function decisionCards(decisions) {
  if (!decisions || decisions.length === 0) {
    return emptyState("No decisions match this filter.");
  }

  const cards = decisions
    .map((d) => {
      if (!d) return "";
      const ticker = escapeHtml(d.ticker);
      const direction = d.thesis?.direction;
      const status = d.status;
      const time = fmtTime(d.createdAt);

      const sizePct = d.riskDecision?.positionSizePct != null
        ? `${(d.riskDecision.positionSizePct * 100).toFixed(1)}%`
        : "-";

      const rawReason = d.portfolioDecision?.reason ?? d.riskDecision?.reason ?? "";
      const truncatedReason = rawReason.length > 140
        ? rawReason.slice(0, 140) + "\u2026"
        : rawReason;
      const reasonEscaped = escapeHtml(truncatedReason);

      return `<article class="sig-card">
        <div class="sig-card-top">
          <span class="ticker" style="font-family: var(--font-mono); font-weight: 600;">${ticker}</span>
          ${directionPill(direction)}
          ${decisionBadge(status)}
          <span class="sig-card-time">${time}</span>
        </div>
        <div class="sig-card-mid">
          <span class="sig-card-size">${sizePct}</span>
          <span class="sig-card-reason" title="${escapeHtml(rawReason)}">${reasonEscaped || "\u2014"}</span>
        </div>
        ${llmAnswerDetails(d)}
      </article>`;
    })
    .join("\n");

  return `<div class="sig-cards">${cards}</div>`;
}
