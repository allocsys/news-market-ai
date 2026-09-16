// Backtest-integrity helpers (plan.md "Backtesting Integrity" section).
// These are used both as runtime guards and directly inside the automated
// leak-check test (test/backtest.leakcheck.test.js, plan.md point 6) -- the
// same function backs both, so the test isn't checking a reimplementation
// of the rule.

import { LookaheadViolationError } from "../shared/errors.js";

/**
 * Throws LookaheadViolationError on the first row whose timestampField is
 * after `asOf`. Call this on the result of any point-in-time read before
 * trusting it in a backtest run.
 */
export function assertNoLookahead(rows, asOf, timestampField = "published_at") {
  for (const row of rows) {
    const value = row[timestampField];
    if (value && value > asOf) {
      throw new LookaheadViolationError(
        `Row timestamp ${JSON.stringify(value)} is after asOf=${asOf} (field: ${timestampField})`
      );
    }
  }
}

/**
 * Rolling walk-forward windows (plan.md Backtesting Integrity, point 5):
 * train on a fixed-length window, test on the window immediately after it,
 * then roll both forward by `testDays` and repeat -- rather than one static
 * train/test split.
 */
export function* walkForwardWindows(startDate, endDate, { trainDays, testDays }) {
  const DAY_MS = 86400000;
  let trainStart = new Date(startDate);
  const end = new Date(endDate);

  while (true) {
    const trainEnd = new Date(trainStart.getTime() + trainDays * DAY_MS);
    const testEnd = new Date(trainEnd.getTime() + testDays * DAY_MS);
    if (testEnd > end) break;

    yield {
      trainStart: trainStart.toISOString(),
      trainEnd: trainEnd.toISOString(),
      testStart: trainEnd.toISOString(),
      testEnd: testEnd.toISOString(),
    };
    trainStart = new Date(trainStart.getTime() + testDays * DAY_MS);
  }
}
