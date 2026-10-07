// Date-range helpers shared by the backfill and backtest forms. Dates are UTC
// ISO days (YYYY-MM-DD), which also compare correctly as plain strings.

const DAY_MS = 24 * 60 * 60 * 1000;

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** The UTC ISO day `n` days before now (0 = today). */
export const daysAgo = (n: number) => isoDay(new Date(Date.now() - n * DAY_MS));

/** Quick-pick windows ending today. */
export const RANGE_PRESETS = [
  { label: "7d", days: 7 },
  { label: "14d", days: 14 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
];

/** The { from, to } window for a preset: `days` days ago through today. */
export const presetRange = (days: number) => ({ from: daysAgo(days), to: daysAgo(0) });
