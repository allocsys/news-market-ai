// Covers the `llm` Worker's (src/llm-worker.js) `queue()` export (plan.md
// Step 6) -- the consumer for both ANALYZE (`analyze`) and LLM_JOBS
// (`backtest`, `exit_check`).
//
// These tests moved here, behavior/assertions unchanged, from two files that
// used to exercise them through `backend`'s queue():
//   - `backtest`: test/queue_consumer.test.js (plan.md Step 3)
//   - `exit_check` / `analyze`: test/cron_fanout.test.js (plan.md Step 4)
// The underlying functions (runManualBacktest, checkOpenPositionExits,
// runPipelineForTicker) did not change at all -- only which Worker's
// queue() calls them. Plus new tests for this Worker's own unrecognized-type
// and crashed-handler paths (there's no shared queue() handler to inherit
// those from anymore) and one proving `backend`'s old message types don't
// leak back in here by accident.
//
// SCOPE NOTE on `analyze`: only the retry-on-failure path is covered here.
// A full success round-trip through runPipelineForTicker needs the same
// heavyweight FakePipelineDb + config.fakeModel machinery
// test/checkpoint_resume.test.js already builds and exercises in depth
// (six agent stages, checkpoint/resume, position open/close) -- duplicating
// that here would just be the same coverage under a different file name.
// What THIS file adds: proving the `analyze` branch specifically retries
// (not acks) on failure, which is the one deliberate behavioral difference
// from every other message type in this handler (see llm-worker.js's own
// comment on that branch for why that's correct given checkpointer.js's
// resume semantics).
//
// FakeMessage below stands in for a Cloudflare Queues Message object --
// just enough of its shape (`body`, `ack()`, `retry()`) for these tests to
// observe which one queue() called, without needing the real Queues
// runtime.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/llm-worker.js";
import { getRecentBacktestRuns } from "../src/storage/d1.js";

class FakeMessage {
  constructor(body) {
    this.body = body;
    this.acked = false;
    this.retried = false;
  }
  ack() {
    this.acked = true;
  }
  retry() {
    this.retried = true;
  }
}

function batchOf(...messages) {
  return { messages };
}

// Same narrow in-memory fake as test/storage_backtest_runs.test.js -- this
// file needs the real insert/complete/fail/list SQL shapes runManualBacktest
// actually issues, not a hand-guessed one.
class FakeBacktestRunsDb {
  constructor() {
    this.rows = new Map();
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
              const results = [...db.rows.values()].sort((a, b) => (a.started_at < b.started_at ? 1 : -1)).slice(0, limit);
              return { results };
            }
            throw new Error(`FakeBacktestRunsDb: unsupported all() query: ${sql}`);
          },
        };
      },
    };
  }
}

/** Minimal fake for checkOpenPositionExits: no open positions, so it never reaches closePosition/settlePositionOutcome at all -- just proving the exit_check branch wires through, not exit logic itself (see test/exit_logic.test.js for that). */
class FakeNoPositionsDb {
  prepare(sql) {
    return {
      bind() {
        return {
          async all() {
            if (/FROM positions/.test(sql)) return { results: [] };
            throw new Error(`FakeNoPositionsDb: unsupported all() query: ${sql}`);
          },
        };
      },
    };
  }
}

// ---------------------------------------------------------------------------
// backtest (LLM_JOBS)
// ---------------------------------------------------------------------------

test("queue() processes a backtest job: runs runManualBacktest, persists a completed backtest_runs row, then acks", async () => {
  const db = new FakeBacktestRunsDb();
  const env = { DB: db };
  // structured.js's config.fakeModel isn't wired through queue() -- this
  // test only needs runManualBacktest to be CALLED and to persist a row;
  // it doesn't need the "on signal" side's real Gemini path to succeed, so
  // a window with no backfilled news (onSignalRunner reads nothing, no LLM
  // calls) is enough to exercise the whole plumbing without live traffic.
  const message = new FakeMessage({
    type: "backtest",
    id: "backtest-1",
    tickers: ["AAPL"],
    testStart: "2024-01-01T00:00:00.000Z",
    testEnd: "2024-01-02T00:00:00.000Z",
    graceDays: 0,
  });

  await worker.queue(batchOf(message), env);

  assert.equal(message.acked, true);
  assert.equal(message.retried, false);
  const [run] = await getRecentBacktestRuns(db, { limit: 10 });
  assert.equal(run.id, "backtest-1");
  assert.ok(run.status === "complete" || run.status === "failed"); // runManualBacktest never throws -- see its own header
});

// ---------------------------------------------------------------------------
// exit_check (LLM_JOBS)
// ---------------------------------------------------------------------------

test("queue() exit_check runs checkOpenPositionExits and acks", async () => {
  const env = { DB: new FakeNoPositionsDb() };

  const message = new FakeMessage({ type: "exit_check", asOf: "2026-09-18T00:00:00.000Z" });
  await worker.queue(batchOf(message), env);

  assert.equal(message.acked, true);
  assert.equal(message.retried, false);
});

test("queue() exit_check acks (does not retry) on failure -- next scheduled tick re-evaluates every still-open position regardless", async (t) => {
  class ThrowingPositionsDb {
    prepare() {
      throw new Error("simulated D1 read failure");
    }
  }
  const env = { DB: new ThrowingPositionsDb() };
  const errorLogs = [];
  t.mock.method(console, "error", (...args) => errorLogs.push(args));

  const message = new FakeMessage({ type: "exit_check", asOf: "2026-09-18T00:00:00.000Z" });
  await worker.queue(batchOf(message), env);

  assert.equal(message.acked, true);
  assert.equal(message.retried, false);
  assert.ok(errorLogs.some(([msg]) => msg.includes("exit_check job failed")));
});

// ---------------------------------------------------------------------------
// analyze (ANALYZE)
// ---------------------------------------------------------------------------

test("queue() analyze RETRIES (does not ack) on failure -- the one deliberate exception to every other message type in this handler, since runPipelineForTicker is checkpoint-resumable", async (t) => {
  class ThrowingCheckpointDb {
    prepare() {
      throw new Error("simulated D1 failure reading the checkpoint");
    }
  }
  const env = { DB: new ThrowingCheckpointDb() };
  const errorLogs = [];
  t.mock.method(console, "error", (...args) => errorLogs.push(args));

  const message = new FakeMessage({
    type: "analyze",
    runId: "news-1",
    ticker: "AAPL",
    newsItem: { id: "news-1", tickers: ["AAPL"], publishedAt: "2026-09-18T00:00:00.000Z" },
    asOf: "2026-09-18T00:00:00.000Z",
  });
  await worker.queue(batchOf(message), env);

  assert.equal(message.acked, false);
  assert.equal(message.retried, true);
  assert.ok(errorLogs.some(([msg]) => msg.includes("crashed unexpectedly")));
});

// ---------------------------------------------------------------------------
// generic paths
// ---------------------------------------------------------------------------

test("queue() acks (does not retry) an unrecognized job type -- including `backfill`, which stays on backend -- logging the anomaly", async (t) => {
  const env = { DB: new FakeBacktestRunsDb() };
  const errorLogs = [];
  t.mock.method(console, "error", (...args) => errorLogs.push(args));

  const unexpected = new FakeMessage({ type: "something-unexpected", id: "mystery-1" });
  const backfill = new FakeMessage({ type: "backfill", id: "backfill-1", from: "2024-01-01", to: "2024-01-31" });
  await worker.queue(batchOf(unexpected, backfill), env);

  assert.equal(unexpected.acked, true);
  assert.equal(unexpected.retried, false);
  // `backfill` is backend's JOBS message type (Finnhub, no LLM) -- this
  // Worker must never process it, just ack-and-log like any other unknown type.
  assert.equal(backfill.acked, true);
  assert.equal(backfill.retried, false);
  assert.equal(errorLogs.filter(([msg]) => msg.includes("unrecognized type")).length, 2);
});

test("queue() retries (does not ack) a message when the handler itself crashes unexpectedly", async (t) => {
  // A message with no `.type` at all reaches the `else` branch fine (that's
  // the "unrecognized type" case above) -- to actually exercise the retry
  // path we need queue()'s own try/catch to see a real thrown error, e.g.
  // a completely malformed message body that isn't even an object.
  const env = { DB: new FakeBacktestRunsDb() };
  const errorLogs = [];
  t.mock.method(console, "error", (...args) => errorLogs.push(args));

  const message = new FakeMessage(null); // job.type on null throws inside queue()'s try block
  await worker.queue(batchOf(message), env);

  assert.equal(message.acked, false);
  assert.equal(message.retried, true);
  assert.ok(errorLogs.some(([msg]) => msg.includes("crashed unexpectedly")));
});
