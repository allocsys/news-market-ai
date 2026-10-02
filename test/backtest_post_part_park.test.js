// The POST-part quota check in backtest-worker.js: a part that ends in a 'continue' outcome
// checks today's ledger PLUS its own counts against the daily shares. If a share is reached the
// run is PARKED (status 'paused', data + resume envelope kept, resume_after next UTC midnight)
// instead of enqueuing the next part. Forced the same way as backtest_continuation.test.js: a
// 16-op BACKTEST_MAX_TOTAL_SUBREQUESTS budget splits the run into parts. Real sqlite D1s.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/backtest-worker.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { STATE_DIR, INPUTS_DIR, SIM_DIR, seedBar } from "./helpers/engine_ctx.js";
import { getQuotaUsage, quotaUsageUpsertStatement, utcDay, nextUtcMidnightIso } from "../src/storage/quota_usage.js";

class FakeMessage {
  constructor(body) {
    this.body = body;
    this.acked = false;
    this.retried = false;
  }
  ack() { this.acked = true; }
  retry() { this.retried = true; }
}

const JOB = { type: "backtest", id: "bt-postpark", tickers: ["AAPL"], testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-09T00:00:00.000Z", graceDays: 1 };

async function bindings() {
  const b = { SIM_DB: createTestD1([STATE_DIR, SIM_DIR]), INPUTS_DB: createTestD1([INPUTS_DIR]) };
  for (const date of ["2025-12-31", "2026-01-01", "2026-01-03", "2026-01-05", "2026-01-08", "2026-01-09"]) await seedBar(b.INPUTS_DB, { ticker: "AAPL", date, close: 100 });
  return b;
}

function fakeQueue() {
  const sent = [];
  return { sent, async send(body, options) { sent.push({ body, options }); } };
}

const quiet = (t) => { t.mock.method(console, "log", () => {}); t.mock.method(console, "error", () => {}); };
const PAUSE_COLUMNS = "status, error, paused_reason, paused_at, resume_after, cursor";
const runRow = (db) => db.prepare(`SELECT ${PAUSE_COLUMNS} FROM backtest_runs WHERE id = ?`).bind(JOB.id).first();

test("queue(): a part that ends in 'continue' and tips today's D1 write total over the share PARKS the run -- paused, envelope for part 2, resume_after next UTC midnight, acked, nothing sent", async (t) => {
  quiet(t);
  const b = await bindings();
  const queue = fakeQueue();
  // Share 10 -> pause at 90% = 9 rows. The ledger already holds 8; part 1 (never refused at its start)
  // writes at least its registry/job rows, so ledger + part is over the line AFTER the part ran.
  const env = { ...b, BACKTEST: queue, BACKTEST_MAX_TOTAL_SUBREQUESTS: "16", BACKTEST_DAILY_WRITE_BUDGET: "10", WATCHLIST_TICKERS: "AAPL" };
  await quotaUsageUpsertStatement(b.SIM_DB, { day: utcDay(), d1Written: 8 }).run();

  const message = new FakeMessage(JOB);
  await worker.queue({ messages: [message] }, env);

  assert.equal(message.acked, true);
  assert.equal(message.retried, false);
  assert.equal(queue.sent.length, 0, "the continuation is parked, not enqueued");
  const run = await runRow(b.SIM_DB);
  assert.equal(run.status, "paused", "paused, not failed: the data stays");
  assert.equal(run.error, null);
  assert.equal(run.paused_reason, "d1_write_budget");
  assert.ok(run.paused_at);
  assert.equal(run.resume_after, nextUtcMidnightIso());
  const envelope = JSON.parse(run.cursor);
  assert.equal(envelope.part, 2, "resume continues with the NEXT part");
  assert.equal(typeof envelope.cursor.clockNow, "string", "the run cursor is kept");
  assert.deepEqual(envelope.job, { id: JOB.id, tickers: JOB.tickers, testStart: JOB.testStart, testEnd: JOB.testEnd, graceDays: JOB.graceDays });
  const ledger = await getQuotaUsage(b.SIM_DB);
  assert.ok(ledger.d1Written > 8, "the part's own writes were added to today's ledger before parking");
});

test("queue(): the same part under the share is NOT parked -- the continuation is sent and the run stays running", async (t) => {
  quiet(t);
  const b = await bindings();
  const queue = fakeQueue();
  const env = { ...b, BACKTEST: queue, BACKTEST_MAX_TOTAL_SUBREQUESTS: "16", BACKTEST_DAILY_WRITE_BUDGET: "1000000", WATCHLIST_TICKERS: "AAPL" };

  const message = new FakeMessage(JOB);
  await worker.queue({ messages: [message] }, env);

  assert.equal(message.acked, true);
  assert.equal(queue.sent.length, 1);
  assert.equal(queue.sent[0].body.part, 2);
  const run = await runRow(b.SIM_DB);
  assert.equal(run.status, "running");
  assert.equal(run.paused_reason, null);
  assert.equal(run.cursor, null);
});

test("queue(): with the daily write share disabled (0) and quotaPausePct 0, a continuing part is never parked", async (t) => {
  quiet(t);
  const b = await bindings();
  const queue = fakeQueue();
  const env = { ...b, BACKTEST: queue, BACKTEST_MAX_TOTAL_SUBREQUESTS: "16", BACKTEST_DAILY_WRITE_BUDGET: "0", QUOTA_PAUSE_PCT: "0", WATCHLIST_TICKERS: "AAPL" };
  await quotaUsageUpsertStatement(b.SIM_DB, { day: utcDay(), d1Written: 10 ** 9 }).run();

  await worker.queue({ messages: [new FakeMessage(JOB)] }, env);

  assert.equal(queue.sent.length, 1, "continuation sent");
  assert.equal((await runRow(b.SIM_DB)).status, "running");
});
