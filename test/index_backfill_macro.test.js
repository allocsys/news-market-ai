// Covers backend's (src/index.js) POST /backfill-macro route -- the operator-triggered
// entry point for ingestion/ingest.js#ingestMacro with `{ from, backfill: true }`.
// Same contract as POST /backfill-prices (test/index_backfill_prices.test.js):
// validate, write a best-effort 'queued' job_progress row under run_id 'live',
// enqueue onto BACKFILL, return an immediate ack. Only `from` is taken (FRED has no
// end bound). The real work runs in the `ingest` Worker's queue() -- see
// test/backfill_macro.test.js for that half.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { STATE_DIR } from "./helpers/engine_ctx.js";
import { BrokenDb } from "./helpers/broken_db.js";
import { RunStore } from "../src/storage/run_store.js";

class FakeBackfillQueue {
  constructor() {
    this.sent = [];
  }
  async send(body) {
    this.sent.push(body);
  }
}

class ThrowingBackfillQueue {
  async send() {
    throw new Error("simulated queue send failure");
  }
}

function baseEnv(overrides = {}) {
  return {
    LIVE_DB: createTestD1([STATE_DIR]),
    BACKFILL: new FakeBackfillQueue(),
    WATCHLIST_TICKERS: "XAUUSD",
    ...overrides,
  };
}

function post(env, query) {
  return worker.fetch(new Request(`https://worker.example/backfill-macro${query}`, { method: "POST" }), env);
}

const BAD_REQUESTS = [
  ["a missing `from`", ""],
  ["an empty `from`", "?from="],
  ["a malformed date", "?from=not-a-date"],
  ["a date that isn't a real calendar day (2025-02-30)", "?from=2025-02-30"],
  ["a date before the 2000-01-01 sanity bound", "?from=1999-12-31"],
  ["a date in the future", "?from=2999-01-01"],
];

for (const [label, query] of BAD_REQUESTS) {
  test(`POST /backfill-macro returns 400 for ${label}, without touching the queue or the job table`, async () => {
    const env = baseEnv();
    const response = await post(env, query);
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.ok(body.error, "the 400 explains itself");
    assert.equal(env.BACKFILL.sent.length, 0);
  });
}

test("POST /backfill-macro with a valid `from` enqueues a backfill_macro job and writes a 'queued' progress row", async () => {
  const env = baseEnv();
  const response = await post(env, "?from=2024-01-01");

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/json/);
  const body = await response.json();
  assert.equal(body.accepted, true);
  assert.equal(body.from, "2024-01-01");
  assert.match(body.id, /^backfill-macro-/);

  assert.equal(env.BACKFILL.sent.length, 1);
  assert.deepEqual(env.BACKFILL.sent[0], { type: "backfill_macro", id: body.id, from: "2024-01-01" });

  const job = await new RunStore(env.LIVE_DB, "live").getJob(body.id);
  assert.equal(job.status, "queued");
  assert.equal(job.type, "backfill_macro");
  assert.equal(job.params.from, "2024-01-01");
});

test("POST /backfill-macro accepts the earliest allowed date (2000-01-01)", async () => {
  const env = baseEnv();
  const response = await post(env, "?from=2000-01-01");
  assert.equal(response.status, 200);
  assert.equal(env.BACKFILL.sent.length, 1);
});

test("POST /backfill-macro accepts today (from is not in the future)", async () => {
  const env = baseEnv();
  const today = new Date().toISOString().slice(0, 10);
  const response = await post(env, `?from=${today}`);
  assert.equal(response.status, 200);
});

test("POST /backfill-macro is not gated on the feature:macro live flag", async () => {
  // No system_flags row at all: the route still enqueues -- the flag only gates live ticks/analysts.
  const env = baseEnv();
  const response = await post(env, "?from=2025-01-01");
  assert.equal(response.status, 200);
  assert.equal(env.BACKFILL.sent.length, 1);
});

test("POST /backfill-macro still enqueues when the progress store is down -- the 'queued' row is best-effort", async (t) => {
  t.mock.method(console, "warn", () => {});
  const env = baseEnv({ LIVE_DB: new BrokenDb() });

  const response = await post(env, "?from=2025-01-01");

  assert.equal(response.status, 200);
  assert.equal(env.BACKFILL.sent.length, 1);
});

test("POST /backfill-macro returns 500 with the failure message if enqueueing itself fails", async (t) => {
  const env = baseEnv({ BACKFILL: new ThrowingBackfillQueue() });
  const errorLogs = [];
  t.mock.method(console, "error", (...args) => errorLogs.push(args));

  const response = await post(env, "?from=2025-01-01");

  assert.equal(response.status, 500);
  const body = await response.json();
  assert.match(body.message, /simulated queue send failure/);
  assert.ok(errorLogs.some(([msg]) => msg.includes("backfill-macro enqueue failed")));
});
