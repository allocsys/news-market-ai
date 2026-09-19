// Covers storage/sim_registry.js's backtest_runs read/write functions
// (migrations/sim/0001_backtest_runs.sql) -- insertBacktestRun/
// completeBacktestRun/failBacktestRun/getRecentBacktestRuns. Minimal
// in-memory fake of just this table's INSERT/UPDATE/SELECT shapes, same
// narrow-fake convention as test/backtest_no_signal_baseline.test.js's
// FakePriceBarsDb -- this file doesn't touch any other table.

import test from "node:test";
import assert from "node:assert/strict";
import { insertBacktestRun, completeBacktestRun, failBacktestRun, getRecentBacktestRuns } from "../src/storage/sim_registry.js";

class FakeBacktestRunsDb {
  constructor() {
    this.rows = new Map(); // id -> row
  }
  prepare(sql) {
    const db = this;
    return {
      bind(...args) {
        return {
          async run() {
            if (/INSERT INTO backtest_runs/.test(sql)) {
              const [id, tickers, testStart, testEnd, trainDays, testDays, graceDays, startedAt] = args;
              db.rows.set(id, {
                id, tickers, test_start: testStart, test_end: testEnd, train_days: trainDays, test_days: testDays,
                grace_days: graceDays, status: "running", result: null, error: null, started_at: startedAt, finished_at: null,
              });
              return;
            }
            if (/UPDATE backtest_runs SET status = 'complete'/.test(sql)) {
              const [result, finishedAt, id] = args;
              const row = db.rows.get(id);
              if (row) { row.status = "complete"; row.result = result; row.finished_at = finishedAt; }
              return;
            }
            if (/UPDATE backtest_runs SET status = 'failed'/.test(sql)) {
              const [error, finishedAt, id] = args;
              const row = db.rows.get(id);
              if (row) { row.status = "failed"; row.error = error; row.finished_at = finishedAt; }
              return;
            }
            throw new Error(`FakeBacktestRunsDb: unsupported run() query: ${sql}`);
          },
          async all() {
            if (/FROM backtest_runs/.test(sql)) {
              const [limit] = args;
              const results = [...db.rows.values()]
                .sort((a, b) => (a.started_at < b.started_at ? 1 : -1))
                .slice(0, limit);
              return { results };
            }
            throw new Error(`FakeBacktestRunsDb: unsupported all() query: ${sql}`);
          },
        };
      },
    };
  }
}

test("insertBacktestRun writes a 'running' row with no result/error yet", async () => {
  const db = new FakeBacktestRunsDb();
  await insertBacktestRun(db, {
    id: "run-1", tickers: ["AAPL", "MSFT"], testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-02-01T00:00:00.000Z",
    trainDays: 0, testDays: 31, graceDays: 5, startedAt: "2026-02-01T00:00:00.000Z",
  });

  const [run] = await getRecentBacktestRuns(db, { limit: 10 });
  assert.equal(run.id, "run-1");
  assert.deepEqual(run.tickers, ["AAPL", "MSFT"]);
  assert.equal(run.status, "running");
  assert.equal(run.result, null);
  assert.equal(run.finishedAt, null);
  assert.equal(run.graceDays, 5);
});

test("completeBacktestRun sets status='complete' and persists the JSON result", async () => {
  const db = new FakeBacktestRunsDb();
  await insertBacktestRun(db, {
    id: "run-2", tickers: ["AAPL"], testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-02-01T00:00:00.000Z",
    trainDays: 0, testDays: 31, startedAt: "2026-02-01T00:00:00.000Z",
  });

  const result = { overall: { on: { cumulativeReturn: 0.1 }, off: { cumulativeReturn: 0.02 }, delta: { cumulativeReturn: 0.08 } }, perWindow: [] };
  await completeBacktestRun(db, { id: "run-2", result, finishedAt: "2026-02-01T00:05:00.000Z" });

  const [run] = await getRecentBacktestRuns(db, { limit: 10 });
  assert.equal(run.status, "complete");
  assert.deepEqual(run.result, result);
  assert.equal(run.finishedAt, "2026-02-01T00:05:00.000Z");
  assert.equal(run.error, null);
});

test("failBacktestRun sets status='failed' with the error message, leaves result null", async () => {
  const db = new FakeBacktestRunsDb();
  await insertBacktestRun(db, {
    id: "run-3", tickers: ["AAPL"], testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-02-01T00:00:00.000Z",
    trainDays: 0, testDays: 31, startedAt: "2026-02-01T00:00:00.000Z",
  });

  await failBacktestRun(db, { id: "run-3", error: "simulated failure", finishedAt: "2026-02-01T00:05:00.000Z" });

  const [run] = await getRecentBacktestRuns(db, { limit: 10 });
  assert.equal(run.status, "failed");
  assert.equal(run.error, "simulated failure");
  assert.equal(run.result, null);
});

test("getRecentBacktestRuns returns newest-first, respecting limit", async () => {
  const db = new FakeBacktestRunsDb();
  for (const [id, startedAt] of [["a", "2026-01-01T00:00:00.000Z"], ["b", "2026-01-03T00:00:00.000Z"], ["c", "2026-01-02T00:00:00.000Z"]]) {
    await insertBacktestRun(db, { id, tickers: ["AAPL"], testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-02T00:00:00.000Z", trainDays: 0, testDays: 1, startedAt });
  }

  const runs = await getRecentBacktestRuns(db, { limit: 2 });
  assert.deepEqual(runs.map((r) => r.id), ["b", "c"]);
});
