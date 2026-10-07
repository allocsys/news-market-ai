// Macro context for the Analyst Team (XAUUSD): turns a point-in-time macro snapshot
// (storage/inputs_view.js#getMacroSnapshotAsOf: FRED rates/dollar/inflation + CFTC
// gold COT) into a short, factual text block for the analyst prompt.
//
// GATING (the whole point of keeping this separate from analystTeam.js):
//   - config.macroEnabled === true is the ONLY switch the pipeline looks at. The live
//     llm Worker sets it from the operator flag (storage/macro_flag.js); a backtest
//     gets it from its own per-run knob (backtest/knobOverrides.js). The pipeline
//     never reads the flag itself, so a backtest can never be affected by the live one.
//   - OFF (or a ticker the macro feature does not cover) => NO D1 read at all and no
//     prompt text. Budget-paced backtest walks hardcode D1 call counts per stage
//     (test/backtest_budget_resume.test.js), so "off = zero extra calls" is a contract.
//
// POINT-IN-TIME: the snapshot only holds values whose available_at <= asOf, and the
// formatter adds nothing from outside it (no "today"). The block states each value's
// observation date so the model can see how stale a slow series is.

import { getMacroSnapshotAsOf } from "../../storage/inputs_view.js";
import { COT_SERIES } from "../../ingestion/sources/cftc_cot.js";

/** Tickers the macro feature covers (gold). Everything else analyzes exactly as before. */
export const MACRO_TICKERS = Object.freeze(["XAUUSD"]);

// Window/size for the snapshot read. 440 days (not the 400 default) so a monthly series
// like CPI still has an observation ~1 year before its latest one even after its
// publication lag -- the year-over-year line needs it. perSeries only trims in JS.
const SNAPSHOT_WINDOW_DAYS = 440;
const SNAPSHOT_PER_SERIES = 60;

const DAY_MS = 24 * 60 * 60 * 1000;

const FRED_LINES = [
  { id: "DFII10", label: "10y TIPS real yield", unit: "%" },
  { id: "T10YIE", label: "10y breakeven inflation", unit: "%" },
  { id: "DFF", label: "effective fed funds rate", unit: "%" },
  { id: "DTWEXBGS", label: "broad trade-weighted US dollar index", unit: "" },
];

/** True when the macro block should be built for this run + ticker. */
export function macroAppliesTo(config, ticker) {
  return config?.macroEnabled === true && MACRO_TICKERS.includes(ticker);
}

/**
 * The formatted macro block for `ticker` as of `asOf`, or null when the feature is off, the ticker
 * is not covered, or nothing is available yet (so the prompt simply has no macro section).
 * One D1 read, only when macroAppliesTo.
 */
export async function loadMacroContext(config, inputs, { ticker, asOf }) {
  if (!macroAppliesTo(config, ticker)) return null;
  const snapshot = await getMacroSnapshotAsOf(inputs, { asOf, perSeries: SNAPSHOT_PER_SERIES, windowDays: SNAPSHOT_WINDOW_DAYS });
  return formatMacroContext(snapshot) || null;
}

function shiftDate(obsDate, days) {
  return new Date(Date.parse(`${obsDate}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Observations as `[{ obsDate, val }]`, newest first, dropping anything non-numeric (never zero-filled). */
function cleanList(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((o) => o && typeof o.obsDate === "string" && o.val !== null && o.val !== undefined && Number.isFinite(Number(o.val)))
    .map((o) => ({ obsDate: o.obsDate, val: Number(o.val) }))
    .sort((a, b) => (a.obsDate < b.obsDate ? 1 : a.obsDate > b.obsDate ? -1 : 0));
}

/** The observation closest to `targetDate` within `tolDays`, or null. */
function nearest(list, targetDate, tolDays) {
  const target = Date.parse(`${targetDate}T00:00:00Z`);
  let best = null;
  let bestGap = Infinity;
  for (const o of list) {
    const gap = Math.abs(Date.parse(`${o.obsDate}T00:00:00Z`) - target);
    if (gap < bestGap) {
      best = o;
      bestGap = gap;
    }
  }
  return best && bestGap <= tolDays * DAY_MS ? best : null;
}

function signed(value, digits) {
  const text = value.toFixed(digits);
  const n = Number(text);
  if (n === 0) return (0).toFixed(digits);
  return n > 0 ? `+${text}` : text;
}

function whole(value) {
  return Math.round(value).toLocaleString("en-US");
}

/**
 * Compact text lines (one per series group) from a `getMacroSnapshotAsOf` result
 * (`{ [series]: [{ obsDate, availableAt, val }] }`, newest first). Returns "" when
 * there is nothing usable. Unknown series (a custom FRED_SERIES list) get a plain
 * "id: value (date)" line rather than being dropped.
 */
export function formatMacroContext(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return "";
  const lines = [];
  const handled = new Set();
  const take = (id) => {
    handled.add(id);
    return cleanList(snapshot[id]);
  };

  for (const { id, label, unit } of FRED_LINES) {
    const list = take(id);
    if (list.length === 0) continue;
    const latest = list[0];
    const prior = nearest(list.slice(1), shiftDate(latest.obsDate, -30), 10);
    const pp = unit === "%" ? " pp" : "";
    const change = prior ? `; about a month earlier ${prior.val.toFixed(2)}${unit}, change ${signed(latest.val - prior.val, 2)}${pp}` : "";
    lines.push(`- ${label} (${id}): ${latest.val.toFixed(2)}${unit} as of ${latest.obsDate}${change}`);
  }

  const cpi = take("CPIAUCSL");
  if (cpi.length > 0) {
    const latest = cpi[0];
    const yearAgo = nearest(cpi.slice(1), shiftDate(latest.obsDate, -365), 20);
    const yoy = yearAgo && yearAgo.val !== 0 ? `, ${signed((latest.val / yearAgo.val - 1) * 100, 1)}% year over year` : "";
    lines.push(`- US CPI, all items (CPIAUCSL): index ${latest.val.toFixed(1)} for the month starting ${latest.obsDate}${yoy}`);
  }

  const longs = take(COT_SERIES.MM_LONG);
  const shorts = take(COT_SERIES.MM_SHORT);
  const openInterest = take(COT_SERIES.OPEN_INTEREST);
  const shortByDate = new Map(shorts.map((o) => [o.obsDate, o.val]));
  const weeks = longs.filter((o) => shortByDate.has(o.obsDate)).map((o) => ({ obsDate: o.obsDate, long: o.val, short: shortByDate.get(o.obsDate), net: o.val - shortByDate.get(o.obsDate) }));
  if (weeks.length > 0) {
    const [week, prev] = weeks;
    const oi = openInterest.find((o) => o.obsDate === week.obsDate);
    const prior = prev ? `; prior week net ${whole(prev.net)}, change ${signed(week.net - prev.net, 0)}` : "";
    const interest = oi ? `; open interest ${whole(oi.val)}` : "";
    lines.push(`- Gold futures, CFTC managed money, week of ${week.obsDate}: net ${whole(week.net)} contracts (long ${whole(week.long)}, short ${whole(week.short)})${prior}${interest}`);
  }

  for (const id of Object.keys(snapshot).sort()) {
    if (handled.has(id)) continue;
    const list = cleanList(snapshot[id]);
    if (list.length === 0) continue;
    lines.push(`- ${id}: ${Number(list[0].val.toFixed(4))} as of ${list[0].obsDate}`);
  }

  return lines.join("\n");
}
