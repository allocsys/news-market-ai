// src/ingestion/date_windows.js -- pure YYYY-MM-DD arithmetic under the
// date-windowed Finnhub backfill (see ingestion/ingest.js#backfillHistoricalNews).

import test from "node:test";
import assert from "node:assert/strict";
import { toDayString, addDays, daysBetween, buildWindows, splitWindow } from "../src/ingestion/date_windows.js";

test("toDayString accepts a YYYY-MM-DD string, an ISO timestamp and a Date, and rejects garbage", () => {
  assert.equal(toDayString("2025-09-01"), "2025-09-01");
  assert.equal(toDayString("2025-09-01T23:59:59.000Z"), "2025-09-01");
  assert.equal(toDayString(new Date("2025-09-01T00:00:00.000Z")), "2025-09-01");
  assert.throws(() => toDayString("not a date"), /invalid date/);
});

test("addDays crosses month, year and leap-day boundaries and goes backwards", () => {
  assert.equal(addDays("2025-09-30", 1), "2025-10-01");
  assert.equal(addDays("2025-12-31", 1), "2026-01-01");
  assert.equal(addDays("2024-02-28", 2), "2024-03-01"); // 2024 is a leap year
  assert.equal(addDays("2025-02-28", 1), "2025-03-01");
  assert.equal(addDays("2025-09-01", -1), "2025-08-31");
  assert.equal(addDays("2025-09-01", 0), "2025-09-01");
});

test("daysBetween is a signed whole-day difference, not an inclusive count", () => {
  assert.equal(daysBetween("2025-09-01", "2025-09-01"), 0);
  assert.equal(daysBetween("2025-09-01", "2025-09-30"), 29);
  assert.equal(daysBetween("2025-09-30", "2025-09-01"), -29);
  assert.equal(daysBetween("2024-12-31", "2025-01-01"), 1);
});

test("buildWindows tiles the range with consecutive non-overlapping windows, the last one shorter when it doesn't divide evenly", () => {
  assert.deepEqual(buildWindows("2025-09-01", "2025-09-12", 5), [
    { from: "2025-09-01", to: "2025-09-05" },
    { from: "2025-09-06", to: "2025-09-10" },
    { from: "2025-09-11", to: "2025-09-12" },
  ]);
});

test("buildWindows covers an exact multiple, a single day, a window bigger than the range, and an empty range", () => {
  assert.deepEqual(buildWindows("2025-09-01", "2025-09-10", 5), [
    { from: "2025-09-01", to: "2025-09-05" },
    { from: "2025-09-06", to: "2025-09-10" },
  ]);
  assert.deepEqual(buildWindows("2025-09-01", "2025-09-01", 5), [{ from: "2025-09-01", to: "2025-09-01" }]);
  assert.deepEqual(buildWindows("2025-09-01", "2025-09-03", 30), [{ from: "2025-09-01", to: "2025-09-03" }]);
  assert.deepEqual(buildWindows("2025-09-05", "2025-09-01", 5), []);
});

test("buildWindows: every day of a long range lands in exactly one window", () => {
  const windows = buildWindows("2025-01-01", "2025-12-31", 5);
  let expected = "2025-01-01";
  for (const w of windows) {
    assert.equal(w.from, expected, "each window starts the day after the previous one ends");
    assert.ok(w.from <= w.to);
    assert.ok(daysBetween(w.from, w.to) <= 4);
    expected = addDays(w.to, 1);
  }
  assert.equal(expected, "2026-01-01");
  assert.equal(windows.length, 73); // 365 / 5
});

test("buildWindows rejects a window size below one day", () => {
  assert.throws(() => buildWindows("2025-09-01", "2025-09-05", 0), /windowDays >= 1/);
  assert.throws(() => buildWindows("2025-09-01", "2025-09-05", NaN), /windowDays >= 1/);
});

test("splitWindow halves cover the window exactly, with no gap and no overlap, for every size from 2 to 9 days", () => {
  for (let days = 2; days <= 9; days++) {
    const from = "2025-09-01";
    const to = addDays(from, days - 1);
    const [first, second] = splitWindow(from, to);
    assert.equal(first.from, from);
    assert.equal(second.to, to);
    assert.equal(second.from, addDays(first.to, 1), `${days} days: second half starts the day after the first ends`);
    assert.ok(first.from <= first.to && second.from <= second.to, `${days} days: both halves are non-empty`);
  }
  assert.deepEqual(splitWindow("2025-09-01", "2025-09-05"), [
    { from: "2025-09-01", to: "2025-09-03" },
    { from: "2025-09-04", to: "2025-09-05" },
  ]);
  assert.deepEqual(splitWindow("2025-09-01", "2025-09-02"), [
    { from: "2025-09-01", to: "2025-09-01" },
    { from: "2025-09-02", to: "2025-09-02" },
  ]);
});

test("splitWindow refuses a single day", () => {
  assert.throws(() => splitWindow("2025-09-01", "2025-09-01"), /at least two days/);
});
