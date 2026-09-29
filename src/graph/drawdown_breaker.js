// The ONE place the drawdown circuit breaker's inputs are read, shared by
// graph/pipeline.js's portfolio_checked stage and backtest/newsReplay.js so
// both hand agents/managers/portfolio_manager.js#evaluatePortfolio identical
// options. Returns `{}` (no options, no store read) when the breaker is not
// configured, which is what keeps configs without drawdownBreakerPct -- unit
// tests, subrequest-budget-paced walks that count exact D1 reads per stage --
// exactly as they were. config.js#loadConfig always sets it (default from
// shared/constants.js; 0 disables).

export async function loadDrawdownBreakerOptions(store, config, { asOf }) {
  const drawdownBreakerPct = config.drawdownBreakerPct;
  if (!(drawdownBreakerPct > 0)) return {};
  const realizedPnlPct = await store.getRealizedPnlPctAsOf({
    asOf,
    windowDays: config.drawdownBreakerWindowDays,
    costBps: config.tradeCostBps,
  });
  return { realizedPnlPct, drawdownBreakerPct };
}
