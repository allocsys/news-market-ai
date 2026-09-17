// Covers src/index.js's POST /backfill route -- the operational entry
// point wired onto graph/pipeline.js#backfillHistoricalNews (see plan.md's
// Backlog note this closes). No existing test file touches src/index.js's
// fetch handler at all before this one; /dashboard's GET route stays
// untested here too, out of scope for this file.
//
// Auth/validation branches are tested against a minimal fake env (no real
// D1/KV) since they return before ever touching backfillHistoricalNews.
// The success/failure-passthrough branches use a FakeDb shaped like
// storage/d1.js#insertNewsItem expects (same convention as
// test/ingestion_wiring.test.js's FakeNewsDb) plus a mocked global.fetch
// for Finnhub, since backfillHistoricalNews itself is exercised elsewhere
// (test/ingestion_wiring.test.js) and doesn't need re-testing here -- this
// file's job is just "does the route wire it correctly."

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
            // news_item_revisions / news_item_tickers inserts are
            // exercised but not asserted on here -- see
            // test/ingestion_wiring.test.js's FakeNewsDb for full coverage.
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

test("POST /backfill returns 503 when BACKFILL_API_SECRET is unset (disabled, not open)", async () => {
  const env = baseEnv(); // no BACKFILL_API_SECRET
  const request = new Request("https://worker.example/backfill?from=2024-01-01&to=2024-01-31", { method: "POST" });

  const response = await worker.fetch(request, env);
  assert.equal(response.status, 503);
});

test("POST /backfill returns 401 when X-Backfill-Secret is missing or wrong", async () => {
  const env = baseEnv({ BACKFILL_API_SECRET: "correct-secret" });
  const request = new Request("https://worker.example/backfill?from=2024-01-01&to=2024-01-31", {
    method: "POST",
    headers: { "X-Backfill-Secret": "wrong-secret" },
  });

  const response = await worker.fetch(request, env);
  assert.equal(response.status, 401);
});

test("POST /backfill returns 400 for a missing or malformed from/to", async () => {
  const env = baseEnv({ BACKFILL_API_SECRET: "correct-secret" });

  const missing = await worker.fetch(
    new Request("https://worker.example/backfill?from=2024-01-01", { method: "POST", headers: { "X-Backfill-Secret": "correct-secret" } }),
    env,
  );
  assert.equal(missing.status, 400);

  const malformed = await worker.fetch(
    new Request("https://worker.example/backfill?from=not-a-date&to=2024-01-31", { method: "POST", headers: { "X-Backfill-Secret": "correct-secret" } }),
    env,
  );
  assert.equal(malformed.status, 400);
});

test("POST /backfill with a correct secret and valid range calls backfillHistoricalNews and reports counts", async (t) => {
  const env = baseEnv({ BACKFILL_API_SECRET: "correct-secret" });
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, json: async () => mockFinnhubJson() }));

  const request = new Request("https://worker.example/backfill?from=2024-01-01&to=2024-01-31", {
    method: "POST",
    headers: { "X-Backfill-Secret": "correct-secret" },
  });

  const response = await worker.fetch(request, env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.inserted, 1);
  assert.equal(body.errorCount, 0);
  assert.equal(env.DB.newsItems.length, 1);
});

test("POST /backfill returns 500 with the failure message on a real (non-vendor) bug, e.g. a DB write failure", async (t) => {
  // A network/vendor failure is NOT what should hit this path -- finnhub.js
  // isolates per-ticker VendorErrors internally, so backfillHistoricalNews
  // never throws on those (see test/ingestion_wiring.test.js's isolation
  // test). This 500 branch is for a genuine bug: here, insertNewsItem
  // itself throwing (a D1 failure), which is exactly the kind of error
  // that SHOULD propagate rather than being silently swallowed.
  class ThrowingDb extends FakeNewsDb {
    prepare() {
      throw new Error("simulated D1 write failure");
    }
  }
  const env = baseEnv({ BACKFILL_API_SECRET: "correct-secret", DB: new ThrowingDb() });
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, json: async () => mockFinnhubJson() }));

  const errorLogs = [];
  t.mock.method(console, "error", (...args) => errorLogs.push(args));

  const request = new Request("https://worker.example/backfill?from=2024-01-01&to=2024-01-31", {
    method: "POST",
    headers: { "X-Backfill-Secret": "correct-secret" },
  });

  const response = await worker.fetch(request, env);
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.match(body.message, /simulated D1 write failure/);
  assert.ok(errorLogs.some(([msg]) => msg.includes("backfill run failed")));
});
