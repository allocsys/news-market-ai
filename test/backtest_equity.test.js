// plan.md step D: src/backtest/equity.js, the daily portfolio equity curves both
// sides of the signal on/off comparison are scored on. Pure functions, so every
// expected number below is worked out by hand in the comments.

import test from "node:test";
import assert from "node:assert/strict";
import { buildPriceGrid, offEquityReturns, onEquityReturns, sliceSeriesByWindow, daysBetween, addDays, meanOf } from "../src/backtest/equity.js";

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ""} expected ${b}, got ${a}`);
const closeAll = (actual, expected, msg) => {
  assert.equal(actual.length, expected.length, `${msg ?? ""} length`);
  actual.forEach((v, i) => close(v, expected[i], `${msg ?? ""}[${i}]`));
};
const bar = (date, c) => ({ date, close: c });

// Span 2024-01-01 (Mon, a holiday: no bars) .. 2024-01-06 exclusive; the Friday
// 2023-12-29 bar is the last one before it, the entry price for buy-and-hold.
const FROM = "2024-01-01";
const TO = "2024-01-06";
const BARS = {
  A: [bar("2023-12-29", 100), bar("2024-01-02", 110), bar("2024-01-03", 121), bar("2024-01-04", 121), bar("2024-01-05", 133.1)],
  B: [bar("2023-12-29", 50), bar("2024-01-02", 50), bar("2024-01-03", 55), bar("2024-01-04", 44), bar("2024-01-05", 44)],
};
const grid = () => buildPriceGrid({ barsByTicker: BARS, tickers: ["A", "B"], from: FROM, to: TO });

test("daysBetween and addDays are calendar-day arithmetic on YYYY-MM-DD", () => {
  assert.equal(daysBetween("2023-12-29", "2024-01-02"), 4);
  assert.equal(daysBetween("2024-01-02", "2023-12-29"), -4);
  assert.equal(addDays("2024-01-01", -5), "2023-12-27");
  assert.equal(addDays("2024-02-28", 2), "2024-03-01"); // leap year
});

// ---------------------------------------------------------------------------
// buildPriceGrid
// ---------------------------------------------------------------------------

test("buildPriceGrid: weekends and holidays are fine, the grid is the union of bar dates in the span, entry price is the last bar before it", () => {
  const g = grid();
  assert.deepEqual(g.problems, []);
  assert.deepEqual(g.tickers, ["A", "B"]);
  assert.deepEqual(g.dates, ["2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05"]); // no Jan 1 bar, and the Dec 29 bar is not in the span
  assert.deepEqual(g.closes.A, [110, 121, 121, 133.1]);
  assert.deepEqual(g.basis, { A: 100, B: 50 });
});

test("buildPriceGrid forward-fills a ticker's missing day (no invented move) and never reads a bar dated on or after `to`", () => {
  const g = buildPriceGrid({
    barsByTicker: {
      A: [bar("2023-12-29", 100), bar("2024-01-02", 110), bar("2024-01-03", 120), bar("2024-01-04", 130), bar("2024-01-06", 9999)], // the Jan 6 bar is at `to`: invisible
      B: [bar("2023-12-29", 50), bar("2024-01-02", 55), bar("2024-01-04", 60)], // no Jan 3 bar
    },
    tickers: ["A", "B"], from: FROM, to: TO,
  });
  assert.deepEqual(g.problems, []);
  assert.deepEqual(g.dates, ["2024-01-02", "2024-01-03", "2024-01-04"]);
  assert.deepEqual(g.closes.B, [55, 55, 60]); // Jan 3 carries Jan 2's close
  assert.deepEqual(g.closes.A, [110, 120, 130]); // 9999 never appears
});

test("buildPriceGrid flags a ticker with no bar in the span, one starting too late, one that stops early, and one with a hole; each with its reason", () => {
  const g = buildPriceGrid({
    barsByTicker: {
      NONE: [bar("2023-12-20", 10)], // nothing inside the span (its latest bar is Dec 20)
      LATE: [bar("2024-01-05", 10)], // first bar 4 days after Jan 1 and 1 day before the end: acceptable
    },
    tickers: ["NONE", "LATE"], from: FROM, to: TO,
  });
  assert.deepEqual(g.tickers, ["LATE"]);
  assert.equal(g.problems.length, 1);
  assert.equal(g.problems[0].ticker, "NONE");
  assert.match(g.problems[0].reason, /no price bars in \[2024-01-01, 2024-01-06\)/);
  assert.match(g.problems[0].reason, /2023-12-20/);

  const start = buildPriceGrid({ barsByTicker: { X: [bar("2024-01-10", 10)] }, tickers: ["X"], from: "2024-01-01", to: "2024-01-31" });
  assert.match(start.problems[0].reason, /first price bar is 2024-01-10, 9 days after the window start 2024-01-01/);

  const end = buildPriceGrid({ barsByTicker: { X: [bar("2024-01-01", 10), bar("2024-01-03", 10)] }, tickers: ["X"], from: "2024-01-01", to: "2024-01-31" });
  assert.match(end.problems[0].reason, /price data ends 2024-01-03, 28 days before the window end 2024-01-31/);

  const hole = buildPriceGrid({ barsByTicker: { X: [bar("2024-01-01", 10), bar("2024-01-04", 10), bar("2024-01-14", 10), bar("2024-01-30", 10)] }, tickers: ["X"], from: "2024-01-01", to: "2024-01-31" });
  assert.match(hole.problems[0].reason, /no price bars for 10 days between 2024-01-04 and 2024-01-14/);

  assert.deepEqual(hole.tickers, []);
  assert.deepEqual(hole.dates, []);
});

test("buildPriceGrid: with no recent bar before the span, the entry price is the first bar inside it", () => {
  const g = buildPriceGrid({
    barsByTicker: { A: [bar("2023-12-20", 90), bar("2024-01-02", 110), bar("2024-01-03", 121)] }, // Dec 20 is 12 days before Jan 1: too stale to buy at
    tickers: ["A"], from: FROM, to: "2024-01-04",
  });
  assert.deepEqual(g.problems, []);
  assert.equal(g.basis.A, 110);
  closeAll(offEquityReturns(g).returns, [0, 0.1], "first-bar entry earns nothing on its own day"); // (121 / 110) - 1
});

// ---------------------------------------------------------------------------
// offEquityReturns: equal-weight buy-and-hold, never rebalanced
// ---------------------------------------------------------------------------

test("offEquityReturns: equal-weight buy-and-hold from the prior close, hand-checked", () => {
  const { returns, exposure } = offEquityReturns(grid());
  // value_k = (A/100 + B/50) / 2 : Jan 2 = (1.10+1.00)/2 = 1.05 ; Jan 3 = (1.21+1.10)/2 = 1.155 ;
  //          Jan 4 = (1.21+0.88)/2 = 1.045 ; Jan 5 = (1.331+0.88)/2 = 1.1055
  closeAll(returns, [1.05 - 1, 1.155 / 1.05 - 1, 1.045 / 1.155 - 1, 1.1055 / 1.045 - 1]);
  assert.deepEqual(exposure, [1, 1, 1, 1]);
});

test("offEquityReturns of an empty grid is empty (nothing invented)", () => {
  const g = buildPriceGrid({ barsByTicker: {}, tickers: ["A"], from: FROM, to: TO });
  assert.deepEqual(offEquityReturns(g), { returns: [], exposure: [] });
});

// ---------------------------------------------------------------------------
// onEquityReturns
// ---------------------------------------------------------------------------

const pos = (over) => ({ id: "p", ticker: "A", direction: "long", positionSizePct: 0.1, entryPrice: 110, exitPrice: null, closeReason: null, openedAt: "2024-01-03T09:30:00.000Z", closedAt: null, ...over });

test("onEquityReturns: no positions means cash the whole time (0% every day, 0 exposure)", () => {
  const r = onEquityReturns(grid(), []);
  assert.deepEqual(r.returns, [0, 0, 0, 0]);
  assert.deepEqual(r.exposure, [0, 0, 0, 0]);
  assert.equal(r.positionsTraded, 0);
});

test("onEquityReturns: a long is sized at its % of equity, earns the close-to-close moves from its open day up to (not including) its close day", () => {
  // Opened during Jan 3 at the prior close 110 (Jan 2), closed during Jan 5 at the prior close 121 (Jan 4): active Jan 3 and Jan 4.
  const r = onEquityReturns(grid(), [pos({ id: "p1", closedAt: "2024-01-05T00:00:00.000Z", exitPrice: 121 })]);
  // Jan 3: allocation 0.10, value 0.10 * 121/110 = 0.11, pnl 0.01, return 0.01 on equity 1. Jan 4: 121 -> 121, pnl 0. Jan 5: closed, cash.
  closeAll(r.returns, [0, 0.01, 0, 0]);
  closeAll(r.exposure, [0, 0.1, 0.11 / 1.01, 0]);
  assert.equal(r.positionsTraded, 1);
});

test("onEquityReturns: a short profits when the price falls, and a still-open position is marked to market at the end of the span", () => {
  // Short B opened during Jan 4 at the prior close 55 (Jan 3). Jan 4: 44/55 = 0.8 -> value 0.10 * (2 - 0.8) = 0.12, pnl +0.02. Jan 5: 44 -> 44, pnl 0.
  const r = onEquityReturns(grid(), [pos({ id: "s1", ticker: "B", direction: "short", entryPrice: 55, openedAt: "2024-01-04T10:00:00.000Z" })]);
  closeAll(r.returns, [0, 0, 0.02, 0]);
  closeAll(r.exposure, [0, 0, 0.1, 0.12 / 1.02]);
});

test("onEquityReturns: a later position is sized off the equity the earlier ones have grown to", () => {
  const r = onEquityReturns(grid(), [
    pos({ id: "p1", closedAt: "2024-01-05T00:00:00.000Z", exitPrice: 121 }), // +0.01 on Jan 3, equity 1.01
    pos({ id: "p2", positionSizePct: 0.5, entryPrice: 121, openedAt: "2024-01-04T12:00:00.000Z" }), // open through the end
  ]);
  // p2 allocation = 0.5 * 1.01 = 0.505 on Jan 4 (121 -> 121, pnl 0); Jan 5: 133.1/121 = 1.1 -> value 0.5555, pnl 0.0505 on equity 1.01 = +5%.
  closeAll(r.returns, [0, 0.01, 0, 0.05]);
});

test("onEquityReturns: a position that opens and closes inside one UTC day is active for that one day and earns its move; one opened before the span is active from its first day", () => {
  const sameDay = onEquityReturns(grid(), [pos({ id: "d", openedAt: "2024-01-03T09:00:00.000Z", closedAt: "2024-01-03T15:00:00.000Z" })]);
  // Active only on its open day, Jan 3: alloc 0.10, value 0.10 * 121/110 = 0.11, pnl 0.01, return 0.01.
  closeAll(sameDay.returns, [0, 0.01, 0, 0]);
  assert.equal(sameDay.positionsTraded, 1);

  // Opened Dec 29 at 100 (the Friday close), so it earns Jan 2's +10% and Jan 3's +10% on 0.10 of equity 1.
  const carried = onEquityReturns(grid(), [pos({ id: "c", entryPrice: 100, openedAt: "2023-12-29T18:00:00.000Z", closedAt: "2024-01-04T00:00:00.000Z" })]);
  // Jan 2: alloc 0.10, value 0.11, pnl 0.01 (return 0.01). Jan 3: value 0.121, pnl 0.011 on equity 1.01.
  closeAll(carried.returns, [0.01, 0.011 / 1.01, 0, 0]);
});

test("onEquityReturns counts, and does not guess at, positions it cannot replay", () => {
  const r = onEquityReturns(grid(), [
    pos({ id: "no-price", entryPrice: null }),
    pos({ id: "no-direction", direction: null }),
    pos({ id: "zero-size", positionSizePct: 0 }),
    pos({ id: "other-ticker", ticker: "ZZZ" }),
    pos({ id: "ok" }),
  ]);
  assert.equal(r.positionsIgnored, 4);
  assert.equal(r.positionsTraded, 1);
});

test("onEquityReturns over an empty grid is empty and counts every position as ignored", () => {
  const g = buildPriceGrid({ barsByTicker: {}, tickers: ["A"], from: FROM, to: TO });
  assert.deepEqual(onEquityReturns(g, [pos({})]), { returns: [], exposure: [], positionsTraded: 0, positionsIgnored: 1 });
});

// ---------------------------------------------------------------------------
// slicing
// ---------------------------------------------------------------------------

test("sliceSeriesByWindow takes the grid dates in [testStart's UTC date, testEnd's UTC date), for ISO timestamps", () => {
  const dates = ["2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05"];
  const values = [1, 2, 3, 4];
  assert.deepEqual(sliceSeriesByWindow(dates, values, { testStart: "2024-01-03T00:00:00.000Z", testEnd: "2024-01-05T00:00:00.000Z" }), [2, 3]);
  assert.deepEqual(sliceSeriesByWindow(dates, values, { testStart: "2024-01-01T00:00:00.000Z", testEnd: "2024-01-03T00:00:00.000Z" }), [1]);
  assert.deepEqual(sliceSeriesByWindow(dates, values, { testStart: "2024-02-01T00:00:00.000Z", testEnd: "2024-02-05T00:00:00.000Z" }), []);
});

test("contiguous windows partition the series: their slices, joined, are the whole thing", () => {
  const dates = ["2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05"];
  const values = [1, 2, 3, 4];
  const a = sliceSeriesByWindow(dates, values, { testStart: "2024-01-01T00:00:00.000Z", testEnd: "2024-01-04T00:00:00.000Z" });
  const b = sliceSeriesByWindow(dates, values, { testStart: "2024-01-04T00:00:00.000Z", testEnd: "2024-01-06T00:00:00.000Z" });
  assert.deepEqual([...a, ...b], values);
});

test("meanOf", () => {
  assert.equal(meanOf([]), 0);
  assert.equal(meanOf([1, 2, 3]), 2);
});
