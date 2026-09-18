import {
  pillLinks, positionsTable, POSITIONS_LIMIT_OPTIONS, errorState,
  donutChart, gaugeChart, escapeHtml,
} from "../helpers.js";

export function renderPositionsView({ openPositions, openPositionsError, closedPositions, closedPositionsError, params }) {
  const positionsFilterBar = `<div class="filter-bar">
    ${pillLinks("Rows", POSITIONS_LIMIT_OPTIONS, params.positionsLimit, "positionsLimit", params)}
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
  const otherExits = closedPositions.length - stopLosses - takeProfits;
  const closeReasonsDonut = donutChart(
    [
      { label: "Take profit", value: takeProfits, color: "var(--color-success-text)" },
      { label: "Stop loss", value: stopLosses, color: "var(--color-danger-text)" },
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
  const totalExposurePct = openPositions.reduce((sum, p) => sum + (p.positionSizePct ?? 0), 0) * 100;
  const exposureFraction = Math.max(0, Math.min(1, totalExposurePct / 100));
  const exposureAccent =
    totalExposurePct >= 80 ? "var(--color-danger-text)" :
    totalExposurePct >= 50 ? "var(--color-warning-text)" :
    "var(--color-success-text)";
  const exposureGauge = gaugeChart(exposureFraction, {
    valueLabel: totalExposurePct.toFixed(1) + "%",
    label: "deployed",
    title: "Open exposure",
    subtitle: "sum of position size %",
    accent: exposureAccent,
  });

  return `<div class="grid">
    <section id="positions">
      <h2>Open positions${openPositionsError ? "" : ` <span class="h2-count">${openPositions.length}</span>`}</h2>
      ${positionsFilterBar}
      ${openPositionsError ? errorState(openPositionsError) : `
        <div class="chart-row-2" style="margin-bottom:1.5rem">
          ${openDirectionDonut}
          ${exposureGauge}
        </div>
        ${positionsTable(openPositions)}
      `}
    </section>
    <section>
      <h2>Recently closed${closedPositionsError ? "" : ` <span class="h2-count">${closedPositions.length}</span>`}</h2>
      <p class="note">No exit price is recorded on close -- realized return can't be shown, only how/when a position closed.</p>
      ${closedPositionsError ? errorState(closedPositionsError) : `
        <div class="chart-row-2" style="margin-bottom:1.5rem">
          ${closeReasonsDonut}
          <div class="panel">
            <div class="panel-header"><span class="panel-title">Exit quality</span></div>
            <div class="panel-body">
              ${(() => {
                const total = closedPositions.length || 1;
                const tpPct = (takeProfits / total * 100).toFixed(0);
                const slPct = (stopLosses / total * 100).toFixed(0);
                const ratio = stopLosses > 0 ? (takeProfits / stopLosses).toFixed(2) : takeProfits > 0 ? "\u221e" : "\u2014";
                return `
                  <div style="display:flex;gap:1.5rem;flex-wrap:wrap">
                    <div>
                      <div style="font-family:var(--font-display);font-size:1.5rem;font-weight:600;color:var(--color-success-text);font-variant-numeric:tabular-nums">${takeProfits}</div>
                      <div style="font-size:0.6875rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;font-weight:600">Take profit (${tpPct}%)</div>
                    </div>
                    <div>
                      <div style="font-family:var(--font-display);font-size:1.5rem;font-weight:600;color:var(--color-danger-text);font-variant-numeric:tabular-nums">${stopLosses}</div>
                      <div style="font-size:0.6875rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;font-weight:600">Stop loss (${slPct}%)</div>
                    </div>
                    <div>
                      <div style="font-family:var(--font-display);font-size:1.5rem;font-weight:600;color:var(--text-main);font-variant-numeric:tabular-nums">${ratio}</div>
                      <div style="font-size:0.6875rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;font-weight:600">TP / SL ratio</div>
                    </div>
                  </div>
                `;
              })()}
            </div>
          </div>
        </div>
        ${positionsTable(closedPositions, { closed: true })}
      `}
    </section>
  </div>`;
}
