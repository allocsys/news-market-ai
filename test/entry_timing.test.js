import test from "node:test";
import assert from "node:assert/strict";
import {
  ENTRY_FRESH_MAX_AGE_MS, PENDING_ENTRY_EXPIRY_MS, isEntryPriceStale, pendingEntryExpiresAt, findFillBar, isPendingEntryExpired,
} from "../src/shared/entry_timing.js";
import { buildBarSequence } from "../src/shared/bar_window.js";

const intradayBar = (ts) => ({ ts, open: 100, high: 101, low: 99, close: 100.5 });

test("isEntryPriceStale: a recently closed intraday bar is fresh", () => {
  // bar 14:30 closes 14:35; asOf 14:40 -> 5 min old
  assert.equal(isEntryPriceStale({ source: "intraday", bar: intradayBar("2026-09-30T14:30:00Z") }, "2026-09-30T14:40:00.000Z"), false);
});

test("isEntryPriceStale: an old intraday bar, a daily fallback, and no price are all stale", () => {
  assert.equal(isEntryPriceStale({ source: "intraday", bar: intradayBar("2026-09-29T19:55:00Z") }, "2026-09-30T14:40:00.000Z"), true);
  assert.equal(isEntryPriceStale({ source: "daily", bar: { date: "2026-09-29", close: 1 } }, "2026-09-30T14:40:00.000Z"), true);
  assert.equal(isEntryPriceStale({ source: null, price: null, bar: null }, "2026-09-30T14:40:00.000Z"), true);
  assert.equal(isEntryPriceStale(null, "2026-09-30T14:40:00.000Z"), true);
});

test("isEntryPriceStale: boundary is inclusive of the max age, and bad timestamps are stale", () => {
  const bar = intradayBar("2026-09-30T14:00:00Z"); // closes 14:05
  const edge = new Date(Date.parse("2026-09-30T14:05:00Z") + ENTRY_FRESH_MAX_AGE_MS).toISOString();
  assert.equal(isEntryPriceStale({ source: "intraday", bar }, edge), false);
  assert.equal(isEntryPriceStale({ source: "intraday", bar }, new Date(Date.parse(edge) + 1).toISOString()), true);
  assert.equal(isEntryPriceStale({ source: "intraday", bar: intradayBar("garbage") }, edge), true);
  assert.equal(isEntryPriceStale({ source: "intraday", bar }, "not a date"), true);
});

test("pendingEntryExpiresAt / isPendingEntryExpired", () => {
  const asOf = "2026-09-26T21:00:00.000Z";
  const exp = pendingEntryExpiresAt(asOf);
  assert.equal(Date.parse(exp) - Date.parse(asOf), PENDING_ENTRY_EXPIRY_MS);
  assert.equal(pendingEntryExpiresAt("nope"), null);
  assert.equal(isPendingEntryExpired(exp, asOf), false);
  assert.equal(isPendingEntryExpired(exp, exp), true);
  assert.equal(isPendingEntryExpired(null, asOf), true);
});

test("findFillBar: first intraday bar opening at/after asOf, at its open; earlier and straddling bars are skipped", () => {
  const seq = buildBarSequence({
    intraday: [
      { ts: "2026-09-26T20:55:00Z", open: 10, high: 11, low: 9, close: 10 },
      { ts: "2026-09-29T13:30:00Z", open: 12, high: 13, low: 11, close: 12.5 },
      { ts: "2026-09-29T13:35:00Z", open: 12.5, high: 13, low: 12, close: 12.8 },
    ],
  });
  const fill = findFillBar(seq, "2026-09-26T21:00:00.000Z");
  assert.deepEqual(fill, { price: 12, source: "intraday", barTs: "2026-09-29T13:30:00Z", openedAt: "2026-09-29T13:30:00.000Z" });
  // asOf exactly at a bar's open: that bar is usable (its open is the first price at/after the decision)
  assert.equal(findFillBar(seq, "2026-09-29T13:35:00.000Z").price, 12.5);
});

test("findFillBar: falls back to a daily bar's open on a day with no intraday rows", () => {
  const seq = buildBarSequence({ daily: [{ date: "2026-09-28", open: 50, high: 52, low: 49, close: 51 }] });
  const fill = findFillBar(seq, "2026-09-26T21:00:00.000Z");
  assert.deepEqual(fill, { price: 50, source: "daily", barTs: "2026-09-28", openedAt: "2026-09-28T00:00:00.000Z" });
});

test("findFillBar: null when nothing has closed yet, asOf is bad, or the only open is unusable", () => {
  assert.equal(findFillBar([], "2026-09-26T21:00:00.000Z"), null);
  assert.equal(findFillBar(undefined, "2026-09-26T21:00:00.000Z"), null);
  const seq = buildBarSequence({ intraday: [{ ts: "2026-09-29T13:30:00Z", open: 12, high: 13, low: 11, close: 12 }] });
  assert.equal(findFillBar(seq, "garbage"), null);
  assert.equal(findFillBar(seq, "2026-09-30T00:00:00.000Z"), null);
  const bad = buildBarSequence({ intraday: [{ ts: "2026-09-29T13:30:00Z", open: 0, high: 1, low: 0, close: 1 }] });
  assert.equal(findFillBar(bad, "2026-09-26T21:00:00.000Z"), null);
});
