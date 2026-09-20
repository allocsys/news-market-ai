// Test for the new `ingest` Worker's queue() (plan.md Step 5,
// src/ingest-worker.js). These are the exact `ingest_ticker`/`ingest_feeds`
// (M2: env.DB is gone from this Worker -- ingestion writes env.INPUTS_DB.)
// tests that used to live in test/cron_fanout.test.js against
// src/index.js's queue() -- moved here unchanged in behavior/assertions,
// since the underlying code (src/ingestion/ingest.js#ingestTickerData /
// #ingestFeedNews) didn't change at all in this step, only which Worker's
// queue() calls it. Plus one unrecognized-type/crash-retry pair for parity
// with backend's own queue() test coverage, since this Worker's queue() has
// the same two-tier ack-vs-retry structure. UPDATE (Step 5 follow-up,
// 2026-09-20): also covers the new `backfill` message type, moved here
// (with its tests) from the now-deleted test/queue_consumer.test.js when
// the BACKFILL queue's consumer moved from `backend` to this Worker.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/ingest-worker.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { STATE_DIR } from "./helpers/engine_ctx.js";
import { BrokenDb } from "./helpers/broken_db.js";
import { RunStore } from "../src/storage/run_store.js";

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

/**
 * Records every message handed to send/sendBatch without actually queueing anything -- stands in for a Cloudflare Queue binding.
 * Enforces the same 100-message sendBatch cap the real one does (live incident 2026-09-19: `batch message count of 163 exceeds limit of 100`), and records each batch's size in `batchSizes`. `failBatchCalls` (0-based call indexes) makes those calls throw, to simulate a queue outage mid-send.
 */
class FakeQueueBinding {
  constructor({ failBatchCalls = [] } = {}) {
    this.sent = [];
    this.batchSizes = [];
    this.failBatchCalls = new Set(failBatchCalls);
    this.batchCalls = 0;
  }
  async send(body) {
    this.sent.push(body);
  }
  async sendBatch(messages) {
    const call = this.batchCalls++;
    if (messages.length > 100) throw new Error(`batch message count of ${messages.length} exceeds limit of 100 (10206)`);
    if (this.failBatchCalls.has(call)) throw new Error("simulated queue outage");
    this.batchSizes.push(messages.length);
    this.sent.push(...messages.map((m) => m.body));
  }
}

function mockFinnhubJson() {
  return [{ url: "https://finnhub.example.com/story", datetime: 1757941800, headline: "Story about Acme", summary: "A brief summary." }];
}

/** `count` distinct Finnhub articles (ids differ by url + datetime), like the trailing window /company-news really returns. */
function finnhubArticles(count, { offset = 0 } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    url: `https://finnhub.example.com/story-${offset + i}`,
    datetime: 1757941800 + offset + i,
    headline: `Story ${offset + i} about Acme`,
    summary: "A brief summary.",
  }));
}

/** Finnhub returns `articles()` (re-evaluated per request, so a test can change it between ticks); every other vendor call gets an empty object, which the adapters log and skip. */
function mockVendors(t, articles) {
  t.mock.method(global, "fetch", async (url) => {
    if (String(url).includes("finnhub")) return { ok: true, status: 200, json: async () => articles() };
    return { ok: true, status: 200, json: async () => ({}) };
  });
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
  // run() mirrors D1's `meta.changes` for the two ON CONFLICT DO NOTHING inserts insertNewsItem reads it from: 1 for a new row, 0 for a conflict.
  prepare(sql) {
    const db = this;
    return {
      bind(...args) {
        return {
          async run() {
            if (/INSERT INTO news_items/.test(sql)) {
              if (db.newsItems.some((n) => n.id === args[0])) return { meta: { changes: 0 } };
              db.newsItems.push({ id: args[0] });
              return { meta: { changes: 1 } };
            } else if (/INSERT INTO news_item_tickers/.test(sql)) {
              if (db.tickers.some((t) => t.newsItemId === args[0] && t.ticker === args[1])) return { meta: { changes: 0 } };
              db.tickers.push({ newsItemId: args[0], ticker: args[1] });
              return { meta: { changes: 1 } };
            } else if (/INSERT INTO news_item_revisions/.test(sql)) return; // exercised, not asserted on
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

  // Two feed entries (AAPL-hinted, MSFT-hinted) share the exact same mocked
  // XML across both fetch calls, and a news item's id is derived from url +
  // publishedAt only -- so they are ONE stored article (as real D1 would
  // have it) carrying two ticker associations. Each association is new, so
  // each still gets its own ANALYZE message, hinted to its own feed's ticker.
  assert.equal(db.newsItems.length, 1);
  assert.equal(db.tickers.length, 2);
  assert.equal(env.ANALYZE.sent.length, 2);
  assert.deepEqual(env.ANALYZE.sent.map((m) => m.ticker).sort(), ["AAPL", "MSFT"]);
  assert.equal(message.acked, true);
});

// ---------------------------------------------------------------------------
// queue(): backfill (Step 5 follow-up, 2026-09-20 -- moved here from the
// deleted test/queue_consumer.test.js, which covered backend's old JOBS
// consumer before that queue was renamed BACKFILL and its consumer moved
// here. Same assertions, only the env shape changed: LIVE_DB is now this
// Worker's own binding, added solely for job_progress reporting -- see
// wrangler.ingest.toml's comment on it.)
// ---------------------------------------------------------------------------

test("queue() processes a backfill job: runs the real backfill, then acks the message", async (t) => {
  const db = new FakeIngestDb();
  // M2: news writes go to INPUTS_DB; M2b: the job_progress row goes to LIVE_DB (run_id 'live').
  const env = baseEnv({ LIVE_DB: createTestD1([STATE_DIR]), INPUTS_DB: db });
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, json: async () => mockFinnhubJson() }));

  const message = new FakeMessage({ type: "backfill", id: "backfill-1", from: "2024-01-01", to: "2024-01-31" });
  await worker.queue(batchOf(message), env);

  assert.equal(db.newsItems.length, 1);
  assert.equal(message.acked, true);
  assert.equal(message.retried, false);

  // The progress row: written even though no 'queued' row existed (upsert), finished 'complete' with the real counts.
  const job = await new RunStore(env.LIVE_DB, "live").getJob("backfill-1");
  assert.equal(job.status, "complete");
  assert.equal(job.type, "backfill");
  assert.equal(job.percent, 100);
  assert.deepEqual(job.params, { from: "2024-01-01", to: "2024-01-31" });
  assert.equal(job.result.inserted, 1);
  assert.match(job.detail, /Inserted 1 article/);
});

test("queue() catches a backfill failure (e.g. a D1 write error), logs it, and still acks -- no lasting state to retry into", async (t) => {
  class ThrowingDb extends FakeIngestDb {
    prepare() {
      throw new Error("simulated D1 write failure");
    }
  }
  const env = baseEnv({ LIVE_DB: createTestD1([STATE_DIR]), INPUTS_DB: new ThrowingDb() });
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, json: async () => mockFinnhubJson() }));

  const errorLogs = [];
  t.mock.method(console, "error", (...args) => errorLogs.push(args));

  const message = new FakeMessage({ type: "backfill", id: "backfill-2", from: "2024-01-01", to: "2024-01-31" });
  await worker.queue(batchOf(message), env);

  assert.equal(message.acked, true);
  assert.equal(message.retried, false);
  assert.ok(errorLogs.some(([msg]) => msg.includes("backfill job failed")));

  const job = await new RunStore(env.LIVE_DB, "live").getJob("backfill-2");
  assert.equal(job.status, "failed");
  assert.match(job.error, /simulated D1 write failure/);
});

test("queue() still runs and acks a backfill when LIVE_DB (the progress store) is down -- progress is best-effort", async (t) => {
  const db = new FakeIngestDb();
  const env = baseEnv({ LIVE_DB: new BrokenDb(), INPUTS_DB: db });
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, json: async () => mockFinnhubJson() }));
  const warnings = [];
  t.mock.method(console, "warn", (...args) => warnings.push(args));

  const message = new FakeMessage({ type: "backfill", id: "backfill-3", from: "2024-01-01", to: "2024-01-31" });
  await worker.queue(batchOf(message), env);

  assert.equal(db.newsItems.length, 1, "the backfill itself is unaffected");
  assert.equal(message.acked, true);
  assert.equal(message.retried, false);
  assert.ok(warnings.some(([msg]) => msg.includes("job progress write failed")));
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

// ---------------------------------------------------------------------------
// queue(): new-items-only enqueue + sendBatch limits (live incident 2026-09-19:
// `batch message count of 163 exceeds limit of 100 (10206)` on every tick, so
// nothing ever reached ANALYZE)
// ---------------------------------------------------------------------------

test("queue() ingest_ticker sends more than 100 new items to ANALYZE in chunks of at most 100, instead of failing the whole send", async (t) => {
  const db = new FakeIngestDb();
  const env = baseEnv({ INPUTS_DB: db });
  mockVendors(t, () => finnhubArticles(163));

  const message = new FakeMessage({ type: "ingest_ticker", ticker: "AAPL", asOf: "2026-09-18T00:00:00.000Z" });
  await worker.queue(batchOf(message), env);

  assert.equal(db.newsItems.length, 163);
  assert.equal(env.ANALYZE.sent.length, 163);
  assert.deepEqual(env.ANALYZE.batchSizes, [100, 63]);
  assert.equal(message.acked, true);
  assert.equal(message.retried, false);
});

test("queue() ingest_ticker enqueues nothing for items it already stored on an earlier tick (Finnhub's trailing window repeats them)", async (t) => {
  const db = new FakeIngestDb();
  const env = baseEnv({ INPUTS_DB: db });
  let articles = finnhubArticles(163);
  mockVendors(t, () => articles);
  const logs = [];
  t.mock.method(console, "log", (...args) => logs.push(args));

  const tick = () => worker.queue(batchOf(new FakeMessage({ type: "ingest_ticker", ticker: "AAPL", asOf: "2026-09-18T00:00:00.000Z" })), env);
  await tick();
  assert.equal(env.ANALYZE.sent.length, 163);

  await tick(); // identical 163-item window
  assert.equal(env.ANALYZE.sent.length, 163, "second tick must not re-enqueue the same items");
  assert.equal(env.ANALYZE.batchCalls, 2, "no sendBatch call at all when nothing is new");
  const [, second] = logs.filter(([msg]) => msg === "ingest_ticker job completed");
  assert.equal(second[1].fetched, 163);
  assert.equal(second[1].freshItems, 0);
  assert.equal(second[1].analyzeMessages, 0);

  // ...and a tick whose window slid forward by 3 articles enqueues exactly those 3.
  articles = finnhubArticles(163, { offset: 3 });
  await tick();
  assert.equal(env.ANALYZE.sent.length, 166);
  assert.deepEqual(env.ANALYZE.sent.slice(163).map((m) => m.newsItem.title).sort(), ["Story 163 about Acme", "Story 164 about Acme", "Story 165 about Acme"]);
});

test("queue() ingest_ticker still analyzes an already-stored article for a second ticker (the same article surfacing under another ticker's query)", async (t) => {
  const db = new FakeIngestDb();
  const env = baseEnv({ INPUTS_DB: db });
  mockVendors(t, () => finnhubArticles(1));

  const tick = (ticker) => worker.queue(batchOf(new FakeMessage({ type: "ingest_ticker", ticker, asOf: "2026-09-18T00:00:00.000Z" })), env);
  await tick("AAPL");
  await tick("MSFT"); // same article id, new (article, MSFT) association
  await tick("MSFT"); // nothing new any more
  await tick("AAPL");

  assert.equal(db.newsItems.length, 1);
  assert.deepEqual(env.ANALYZE.sent.map((m) => m.ticker), ["AAPL", "MSFT"]);
});

test("queue() ingest_ticker keeps sending the remaining chunks when one sendBatch fails, logs what was lost, and still acks", async (t) => {
  const db = new FakeIngestDb();
  const env = baseEnv({ INPUTS_DB: db, ANALYZE: new FakeQueueBinding({ failBatchCalls: [0] }) });
  mockVendors(t, () => finnhubArticles(163));
  const errorLogs = [];
  t.mock.method(console, "error", (...args) => errorLogs.push(args));

  const message = new FakeMessage({ type: "ingest_ticker", ticker: "AAPL", asOf: "2026-09-18T00:00:00.000Z" });
  await worker.queue(batchOf(message), env);

  assert.equal(env.ANALYZE.sent.length, 63, "the second chunk still went out");
  const failure = errorLogs.find(([msg]) => msg.includes("could not enqueue every ANALYZE message"));
  assert.ok(failure, "a partial enqueue failure must be logged, not swallowed");
  assert.equal(failure[1].ticker, "AAPL");
  assert.equal(failure[1].lost, 100);
  assert.equal(failure[1].failures[0].message, "simulated queue outage");
  assert.equal(message.acked, true); // re-running would see the items as already stored and enqueue nothing, so a retry is pointless
  assert.equal(message.retried, false);
});

test("queue() ingest_feeds enqueues an already-stored article only for the ticker it newly gained", async (t) => {
  const db = new FakeIngestDb();
  const feedXml = `<?xml version="1.0"?><rss><channel><item>
      <title>Story mentioning the ticker</title>
      <link>https://news.example.com/story</link>
      <pubDate>Tue, 15 Sep 2026 14:30:00 GMT</pubDate>
      <description>Body text.</description>
    </item></channel></rss>`;
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, text: async () => feedXml }));
  const analyze = new FakeQueueBinding();
  const tick = (feeds) => worker.queue(batchOf(new FakeMessage({ type: "ingest_feeds", asOf: "2026-09-18T00:00:00.000Z" })), baseEnv({ INPUTS_DB: db, ANALYZE: analyze, RSS_FEED_URLS: feeds }));

  await tick("AAPL|https://fake.test/feed.xml");
  await tick("AAPL|https://fake.test/feed.xml"); // same feed again: nothing new
  assert.deepEqual(analyze.sent.map((m) => m.ticker), ["AAPL"]);

  await tick("AAPL|https://fake.test/feed.xml,MSFT|https://fake.test/feed.xml"); // a second feed carries the same article for MSFT
  assert.deepEqual(analyze.sent.map((m) => m.ticker), ["AAPL", "MSFT"]);
});
