import { PRICE_CHART_TICKER_LIMIT, priceChartsGrid, errorState, escapeHtml } from "../helpers.js";

// Design decision (resolved, see plan.md Backtesting Integrity point 3's
// "residual gap" note): these price bars are intentionally NOT point-in-time
// gated. This view has no asOf param and no link to any backtest run --
// handleChartsRoute always shows the latest bars for currently-open positions,
// full stop. Price data generally isn't point-in-time-gated anywhere in this
// system yet (yfinance is current-only), so gating just this view would add
// plumbing with no real consumer. Revisit only if a future feature renders a
// chart scoped to a specific backtest run's window.
export function renderChartsView({ priceBarsByTicker, error }) {
  const tickerCount = error ? 0 : Object.values(priceBarsByTicker).filter((b) => b && b.length >= 2).length;
  return `<section id="charts">
    <h2>Price charts${error ? "" : ` <span class="h2-count">${tickerCount}</span>`}</h2>
    <p class="note">Recent daily closes (yfinance, unadjusted) for tickers with an open position, up to ${PRICE_CHART_TICKER_LIMIT} charted. Not point-in-time-gated -- this is "what the price actually is right now", same convention as the rest of this dashboard. Each cell shows a sparkline of the last 30 closes plus the latest price and percent change over that window.</p>
    ${error ? errorState(error) : priceChartsGrid(priceBarsByTicker)}
  </section>`;
}
