import { PRICE_CHART_TICKER_LIMIT, priceChartsGrid, errorState } from "../helpers.js";

export function renderChartsView({ priceBarsByTicker, error }) {
  return `<section id="charts">
    <h2>Price charts</h2>
    <p class="note">Recent daily closes (yfinance, unadjusted) for tickers with an open position, up to ${PRICE_CHART_TICKER_LIMIT} charted. Not point-in-time-gated -- this is "what the price actually is right now", same convention as the rest of this dashboard.</p>
    ${error ? errorState(error) : priceChartsGrid(priceBarsByTicker)}
  </section>`;
}
