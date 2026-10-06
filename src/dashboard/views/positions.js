import {
  pillLinks, POSITIONS_LIMIT_OPTIONS, errorState, escapeHtml,
  donutChart, gaugeChart, miniStats, fmtShare,
} from "../helpers.js";
import { openPositionCards, closedPositionCards } from "../position_cards.js";

// Book (phone-first redesign step 3): exposure at a glance, open positions as cards,
// recently closed as cards; the donuts, gauge and exit-quality stats sit behind one expander.
function renderExposureRow({ openPositions, openPositionsError, totalExposurePct }) {
  const pct = Number.isFinite(totalExposurePct) ? totalExposurePct : 0;
  const tone = pct >= 80 ? "bad" : pct >= 50 ? "warn" : "ok";
  const width = Math.max(0, Math.min(100, pct));
  const longCount = openPositions.filter((p) => p.direction === "long").length;
  const shortCount = openPositions.filter((p) => p.direction === "short").length;
  const sub = openPositionsError ? "" : `<p class="book-exposure-sub">${openPositions.length} open &middot; ${longCount} long / ${shortCount} short</p>`;
  return `<div class="panel book-exposure"><div class="panel-body">
    <div class="book-exposure-top">
      <span class="book-exposure-value">${escapeHtml(pct.toFixed(1))}%</span>
      <span class="book-exposure-label">of portfolio deployed</span>
    </div>
    <div class="book-bar" role="img" aria-label="Open exposure ${escapeHtml(pct.toFixed(1))} percent"><span class="book-bar-fill book-bar-fill--${tone}" style="width:${width.toFixed(1)}%"></span></div>
    ${sub}
  </div></div>`;
}

export function renderPositionsView({ openPositions, openPositionsError, closedPositions, closedPositionsError, params, totalExposurePct }) {
  const positionsFilterBar = `<div class="filter-bar">
    ${pillLinks("Open rows", POSITIONS_LIMIT_OPTIONS, params.positionsLimit, "positionsLimit", params)}
  </div>`;

  // --- Direction donut for OPEN positions --------------------------------------
  const longCount = openPositions.filter((p) => p.direction === "long").length;
  const shortCount = openPositions.filter((p) => p.direction === "short").length;
  const otherCount = openPositions.length - longCount - shortCount;

  const openDirectionDonut = donutChart(
    [
      { label: "Long", value: longCount, color: "var(--color-success-text)" },
      { label: "Short", value: shortCount, color: "var(--color-danger-text)" },
      ...(otherCount > 0 ? [{ label: "Other", value: otherCount, color: "var(--chart-6)" }] : []),
    ],
    {
      centerValue: String(openPositions.length),
      centerLabel: "open",
      title: "Open by direction",
      subtitle: "long vs short book",
    }
  );

  // --- Close-reasons donut for CLOSED positions --------------------------------
  const stopLosses = closedPositions.filter((p) => p.closeReason === "stop_loss").length;
  const takeProfits = closedPositions.filter((p) => p.closeReason === "take_profit").length;
  const flipped = closedPositions.filter((p) => p.closeReason === "flipped").length;
  const replaced = closedPositions.filter((p) => p.closeReason === "replaced").length;
  const timeExits = closedPositions.filter((p) => p.closeReason === "time_based").length;
  const breakevenStops = closedPositions.filter((p) => p.closeReason === "breakeven_stop").length;
  const trailingStops = closedPositions.filter((p) => p.closeReason === "trailing_stop").length;
  const otherExits = closedPositions.length - stopLosses - takeProfits - flipped - replaced - timeExits - breakevenStops - trailingStops;
  const closeReasonsDonut = donutChart(
    [
      { label: "Take profit", value: takeProfits, color: "var(--color-success-text)" },
      { label: "Stop loss", value: stopLosses, color: "var(--color-danger-text)" },
      ...(breakevenStops > 0 ? [{ label: "Break-even stop", value: breakevenStops, color: "var(--chart-5)" }] : []),
      ...(trailingStops > 0 ? [{ label: "Trailing stop", value: trailingStops, color: "var(--accent)" }] : []),
      ...(timeExits > 0 ? [{ label: "Time exit", value: timeExits, color: "var(--text-muted)" }] : []),
      ...(flipped > 0 ? [{ label: "Flipped", value: flipped, color: "var(--color-info-text)" }] : []),
      ...(replaced > 0 ? [{ label: "Replaced", value: replaced, color: "var(--color-warning-text)" }] : []),
      ...(otherExits > 0 ? [{ label: "Other", value: otherExits, color: "var(--chart-6)" }] : []),
    ],
    {
      centerValue: String(closedPositions.length),
      centerLabel: "closed",
      title: "Exit reasons",
      subtitle: "last 20 closed positions",
    }
  );

  // --- Exposure gauge (open positions only) -----------------------------------
  // totalExposurePct comes in as a prop (storage/run_store.js#RunStore.getOpenExposureTotal,
  // an unbounded aggregate) rather than being summed here from the (Rows-limited)
  // openPositions array -- see helpers.js#renderSummaryCards's own comment.
  const exposureFraction = Math.max(0, Math.min(1, totalExposurePct / 100));
  const exposureAccent =
    totalExposurePct >= 80 ? "var(--color-danger-text)" :
    totalExposurePct >= 50 ? "var(--color-warning-text)" :
    "var(--color-success-text)";
  const exposureGauge = gaugeChart(exposureFraction, {
    valueLabel: fmtShare(totalExposurePct, 100, 1),
    label: "deployed",
    title: "Open exposure",
    subtitle: "sum of position size %",
    accent: exposureAccent,
  });

  // --- Exit quality mini-stats -------------------------------------------------
  const exitTotal = closedPositions.length || 1;
  const tpPct = fmtShare(takeProfits, exitTotal);
  const slPct = fmtShare(stopLosses, exitTotal);
  const tpSlRatio = stopLosses > 0 ? (takeProfits / stopLosses).toFixed(2) : takeProfits > 0 ? "\u221e" : "\u2014";
  const exitQuality = miniStats(
    [
      { value: takeProfits, label: `Take profit (${tpPct})`, color: "var(--color-success-text)" },
      { value: stopLosses, label: `Stop loss (${slPct})`, color: "var(--color-danger-text)" },
      { value: tpSlRatio, label: "TP / SL ratio" },
    ],
    { cols: 3 }
  );

  // Charts and exit stats stay available, one tap away, and only for the halves that loaded.
  const chartsBody = `
    ${openPositionsError ? "" : `<div class="chart-row-2 chart-row-gap">${openDirectionDonut}${exposureGauge}</div>`}
    ${closedPositionsError ? "" : `<div class="chart-row-2 chart-row-gap">
      ${closeReasonsDonut}
      <div class="panel">
        <div class="panel-header"><span class="panel-title">Exit quality</span></div>
        <div class="panel-body">${exitQuality}</div>
      </div>
    </div>`}`;
  const chartsExpander = openPositionsError && closedPositionsError
    ? ""
    : `<details class="llm-answer book-more"><summary>Charts and exit stats</summary><div class="llm-answer-body maxw-none">${chartsBody}</div></details>`;

  return `<section id="positions" class="book">
    <h2>Book</h2>
    ${renderExposureRow({ openPositions, openPositionsError, totalExposurePct })}
    <h2>Open positions${openPositionsError ? "" : ` <span class="h2-count">${openPositions.length}</span>`}</h2>
    ${positionsFilterBar}
    ${openPositionsError ? errorState(openPositionsError) : openPositionCards(openPositions)}
    <h2>Recently closed${closedPositionsError ? "" : ` <span class="h2-count">${closedPositions.length}</span>`}</h2>
    <p class="note">The exit price is recorded on close (a dash means none was available, e.g. a time-based exit with no price data).</p>
    ${closedPositionsError ? errorState(closedPositionsError) : closedPositionCards(closedPositions)}
    ${chartsExpander}
  </section>`;
}
