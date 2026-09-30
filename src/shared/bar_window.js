// Bar-window helpers for the bar-based exit check (graph/exit_check.js). Pure
// functions, no I/O: where a position's next window of bars starts, and how the
// intraday and daily rows read for it are merged into ONE chronological sequence
// the exit walker (agents/risk_mgmt/exit_bars.js) can step through.
//
// THE CURSOR. A position's `last_checked_at` (migrations/state/0006) is the close
// time of the last bar already evaluated; NULL means "never checked", and the
// window then starts at `opened_at`. Either way the window is
//
//     intraday bars:  ts >= start   and   ts + 5min <= asOf   (fully closed at asOf)
//     daily bars:     date >= dailyFromDate   and   date < UTC date of asOf
//
// ENTRY-TIME BAR. An intraday bar whose ts is BEFORE opened_at is never in the
// window, including the one that straddles the entry (ts < opened_at < ts + 5min):
// its high/low may include prices from before the position existed. The daily bar
// of the entry day is never used either (it holds the whole day, entry included):
// daily bars only start on the first FULL UTC day after the anchor. If a day has
// no intraday rows the entry day is simply not checked -- conservative (a stop or
// target touched on the entry day is missed), never optimistic about lookahead.
//
// INTRADAY BEFORE DAILY. For a UTC day that has any intraday row in the window the
// intraday bars are used and that day's daily bar is ignored (the intraday path
// gives the ORDER of a stop/target touch; a daily bar that touches both can only
// resolve as "stop first"). A day with no intraday rows falls back to its daily bar.

import { INTRADAY_BAR_MS, canonicalIntradayTs, intradayBarAvailableAt } from "./intraday_availability.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Rows one intraday window read may return; a full 14 days of 24h/5min FX bars is ~4,000. */
export const EXIT_WINDOW_INTRADAY_ROW_CAP = 6000;
/** Daily rows one window read may return (a hold is at most a few weeks). */
export const EXIT_WINDOW_DAILY_ROW_CAP = 90;

function ceilToSecondIso(ms) {
  return new Date(Math.ceil(ms / 1000) * 1000).toISOString();
}

/**
 * Where the next window for a position starts. `lastCheckedAt` (the cursor) wins
 * over `openedAt`. Returns `{ anchorIso, intradayFromTs, dailyFromDate }` or
 * `null` when neither timestamp parses (the caller then skips the price walk and
 * only the time exit can fire -- a date that cannot be computed is never
 * silently turned into "the beginning of time").
 *
 * `intradayFromTs`: canonical inclusive lower bound on price_bars_intraday.ts.
 * `dailyFromDate`: first `YYYY-MM-DD` daily bar that may be used -- the anchor's
 * own UTC date only if the anchor is exactly 00:00:00Z (then that whole day is
 * after it), otherwise the NEXT date.
 */
export function exitWindowStart({ openedAt, lastCheckedAt }) {
  const anchor = lastCheckedAt ?? openedAt;
  const anchorMs = typeof anchor === "string" ? Date.parse(anchor) : Number.NaN;
  if (Number.isNaN(anchorMs)) return null;

  const dayStartMs = Math.floor(anchorMs / DAY_MS) * DAY_MS;
  const dailyFromMs = anchorMs === dayStartMs ? dayStartMs : dayStartMs + DAY_MS;

  return {
    anchorIso: new Date(anchorMs).toISOString(),
    intradayFromTs: canonicalIntradayTs(ceilToSecondIso(anchorMs)),
    dailyFromDate: new Date(dailyFromMs).toISOString().slice(0, 10),
  };
}

/**
 * Merges the rows read for one window into a single chronological array of
 * `{ kind, openMs, availableAt, open, high, low, close }` (see the header for
 * intraday-before-daily). `availableAt` is when the bar fully closed: an
 * intraday bar's ts + 5 minutes, a daily bar's next 00:00:00Z -- both are
 * <= asOf by construction of the reads that produced the rows, so it is also
 * the earliest honest timestamp for an exit triggered by that bar.
 *
 * `intradayTruncated` (the intraday read hit its row cap): the window is cut
 * off at the last intraday row, so daily rows dated AFTER that day are dropped
 * -- otherwise they would be walked out of order ahead of the missing intraday
 * bars and, worse, be mistaken for "days with no intraday data".
 */
export function buildBarSequence({ intraday = [], daily = [], intradayTruncated = false } = {}) {
  const daysWithIntraday = new Set();
  const seq = [];

  for (const r of intraday) {
    daysWithIntraday.add(String(r.ts).slice(0, 10));
    seq.push({
      kind: "intraday",
      openMs: Date.parse(r.ts),
      availableAt: intradayBarAvailableAt(r.ts),
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
    });
  }

  const lastIntradayDate = intraday.length > 0 ? String(intraday[intraday.length - 1].ts).slice(0, 10) : null;

  for (const r of daily) {
    if (daysWithIntraday.has(r.date)) continue;
    if (intradayTruncated && lastIntradayDate != null && r.date > lastIntradayDate) continue;
    const openMs = Date.parse(`${r.date}T00:00:00Z`);
    if (Number.isNaN(openMs)) continue;
    seq.push({
      kind: "daily",
      openMs,
      availableAt: `${new Date(openMs + DAY_MS).toISOString().slice(0, 19)}Z`,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
    });
  }

  seq.sort((a, b) => a.openMs - b.openMs);
  return seq;
}

export { INTRADAY_BAR_MS };
