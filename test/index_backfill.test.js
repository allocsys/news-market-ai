// Covers backend's (src/index.js) POST /backfill route -- the operational
// entry point wired onto graph/pipeline.js#backfillHistoricalNews.
//
// Since plan.md Step 2 (dashboard Worker split), this route no longer
// checks a session cookie itself -- backend is private (see wrangler.toml,
// workers_dev = false) and only ever reached via `dashboard`'s BACKEND
// service binding, which already checked the session one hop up before
// forwarding (see test/dashboard_worker.test.js for that side).
//
// Since plan.md Step 3 (JOBS queue), this route no longer runs
// backfillHistoricalNews itself at all -- synchronously OR via
// ctx.waitUntil. It only validates the request and enqueues a
// `{ type: 'backfill', id, from, to }` message onto env.JOBS, returning an
// immediate `{ accepted, id, from, to }` ack. The actual backfill run
// (and its real inserted/errorCount) now happens in the queue() consumer --
// see test/queue_consumer.test.js for that half of the contract.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

/** Minimal fake of the JOBS queue binding (Cloudflare Queues' `send`
 * producer API) -- captures every enqueued message so a test can assert on
 * it, same "wrap the real interface, verify what was actually sent" spirit
 * as test/dashboard_worker.test.js's FakeBackend service-binding wrapper. */
class FakeJobsQueue {
  constructor() {
    this.sent = [];
  }
  async send(body) {
    this.sent.push(body);
  }
}

class ThrowingJobsQueue {
  async send() {
    throw new Error("simulated queue send failure");
  }
}

function baseEnv(overrides = {}) {
  return {
    DB: {},
    JOBS: new FakeJobsQueue(),
    WATCHLIST_TICKERS: "AAPL",
    FINNHUB_API_KEY: "test-key",
    FINNHUB_API_BASE: "https://fake.test/finnhub",
    ...overrides,
  };
}

test("POST /backfill returns 400 for a missing or malformed from/to, without touching the queue", async () => {
  const env = baseEnv();

  const missing = await worker.fetch(new Request("https://worker.example/backfill?from=2024-01-01", { method: "POST" }), env);
  assert.equal(missing.status, 400);

  const malformed = await worker.fetch(new Request("https://worker.example/backfill?from=not-a-date&to=2024-01-31", { method: "POST" }), env);
  assert.equal(malformed.status, 400);

  assert.equal(env.JOBS.sent.length, 0);
});

test("POST /backfill with a valid range enqueues a backfill job onto JOBS and returns an immediate accepted ack", async () => {
  const env = baseEnv();

  const request = new Request("https://worker.example/backfill?from=2024-01-01&to=2024-01-31", { method: "POST" });
  const response = await worker.fetch(request, env);

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/json/);
  const body = await response.json();
  assert.equal(body.accepted, true);
  assert.equal(body.from, "2024-01-01");
  assert.equal(body.to, "2024-01-31");
  assert.match(body.id, /^backfill-/);

  assert.equal(env.JOBS.sent.length, 1);
  assert.deepEqual(env.JOBS.sent[0], { type: "backfill", id: body.id, from: "2024-01-01", to: "2024-01-31" });
});

test("POST /backfill still enqueues (and ignores) a legacy ?async=1 query param -- harmless leftover from before plan.md Step 3", async () => {
  const env = baseEnv();
  const request = new Request("https://worker.example/backfill?from=2024-01-01&to=2024-01-31&async=1", { method: "POST" });
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.accepted, true);
  assert.equal(env.JOBS.sent.length, 1);
});

test("POST /backfill returns 500 with the failure message if enqueueing itself fails (e.g. JOBS unavailable)", async (t) => {
  const env = baseEnv({ JOBS: new ThrowingJobsQueue() });

  const errorLogs = [];
  t.mock.method(console, "error", (...args) => errorLogs.push(args));

  const request = new Request("https://worker.example/backfill?from=2024-01-01&to=2024-01-31", { method: "POST" });
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.match(body.message, /simulated queue send failure/);
  assert.ok(errorLogs.some(([msg]) => msg.includes("backfill enqueue failed")));
});
