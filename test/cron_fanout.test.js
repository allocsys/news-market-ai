// Cron fan-out test (plan.md Step 4) -- covers src/index.js's `scheduled`,
// a thin scheduler (no inline pipeline run): it only enqueues.
//
// UPDATE (plan.md Step 5): the `ingest_ticker`/`ingest_feeds` queue()
// tests that used to live here moved to test/ingest_worker.test.js --
// those message types are no longer handled by src/index.js's queue() at
// all, they're the `ingest` Worker's (src/ingest-worker.js) job.
//
// UPDATE (plan.md Step 6): `exit_check` is now enqueued onto LLM_JOBS, not
// JOBS -- it calls Gemini (settle.js -> closeTheLoop), so its consumer moved
// to the `llm` Worker (src/llm-worker.js) and JOBS carries `backfill` only.
// The `exit_check` and `analyze` queue() tests that used to live here
// (testing backend's queue()) moved to test/llm_worker.test.js, unchanged
// in behavior -- backend's queue() doesn't handle either type anymore, see
// test/queue_consumer.test.js for the test proving that. What's left here:
// scheduled()'s own fan-out tests, which stay backend's job.
//
// UPDATE (plan.md M5): scheduled() never touches D1 at all (it only
// enqueues), so these tests pass no database binding -- the FakeIngestDb
// stand-in that used to be handed in as `DB` (the legacy pre-split binding,
// now removed from every wrangler config) is gone with it.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

/** Records every message handed to send/sendBatch without actually queueing anything -- stands in for a Cloudflare Queue binding. */
class FakeQueueBinding {
  constructor() {
    this.sent = [];
  }
  async send(body) {
    this.sent.push(body);
  }
  async sendBatch(messages) {
    this.sent.push(...messages.map((m) => m.body));
  }
}

function baseEnv(overrides = {}) {
  return {
    WATCHLIST_TICKERS: "AAPL,MSFT",
    FINNHUB_API_KEY: "test-key",
    ENTITY_RESOLUTION_USE_NAME_INDEX: "false", // keep these tests scoped to fan-out wiring, not entity resolution's own SEC-lookup path (covered separately)
    INGEST: new FakeQueueBinding(),
    ANALYZE: new FakeQueueBinding(),
    JOBS: new FakeQueueBinding(),
    LLM_JOBS: new FakeQueueBinding(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// scheduled()
// ---------------------------------------------------------------------------

test("scheduled() fans out one INGEST message per watchlist ticker, one ingest_feeds message, and one LLM_JOBS exit_check message -- no inline pipeline work", async () => {
  const env = baseEnv();

  await worker.scheduled({ cron: "*/15 * * * *" }, env);

  const ingestTypes = env.INGEST.sent.map((m) => m.type);
  assert.deepEqual(ingestTypes.sort(), ["ingest_feeds", "ingest_ticker", "ingest_ticker"].sort());
  const tickerMessages = env.INGEST.sent.filter((m) => m.type === "ingest_ticker");
  assert.deepEqual(tickerMessages.map((m) => m.ticker).sort(), ["AAPL", "MSFT"]);
  assert.ok(tickerMessages.every((m) => typeof m.asOf === "string"));

  assert.equal(env.LLM_JOBS.sent.length, 1);
  assert.equal(env.LLM_JOBS.sent[0].type, "exit_check");
  assert.ok(typeof env.LLM_JOBS.sent[0].asOf === "string");

  // JOBS is backfill-only since Step 6 -- a cron tick must never put anything on it.
  assert.equal(env.JOBS.sent.length, 0);
  assert.equal(env.ANALYZE.sent.length, 0);
});

test("scheduled() logs (not throws) if INGEST fan-out fails, and still attempts the exit_check enqueue -- ingestion and exit-checking stay isolated failure domains", async (t) => {
  const errorLogs = [];
  t.mock.method(console, "error", (...args) => errorLogs.push(args));

  const brokenIngest = { async sendBatch() { throw new Error("simulated INGEST enqueue failure"); }, async send() { throw new Error("simulated INGEST enqueue failure"); } };
  const env = baseEnv({ INGEST: brokenIngest });

  await worker.scheduled({ cron: "*/15 * * * *" }, env);

  assert.ok(errorLogs.some(([msg]) => msg.includes("INGEST fan-out failed")));
  assert.equal(env.LLM_JOBS.sent.length, 1); // exit_check enqueue still attempted despite the INGEST failure above
  assert.equal(env.LLM_JOBS.sent[0].type, "exit_check");
});

test("scheduled() logs (not throws) if the exit_check enqueue fails, without disturbing the INGEST fan-out that already succeeded", async (t) => {
  const errorLogs = [];
  t.mock.method(console, "error", (...args) => errorLogs.push(args));

  const brokenLlmJobs = { async send() { throw new Error("simulated LLM_JOBS enqueue failure"); } };
  const env = baseEnv({ LLM_JOBS: brokenLlmJobs });

  await worker.scheduled({ cron: "*/15 * * * *" }, env);

  assert.ok(errorLogs.some(([msg]) => msg.includes("exit_check enqueue failed")));
  assert.equal(env.INGEST.sent.length, 3); // 2 ingest_ticker + 1 ingest_feeds, unaffected
});
