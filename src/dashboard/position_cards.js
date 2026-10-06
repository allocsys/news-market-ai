// Phone-first position cards (UI redesign step 3). Replaces positionsTable on the
// Book (Positions) page; positionsTable stays for Recent exits until step 6.
// One card per position: ticker + direction + the one number that matters in the
// header (size for open, P&L for closed), three small stats under it, one footer line.
import { escapeHtml, fmtTime, fmtExcursion, directionPill, closeReasonPill } from "./helpers.js";

const usd = (v) => (v != null && Number.isFinite(Number(v)) ? `$${Number(v).toFixed(2)}` : "\u2014");
const sizePct = (v) => (v != null && Number.isFinite(Number(v)) ? `${(Number(v) * 100).toFixed(1)}%` : "\u2014");
const tone = (v) => (v > 0 ? "pos" : v < 0 ? "neg" : "flat");

function stat(label, valueHtml, { title = "", cls = "" } = {}) {
  return `<div class="pos-stat"><dt${title ? ` title="${escapeHtml(title)}"` : ""}>${label}</dt><dd class="${cls}">${valueHtml}</dd></div>`;
}

const MAE_TITLE = "Worst gross return seen while open (sampled at exit checks)";
const MFE_TITLE = "Best gross return seen while open (sampled at exit checks)";

/** Open positions: size in the header; Entry / MAE / MFE under it; opened time in the footer. */
export function openPositionCards(positions) {
  if (!positions || positions.length === 0) return `<p class="empty">None.</p>`;
  const cards = positions
    .map(
      (p) => `<article class="pos-card">
        <header class="pos-card-head">
          <span class="ticker pos-card-ticker">${escapeHtml(p.ticker)}</span>
          ${directionPill(p.direction)}
          <span class="pos-card-main" title="Position size">${sizePct(p.positionSizePct)}</span>
        </header>
        <dl class="pos-card-stats">
          ${stat("Entry", usd(p.entryPrice))}
          ${stat("MAE", fmtExcursion(p.maePct), { title: MAE_TITLE, cls: `pos-${tone(p.maePct)}` })}
          ${stat("MFE", fmtExcursion(p.mfePct), { title: MFE_TITLE, cls: `pos-${tone(p.mfePct)}` })}
        </dl>
        <p class="pos-card-foot">Opened ${fmtTime(p.openedAt)}</p>
      </article>`
    )
    .join("\n");
  return `<div class="pos-cards">${cards}</div>`;
}

/** Closed positions: net P&L in the header; Entry / Exit / Size under it; reason + times in the footer. */
export function closedPositionCards(positions) {
  if (!positions || positions.length === 0) return `<p class="empty">None.</p>`;
  const cards = positions
    .map((p) => {
      const pnlTitle = p.returnIsNet === false ? "Gross return (this run predates the cost model)" : "Return net of round-trip trading costs";
      return `<article class="pos-card">
        <header class="pos-card-head">
          <span class="ticker pos-card-ticker">${escapeHtml(p.ticker)}</span>
          ${directionPill(p.direction)}
          <span class="pos-card-main pos-${tone(p.realizedReturn)}" title="${pnlTitle}">${fmtExcursion(p.realizedReturn)}</span>
        </header>
        <dl class="pos-card-stats">
          ${stat("Entry", usd(p.entryPrice))}
          ${stat("Exit", usd(p.exitPrice))}
          ${stat("Size", sizePct(p.positionSizePct))}
        </dl>
        <p class="pos-card-foot">${closeReasonPill(p.closeReason)} <span>Closed ${fmtTime(p.closedAt)}</span> <span>Opened ${fmtTime(p.openedAt)}</span></p>
      </article>`;
    })
    .join("\n");
  return `<div class="pos-cards">${cards}</div>`;
}
