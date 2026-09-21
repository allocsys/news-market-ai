// The continuation chain at the Worker level: a run that outgrows one
// invocation's subrequest budget is split into parts, each sent to the
// BACKTEST queue as a delayed message carrying part + cursor. Real sqlite
// SIM_DB/INPUTS_DB; the queue is a fake {send}. No news is seeded (loadConfig
// cannot supply a fake model), so the units here are the per-day exit checks
// and the scoring -- the news/pipeline units are covered in
// test/backtest_budget_resume.test.js and the runManualBacktest tests below.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/backtest-worker.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { STATE_DIR, INPUTS_DIR, SIM_DIR, seedBar } from "./helpers/engine_ctx.js";
import { RunStore } from "../src/storage/run_store.js";

class FakeMessage {
  constructor(body) {
    this.body = body;
    this.acked = false;
    this.retried = false;
  }
  ack() { this.acked = true; }
  retry() { this.retried = true; }
}

const JOB = { type: "backtest", id: "bt-chain", tickers: ["AAPL"], testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-09T00:00:00.000Z", graceDays: 1 };

async function bindings() {
  const b = { SIM_DB: createTestD1([STATE_DIR, SIM_DIR]), INPUTS_DB: createTestD1([INPUTS_DIR]) };
  for (const date of ["2025-12-31", "2026-01-01", "2026-01-03", "2026-01-05", "2026-01-08", "2026-01-09"]) await seedBar(b.INPUTS_DB, { ticker: "AAPL", date, close: 100 });
  return b;
}

/** A fake BACKTEST producer that records every send (and can be made to throw). */
function fakeQueue({ failSends = false } = {}) {
  const sent = [];
  return { sent, async send(body, options) { if (failSends) throw new Error("queue send failed"); sent.push({ body, options }); } };
}

/** Delivers `job`, then every message the Worker sends itself, until none is left. Returns each delivery. */
async function runChain(env, queue, job, { maxDeliveries = 60 } = {}) {
  const deliveries = [];
  const pending = [job];
  while (pending.length) {
    if (deliveries.length >= maxDeliveries) throw new Error(`chain did not end within ${maxDeliveries} deliveries`);
    const message = new FakeMessage(pending.shift());
    await worker.queue({ messages: [message] }, env);
    deliveries.push(message);
    while (queue.sent.length) pending.push(queue.sent.shift().body);
  }
  return deliveries;
}

const quiet = (t) => { t.mock.method(console, "log", () => {}); t.mock.method(console, "error", () => {}); };
const registryRow = (db, id) => db.prepare("SELECT status, result, error FROM backtest_runs WHERE id = ?").bind(id).first();

test("a run that outgrows one part is chained through delayed self-sent messages carrying part + cursor, and the LAST part completes it", async (t) => {
  quiet(t);
  const b = await bindings();
  const queue = fakeQueue();
  const env = { ...b, BACKTEST: queue, BACKTEST_MAX_TOTAL_SUBREQUESTS: "16", BACKTEST_CONTINUATION_DELAY_SECONDS: "7", WATCHLIST_TICKERS: "AAPL" };

  const captured = [];
  const realSend = queue.send;
  queue.send = async (body, options) => { captured.push({ body, options }); return realSend(body, options); };

  const deliveries = await runChain(env, queue, JOB);
  assert.ok(deliveries.length > 1, `a 16-op budget forced a split (${deliveries.length} deliveries)`);
  assert.ok(deliveries.every((m) => m.acked && !m.retried), "every part is acked, none retried");

  assert.equal(captured.length, deliveries.length - 1, "one continuation message per non-final part");
  captured.forEach(({ body, options }, i) => {
    assert.equal(body.type, "backtest");
    assert.equal(body.id, JOB.id);
    assert.deepEqual(body.tickers, JOB.tickers);
    assert.equal(body.testStart, JOB.testStart);
    assert.equal(body.testEnd, JOB.testEnd);
    assert.equal(body.graceDays, JOB.graceDays);
    assert.equal(body.part, i + 2, "parts count up from 2");
    assert.ok(body.cursor && typeof body.cursor.clockNow === "string", "the cursor pins the clock");
    assert.deepEqual(options, { delaySeconds: 7 }, "the configured delay is passed to send");
  });

  const run = await registryRow(b.SIM_DB, JOB.id);
  assert.equal(run.status, "complete", run.error);
  const job = await new RunStore(b.SIM_DB, JOB.id).getJob(JOB.id);
  assert.equal(job.status, "complete");
  assert.equal(job.percent, 100);
});

test("a chained run produces the SAME result as the same run in one unbudgeted invocation", async (t) => {
  quiet(t);
  const single = await bindings();
  await runChain({ ...single, WATCHLIST_TICKERS: "AAPL" }, fakeQueue(), JOB); // no BACKTEST binding -> budget off
  const chained = await bindings();
  const queue = fakeQueue();
  const deliveries = await runChain({ ...chained, BACKTEST: queue, BACKTEST_MAX_TOTAL_SUBREQUESTS: "16", WATCHLIST_TICKERS: "AAPL" }, queue, JOB);
  assert.ok(deliveries.length > 1);
  assert.deepEqual(JSON.parse((await registryRow(chained.SIM_DB, JOB.id)).result), JSON.parse((await registryRow(single.SIM_DB, JOB.id)).result));
});

test("with no BACKTEST producer bound, or a limit of 0, the budget is off: one delivery runs the whole run and nothing is sent", async (t) => {
  quiet(t);
  for (const extra of [{}, { BACKTEST_MAX_TOTAL_SUBREQUESTS: "0" }, { BACKTEST_MAX_EXTERNAL_SUBREQUESTS: "0" }]) {
    const b = await bindings();
    const queue = fakeQueue();
    const env = { ...b, ...(Object.keys(extra).length ? { BACKTEST: queue } : {}), ...extra, WATCHLIST_TICKERS: "AAPL" };
    const deliveries = await runChain(env, queue, JOB);
    assert.equal(deliveries.length, 1, JSON.stringify(extra));
    assert.equal((await registryRow(b.SIM_DB, JOB.id)).status, "complete");
  }
});

test("a continuation part does not re-insert the registry row or restart job_progress: the run keeps its original started_at", async (t) => {
  quiet(t);
  const b = await bindings();
  const queue = fakeQueue();
  const env = { ...b, BACKTEST: queue, BACKTEST_MAX_TOTAL_SUBREQUESTS: "16", WATCHLIST_TICKERS: "AAPL" };
  await worker.queue({ messages: [new FakeMessage(JOB)] }, env);
  assert.equal(queue.sent.length, 1, "first part ended with a continuation");
  const first = await b.SIM_DB.prepare("SELECT started_at FROM backtest_runs WHERE id = ?").bind(JOB.id).first();
  const next = queue.sent.shift().body;
  const m = new FakeMessage(next);
  await worker.queue({ messages: [m] }, env);
  assert.equal(m.acked, true);
  const after = await b.SIM_DB.prepare("SELECT started_at FROM backtest_runs WHERE id = ?").bind(JOB.id).first();
  assert.equal(after.started_at, first.started_at);
});

test("the part-finished log line reports the real usage so the owner can see which limit binds", async (t) => {
  const lines = [];
  t.mock.method(console, "log", (...a) => lines.push(a));
  t.mock.method(console, "error", () => {});
  const b = await bindings();
  const queue = fakeQueue();
  await worker.queue({ messages: [new FakeMessage(JOB)] }, { ...b, BACKTEST: queue, BACKTEST_MAX_TOTAL_SUBREQUESTS: "16", WATCHLIST_TICKERS: "AAPL" });
  const line = lines.find((l) => l[0] === "backtest part finished");
  assert.ok(line, "logged");
  assert.equal(line[1].id, JOB.id);
  assert.equal(line[1].part, 1);
  assert.equal(line[1].status, "continue");
  assert.ok(["budget", "exhausted"].includes(line[1].reason));
  for (const k of ["external", "total", "kv", "d1", "externalLimit", "totalLimit", "units"]) assert.ok(k in line[1], `snapshot has ${k}`);
  assert.equal(line[1].totalLimit, 16);
});

test("when the continuation send fails the part is RETRIED (not acked), so a retry cannot leave two chains", async (t) => {
  quiet(t);
  const b = await bindings();
  const queue = fakeQueue({ failSends: true });
  const m = new FakeMessage(JOB);
  await worker.queue({ messages: [m] }, { ...b, BACKTEST: queue, BACKTEST_MAX_TOTAL_SUBREQUESTS: "16", WATCHLIST_TICKERS: "AAPL" });
  assert.equal(m.retried, true);
  assert.equal(m.acked, false);
  assert.equal((await registryRow(b.SIM_DB, JOB.id)).status, "running", "still running, ready for the redelivery");
});

test("exceeding BACKTEST_MAX_PARTS fails the run like any other failure: registry + job_progress 'failed', its data deleted, error log kept, message acked, no further send", async (t) => {
  quiet(t);
  const b = await bindings();
  const queue = fakeQueue();
  const env = { ...b, BACKTEST: queue, BACKTEST_MAX_TOTAL_SUBREQUESTS: "16", BACKTEST_MAX_PARTS: "1", WATCHLIST_TICKERS: "AAPL" };
  const deliveries = await runChain(env, queue, JOB);
  assert.equal(deliveries.length, 1, "part 1 needed a continuation, which the cap of 1 part refuses");
  assert.ok(deliveries.every((m) => m.acked && !m.retried));
  const run = await registryRow(b.SIM_DB, JOB.id);
  assert.equal(run.status, "failed");
  assert.match(run.error, /exceeded 1 continuation parts/);
  const job = await new RunStore(b.SIM_DB, JOB.id).getJob(JOB.id);
  assert.equal(job.status, "failed", "the dashboard's job row is failed too");
});

test("a redelivery of a part whose run already finished is acked and skipped, as for any terminal run", async (t) => {
  quiet(t);
  const b = await bindings();
  const queue = fakeQueue();
  const env = { ...b, BACKTEST: queue, BACKTEST_MAX_TOTAL_SUBREQUESTS: "16", WATCHLIST_TICKERS: "AAPL" };
  const deliveries = await runChain(env, queue, JOB);
  const last = new FakeMessage({ ...JOB, part: deliveries.length, cursor: { clockNow: "2026-06-01T00:00:00.000Z", phase: "score", window: 1, walk: null, completed: 0 } });
  await worker.queue({ messages: [last] }, env);
  assert.equal(last.acked, true);
  assert.equal(queue.sent.length, 0);
});
