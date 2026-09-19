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
// M2: analyze/exit_check now build their engine ctx from LIVE_DB + INPUTS_DB
// (real sqlite here, see engineBindings()); the `backtest` message type is
// rejected loudly instead of run (backtests move to the M3 backtest Worker).
// llm_calls (retention prune) still rides env.DB until M2b.
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
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { STATE_DIR, INPUTS_DIR } from "./helpers/engine_ctx.js";
import path from "node:path";

// The OLD DB's schema (root migrations/*.sql) -- where job_progress and llm_calls still live until M2b.
const OLD_DB_DIR = path.join(STATE_DIR, "..", "..", "migrations");

/** Real sqlite LIVE_DB + INPUTS_DB, the two bindings llm-worker.js builds its engine ctx from (M2). */
function engineBindings() {
  return { LIVE_DB: createTestD1([STATE_DIR]), INPUTS_DB: createTestD1([INPUTS_DIR]) };
}

/** A db whose every statement throws -- simulates a D1 outage. */
class ThrowingDb {
  prepare() {
    throw new Error("simulated D1 read failure");
  }
}

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

test("queue() REJECTS a backtest job loudly (M2): marks the job failed with an M3 pointer, runs nothing, then acks", async (t) => {
  // job_progress still lives on the old env.DB until M2b (schema: root migrations).
  const db = createTestD1([OLD_DB_DIR]);
  const bindings = engineBindings();
  const env = { DB: db, ...bindings };
  const errorLogs = [];
  t.mock.method(console, "error", (...args) => errorLogs.push(args));

  const message = new FakeMessage({
    type: "backtest",
    id: "backtest-1",
    tickers: ["AAPL"],
    testStart: "2024-01-01T00:00:00.000Z",
    testEnd: "2024-01-02T00:00:00.000Z",
    graceDays: 0,
  });
  await worker.queue(batchOf(message), env);

  // Acked, not retried: a retry would fail identically.
  assert.equal(message.acked, true);
  assert.equal(message.retried, false);
  assert.ok(errorLogs.some(([msg]) => msg.includes("backtest job rejected")));

  // Failed loudly on the job row, with the reason the dashboard will show.
  const job = await db.prepare("SELECT status, error FROM job_progress WHERE id = ?").bind("backtest-1").first();
  assert.equal(job.status, "failed");
  assert.match(job.error, /backtest Worker in M3/);

  // Nothing ran: no engine state written to either binding.
  for (const table of ["positions", "trade_decisions", "decision_memory", "pipeline_checkpoints"]) {
    const { results } = await bindings.LIVE_DB.prepare(`SELECT * FROM ${table}`).all();
    assert.equal(results.length, 0, `${table} must stay empty`);
  }
});

// ---------------------------------------------------------------------------
// exit_check (LLM_JOBS)
// ---------------------------------------------------------------------------

test("queue() exit_check runs checkOpenPositionExits and acks", async () => {
  const env = { DB: new FakeNoPositionsDb(), ...engineBindings() };

  const message = new FakeMessage({ type: "exit_check", asOf: "2026-09-18T00:00:00.000Z" });
  await worker.queue(batchOf(message), env);

  assert.equal(message.acked, true);
  assert.equal(message.retried, false);
});

test("queue() exit_check acks (does not retry) on failure -- next scheduled tick re-evaluates every still-open position regardless", async (t) => {
  // The live state DB is what exit_check reads open positions from (M2).
  const env = { DB: new FakeNoPositionsDb(), LIVE_DB: new ThrowingDb(), INPUTS_DB: createTestD1([INPUTS_DIR]) };
  const errorLogs = [];
  t.mock.method(console, "error", (...args) => errorLogs.push(args));

  const message = new FakeMessage({ type: "exit_check", asOf: "2026-09-18T00:00:00.000Z" });
  await worker.queue(batchOf(message), env);

  assert.equal(message.acked, true);
  assert.equal(message.retried, false);
  assert.ok(errorLogs.some(([msg]) => msg.includes("exit_check job failed")));
});

// ---------------------------------------------------------------------------
// LLM call log retention (storage/llm_calls.js#pruneLlmCalls) rides the
// exit_check tick
// ---------------------------------------------------------------------------

/** FakeNoPositionsDb plus the one DELETE the retention prune issues. `failDelete` makes that DELETE reject. */
class PrunableDb extends FakeNoPositionsDb {
  constructor({ failDelete = false } = {}) {
    super();
    this.cutoffs = [];
    this.failDelete = failDelete;
  }
  prepare(sql) {
    if (!/DELETE FROM llm_calls/.test(sql)) return super.prepare(sql);
    const db = this;
    return {
      bind(cutoff) {
        return {
          async run() {
            if (db.failDelete) throw new Error("simulated D1 failure on prune");
            db.cutoffs.push(cutoff);
          },
        };
      },
    };
  }
}

const DAY_MS = 24 * 3600 * 1000;

test("queue() exit_check prunes LLM call log rows older than the retention window (14 days by default)", async () => {
  const env = { DB: new PrunableDb(), ...engineBindings() };
  const before = Date.now();
  const message = new FakeMessage({ type: "exit_check", asOf: "2026-09-18T00:00:00.000Z" });
  await worker.queue(batchOf(message), env);

  assert.equal(message.acked, true);
  assert.equal(env.DB.cutoffs.length, 1);
  const cutoffMs = Date.parse(env.DB.cutoffs[0]);
  assert.ok(Math.abs(cutoffMs - (before - 14 * DAY_MS)) < 5000, `cutoff ${env.DB.cutoffs[0]} should be ~14 days ago`);
});

test("queue() exit_check honors LLM_LOG_RETENTION_DAYS", async () => {
  const env = { DB: new PrunableDb(), ...engineBindings(), LLM_LOG_RETENTION_DAYS: "3" };
  const before = Date.now();
  await worker.queue(batchOf(new FakeMessage({ type: "exit_check", asOf: "2026-09-18T00:00:00.000Z" })), env);

  assert.ok(Math.abs(Date.parse(env.DB.cutoffs[0]) - (before - 3 * DAY_MS)) < 5000);
});

test("queue() exit_check skips the prune entirely when LLM_LOG_ENABLED is \"false\"", async () => {
  const env = { DB: new PrunableDb(), ...engineBindings(), LLM_LOG_ENABLED: "false" };
  const message = new FakeMessage({ type: "exit_check", asOf: "2026-09-18T00:00:00.000Z" });
  await worker.queue(batchOf(message), env);

  assert.equal(message.acked, true);
  assert.equal(env.DB.cutoffs.length, 0);
});

test("queue() exit_check still acks when the prune itself fails -- a log-retention hiccup must not look like a failed exit check", async (t) => {
  const warnings = [];
  t.mock.method(console, "warn", (...args) => warnings.push(args));
  const env = { DB: new PrunableDb({ failDelete: true }), ...engineBindings() };
  const message = new FakeMessage({ type: "exit_check", asOf: "2026-09-18T00:00:00.000Z" });
  await worker.queue(batchOf(message), env);

  assert.equal(message.acked, true);
  assert.equal(message.retried, false);
  assert.ok(warnings.some(([msg]) => msg.includes("llm call log prune failed")));
});

// ---------------------------------------------------------------------------
// analyze (ANALYZE)
// ---------------------------------------------------------------------------

test("queue() analyze RETRIES (does not ack) on failure -- the one deliberate exception to every other message type in this handler, since runPipelineForTicker is checkpoint-resumable", async (t) => {
  // The checkpoint read is the first thing runPipelineForTicker does, and it
  // goes through the live RunStore (LIVE_DB) since M2.
  const env = { DB: new FakeNoPositionsDb(), LIVE_DB: new ThrowingDb(), INPUTS_DB: createTestD1([INPUTS_DIR]) };
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
