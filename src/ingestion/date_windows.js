// Pure UTC day arithmetic for the date-windowed Finnhub backfill
// (ingestion/ingest.js#backfillHistoricalNews, sources/finnhub.js
// #createWindowedFetcher). Everything here works on "YYYY-MM-DD" strings, the
// only granularity Finnhub's /company-news `from`/`to` params accept, and
// treats a window as an INCLUSIVE pair of days: { from: "2025-09-01", to:
// "2025-09-05" } is five days.
//
// ASSUMPTION carried by every caller: Finnhub treats `to` as inclusive, i.e.
// from=to=<day> returns that day's articles. The stored data supports it (the
// */15 cron asks for to=<today> and today's articles are in the inputs DB) but
// it has not been confirmed against Finnhub's docs or a direct call -- see
// backfillHistoricalNews's header for how to check after a real run.

const DAY_MS = 24 * 60 * 60 * 1000;

const dayMs = (day) => Date.parse(`${day}T00:00:00.000Z`);

/** A Date, ISO string or YYYY-MM-DD string as a UTC "YYYY-MM-DD" (throws on anything unparseable). */
export function toDayString(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid date: ${String(value)}`);
  return d.toISOString().slice(0, 10);
}

/** `day` shifted by `n` days (negative goes back). */
export function addDays(day, n) {
  return new Date(dayMs(day) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `fromDay` to `toDay` (0 for the same day, negative if `toDay` is earlier) -- NOT an inclusive count; add 1 for that. */
export function daysBetween(fromDay, toDay) {
  return Math.round((dayMs(toDay) - dayMs(fromDay)) / DAY_MS);
}

/**
 * Consecutive, non-overlapping windows of `windowDays` days covering
 * [from, to] inclusive; the last one is shorter when the range doesn't divide
 * evenly. Empty when `from` is after `to`.
 */
export function buildWindows(from, to, windowDays) {
  const size = Math.floor(windowDays);
  if (!Number.isFinite(size) || size < 1) throw new Error("buildWindows requires windowDays >= 1");
  const windows = [];
  let start = from;
  while (start <= to) {
    const end = addDays(start, size - 1);
    const last = end < to ? end : to;
    windows.push({ from: start, to: last });
    start = addDays(last, 1);
  }
  return windows;
}

/** Splits a window of two or more days into two non-overlapping halves that together cover it exactly. */
export function splitWindow(from, to) {
  if (!(from < to)) throw new Error("splitWindow requires a window of at least two days");
  const mid = addDays(from, Math.floor(daysBetween(from, to) / 2));
  return [
    { from, to: mid },
    { from: addDays(mid, 1), to },
  ];
}
