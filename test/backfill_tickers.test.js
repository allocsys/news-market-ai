// Optional `tickers` selection on the news backfill (POST /backfill?tickers=...):
// backfillHistoricalNews filters the watchlist, the ingest Worker carries the
// selection through every continuation part, backend validates it, and the
// dashboard gateway forwards it. Same harnesses as test/backfill_windowing.test.js,
// test/ingest_worker.test.js and test/dashboard_gateway_price_backfill.test.js.

import test from "node:test";
import assert from "node:assert/strict";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { INPUTS_DIR, STATE_DIR } from "./helpers/engine_ctx.js";
import { loadConfig } from "../src/config.js";
import { backfillHistoricalNews } from "../src/ingestion/ingest.js";
import { addDays } from "../src/ingestion/date_windows.js";
import ingestWorker from "../src/ingest-worker.js";
import backendWorker from "../src/index.js";
import { RunStore } from "../src/storage/run_store.js";
import { worker as gatewayWorker, loginConfigured, sessionCookieFor } from "./helpers/dashboard_gateway.js";
import { jobStateDb } from "./helpers/job_db.js";

function makeConfig(overrides = {}) {
  return loadConfig({
    WATCHLIST_TICKERS: "AAPL,MSFT",
    FINNHUB_API_KEY: "test-key",
    ENTITY_RESOLUTION_USE_NAME_INDEX: "false",
    FINNHUB_MIN_REQUEST_INTERVAL_MS: "1",
    RETRY_MAX_ATTEMPTS: "1",
    ...overrides,
  });
}

/** Finnhub stand-in: `perDay` distinct articles per ticker per day, honouring ?from=&to=. Returns the recorded requests. */
function mockFinnhub(t, { perDay = 1 } = {}) {
  const requests = [];
  t.mock.method(global, "fetch", async (url) => {
    const u = new URL(String(url));
    if (!u.hostname.includes("finnhub")) return { ok: true, status: 200, json: async () => ({}) };
    const symbol = u.searchParams.get("symbol");
    const from = u.searchParams.get("from");
    const to = u.searchParams.get("to");
    requests.push({ symbol, from, to });
    const articles = [];
    for (let day = from; day <= to; day = addDays(day, 1)) {
      for (let i = 0; i < perDay; i++) {
        articles.push({
          url: `https://finnhub.example.com/${symbol}/${day}/${i}`,
          datetime: Date.parse(`${day}T12:00:00Z`) / 1000 + i,
          headline: `${symbol} story ${day} ${i}`,
          summary: "",
        });
      }
    }
    return { ok: true, status: 200, json: async () => articles };
  });
  return requests;
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

class FakeQueue {
  constructor() {
    this.sent = [];
  }
  async send(body) {
    this.sent.push(body);
  }
}

// ---------------------------------------------------------------------------
// backfillHistoricalNews
// ---------------------------------------------------------------------------

test("backfillHistoricalNews fetches only the selected tickers", async (t) => {
  const db = createTestD1([INPUTS_DIR]);
  const requests = mockFinnhub(t);

  await backfillHistoricalNews(makeConfig(), db, { from: "2025-09-01", to: "2025-09-03", tickers: ["MSFT"] });

  assert.ok(requests.length > 0);
  assert.ok(requests.every((r) => r.symbol === "MSFT"), "no request for the unselected AAPL");
});

test("backfillHistoricalNews with no tickers, or an empty list, covers the whole watchlist", async (t) => {
  for (const tickers of [undefined, []]) {
    const db = createTestD1([INPUTS_DIR]);
    const requests = mockFinnhub(t);

    await backfillHistoricalNews(makeConfig(), db, { from: "2025-09-01", to: "2025-09-03", tickers });

    assert.deepEqual([...new Set(requests.map((r) => r.symbol))].sort(), ["AAPL", "MSFT"]);
    t.mock.restoreAll();
  }
});

// ---------------------------------------------------------------------------
// ingest Worker: the selection survives continuation parts
// ---------------------------------------------------------------------------

test("a backfill job's tickers go on its progress row and on every continuation message", async (t) => {
  const BACKFILL = new FakeQueue();
  const env = {
    WATCHLIST_TICKERS: "AAPL,MSFT",
    FINNHUB_API_KEY: "test-key",
    ENTITY_RESOLUTION_USE_NAME_INDEX: "false",
    FINNHUB_MIN_REQUEST_INTERVAL_MS: "1",
    LIVE_DB: createTestD1([STATE_DIR]),
    INPUTS_DB: createTestD1([INPUTS_DIR]),
    ANALYZE: new FakeQueue(),
    BACKFILL,
  };
  // 30 days x 40 articles for the one selected ticker: part 1 stops at the first window boundary past the write cap.
  const requests = mockFinnhub(t, { perDay: 40 });
  t.mock.method(console, "log", () => {});

  const first = new FakeMessage({ type: "backfill", id: "backfill-tickers", from: "2025-09-01", to: "2025-09-30", tickers: ["MSFT"] });
  await ingestWorker.queue({ messages: [first] }, env);

  assert.equal(first.acked, true);
  assert.equal(BACKFILL.sent.length, 1, "part 1 enqueues a continuation");
  assert.deepEqual(BACKFILL.sent[0].tickers, ["MSFT"], "without this, later parts would fetch the whole watchlist");

  const second = new FakeMessage(BACKFILL.sent[0]);
  await ingestWorker.queue({ messages: [second] }, env);

  assert.equal(second.acked, true);
  assert.ok(requests.every((r) => r.symbol === "MSFT"), "no part ever fetched AAPL");
  const job = await new RunStore(env.LIVE_DB, "live").getJob("backfill-tickers");
  assert.equal(job.status, "complete");
  assert.deepEqual(job.params, { from: "2025-09-01", to: "2025-09-30", tickers: ["MSFT"] });
});

// ---------------------------------------------------------------------------
// backend POST /backfill
// ---------------------------------------------------------------------------

async function postBackend(search, { watchlist = "AAPL,MSFT" } = {}) {
  const queue = new FakeQueue();
  const env = { LIVE_DB: (await jobStateDb()).db, BACKFILL: queue, WATCHLIST_TICKERS: watchlist };
  const response = await backendWorker.fetch(new Request(`https://backend/backfill?${search}`, { method: "POST" }), env, { waitUntil() {} });
  return { response, queue };
}

test("POST /backfill with tickers normalises them, queues them and echoes them", async () => {
  const { response, queue } = await postBackend("from=2025-09-01&to=2025-09-30&tickers=msft,%20aapl,msft");

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.tickers, ["MSFT", "AAPL"]);
  assert.deepEqual(queue.sent[0].tickers, ["MSFT", "AAPL"]);
});

test("POST /backfill without tickers keeps the old message shape (whole watchlist)", async () => {
  const { response, queue } = await postBackend("from=2025-09-01&to=2025-09-30");

  assert.equal(response.status, 200);
  assert.deepEqual(queue.sent[0], { type: "backfill", id: (await response.json()).id, from: "2025-09-01", to: "2025-09-30" });
});

test("POST /backfill rejects a ticker that is not on the watchlist, queueing nothing", async () => {
  const { response, queue } = await postBackend("from=2025-09-01&to=2025-09-30&tickers=NVDA");

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /not in the watchlist: NVDA/);
  assert.equal(queue.sent.length, 0);
});

// ---------------------------------------------------------------------------
// dashboard gateway passthrough
// ---------------------------------------------------------------------------

test("gateway POST /backfill forwards tickers (JSON array body) to backend and on to the queue", async () => {
  const queue = new FakeQueue();
  const backend = { fetch: (input, init) => backendWorker.fetch(new Request(input, init), { LIVE_DB: null, BACKFILL: queue, WATCHLIST_TICKERS: "AAPL,MSFT" }, { waitUntil() {} }) };
  const backendEnv = { LIVE_DB: (await jobStateDb()).db, BACKFILL: queue, WATCHLIST_TICKERS: "AAPL,MSFT" };
  const env = loginConfigured({ BACKEND: { fetch: (input, init) => backendWorker.fetch(new Request(input, init), backendEnv, { waitUntil() {} }) } });
  const cookie = await sessionCookieFor(env);
  void backend;

  const response = await gatewayWorker.fetch(
    new Request("https://dashboard.example/backfill", {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ from: "2025-09-01", to: "2025-09-30", tickers: ["MSFT"] }),
    }),
    env,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(queue.sent[0].tickers, ["MSFT"]);
});

test("gateway POST /backfill with an empty tickers array sends no tickers (whole watchlist)", async () => {
  const queue = new FakeQueue();
  const backendEnv = { LIVE_DB: (await jobStateDb()).db, BACKFILL: queue, WATCHLIST_TICKERS: "AAPL,MSFT" };
  const env = loginConfigured({ BACKEND: { fetch: (input, init) => backendWorker.fetch(new Request(input, init), backendEnv, { waitUntil() {} }) } });
  const cookie = await sessionCookieFor(env);

  const response = await gatewayWorker.fetch(
    new Request("https://dashboard.example/backfill", {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ from: "2025-09-01", to: "2025-09-30", tickers: [] }),
    }),
    env,
  );

  assert.equal(response.status, 200);
  assert.equal("tickers" in queue.sent[0], false);
});
