// Per-trade gate statistics for a backtest run (docs/rollout.md): the rollout
// gate is "mean NET return per trade has a one-sided 95% lower bound > 0 over
// >= N trades", so it needs the per-TRADE realized returns, which the daily
// equity curves (runBacktest's scoring) do not give. The curves feed only max
// drawdown and the each-half test; THIS feeds the gate.
//
// Counting rule (owner decision, Q1 option A): every trade OPENED in the
// requested window counts, including ones that close in the grace tail after
// the window ends. Trades still open when the run ends are reported as
// `openAtEnd` and are NOT in n/mean (no realized return yet; never invented).
//
// Pure: no I/O. Callers pass rows already selected for the window.

import { computeRealizedReturn } from "../shared/returns.js";

/** One-sided 95% critical value used by the rollout gate's lower bound (mean - Z * SE). */
export const GATE_Z_ONE_SIDED_95 = 1.645;

/**
 * @param {Array<{direction, entryPrice, exitPrice, closedAt}>} trades  positions opened in the requested window
 * @param {{costBps?: number}} [opts]  per SIDE; return is NET of one entry + one exit cost
 * @returns {{n, mean, sd, se, lowerBound, winRate, openAtEnd, unreplayable}}
 *   n = closed trades with a computable net return. mean/sd/se/lowerBound/winRate are null when
 *   undefined (n = 0 for mean/winRate; n < 2 for sd/se/lowerBound) rather than 0, so a thin sample
 *   cannot read as a pass.
 */
export function computeGateStats(trades, { costBps } = {}) {
  const returns = [];
  let openAtEnd = 0;
  let unreplayable = 0;
  for (const t of trades ?? []) {
    if (!t.closedAt) {
      openAtEnd += 1;
      continue;
    }
    const r = computeRealizedReturn({ direction: t.direction, entryPrice: t.entryPrice, exitPrice: t.exitPrice, costBps });
    if (r == null || !Number.isFinite(r)) {
      unreplayable += 1; // closed but missing prices / direction: counted, never fabricated
      continue;
    }
    returns.push(r);
  }

  const n = returns.length;
  const mean = n > 0 ? returns.reduce((a, b) => a + b, 0) / n : null;
  let sd = null;
  let se = null;
  let lowerBound = null;
  if (n >= 2) {
    const ss = returns.reduce((a, r) => a + (r - mean) ** 2, 0);
    sd = Math.sqrt(ss / (n - 1)); // sample SD
    se = sd / Math.sqrt(n);
    lowerBound = mean - GATE_Z_ONE_SIDED_95 * se;
  }
  const winRate = n > 0 ? returns.filter((r) => r > 0).length / n : null;
  return { n, mean, sd, se, lowerBound, winRate, openAtEnd, unreplayable };
}
