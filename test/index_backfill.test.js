// Covers backend's (src/index.js) POST /backfill route -- the operational
// entry point wired onto ingestion/ingest.js#backfillHistoricalNews.
//
// Since plan.md Step 2 (dashboard Worker split), this route no longer
// checks a session cookie itself -- backend is private (see wrangler.toml,
// workers_dev = false) and only ever reached via `dashboard`'s BACKEND
// service binding, which already checked the session one hop up before
// forwarding (see test/dashboard_worker.test.js for that side).
//
// Since plan.md Step 3, this route no longer runs backfillHistoricalNews
// itself at all -- synchronously OR via ctx.waitUntil. It only validates
// the request and enqueues a `{ type: 'backfill', id, from, to }` message
// onto env.BACKFILL, returning an immediate `{ accepted, id, from, to }`
// ack. UPDATE (Step 5 follow-up, 2026-09-20): this queue used to be called
// JOBS and was consumed here too; it's renamed BACKFILL and its consumer
// moved to the `ingest` Worker (src/ingest-worker.js) so `backend` never
// needs a Finnhub key -- see test/ingest_worker.test.js for that half of
// the contract now.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { STATE_DIR } from "./helpers/engine_ctx.js";
import { RunStore } from "../src/storage/run_store.js";

/** Minimal fake of the BACKFILL queue binding (Cloudflare Queues' `send`
 * producer API) -- captures every enqueued message so a test can assert on
 * it, same "wrap the real interface, verify what was actually sent" spirit
 * as test/dashboard_worker.test.js's FakeBackend service-binding wrapper. */
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
    LIVE_DB: createTestD1([STATE_DIR]), // M2b: the 'queued' job_progress row lands here, run_id 'live'

    BACKFILL: new FakeBackfillQueue(),
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

  assert.equal(env.BACKFILL.sent.length, 0);
});

test("POST /backfill with a valid range enqueues a backfill job onto BACKFILL and returns an immediate accepted ack", async () => {
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

  assert.equal(env.BACKFILL.sent.length, 1);
  assert.deepEqual(env.BACKFILL.sent[0], { type: "backfill", id: body.id, from: "2024-01-01", to: "2024-01-31" });

  // A 'queued' progress row was written BEFORE the enqueue, under the live run.
  const job = await new RunStore(env.LIVE_DB, "live").getJob(body.id);
  assert.equal(job.status, "queued");
  assert.equal(job.type, "backfill");
  assert.deepEqual(job.params, { from: "2024-01-01", to: "2024-01-31" });
});

test("POST /backfill still enqueues when the progress store is down -- the 'queued' row is best-effort and must never block the real enqueue", async (t) => {
  const { BrokenDb } = await import("./helpers/broken_db.js");
  t.mock.method(console, "warn", () => {});
  const env = baseEnv({ LIVE_DB: new BrokenDb() });

  const response = await worker.fetch(new Request("https://worker.example/backfill?from=2024-01-01&to=2024-01-31", { method: "POST" }), env);

  assert.equal(response.status, 200);
  assert.equal(env.BACKFILL.sent.length, 1);
});

test("POST /backfill still enqueues (and ignores) a legacy ?async=1 query param -- harmless leftover from before plan.md Step 3", async () => {
  const env = baseEnv();
  const request = new Request("https://worker.example/backfill?from=2024-01-01&to=2024-01-31&async=1", { method: "POST" });
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.accepted, true);
  assert.equal(env.BACKFILL.sent.length, 1);
});

test("POST /backfill returns 500 with the failure message if enqueueing itself fails (e.g. BACKFILL unavailable)", async (t) => {
  const env = baseEnv({ BACKFILL: new ThrowingBackfillQueue() });

  const errorLogs = [];
  t.mock.method(console, "error", (...args) => errorLogs.push(args));

  const request = new Request("https://worker.example/backfill?from=2024-01-01&to=2024-01-31", { method: "POST" });
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.match(body.message, /simulated queue send failure/);
  assert.ok(errorLogs.some(([msg]) => msg.includes("backfill enqueue failed")));
});
