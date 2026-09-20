// Covers backend's (src/index.js) POST /backfill-prices route -- the operational
// entry point for ingestion/ingest.js#backfillHistoricalPriceBars (plan.md Next
// Steps step A). Same contract as POST /backfill (test/index_backfill.test.js):
// validate, write a best-effort 'queued' job_progress row under run_id 'live',
// enqueue onto BACKFILL, and return an immediate ack. The real work runs in the
// `ingest` Worker's queue() -- see test/backfill_prices.test.js for that half.

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
    WATCHLIST_TICKERS: "AAPL,MSFT",
    ...overrides,
  };
}

function post(env, query) {
  return worker.fetch(new Request(`https://worker.example/backfill-prices${query}`, { method: "POST" }), env);
}

const BAD_REQUESTS = [
  ["a missing `to`", "?from=2025-01-01"],
  ["a missing `from`", "?to=2025-01-31"],
  ["a malformed date", "?from=not-a-date&to=2025-01-31"],
  ["a date that isn't a real calendar day (2025-02-30)", "?from=2025-02-30&to=2025-03-01"],
  ["from after to", "?from=2025-02-01&to=2025-01-01"],
  ["a ticker that isn't a symbol", "?from=2025-01-01&to=2025-01-31&tickers=AAPL,bad%20symbol"],
  ["a ticker list that is only separators", "?from=2025-01-01&to=2025-01-31&tickers=,,"],
  ["more than 10 tickers", `?from=2025-01-01&to=2025-01-31&tickers=${Array.from({ length: 11 }, (_, i) => `T${i}`).join(",")}`],
];

for (const [label, query] of BAD_REQUESTS) {
  test(`POST /backfill-prices returns 400 for ${label}, without touching the queue`, async () => {
    const env = baseEnv();
    const response = await post(env, query);
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.ok(body.error, "the 400 explains itself");
    assert.equal(env.BACKFILL.sent.length, 0);
  });
}

test("POST /backfill-prices with a valid range enqueues a backfill_prices job for the whole watchlist and writes a 'queued' progress row", async () => {
  const env = baseEnv();
  const response = await post(env, "?from=2025-01-01&to=2025-12-31");

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/json/);
  const body = await response.json();
  assert.equal(body.accepted, true);
  assert.equal(body.from, "2025-01-01");
  assert.equal(body.to, "2025-12-31");
  assert.match(body.id, /^backfill-prices-/);
  assert.deepEqual(body.tickers, ["AAPL", "MSFT"], "the ack echoes the watchlist it will use");

  assert.equal(env.BACKFILL.sent.length, 1);
  const sent = env.BACKFILL.sent[0];
  assert.equal(sent.type, "backfill_prices");
  assert.equal(sent.id, body.id);
  assert.equal(sent.from, "2025-01-01");
  assert.equal(sent.to, "2025-12-31");
  assert.equal(sent.tickers, undefined, "no explicit tickers: the consumer resolves the watchlist itself");

  const job = await new RunStore(env.LIVE_DB, "live").getJob(body.id);
  assert.equal(job.status, "queued");
  assert.equal(job.type, "backfill_prices");
  assert.equal(job.params.from, "2025-01-01");
  assert.equal(job.params.to, "2025-12-31");
});

test("POST /backfill-prices upper-cases, trims and de-duplicates an explicit ticker list", async () => {
  const env = baseEnv();
  const response = await post(env, "?from=2025-01-01&to=2025-01-31&tickers=msft,%20aapl,MSFT,BRK-B");

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.tickers, ["MSFT", "AAPL", "BRK-B"]);
  assert.deepEqual(env.BACKFILL.sent[0].tickers, ["MSFT", "AAPL", "BRK-B"]);
});

test("POST /backfill-prices accepts a single-day range (from === to)", async () => {
  const env = baseEnv();
  const response = await post(env, "?from=2025-01-02&to=2025-01-02");
  assert.equal(response.status, 200);
  assert.equal(env.BACKFILL.sent.length, 1);
});

test("POST /backfill-prices still enqueues when the progress store is down -- the 'queued' row is best-effort", async (t) => {
  t.mock.method(console, "warn", () => {});
  const env = baseEnv({ LIVE_DB: new BrokenDb() });

  const response = await post(env, "?from=2025-01-01&to=2025-01-31");

  assert.equal(response.status, 200);
  assert.equal(env.BACKFILL.sent.length, 1);
});

test("POST /backfill-prices returns 500 with the failure message if enqueueing itself fails", async (t) => {
  const env = baseEnv({ BACKFILL: new ThrowingBackfillQueue() });
  const errorLogs = [];
  t.mock.method(console, "error", (...args) => errorLogs.push(args));

  const response = await post(env, "?from=2025-01-01&to=2025-01-31");

  assert.equal(response.status, 500);
  const body = await response.json();
  assert.match(body.message, /simulated queue send failure/);
  assert.ok(errorLogs.some(([msg]) => msg.includes("backfill-prices enqueue failed")));
});
