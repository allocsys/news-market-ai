// Deterministic technical-indicator calculations over price_bars (plan.md
// Adopted Pattern #9: grounded, not free-associated, data claims -- the
// technical analyst agent below must never let an LLM invent a moving
// average or a price-change figure from its own "knowledge"; every number
// in its prompt has to come from here, computed off real
// storage/d1.js#getPriceBarsAsOf rows, or not be claimed at all).
//
// Pure functions, no DB/LLM access -- same separation as risk.js/exit.js
// keeping their own rule logic pure and letting a thin orchestration layer
// (technicalAnalyst.js here) supply the real data.
//
// Bars are expected in the same order storage/d1.js#getPriceBarsAsOf
// returns them: most-recent-first (`ORDER BY date DESC`).

/** Simple moving average of the `window` most recent closes, or null if there aren't enough bars. */
export function computeSMA(bars, window) {
  if (bars.length < window) return null;
  const slice = bars.slice(0, window);
  return slice.reduce((sum, b) => sum + b.close, 0) / window;
}

/** % change from the close `window` bars ago to the latest close, or null if there isn't a bar that far back. */
export function computePriceChangePct(bars, window) {
  if (bars.length <= window) return null; // need one extra bar as the "before" anchor
  const latest = bars[0].close;
  const prior = bars[window].close;
  if (prior === 0) return null;
  return (latest - prior) / prior;
}

/** Ratio of the latest bar's volume to the average of the `window` bars before it, or null if there aren't enough. */
export function computeVolumeRatio(bars, window) {
  if (bars.length < window + 1) return null; // exclude the latest bar from its own baseline average
  const latestVolume = bars[0].volume;
  const priorBars = bars.slice(1, window + 1);
  const avgVolume = priorBars.reduce((sum, b) => sum + b.volume, 0) / priorBars.length;
  if (avgVolume === 0) return null;
  return latestVolume / avgVolume;
}

/**
 * Bundles the above into one grounded snapshot for a prompt.
 *
 * Returns `{ hasData: false }` when there are no bars at all --
 * agents/analysts/technicalAnalyst.js must skip calling the LLM entirely in
 * that case, not ask it to analyze nothing (same honest-null convention as
 * agents/risk_mgmt/exit.js#evaluateExit's entryPrice handling). Individual
 * indicator fields inside a `hasData: true` snapshot can still be null if
 * there simply aren't enough bars for that specific window -- callers,
 * including the LLM prompt itself, must treat a null indicator as "unknown",
 * never as zero.
 */
export function computeTechnicalSnapshot(bars, { smaWindow = 5, momentumWindow = 5, volumeWindow = 5 } = {}) {
  if (!bars || bars.length === 0) {
    return { hasData: false };
  }

  return {
    hasData: true,
    latestClose: bars[0].close,
    latestDate: bars[0].date,
    barsAvailable: bars.length,
    sma: computeSMA(bars, smaWindow),
    smaWindow,
    priceChangePct: computePriceChangePct(bars, momentumWindow),
    priceChangeWindow: momentumWindow,
    volumeRatio: computeVolumeRatio(bars, volumeWindow),
    volumeWindow,
  };
}
