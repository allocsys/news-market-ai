// Covers backend's (src/index.js) POST /backtest/run route AFTER M3:
// re-enabled, and rewritten to enqueue onto BACKTEST (the new `backtest`
// Worker's queue, wrangler.backtest.toml) instead of the pre-M2 LLM_JOBS
// shape (git history, commit 62ce1f8) or the M2-era always-503 stub (the
// old version of this file, see git history for that contract if needed).
//
// Two things are new relative to the pre-M2 route this replaces:
//   - the 'queued' job_progress row is written via RunStore(env.SIM_DB, id)
//     -- this backtest's OWN run id, not RunStore(env.LIVE_DB, "live") the
//     way POST /backfill's row is (see test/index_backfill.test.js) --
//     every backtest has been its own `sim` environment since M1/M2b.
//   - testEnd is checked against a SimClock before anything is created or
//     enqueued (src/backtest/simClock.js's assertNotFuture): a caller
//     asking for a future testEnd gets a 400 naming the problem, not a job
//     that would fail three hops later inside the backtest Worker.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { STATE_DIR, SIM_DIR } from "./helpers/engine_ctx.js";
import { RunStore } from "../src/storage/run_store.js";

class FakeBacktestQueue {
  constructor() {
    this.sent = [];
  }
  async send(body) {
    this.sent.push(body);
  }
}

class ThrowingBacktestQueue {
  async send() {
    throw new Error("simulated queue send failure");
  }
}

function baseEnv(overrides = {}) {
  return {
    SIM_DB: createTestD1([STATE_DIR, SIM_DIR]), // the 'queued' job_progress row lands here, under this backtest's own run id
    BACKTEST: new FakeBacktestQueue(),
    WATCHLIST_TICKERS: "AAPL,MSFT",
    ...overrides,
  };
}

test("POST /backtest/run returns 400 for a missing or malformed testStart/testEnd, without touching the queue or SIM_DB", async () => {
  const env = baseEnv();

  const missing = await worker.fetch(new Request("https://worker.example/backtest/run?testStart=2024-01-01", { method: "POST" }), env);
  assert.equal(missing.status, 400);

  const malformed = await worker.fetch(new Request("https://worker.example/backtest/run?testStart=nope&testEnd=2024-01-31", { method: "POST" }), env);
  assert.equal(malformed.status, 400);

  assert.equal(env.BACKTEST.sent.length, 0);
});

test("POST /backtest/run returns 400 when testStart is not before testEnd, without touching the queue or SIM_DB", async () => {
  const env = baseEnv();

  const equal = await worker.fetch(
    new Request("https://worker.example/backtest/run?testStart=2024-01-15&testEnd=2024-01-15", { method: "POST" }),
    env
  );
  assert.equal(equal.status, 400);
  const equalBody = await equal.json();
  assert.match(equalBody.error, /must be before/);

  const reversed = await worker.fetch(
    new Request("https://worker.example/backtest/run?testStart=2024-02-01&testEnd=2024-01-01", { method: "POST" }),
    env
  );
  assert.equal(reversed.status, 400);
  const reversedBody = await reversed.json();
  assert.match(reversedBody.error, /must be before/);

  assert.equal(env.BACKTEST.sent.length, 0);
  assert.equal((await new RunStore(env.SIM_DB, "anything").db.prepare("SELECT COUNT(*) AS n FROM job_progress").first()).n, 0);
});

test("POST /backtest/run returns 400 for a non-numeric graceDays", async () => {
  const env = baseEnv();
  const response = await worker.fetch(
    new Request("https://worker.example/backtest/run?testStart=2024-01-01&testEnd=2024-01-31&graceDays=soon", { method: "POST" }),
    env
  );
  assert.equal(response.status, 400);
  assert.equal(env.BACKTEST.sent.length, 0);
});

test("POST /backtest/run returns 400 for a testEnd in the future, without touching the queue or SIM_DB", async () => {
  const env = baseEnv();
  const farFuture = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);

  const response = await worker.fetch(
    new Request(`https://worker.example/backtest/run?testStart=2024-01-01&testEnd=${farFuture}`, { method: "POST" }),
    env
  );
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error, /future/);
  assert.match(body.error, /testEnd/);

  assert.equal(env.BACKTEST.sent.length, 0);
  const row = await env.SIM_DB.prepare("SELECT COUNT(*) as n FROM job_progress").first();
  assert.equal(row.n, 0, "no job row for a rejected request");
});

test("POST /backtest/run with a valid request enqueues onto BACKTEST and returns an immediate accepted ack", async () => {
  const env = baseEnv();

  const request = new Request("https://worker.example/backtest/run?testStart=2024-01-01&testEnd=2024-01-31&tickers=AAPL,%20MSFT&graceDays=5", { method: "POST" });
  const response = await worker.fetch(request, env);

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/json/);
  const body = await response.json();
  assert.equal(body.accepted, true);
  assert.equal(body.testStart, "2024-01-01");
  assert.equal(body.testEnd, "2024-01-31");
  assert.deepEqual(body.tickers, ["AAPL", "MSFT"]);
  assert.match(body.id, /^backtest-/);

  assert.equal(env.BACKTEST.sent.length, 1);
  assert.deepEqual(env.BACKTEST.sent[0], {
    type: "backtest",
    id: body.id,
    tickers: ["AAPL", "MSFT"],
    testStart: "2024-01-01T00:00:00.000Z",
    testEnd: "2024-01-31T00:00:00.000Z",
    graceDays: 5,
  });

  // The 'queued' row lives in SIM_DB, under THIS backtest's own run id -- not 'live'.
  const job = await new RunStore(env.SIM_DB, body.id).getJob(body.id);
  assert.equal(job.status, "queued");
  assert.equal(job.type, "backtest");
  assert.deepEqual(job.params, { tickers: ["AAPL", "MSFT"], testStart: "2024-01-01", testEnd: "2024-01-31", graceDays: 5 });
});

test("POST /backtest/run with no tickers param falls back to config.watchlist", async () => {
  const env = baseEnv({ WATCHLIST_TICKERS: "AAPL,TSLA" });

  const response = await worker.fetch(
    new Request("https://worker.example/backtest/run?testStart=2024-01-01&testEnd=2024-01-31", { method: "POST" }),
    env
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.tickers, ["AAPL", "TSLA"]);
});

test("POST /backtest/run returns 400 when tickers is given but resolves to nothing after trimming (e.g. a bare comma)", async () => {
  // tickers="" (empty string) is falsy and falls back to config.watchlist,
  // same as the pre-M2 route (git history) -- this isn't that case. A bare
  // "," IS truthy, splits to two empty strings, and both get filtered out,
  // which is the actual way to reach the empty-tickers 400 branch.
  const env = baseEnv();
  const response = await worker.fetch(
    new Request("https://worker.example/backtest/run?testStart=2024-01-01&testEnd=2024-01-31&tickers=,", { method: "POST" }),
    env
  );
  assert.equal(response.status, 400);
  assert.equal(env.BACKTEST.sent.length, 0);
});

// NOTE: there is no test here for "tickers empty AND watchlist empty" --
// config.js's loadConfig falls back to a non-empty default watchlist
// ("AAPL,MSFT,TSLA") whenever WATCHLIST_TICKERS is unset/empty (env.WATCHLIST_TICKERS
// || "AAPL,MSFT,TSLA"), so that combination can't actually happen; the
// empty-tickers 400 branch above is only reachable via a malformed explicit
// tickers param (e.g. a bare comma), which the test above already covers.

test("POST /backtest/run still enqueues when the progress store is down -- the 'queued' row is best-effort and must never block the real enqueue", async (t) => {
  const { BrokenDb } = await import("./helpers/broken_db.js");
  t.mock.method(console, "warn", () => {});
  const env = baseEnv({ SIM_DB: new BrokenDb() });

  const response = await worker.fetch(
    new Request("https://worker.example/backtest/run?testStart=2024-01-01&testEnd=2024-01-31", { method: "POST" }),
    env
  );

  assert.equal(response.status, 200);
  assert.equal(env.BACKTEST.sent.length, 1);
});

test("POST /backtest/run returns 500 with the failure message if enqueueing itself fails (e.g. BACKTEST unavailable)", async (t) => {
  const env = baseEnv({ BACKTEST: new ThrowingBacktestQueue() });

  const errorLogs = [];
  t.mock.method(console, "error", (...args) => errorLogs.push(args));

  const response = await worker.fetch(
    new Request("https://worker.example/backtest/run?testStart=2024-01-01&testEnd=2024-01-31", { method: "POST" }),
    env
  );
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.match(body.message, /simulated queue send failure/);
  assert.ok(errorLogs.some(([msg]) => msg.includes("backtest enqueue failed")));
});

test("POST /backtest/run accepts a full ISO testStart/testEnd, not just YYYY-MM-DD", async () => {
  const env = baseEnv();
  const response = await worker.fetch(
    new Request("https://worker.example/backtest/run?testStart=2024-01-01T00:00:00.000Z&testEnd=2024-01-31T12:00:00.000Z", { method: "POST" }),
    env
  );
  assert.equal(response.status, 200);
  assert.deepEqual(env.BACKTEST.sent[0].testStart, "2024-01-01T00:00:00.000Z");
  assert.deepEqual(env.BACKTEST.sent[0].testEnd, "2024-01-31T12:00:00.000Z");
});
