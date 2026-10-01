// First tradable bar after an instant. Shared by the pending-entry fill (graph/entry_fill.js) and
// the read-only replay (backtest/newsReplay.js#simulateForward), so both price an entry the same way.
//
// Window rule is the exit walk's (shared/bar_window.js#exitWindowStart) with `from` as the anchor:
// intraday bars with ts >= from, daily bars from the next full UTC day (or the same day when `from`
// is exactly 00:00:00Z); a UTC day with intraday rows uses them, a day without falls back to its
// daily bar. Only bars fully closed by `asOf` are read (the inputs_view window reads gate on it).

import { getDailyBarsWindowAsOf, getIntradayBarsWindowAsOf } from "../storage/inputs_view.js";
import { buildBarSequence, exitWindowStart } from "../shared/bar_window.js";
import { findFillBar } from "../shared/entry_timing.js";

/**
 * The first bar that OPENS at/after `from` and has closed by `asOf`, as
 * shared/entry_timing.js#findFillBar returns it ({ price, source, barTs, openedAt }), or null when
 * no such bar is visible yet (or `from` does not parse).
 */
export async function findFirstBarOpenAtOrAfter(inputs, { ticker, from, asOf }) {
  const start = exitWindowStart({ openedAt: from, lastCheckedAt: null });
  if (!start) return null;
  const intraday = await getIntradayBarsWindowAsOf(inputs, { ticker, fromTs: start.intradayFromTs, asOf });
  const daily = await getDailyBarsWindowAsOf(inputs, { ticker, fromDate: start.dailyFromDate, asOf });
  const bars = buildBarSequence({ intraday: intraday.rows, daily: daily.rows, intradayTruncated: intraday.truncated });
  return findFillBar(bars, from);
}
