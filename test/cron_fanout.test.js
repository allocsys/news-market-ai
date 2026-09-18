// Cron fan-out test (plan.md Step 4) -- covers src/index.js's `scheduled`
// (now a thin scheduler, no more inline pipeline run) and queue()'s
// `exit_check` and `analyze` message types. test/queue_consumer.test.js
// already covers JOBS's original `backfill`/`backtest` types plus the
// generic unrecognized-type/crashed-handler paths -- this file only adds
// the Step 4 additions, not a re-test of what that file already covers.
//
// UPDATE (plan.md Step 5): the `ingest_ticker`/`ingest_feeds` queue()
// tests that used to live here moved to test/ingest_worker.test.js --
// those message types are no longer handled by src/index.js's queue() at
// all (see that file's own comment), they're now the new `ingest`
// Worker's (src/ingest-worker.js) job. scheduled()'s own fan-out tests
// stay here unchanged -- backend still enqueues onto INGEST, it just no
// longer consumes it.
//
// SCOPE NOTE on `analyze`: only the retry-on-failure path is covered here.
// A full success round-trip through runPipelineForTicker needs the same
// heavyweight FakePipelineDb + config.fakeModel machinery
// test/checkpoint_resume.test.js already builds and exercises in depth
// (six agent stages, checkpoint/resume, position open/close) -- duplicating
// that here would just be the same coverage under a different file name.
// What THIS file adds that checkpoint_resume.test.js doesn't: proving
// queue()'s `analyze` branch specifically retries (not acks) on failure,
// which is the one deliberate behavioral difference from every other
// message type in this handler (see index.js's own comment on that branch
// for why that's correct given checkpointer.js's resume semantics).

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

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

/** Minimal in-memory fake covering news_items/news_item_tickers (insertNewsItem) -- enough for scheduled()'s own tests below, which never reach D1 at all (scheduled() only enqueues, see its own header) but still need a DB value in baseEnv() for shape parity with the rest of this file's env objects. */
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

/** Minimal fake for checkOpenPositionExits: no open positions, so it never reaches closePosition/settlePositionOutcome at all -- just proving the exit_check branch wires through, not exit logic itself (see test/exit_logic.test.js for that). */
class FakeNoPositionsDb {
  prepare(sql) {
    return {
      bind() {
        return {
          async all() {
            if (/FROM positions/.test(sql)) return { results: [] };
            throw new Error(`FakeNoPositionsDb: unsupported all() query: ${sql}`);
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
    INGEST: new FakeQueueBinding(),
    ANALYZE: new FakeQueueBinding(),
    JOBS: new FakeQueueBinding(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// scheduled()
// ---------------------------------------------------------------------------

test("scheduled() fans out one INGEST message per watchlist ticker, one ingest_feeds message, and one JOBS exit_check message -- no inline pipeline work", async () => {
  const env = baseEnv({ DB: new FakeIngestDb() });

  await worker.scheduled({ cron: "*/15 * * * *" }, env);

  const ingestTypes = env.INGEST.sent.map((m) => m.type);
  assert.deepEqual(ingestTypes.sort(), ["ingest_feeds", "ingest_ticker", "ingest_ticker"].sort());
  const tickerMessages = env.INGEST.sent.filter((m) => m.type === "ingest_ticker");
  assert.deepEqual(tickerMessages.map((m) => m.ticker).sort(), ["AAPL", "MSFT"]);
  assert.ok(tickerMessages.every((m) => typeof m.asOf === "string"));

  assert.equal(env.JOBS.sent.length, 1);
  assert.equal(env.JOBS.sent[0].type, "exit_check");
  assert.ok(typeof env.JOBS.sent[0].asOf === "string");
});

test("scheduled() logs (not throws) if INGEST fan-out fails, and still attempts the exit_check enqueue -- ingestion and exit-checking stay isolated failure domains", async (t) => {
  const errorLogs = [];
  t.mock.method(console, "error", (...args) => errorLogs.push(args));

  const brokenIngest = { async sendBatch() { throw new Error("simulated INGEST enqueue failure"); }, async send() { throw new Error("simulated INGEST enqueue failure"); } };
  const env = baseEnv({ DB: new FakeIngestDb(), INGEST: brokenIngest });

  await worker.scheduled({ cron: "*/15 * * * *" }, env);

  assert.ok(errorLogs.some(([msg]) => msg.includes("INGEST fan-out failed")));
  assert.equal(env.JOBS.sent.length, 1); // exit_check enqueue still attempted despite the INGEST failure above
  assert.equal(env.JOBS.sent[0].type, "exit_check");
});

// ---------------------------------------------------------------------------
// queue(): exit_check
// ---------------------------------------------------------------------------

test("queue() exit_check runs checkOpenPositionExits and acks, isolated from INGEST/ANALYZE entirely (own message, own queue)", async (t) => {
  const env = baseEnv({ DB: new FakeNoPositionsDb() });

  const message = new FakeMessage({ type: "exit_check", asOf: "2026-09-18T00:00:00.000Z" });
  await worker.queue(batchOf(message), env);

  assert.equal(message.acked, true);
  assert.equal(message.retried, false);
  assert.equal(env.INGEST.sent.length, 0);
  assert.equal(env.ANALYZE.sent.length, 0);
});

test("queue() exit_check acks (does not retry) on failure -- next scheduled tick re-evaluates every still-open position regardless", async (t) => {
  class ThrowingPositionsDb {
    prepare() {
      throw new Error("simulated D1 read failure");
    }
  }
  const env = baseEnv({ DB: new ThrowingPositionsDb() });
  const errorLogs = [];
  t.mock.method(console, "error", (...args) => errorLogs.push(args));

  const message = new FakeMessage({ type: "exit_check", asOf: "2026-09-18T00:00:00.000Z" });
  await worker.queue(batchOf(message), env);

  assert.equal(message.acked, true);
  assert.equal(message.retried, false);
  assert.ok(errorLogs.some(([msg]) => msg.includes("exit_check job failed")));
});

// ---------------------------------------------------------------------------
// queue(): analyze
// ---------------------------------------------------------------------------

test("queue() analyze RETRIES (does not ack) on failure -- the one deliberate exception to every other message type in this handler, since runPipelineForTicker is checkpoint-resumable", async (t) => {
  class ThrowingCheckpointDb {
    prepare() {
      throw new Error("simulated D1 failure reading the checkpoint");
    }
  }
  const env = baseEnv({ DB: new ThrowingCheckpointDb() });
  const errorLogs = [];
  t.mock.method(console, "error", (...args) => errorLogs.push(args));

  const message = new FakeMessage({
    type: "analyze",
    runId: "news-1",
    ticker: "AAPL",
    newsItem: { id: "news-1", tickers: ["AAPL"], publishedAt: "2026-09-18T00:00:00.000Z" },
    asOf: "2026-09-18T00:00:00.000Z",
  });
  await worker.queue(batchOf(message), env);

  assert.equal(message.acked, false);
  assert.equal(message.retried, true);
  assert.ok(errorLogs.some(([msg]) => msg.includes("crashed unexpectedly")));
});
