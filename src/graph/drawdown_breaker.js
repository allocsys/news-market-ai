// The ONE place the drawdown circuit breaker's inputs are read, shared by
// graph/pipeline.js's portfolio_checked stage and backtest/newsReplay.js so
// both hand agents/managers/portfolio_manager.js#evaluatePortfolio identical
// options. Returns `{}` (no options, no store read) when the breaker is not
// configured, which is what keeps configs without drawdownBreakerPct -- unit
// tests, subrequest-budget-paced walks that count exact D1 reads per stage --
// exactly as they were. config.js#loadConfig always sets it (default from
// shared/constants.js; 0 disables).
//
// The P&L is realized closes in the window PLUS open positions marked at their last exit-check
// close (includeUnrealized; positions.last_price, migration 0009). Same ONE store read as before:
// the open positions come back in that query, so a decision costs no extra D1 call. The key is
// still named realizedPnlPct for the portfolio manager's option contract. A position with no mark
// yet counts as flat, so a book with no marks behaves exactly like the old realized-only check.

export async function loadDrawdownBreakerOptions(store, config, { asOf }) {
  const drawdownBreakerPct = config.drawdownBreakerPct;
  if (!(drawdownBreakerPct > 0)) return {};
  const realizedPnlPct = await store.getRealizedPnlPctAsOf({
    asOf,
    windowDays: config.drawdownBreakerWindowDays,
    costBps: config.tradeCostBps,
    includeUnrealized: true,
  });
  return { realizedPnlPct, drawdownBreakerPct };
}
