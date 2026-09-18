// Covers backend's (src/index.js) POST /backfill route -- the operational
// entry point wired onto graph/pipeline.js#backfillHistoricalNews.
//
// Since plan.md Step 2 (dashboard Worker split), this route no longer
// checks a session cookie itself -- backend is private (see wrangler.toml,
// workers_dev = false) and only ever reached via `dashboard`'s BACKEND
// service binding, which already checked the session one hop up before
// forwarding (see test/dashboard_worker.test.js for that side). This file
// now only covers: query-param validation, the synchronous "give me real
// counts" mode (no ?async=1, what a scripted caller forwarded through
// dashboard gets), and the ?async=1 fire-and-forget ack mode (what a
// browser form submission forwarded through dashboard gets).

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

class FakeNewsDb {
  constructor() {
    this.newsItems = [];
  }
  prepare(sql) {
    const db = this;
    return {
      bind(...args) {
        return {
          async run() {
            if (/INSERT INTO news_items/.test(sql)) {
              db.newsItems.push({ id: args[0] });
            }
          },
        };
      },
    };
  }
}

function mockFinnhubJson() {
  return [{ url: "https://finnhub.example.com/story", datetime: 1757941800, headline: "Story about Acme", summary: "A brief summary." }];
}

function baseEnv(overrides = {}) {
  return {
    DB: new FakeNewsDb(),
    WATCHLIST_TICKERS: "AAPL",
    FINNHUB_API_KEY: "test-key",
    FINNHUB_API_BASE: "https://fake.test/finnhub",
    ...overrides,
  };
}

test("POST /backfill returns 400 for a missing or malformed from/to", async () => {
  const env = baseEnv();

  const missing = await worker.fetch(new Request("https://worker.example/backfill?from=2024-01-01", { method: "POST" }), env);
  assert.equal(missing.status, 400);

  const malformed = await worker.fetch(new Request("https://worker.example/backfill?from=not-a-date&to=2024-01-31", { method: "POST" }), env);
  assert.equal(malformed.status, 400);
});

test("POST /backfill with a valid range calls backfillHistoricalNews and reports counts synchronously (no ?async=1)", async (t) => {
  const env = baseEnv();
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, json: async () => mockFinnhubJson() }));

  const request = new Request("https://worker.example/backfill?from=2024-01-01&to=2024-01-31", { method: "POST" });
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.inserted, 1);
  assert.equal(body.errorCount, 0);
  assert.equal(env.DB.newsItems.length, 1);
});

test("POST /backfill?async=1 returns an immediate accepted ack and runs the real backfill in the background via ctx.waitUntil", async (t) => {
  const env = baseEnv();
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, json: async () => mockFinnhubJson() }));

  const request = new Request("https://worker.example/backfill?from=2024-01-01&to=2024-01-31&async=1", { method: "POST" });

  // Minimal ExecutionContext stand-in -- captures the promise passed to
  // ctx.waitUntil() so the test can await it itself instead of racing it.
  const ctx = { promises: [], waitUntil(p) { this.promises.push(p); } };

  const response = await worker.fetch(request, env, ctx);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/json/);
  const body = await response.json();
  assert.deepEqual(body, { accepted: true, from: "2024-01-01", to: "2024-01-31" });

  // The response above returns before the real backfill finishes -- it only
  // completes inside ctx.waitUntil, in the background.
  await Promise.all(ctx.promises);
  assert.equal(env.DB.newsItems.length, 1);
});

test("POST /backfill returns 500 with the failure message on a real (non-vendor) bug, e.g. a DB write failure", async (t) => {
  class ThrowingDb extends FakeNewsDb {
    prepare() {
      throw new Error("simulated D1 write failure");
    }
  }
  const env = baseEnv({ DB: new ThrowingDb() });
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, json: async () => mockFinnhubJson() }));

  const errorLogs = [];
  t.mock.method(console, "error", (...args) => errorLogs.push(args));

  const request = new Request("https://worker.example/backfill?from=2024-01-01&to=2024-01-31", { method: "POST" });
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.match(body.message, /simulated D1 write failure/);
  assert.ok(errorLogs.some(([msg]) => msg.includes("backfill run failed")));
});
