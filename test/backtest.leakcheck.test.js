// The automated leak-check test required by plan.md Backtesting Integrity,
// point 6: this must be a real, runnable test in CI, not just a written
// principle. Exercises the exact function (assertNoLookahead) that backtest
// runs will call at runtime, so the test and the guard can't drift apart.

import test from "node:test";
import assert from "node:assert/strict";
import { assertNoLookahead, walkForwardWindows } from "../src/backtest/pointInTime.js";
import { LookaheadViolationError } from "../src/shared/errors.js";

test("assertNoLookahead passes when every row is at or before asOf", () => {
  const rows = [
    { published_at: "2026-01-01T00:00:00Z" },
    { published_at: "2026-01-02T00:00:00Z" },
  ];
  assert.doesNotThrow(() => assertNoLookahead(rows, "2026-01-02T00:00:00Z"));
});

test("assertNoLookahead throws LookaheadViolationError on a future row", () => {
  const rows = [{ published_at: "2026-01-05T00:00:00Z" }];
  assert.throws(() => assertNoLookahead(rows, "2026-01-02T00:00:00Z"), LookaheadViolationError);
});

test("assertNoLookahead ignores rows with no timestamp value", () => {
  const rows = [{ published_at: null }, { published_at: undefined }];
  assert.doesNotThrow(() => assertNoLookahead(rows, "2026-01-02T00:00:00Z"));
});

test("walkForwardWindows produces non-overlapping rolling windows", () => {
  const windows = [...walkForwardWindows("2026-01-01T00:00:00Z", "2026-03-01T00:00:00Z", { trainDays: 30, testDays: 10 })];
  assert.ok(windows.length > 0);
  for (const w of windows) {
    assert.ok(w.trainStart < w.trainEnd);
    assert.equal(w.trainEnd, w.testStart); // test window starts exactly where train ends -- no gap, no overlap
    assert.ok(w.testStart < w.testEnd);
  }
});
