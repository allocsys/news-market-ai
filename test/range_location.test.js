// agents/risk_mgmt/range_location.js: the pure range-location filter (decision switch rangeLocationFilter, default OFF).

import test from "node:test";
import assert from "node:assert/strict";
import { rangeFilterParams, computeRangePosition, evaluateRangeLocation } from "../src/agents/risk_mgmt/range_location.js";
import { DEFAULT_RANGE_FILTER_DAYS, DEFAULT_RANGE_FILTER_EDGE_PCT } from "../src/shared/constants.js";

// Daily bars, MOST RECENT FIRST (the shape graph/pipeline.js holds). n bars, overall high 200 (4th newest) and low 100 (7th newest).
const bars = (n = 10) =>
  Array.from({ length: n }, (_, i) => ({
    date: `2026-01-${String(14 - i).padStart(2, "0")}`,
    high: i === 3 ? 200 : 150,
    low: i === 6 ? 100 : 120,
  }));

test("rangeFilterParams: constants.js defaults, valid overrides kept, invalid ones fall back", () => {
  assert.deepEqual(rangeFilterParams({}), { days: DEFAULT_RANGE_FILTER_DAYS, edgePct: DEFAULT_RANGE_FILTER_EDGE_PCT });
  assert.deepEqual(rangeFilterParams(undefined), { days: DEFAULT_RANGE_FILTER_DAYS, edgePct: DEFAULT_RANGE_FILTER_EDGE_PCT });
  assert.deepEqual(rangeFilterParams({ rangeFilterDays: 14, rangeFilterEdgePct: 0.15 }), { days: 14, edgePct: 0.15 });
  for (const bad of [{ rangeFilterDays: 1 }, { rangeFilterDays: 2.5 }, { rangeFilterEdgePct: 0 }, { rangeFilterEdgePct: 0.6 }, { rangeFilterEdgePct: Number.NaN }]) {
    assert.deepEqual(rangeFilterParams(bad), { days: DEFAULT_RANGE_FILTER_DAYS, edgePct: DEFAULT_RANGE_FILTER_EDGE_PCT }, JSON.stringify(bad));
  }
});

test("computeRangePosition: 0 at the low, 1 at the high, beyond them outside [0, 1]", () => {
  assert.equal(computeRangePosition(bars(), 150, 10).positionPct, 0.5);
  assert.equal(computeRangePosition(bars(), 100, 10).positionPct, 0);
  assert.equal(computeRangePosition(bars(), 200, 10).positionPct, 1);
  assert.ok(Math.abs(computeRangePosition(bars(), 210, 10).positionPct - 1.1) < 1e-9);
  assert.ok(Math.abs(computeRangePosition(bars(), 90, 10).positionPct - -0.1) < 1e-9);
  const r = computeRangePosition(bars(), 150, 10);
  assert.deepEqual([r.high, r.low, r.barsUsed], [200, 100, 10]);
});

test("computeRangePosition: only the `days` most recent bars count", () => {
  // Newest 5 bars: high 200 (4th newest), low 120 (the 100 low is the 7th newest, out of range).
  const r = computeRangePosition(bars(10), 160, 5);
  assert.deepEqual([r.high, r.low, r.barsUsed], [200, 120, 5]);
  assert.equal(r.positionPct, 0.5);
});

test("computeRangePosition: null when not computable (too few bars, bad price, flat range, no array)", () => {
  assert.equal(computeRangePosition(bars(9), 150, 10), null);
  assert.equal(computeRangePosition(bars(), Number.NaN, 10), null);
  assert.equal(computeRangePosition(bars(), 0, 10), null);
  assert.equal(computeRangePosition(bars(), -5, 10), null);
  assert.equal(computeRangePosition(Array.from({ length: 10 }, () => ({ high: 100, low: 100 })), 100, 10), null);
  assert.equal(computeRangePosition(null, 150, 10), null);
  assert.equal(computeRangePosition(undefined, 150, 10), null);
});

test("computeRangePosition: unusable bars are skipped and do not count toward `days`", () => {
  const withJunk = [{ high: Number.NaN, low: 1 }, { high: 150, low: 160 }, { high: 150, low: 0 }, null, ...bars(10)];
  const r = computeRangePosition(withJunk, 150, 10);
  assert.equal(r.barsUsed, 10);
  assert.deepEqual([r.high, r.low], [200, 100]);
});

test("evaluateRangeLocation: a long near the high is blocked, a short near the low is blocked", () => {
  const long = evaluateRangeLocation({ direction: "long", price: 190, bars: bars() });
  assert.equal(long.applied, true);
  assert.equal(long.blocked, true);
  assert.equal(long.breakout, false);
  assert.equal(long.rangePositionPct, 0.9);
  assert.match(long.reason, /^range filter: long at 90% of the 10-day range \(100-200\), within 20% of the high$/);

  const short = evaluateRangeLocation({ direction: "short", price: 110, bars: bars() });
  assert.equal(short.blocked, true);
  assert.match(short.reason, /^range filter: short at 10% of the 10-day range/);
  assert.match(short.reason, /within 20% of the low$/);
});

test("evaluateRangeLocation: the other side of the range is not blocked (a long near the low, a short near the high)", () => {
  const long = evaluateRangeLocation({ direction: "long", price: 110, bars: bars() });
  assert.deepEqual([long.applied, long.blocked], [true, false]);
  assert.match(long.reason, /^range filter passed/);
  const short = evaluateRangeLocation({ direction: "short", price: 190, bars: bars() });
  assert.deepEqual([short.applied, short.blocked], [true, false]);
});

test("evaluateRangeLocation: a middle price passes for both directions", () => {
  for (const direction of ["long", "short"]) {
    const out = evaluateRangeLocation({ direction, price: 150, bars: bars() });
    assert.deepEqual([out.applied, out.blocked, out.breakout], [true, false, false], direction);
  }
});

test("evaluateRangeLocation: a breakout is allowed (long above the prior high, short below the prior low)", () => {
  const long = evaluateRangeLocation({ direction: "long", price: 210, bars: bars() });
  assert.deepEqual([long.applied, long.blocked, long.breakout], [true, false, true]);
  assert.match(long.reason, /beyond the prior high \(breakout\)/);
  const short = evaluateRangeLocation({ direction: "short", price: 90, bars: bars() });
  assert.deepEqual([short.applied, short.blocked, short.breakout], [true, false, true]);
  assert.match(short.reason, /beyond the prior low \(breakout\)/);
  // The wrong-way breakout is not an exception: a long below the range is not near the high.
  assert.equal(evaluateRangeLocation({ direction: "long", price: 90, bars: bars() }).blocked, false);
});

test("evaluateRangeLocation: days and edgePct are honored", () => {
  // 0.9 of the range is inside a 20% edge but outside a 5% edge.
  assert.equal(evaluateRangeLocation({ direction: "long", price: 190, bars: bars(), edgePct: 0.05 }).blocked, false);
  assert.equal(evaluateRangeLocation({ direction: "long", price: 190, bars: bars(), edgePct: 0.2 }).blocked, true);
  // days: 5 -> range 120..200, 190 sits at 87.5%.
  const five = evaluateRangeLocation({ direction: "long", price: 190, bars: bars(), days: 5 });
  assert.equal(five.days, 5);
  assert.equal(five.rangePositionPct, 0.875);
});

test("evaluateRangeLocation: nothing to judge never blocks (flat direction, too little history, no price) and never throws", () => {
  const flat = evaluateRangeLocation({ direction: "flat", price: 190, bars: bars() });
  assert.deepEqual([flat.applied, flat.blocked], [false, false]);
  const short = evaluateRangeLocation({ direction: "long", price: 190, bars: bars(4) });
  assert.deepEqual([short.applied, short.blocked], [false, false]);
  assert.match(short.reason, /fewer than 10 usable daily bars/);
  assert.equal(evaluateRangeLocation({ direction: "long", price: null, bars: bars() }).blocked, false);
  assert.equal(evaluateRangeLocation({}).blocked, false);
  assert.equal(evaluateRangeLocation({ direction: "long", price: 190 }).applied, false);
});
