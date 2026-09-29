// Stock-split guard. price_bars / price_bars_intraday hold RAW (unadjusted)
// prices, so a 2-for-1 split makes a long position look 50% under water and a
// 1-for-2 reverse split makes it look 100% up. Left alone, exit.js would fire
// a bogus stop-loss/take-profit and settle.js would record that fake return
// as a lesson in decision_memory.
//
// HONEST SCOPE: this only DETECTS a suspicious entry->current price ratio; it
// cannot tell a split from a genuine gap of the same size, and it does not
// adjust anything. Callers (graph/exit_check.js) suppress price-based exits
// and log loudly instead of trusting the number.
//   - Why entry->current is a fair comparison here: ordinary moves hit a
//     stop-loss/take-profit long before the ratio reaches ~0.5 or ~2, so an
//     open position sitting at such a ratio is almost always a split (or a
//     data problem), not drift.
//   - False negatives: a split plus a market move bigger than the tolerance
//     falls outside the window and is treated as an ordinary price.
//   - False positives: a real overnight gap of nearly exactly 1/2, 1/3, ...
//     or 2x, 3x, ... suppresses its stop-loss until the time exit. Accepted:
//     rare, and loud in the logs.
//   - Only whole-number factors (2, 3, 4, 5, 10) are matched, forward and
//     reverse. 3-for-2 style splits (ratio ~0.67) are NOT matched: that window
//     is too close to a plausible real drop, so it would suppress real stops.

export const SPLIT_FACTORS = Object.freeze([2, 3, 4, 5, 10]);

/**
 * Compares `currentPrice / entryPrice` with each common split ratio (1/n for a
 * forward n-for-1 split, n for a 1-for-n reverse split) within a RELATIVE
 * `tolerance`. Returns `{ kind: "split" | "reverse_split", factor, ratio }` on
 * the first match, else null. Null for a missing/non-positive price or a
 * tolerance that is not > 0 (0 disables the guard).
 */
export function detectSplitJump(entryPrice, currentPrice, tolerance) {
  if (!(tolerance > 0)) return null;
  if (!Number.isFinite(entryPrice) || !Number.isFinite(currentPrice)) return null;
  if (entryPrice <= 0 || currentPrice <= 0) return null;

  const ratio = currentPrice / entryPrice;
  for (const factor of SPLIT_FACTORS) {
    if (Math.abs(ratio * factor - 1) <= tolerance) return { kind: "split", factor, ratio };
    if (Math.abs(ratio / factor - 1) <= tolerance) return { kind: "reverse_split", factor, ratio };
  }
  return null;
}
