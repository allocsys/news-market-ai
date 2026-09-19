// Test for the new `ingest` Worker's queue() (plan.md Step 5,
// src/ingest-worker.js). These are the exact `ingest_ticker`/`ingest_feeds`
// (M2: env.DB is gone from this Worker -- ingestion writes env.INPUTS_DB.)
// tests that used to live in test/cron_fanout.test.js against
// src/index.js's queue() -- moved here unchanged in behavior/assertions,
// since the underlying code (src/graph/pipeline.js#ingestTickerData /
// #ingestFeedNews) didn't change at all in this step, only which Worker's
// queue() calls it. Plus one unrecognized-type/crash-retry pair for parity
// with backend's own queue() test coverage (test/queue_consumer.test.js),
// since this Worker's queue() has the same two-tier ack-vs-retry structure.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/ingest-worker.js";

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

function batchOf(...messages) {
  return { messages };
}

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

function mockFinnhubJson() {
  return [{ url: "https://finnhub.example.com/story", datetime: 1757941800, headline: "Story about Acme", summary: "A brief summary." }];
}

/** Minimal in-memory fake covering news_items/news_item_tickers (insertNewsItem), price_bars (insertPriceBar), and fundamental_facts (insertFundamentalFacts, via db.batch) -- enough for ingestTickerData/ingestFeedNews to run without throwing, not a general D1 emulator (same convention as test/ingestion_wiring.test.js's FakeDb). */
class FakeIngestDb {
  constructor() {
    this.newsItems = [];
    this.tickers = [];
    this.priceBars = [];
  }
  async batch(statements) {
    const results = [];
    for (const stmt of statements) results.push(await stmt.run());
    return results;
  }
  prepare(sql) {
    const db = this;
    return {
      bind(...args) {
        return {
          async run() {
            if (/INSERT INTO news_items/.test(sql)) db.newsItems.push({ id: args[0] });
            else if (/INSERT INTO news_item_tickers/.test(sql)) db.tickers.push({ newsItemId: args[0], ticker: args[1] });
            else if (/INSERT INTO news_item_revisions/.test(sql)) return; // exercised, not asserted on
            else if (/INSERT INTO price_bars/.test(sql)) db.priceBars.push({ ticker: args[0] });
            else if (/INSERT INTO fundamental_facts/.test(sql)) return; // exercised, not asserted on
            else throw new Error(`FakeIngestDb: unsupported run() query: ${sql}`);
          },
          async all() {
            throw new Error(`FakeIngestDb: unsupported all() query: ${sql}`);
          },
        };
      },
    };
  }
}

function baseEnv(overrides = {}) {
  return {
    WATCHLIST_TICKERS: "AAPL,MSFT",
    FINNHUB_API_KEY: "test-key",
    ENTITY_RESOLUTION_USE_NAME_INDEX: "false", // keep these tests scoped to fan-out wiring, not entity resolution's own SEC-lookup path (covered separately)
    ANALYZE: new FakeQueueBinding(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// queue(): ingest_ticker
// ---------------------------------------------------------------------------

test("queue() ingest_ticker fetches+writes news for that one ticker, enqueues one ANALYZE message per resulting item, then acks", async (t) => {
  const db = new FakeIngestDb();
  const env = baseEnv({ INPUTS_DB: db });

  t.mock.method(global, "fetch", async (url) => {
    if (String(url).includes("finnhub")) return { ok: true, status: 200, json: async () => mockFinnhubJson() };
    // yfinance/edgar calls hit the same mock -- an unexpected response
    // shape becomes a logged VendorError and is skipped, same convention
    // as every other ingestion adapter (see their own headers), so this
    // doesn't need per-vendor mock shapes to avoid crashing the test.
    return { ok: true, status: 200, json: async () => ({}) };
  });

  const message = new FakeMessage({ type: "ingest_ticker", ticker: "AAPL", asOf: "2026-09-18T00:00:00.000Z" });
  await worker.queue(batchOf(message), env);

  assert.equal(db.newsItems.length, 1);
  assert.equal(env.ANALYZE.sent.length, 1);
  assert.equal(env.ANALYZE.sent[0].type, "analyze");
  assert.equal(env.ANALYZE.sent[0].ticker, "AAPL");
  assert.equal(message.acked, true);
  assert.equal(message.retried, false);
});

test("queue() ingest_ticker acks (does not retry) on a business-logic failure -- next cron tick's own message tries again", async (t) => {
  class ThrowingDb {
    prepare() {
      throw new Error("simulated D1 write failure");
    }
  }
  const env = baseEnv({ INPUTS_DB: new ThrowingDb() });
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, json: async () => mockFinnhubJson() }));
  const errorLogs = [];
  t.mock.method(console, "error", (...args) => errorLogs.push(args));

  const message = new FakeMessage({ type: "ingest_ticker", ticker: "AAPL", asOf: "2026-09-18T00:00:00.000Z" });
  await worker.queue(batchOf(message), env);

  assert.equal(message.acked, true);
  assert.equal(message.retried, false);
  assert.ok(errorLogs.some(([msg]) => msg.includes("ingest_ticker job failed")));
});

// ---------------------------------------------------------------------------
// queue(): ingest_feeds
// ---------------------------------------------------------------------------

test("queue() ingest_feeds fans ANALYZE messages out per (item, ticker) pair, since a general feed item may resolve to several tickers", async (t) => {
  const db = new FakeIngestDb();
  const env = baseEnv({ INPUTS_DB: db, RSS_FEED_URLS: "AAPL|https://fake.test/feed.xml,MSFT|https://fake.test/feed.xml" });

  t.mock.method(global, "fetch", async () => ({
    ok: true,
    status: 200,
    text: async () => `<?xml version="1.0"?><rss><channel><item>
        <title>Story mentioning the ticker</title>
        <link>https://news.example.com/story</link>
        <pubDate>Tue, 15 Sep 2026 14:30:00 GMT</pubDate>
        <description>Body text.</description>
      </item></channel></rss>`,
  }));

  const message = new FakeMessage({ type: "ingest_feeds", asOf: "2026-09-18T00:00:00.000Z" });
  await worker.queue(batchOf(message), env);

  // Two feed entries (AAPL-hinted, MSFT-hinted) with distinct URLs share
  // the exact same mocked XML across both fetch calls, so each becomes its
  // own inserted item -- one ANALYZE message per item, each hinted to its
  // own feed's ticker.
  assert.equal(db.newsItems.length, 2);
  assert.equal(env.ANALYZE.sent.length, 2);
  assert.deepEqual(env.ANALYZE.sent.map((m) => m.ticker).sort(), ["AAPL", "MSFT"]);
  assert.equal(message.acked, true);
});

// ---------------------------------------------------------------------------
// queue(): unrecognized type / crashed handler
// ---------------------------------------------------------------------------

test("queue() acks an unrecognized message type without processing it", async (t) => {
  const env = baseEnv({ INPUTS_DB: new FakeIngestDb() });
  const errorLogs = [];
  t.mock.method(console, "error", (...args) => errorLogs.push(args));

  const message = new FakeMessage({ type: "something_else" });
  await worker.queue(batchOf(message), env);

  assert.equal(message.acked, true);
  assert.equal(message.retried, false);
  assert.ok(errorLogs.some(([msg]) => msg.includes("unrecognized type")));
});

test("queue() retries (does not ack) on a genuine handler crash -- e.g. a malformed message with no readable body", async (t) => {
  const env = baseEnv({ INPUTS_DB: new FakeIngestDb() });
  const errorLogs = [];
  t.mock.method(console, "error", (...args) => errorLogs.push(args));

  // Both ingest_ticker and ingest_feeds wrap their own work in an inner
  // try/catch that acks on a business-logic failure (see the two tests
  // above) -- a null message.body is the one thing that crashes BEFORE
  // either inner try/catch is even reached (`job.type` on a null job
  // throws immediately), so it's what actually exercises this handler's
  // own outer catch -> message.retry(), the same safety-net split
  // backend's queue() has for a comparable unanticipated failure.
  const message = new FakeMessage(null);
  await worker.queue(batchOf(message), env);

  assert.equal(message.acked, false);
  assert.equal(message.retried, true);
  assert.ok(errorLogs.some(([msg]) => msg.includes("crashed unexpectedly")));
});
