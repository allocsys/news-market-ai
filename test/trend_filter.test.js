// agents/risk_mgmt/trend_filter.js: the pure trend filter (knobs trendFilterAgainst / trendFilterMixed, default OFF).

import test from "node:test";
import assert from "node:assert/strict";
import { trendFilterParams, trendFilterActive, trendFilterWindow, longTrendAlignment, evaluateTrendFilter } from "../src/agents/risk_mgmt/trend_filter.js";

test("trendFilterParams / trendFilterActive: missing or non-true keys mean OFF", () => {
  assert.deepEqual(trendFilterParams({}), { against: false, mixed: false });
  assert.deepEqual(trendFilterParams(undefined), { against: false, mixed: false });
  assert.deepEqual(trendFilterParams({ trendFilterAgainst: 1, trendFilterMixed: "true" }), { against: false, mixed: false });
  assert.deepEqual(trendFilterParams({ trendFilterAgainst: true }), { against: true, mixed: false });
  assert.equal(trendFilterActive({}), false);
  assert.equal(trendFilterActive({ trendFilterMixed: true }), true);
});

test("evaluateTrendFilter: 'against' is blocked only when against is selected", () => {
  const on = evaluateTrendFilter({ alignment: "against", blockAgainst: true });
  assert.deepEqual([on.applied, on.blocked], [true, true]);
  assert.match(on.reason, /^trend filter: entry is against the trend$/);
  const off = evaluateTrendFilter({ alignment: "against", blockMixed: true });
  assert.deepEqual([off.applied, off.blocked], [true, false]);
});

test("evaluateTrendFilter: 'mixed' is blocked only when mixed is selected", () => {
  assert.equal(evaluateTrendFilter({ alignment: "mixed", blockMixed: true }).blocked, true);
  assert.equal(evaluateTrendFilter({ alignment: "mixed", blockAgainst: true }).blocked, false);
});

test("evaluateTrendFilter: both selected blocks against and mixed, never 'with'", () => {
  const both = { blockAgainst: true, blockMixed: true };
  assert.equal(evaluateTrendFilter({ alignment: "against", ...both }).blocked, true);
  assert.equal(evaluateTrendFilter({ alignment: "mixed", ...both }).blocked, true);
  const withTrend = evaluateTrendFilter({ alignment: "with", ...both });
  assert.deepEqual([withTrend.applied, withTrend.blocked], [true, false]);
  assert.match(withTrend.reason, /^trend filter passed \(with\)$/);
});

test("evaluateTrendFilter: nothing selected or nothing to judge never blocks and never throws", () => {
  const none = evaluateTrendFilter({ alignment: "against" });
  assert.deepEqual([none.applied, none.blocked], [false, false]);
  for (const alignment of ["unknown", null, undefined, 5, "bogus"]) {
    const out = evaluateTrendFilter({ alignment, blockAgainst: true, blockMixed: true });
    assert.deepEqual([out.applied, out.blocked], [false, false], String(alignment));
  }
  assert.equal(evaluateTrendFilter().blocked, false);
  assert.equal(evaluateTrendFilter({}).blocked, false);
});

// ---------------------------------------------------------------------------
// trendFilterWindow / longTrendAlignment / the window fields of the record
// ---------------------------------------------------------------------------

// Newest first, like state.priceBars. A drop from 206 to 110 over 24 sessions, then a 5-session bounce to 120.
const DOWNTREND_WITH_BOUNCE = [120, 118, 116, 114, 112, ...Array.from({ length: 25 }, (_, i) => 110 + i * 4)].map((close, i) => ({
  close,
  date: new Date(Date.parse("2026-01-14T00:00:00Z") - i * 86400000).toISOString().slice(0, 10),
}));

test("trendFilterWindow: only a whole number >= 2 turns it on; everything else is 0 (off)", () => {
  assert.equal(trendFilterWindow({ trendFilterWindow: 20 }), 20);
  assert.equal(trendFilterWindow({ trendFilterWindow: 2 }), 2);
  for (const v of [undefined, null, 0, 1, -3, 2.5, "20", Number.NaN]) assert.equal(trendFilterWindow({ trendFilterWindow: v }), 0, String(v));
  assert.equal(trendFilterWindow({}), 0);
  assert.equal(trendFilterWindow(undefined), 0);
  // The window alone never activates the gate.
  assert.equal(trendFilterActive({ trendFilterWindow: 20 }), false);
  // trendFilterParams keeps its two-key shape.
  assert.deepEqual(trendFilterParams({ trendFilterWindow: 20 }), { against: false, mixed: false });
});

test("longTrendAlignment: a bounce inside a downtrend is 'with' for a long on 5 bars but 'against' on 20", () => {
  const five = longTrendAlignment({ bars: DOWNTREND_WITH_BOUNCE, direction: "long", window: 5 });
  assert.equal(five.alignment, "with");
  const twenty = longTrendAlignment({ bars: DOWNTREND_WITH_BOUNCE, direction: "long", window: 20 });
  assert.equal(twenty.alignment, "against");
  assert.equal(twenty.window, 20);
  assert.equal(twenty.live, false);
  assert.equal(twenty.priceUsed, 120, "no live price: the newest close is the price");
  // The same market for a short is the mirror image.
  assert.equal(longTrendAlignment({ bars: DOWNTREND_WITH_BOUNCE, direction: "short", window: 20 }).alignment, "with");
});

test("longTrendAlignment: a live price joins the series only when it is from a later session than the newest bar", () => {
  const later = longTrendAlignment({ bars: DOWNTREND_WITH_BOUNCE, direction: "long", window: 20, price: 125, priceDate: "2026-01-15T13:30:00Z" });
  assert.equal(later.live, true);
  assert.equal(later.priceUsed, 125);
  const sameSession = longTrendAlignment({ bars: DOWNTREND_WITH_BOUNCE, direction: "long", window: 20, price: 125, priceDate: "2026-01-14" });
  assert.equal(sameSession.live, false, "same session as the newest bar is not counted twice");
  assert.equal(sameSession.priceUsed, 120);
  for (const bad of [{ price: 0 }, { price: -5 }, { price: Number.NaN }, { price: 125, priceDate: null }, { price: 125 }]) {
    assert.equal(longTrendAlignment({ bars: DOWNTREND_WITH_BOUNCE, direction: "long", window: 20, ...bad }).live, false, JSON.stringify(bad));
  }
});

test("longTrendAlignment: too few bars, a bad window, a flat direction or bad closes are 'unknown' and never throw", () => {
  const some = DOWNTREND_WITH_BOUNCE.slice(0, 10);
  assert.equal(longTrendAlignment({ bars: some, direction: "long", window: 20 }).alignment, "unknown");
  assert.equal(longTrendAlignment({ bars: DOWNTREND_WITH_BOUNCE.slice(0, 20), direction: "long", window: 20 }).alignment, "unknown", "needs one bar before the window for the change");
  assert.notEqual(longTrendAlignment({ bars: DOWNTREND_WITH_BOUNCE.slice(0, 21), direction: "long", window: 20 }).alignment, "unknown");
  for (const window of [0, 1, 2.5, -4, undefined, "20", null]) assert.equal(longTrendAlignment({ bars: DOWNTREND_WITH_BOUNCE, direction: "long", window }).alignment, "unknown", String(window));
  assert.equal(longTrendAlignment({ bars: DOWNTREND_WITH_BOUNCE, direction: "flat", window: 20 }).alignment, "unknown");
  assert.equal(longTrendAlignment({ bars: [{ close: null, date: "2026-01-14" }, ...DOWNTREND_WITH_BOUNCE], direction: "long", window: 20 }).alignment, "unknown");
  for (const bars of [undefined, null, [], "x", 5]) assert.equal(longTrendAlignment({ bars, direction: "long", window: 20 }).alignment, "unknown");
  assert.equal(longTrendAlignment().alignment, "unknown");
});

test("evaluateTrendFilter: a window adds window + shortAlignment to the record; without one the record is unchanged", () => {
  const withWindow = evaluateTrendFilter({ alignment: "against", blockAgainst: true, window: 20, shortAlignment: "with" });
  assert.deepEqual([withWindow.blocked, withWindow.window, withWindow.shortAlignment, withWindow.alignment], [true, 20, "with", "against"]);
  const missingShort = evaluateTrendFilter({ alignment: "with", blockAgainst: true, window: 20 });
  assert.equal(missingShort.shortAlignment, "unknown");
  const none = evaluateTrendFilter({ alignment: "against", blockAgainst: true });
  assert.equal("window" in none, false);
  assert.equal("shortAlignment" in none, false);
  const tooSmall = evaluateTrendFilter({ alignment: "against", blockAgainst: true, window: 1, shortAlignment: "with" });
  assert.equal("window" in tooSmall, false, "a window below 2 is not recorded");
  // An 'unknown' long-window read (too few bars) is never blocked.
  const unknown = evaluateTrendFilter({ alignment: "unknown", blockAgainst: true, blockMixed: true, window: 20, shortAlignment: "against" });
  assert.deepEqual([unknown.applied, unknown.blocked], [false, false]);
});
