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
// M2b: job_progress and llm_calls live in that same LIVE_DB (state schema,
// run_id/env_run_id 'live'), so this Worker no longer needs env.DB at all --
// none of these tests bind one, which is the proof.
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
import { RunStore } from "../src/storage/run_store.js";

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

// ---------------------------------------------------------------------------
// backtest (LLM_JOBS)
// ---------------------------------------------------------------------------

test("queue() REJECTS a backtest job loudly (M2): marks the job failed with an M3 pointer, runs nothing, then acks", async (t) => {
  // job_progress lives in LIVE_DB's state schema (M2b); there is no env.DB.
  const bindings = engineBindings();
  const env = { ...bindings };
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
  const job = await bindings.LIVE_DB.prepare("SELECT run_id, type, status, error FROM job_progress WHERE id = ?").bind("backtest-1").first();
  assert.equal(job.run_id, "live", "no SIM_DB here, so the rejection row lands under the live run");
  assert.equal(job.type, "backtest");
  assert.equal(job.status, "failed");
  assert.match(job.error, /backtest Worker in M3/);
  assert.equal((await new RunStore(bindings.LIVE_DB, "live").getJob("backtest-1")).status, "failed", "and is what GET /api/jobs/:id will read back");

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
  const env = engineBindings();

  const message = new FakeMessage({ type: "exit_check", asOf: "2026-09-18T00:00:00.000Z" });
  await worker.queue(batchOf(message), env);

  assert.equal(message.acked, true);
  assert.equal(message.retried, false);
});

test("queue() exit_check acks (does not retry) on failure -- next scheduled tick re-evaluates every still-open position regardless", async (t) => {
  // The live state DB is what exit_check reads open positions from (M2).
  const env = { LIVE_DB: new ThrowingDb(), INPUTS_DB: createTestD1([INPUTS_DIR]) };
  const errorLogs = [];
  t.mock.method(console, "error", (...args) => errorLogs.push(args));

  const message = new FakeMessage({ type: "exit_check", asOf: "2026-09-18T00:00:00.000Z" });
  await worker.queue(batchOf(message), env);

  assert.equal(message.acked, true);
  assert.equal(message.retried, false);
  assert.ok(errorLogs.some(([msg]) => msg.includes("exit_check job failed")));
});

// ---------------------------------------------------------------------------
// LLM call log retention (RunStore#pruneLlmCalls) rides the exit_check tick,
// against the live environment's rows in LIVE_DB
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 3600 * 1000;
const daysAgo = (n) => new Date(Date.now() - n * DAY_MS).toISOString();
const EXIT_CHECK = () => new FakeMessage({ type: "exit_check", asOf: "2026-09-18T00:00:00.000Z" });

/** Bindings whose LIVE_DB holds one live llm_calls row per age in `agesDays` (label "age-<n>d"), plus one 100-day-old row for env 'bt-1'. */
async function bindingsWithLog(agesDays) {
  const bindings = engineBindings();
  const live = new RunStore(bindings.LIVE_DB, "live");
  for (const n of agesDays) await live.insertLlmCall({ label: `age-${n}d`, status: "ok", prompt: "p" }, { now: daysAgo(n) });
  await new RunStore(bindings.LIVE_DB, "bt-1").insertLlmCall({ label: "bt-old", status: "ok", prompt: "p" }, { now: daysAgo(100) });
  return bindings;
}

const labels = async (db, env) => {
  const { results } = await db.prepare("SELECT label FROM llm_calls WHERE env_run_id = ? ORDER BY id").bind(env).all();
  return results.map((r) => r.label);
};

test("queue() exit_check prunes live LLM call log rows older than the retention window (14 days by default), and only live's", async () => {
  const env = await bindingsWithLog([1, 13, 15, 40]);
  const message = EXIT_CHECK();
  await worker.queue(batchOf(message), env);

  assert.equal(message.acked, true);
  assert.deepEqual(await labels(env.LIVE_DB, "live"), ["age-1d", "age-13d"]);
  assert.deepEqual(await labels(env.LIVE_DB, "bt-1"), ["bt-old"], "another environment's rows are never pruned by live's tick");
});

test("queue() exit_check honors LLM_LOG_RETENTION_DAYS", async () => {
  const env = { ...(await bindingsWithLog([1, 2, 4, 10])), LLM_LOG_RETENTION_DAYS: "3" };
  await worker.queue(batchOf(EXIT_CHECK()), env);

  assert.deepEqual(await labels(env.LIVE_DB, "live"), ["age-1d", "age-2d"]);
});

test("queue() exit_check skips the prune entirely when LLM_LOG_ENABLED is \"false\"", async () => {
  const env = { ...(await bindingsWithLog([1, 40])), LLM_LOG_ENABLED: "false" };
  const message = EXIT_CHECK();
  await worker.queue(batchOf(message), env);

  assert.equal(message.acked, true);
  assert.deepEqual(await labels(env.LIVE_DB, "live"), ["age-1d", "age-40d"]);
});

test("queue() exit_check still acks when the prune itself fails -- a log-retention hiccup must not look like a failed exit check", async (t) => {
  const warnings = [];
  t.mock.method(console, "warn", (...args) => warnings.push(args));
  const bindings = await bindingsWithLog([40]);
  // Everything works except the DELETE the prune issues.
  const realDb = bindings.LIVE_DB;
  const env = {
    ...bindings,
    LIVE_DB: {
      prepare(sql) {
        if (/DELETE FROM llm_calls/.test(sql)) throw new Error("simulated D1 failure on prune");
        return realDb.prepare(sql);
      },
      batch: (...args) => realDb.batch(...args),
    },
  };
  const message = EXIT_CHECK();
  await worker.queue(batchOf(message), env);

  assert.equal(message.acked, true);
  assert.equal(message.retried, false);
  assert.ok(warnings.some(([msg]) => msg.includes("llm call log prune failed")));
  assert.deepEqual(await labels(realDb, "live"), ["age-40d"], "nothing was pruned");
});

// ---------------------------------------------------------------------------
// analyze (ANALYZE)
// ---------------------------------------------------------------------------

test("queue() analyze RETRIES (does not ack) on failure -- the one deliberate exception to every other message type in this handler, since runPipelineForTicker is checkpoint-resumable", async (t) => {
  // The checkpoint read is the first thing runPipelineForTicker does, and it
  // goes through the live RunStore (LIVE_DB) since M2.
  const env = { LIVE_DB: new ThrowingDb(), INPUTS_DB: createTestD1([INPUTS_DIR]) };
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
  const env = {}; // neither path touches a binding
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
  const env = {}; // neither path touches a binding
  const errorLogs = [];
  t.mock.method(console, "error", (...args) => errorLogs.push(args));

  const message = new FakeMessage(null); // job.type on null throws inside queue()'s try block
  await worker.queue(batchOf(message), env);

  assert.equal(message.acked, false);
  assert.equal(message.retried, true);
  assert.ok(errorLogs.some(([msg]) => msg.includes("crashed unexpectedly")));
});
