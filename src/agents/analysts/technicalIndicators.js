// Deterministic technical-indicator calculations over price_bars (plan.md
// Adopted Pattern #9: grounded, not free-associated, data claims -- the
// technical analyst agent below must never let an LLM invent a moving
// average or a price-change figure from its own "knowledge"; every number
// in its prompt has to come from here, computed off real
// storage/inputs_view.js#getPriceBarsAsOf rows, or not be claimed at all).
//
// Pure functions, no DB/LLM access -- same separation as risk.js/exit.js
// keeping their own rule logic pure and letting a thin orchestration layer
// (technicalAnalyst.js here) supply the real data.
//
// Bars are expected in the same order storage/inputs_view.js#getPriceBarsAsOf
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
 * Average True Range over the `window` most recent bars, or null if there
 * isn't one extra bar beyond the window to anchor the first bar's previous
 * close (same "need one extra anchor bar" convention as computePriceChangePct
 * above). True range for a bar = max(high-low, |high-prevClose|,
 * |low-prevClose|) -- the classic Wilder definition, gap-aware rather than
 * just high-low, since a gap up/down between sessions is real volatility a
 * plain high-low range would understate.
 *
 * Used by risk_mgmt/risk.js to scale stop-loss/take-profit distances to a
 * ticker's OWN recent volatility instead of one flat % for every ticker --
 * kept here rather than in risk.js so it stays a pure, DB/LLM-free
 * calculation over bars already fetched for the technical analyst, same
 * separation of concerns as every other function in this file.
 */
export function computeATR(bars, window) {
  if (!bars || bars.length < window + 1) return null;
  let sum = 0;
  for (let i = 0; i < window; i++) {
    const bar = bars[i];
    const prevClose = bars[i + 1].close;
    const highLow = bar.high - bar.low;
    const highPrevClose = Math.abs(bar.high - prevClose);
    const lowPrevClose = Math.abs(bar.low - prevClose);
    sum += Math.max(highLow, highPrevClose, lowPrevClose);
  }
  return sum / window;
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
export function computeTechnicalSnapshot(bars, { smaWindow = 5, momentumWindow = 5, volumeWindow = 5 } = {}, current = null) {
  if (!bars || bars.length === 0) {
    return { hasData: false };
  }

  const live = usableCurrentPrice(current, bars);
  if (!live) {
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

  // The daily bars end at the last COMPLETED session (up to ~a day old). With a visible intraday price, the
  // SMA and the price change are taken from the current price plus the completed closes. Volume stays on the
  // last completed daily bar: today's session volume is partial, so it is not comparable to a full-day average.
  const series = [{ close: live.price }, ...bars];
  const latestClose = bars[0].close;
  return {
    hasData: true,
    currentPrice: live.price,
    currentPriceAt: live.availableAt ?? live.ts ?? null,
    currentPriceAgeMinutes: Number.isFinite(live.ageMinutes) ? live.ageMinutes : null,
    latestClose,
    latestDate: bars[0].date,
    currentVsLatestClosePct: latestClose === 0 ? null : (live.price - latestClose) / latestClose,
    barsAvailable: bars.length,
    sma: computeSMA(series, smaWindow),
    smaWindow,
    smaBasis: `current price plus the prior ${smaWindow - 1} completed daily closes`,
    priceChangePct: computePriceChangePct(series, momentumWindow),
    priceChangeWindow: momentumWindow,
    priceChangeBasis: `current price vs the daily close ${momentumWindow} sessions back`,
    volumeRatio: computeVolumeRatio(bars, volumeWindow),
    volumeWindow,
    volumeRatioBasis: "last completed daily bar vs the average of the bars before it (today's partial volume not included)",
  };
}

/**
 * `current` = { price, ts, availableAt, ageMinutes } from graph/price_resolution.js#resolveIntradayForTechnical,
 * a bar already gated to what was visible at asOf. Usable only when it belongs to a session AFTER the newest daily
 * bar: an intraday bar from the same UTC day as that daily bar is the same session's price, and averaging both
 * would count that session twice. Anything else falls back to the daily-only snapshot.
 */
function usableCurrentPrice(current, bars) {
  if (!current || !Number.isFinite(current.price) || !(current.price > 0)) return null;
  const sessionDate = typeof current.ts === "string" ? current.ts.slice(0, 10) : null;
  if (!sessionDate || !(sessionDate > bars[0].date)) return null;
  return current;
}
