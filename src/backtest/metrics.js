// Pure statistical functions over a series of per-period returns (e.g. one
// number per closed trade, or per day of held exposure -- the caller
// decides the period; these functions don't care). No I/O, no D1, no point-
// in-time concerns here -- that's already handled upstream by whatever
// produced the `returns` array (see signalCompare.js's header for how this
// plugs into the rest of backtest/).
//
// `returns` values are fractional (0.05 = +5%), not percentages.

/** Compounds a return series into one cumulative return. Empty input -> 0 (no change), not NaN. */
export function cumulativeReturn(returns) {
  return returns.reduce((acc, r) => acc * (1 + r), 1) - 1;
}

export function meanReturn(returns) {
  if (returns.length === 0) return 0;
  return returns.reduce((a, b) => a + b, 0) / returns.length;
}

/** Sample standard deviation (n-1 denominator). 0 for fewer than 2 points -- not enough data to estimate spread, and 0 (rather than NaN) keeps sharpeRatio well-defined. */
export function stdDevReturn(returns) {
  if (returns.length < 2) return 0;
  const mean = meanReturn(returns);
  const variance = returns.reduce((acc, r) => acc + (r - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance);
}

/**
 * Annualized Sharpe ratio: (mean excess return / stdev) * sqrt(periodsPerYear).
 * `riskFreeRate` is an ANNUAL rate (e.g. 0.04), converted to a per-period
 * rate internally by dividing by `periodsPerYear`. Returns 0 (not NaN or
 * Infinity) when stdev is 0 -- a flat/all-identical return series has no
 * meaningful Sharpe ratio, and 0 is a safer default for callers doing
 * comparisons than a divide-by-zero result.
 */
export function sharpeRatio(returns, { riskFreeRate = 0, periodsPerYear = 252 } = {}) {
  const stdev = stdDevReturn(returns);
  if (stdev === 0) return 0;
  const perPeriodRiskFree = riskFreeRate / periodsPerYear;
  return ((meanReturn(returns) - perPeriodRiskFree) / stdev) * Math.sqrt(periodsPerYear);
}

/**
 * Max drawdown as a positive fraction (0.25 = a 25% peak-to-trough decline)
 * over the equity curve implied by compounding `returns` starting from 1.
 * Returns 0 for fewer than 1 return (nothing to draw down from).
 */
export function maxDrawdown(returns) {
  let equity = 1;
  let peak = 1;
  let worst = 0;
  for (const r of returns) {
    equity *= 1 + r;
    peak = Math.max(peak, equity);
    worst = Math.max(worst, (peak - equity) / peak);
  }
  return worst;
}

/** Fraction of periods with a strictly positive return. 0 for empty input. */
export function winRate(returns) {
  if (returns.length === 0) return 0;
  return returns.filter((r) => r > 0).length / returns.length;
}

/** Bundles the above into one summary object -- the shape signalCompare.js reports per side (on/off) and per window. */
export function summarizeReturns(returns, { riskFreeRate = 0, periodsPerYear = 252 } = {}) {
  return {
    n: returns.length,
    cumulativeReturn: cumulativeReturn(returns),
    meanReturn: meanReturn(returns),
    sharpeRatio: sharpeRatio(returns, { riskFreeRate, periodsPerYear }),
    maxDrawdown: maxDrawdown(returns),
    winRate: winRate(returns),
  };
}
