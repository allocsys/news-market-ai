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
    <p class="note">Last 30 daily closes for open-position tickers (max ${PRICE_CHART_TICKER_LIMIT}). Latest prices, not point-in-time.</p>
    ${error ? errorState(error) : priceChartsGrid(priceBarsByTicker)}
  </section>`;
}
