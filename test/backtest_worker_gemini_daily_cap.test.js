// The Gemini DAILY-cap park path in backtest-worker.js's queue(): when a part ends in a 'continue'
// outcome flagged dailyQuota (EVERY Gemini model/key is on a daily quota cooldown), the worker PARKS
// the run -- status 'paused', paused_reason 'gemini_daily_cap', a resume envelope for the NEXT part,
// resume_after = the shortest cooldown -- instead of enqueuing a continuation. The runManualBacktest
// side of this (the dailyQuota flag, no stall counting) is covered by backtest_daily_quota_pause.test.js;
// this file covers the WORKER side that test deliberately does not reach.
//
// loadConfig(env) cannot supply config.fakeModel, so the real Gemini cascade runs against a mocked
// globalThis.fetch that answers every call with a free-tier PER-DAY 429 (quotaId ...PerDay...). Real
// sqlite SIM/INPUTS D1s, an in-memory CACHE_KV (the cooldown map lives there) and a fake BACKTEST queue.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/backtest-worker.js";
import { loadConfig } from "../src/config.js";
import { dailyQuotaCooldownSeconds } from "../src/shared/cooldown.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { STATE_DIR, INPUTS_DIR, SIM_DIR, seedBar, seedNews } from "./helpers/engine_ctx.js";

class FakeMessage {
  constructor(body) {
    this.body = body;
    this.acked = false;
    this.retried = false;
  }
  ack() { this.acked = true; }
  retry() { this.retried = true; }
}

const JOB = { type: "backtest", id: "bt-dailycap", tickers: ["AAPL"], testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-04T00:00:00.000Z", graceDays: 2 };

async function bindings() {
  const b = { SIM_DB: createTestD1([STATE_DIR, SIM_DIR]), INPUTS_DB: createTestD1([INPUTS_DIR]) };
  for (const date of ["2025-12-31", "2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05"]) await seedBar(b.INPUTS_DB, { ticker: "AAPL", date, close: 100 });
  await seedNews(b.INPUTS_DB, { id: "n1", tickers: ["AAPL"], publishedAt: "2026-01-01T10:00:00.000Z" });
  await seedNews(b.INPUTS_DB, { id: "n2", tickers: ["AAPL"], publishedAt: "2026-01-02T09:00:00.000Z" });
  return b;
}

function fakeQueue() {
  const sent = [];
  return { sent, async send(body, options) { sent.push({ body, options }); } };
}

/** Minimal in-memory KV: the cooldown map wrapper only needs get/put/delete/list. */
function memoryKv() {
  const store = new Map();
  return {
    store,
    get: async (key) => (store.has(key) ? store.get(key) : null),
    put: async (key, value) => { store.set(key, String(value)); },
    delete: async (key) => { store.delete(key); },
    list: async () => ({ keys: [...store.keys()].map((name) => ({ name })) }),
  };
}

function mockGemini(t, handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => handler(String(url), init);
  t.after(() => { globalThis.fetch = original; });
}

const DAILY_MESSAGE = "You exceeded your current quota. * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: m-quick";
const dailyQuota429 = () => new Response(
  JSON.stringify({ error: { message: DAILY_MESSAGE, details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaMetric: "m", quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }] } }),
  { status: 429, headers: { "content-type": "application/json" } }
);
const overloaded503 = () => new Response(JSON.stringify({ error: { message: "high demand" } }), { status: 503, headers: { "content-type": "application/json" } });

const quiet = (t) => { t.mock.method(console, "log", () => {}); t.mock.method(console, "error", () => {}); };

function envFor(b, queue, kv) {
  return {
    ...b,
    BACKTEST: queue,
    CACHE_KV: kv,
    GEMINI_API_KEYS: "key-a",
    GEMINI_QUICK_MODEL: "m-quick",
    GEMINI_DEEP_MODEL: "m-deep",
    BACKTEST_MAX_EXTERNAL_SUBREQUESTS: "40",
    BACKTEST_MAX_TOTAL_SUBREQUESTS: "10000", // big enough that only the quota error (never the budget) ends the part
    WATCHLIST_TICKERS: "AAPL",
  };
}

const PAUSE_COLUMNS = "status, error, paused_reason, paused_at, resume_after, cursor";
const runRow = (db) => db.prepare(`SELECT ${PAUSE_COLUMNS} FROM backtest_runs WHERE id = ?`).bind(JOB.id).first();

test("queue(): every Gemini model/key on a DAILY cooldown PARKS the run -- paused 'gemini_daily_cap', envelope for part 2, resume_after = the cooldown, acked, nothing sent", async (t) => {
  quiet(t);
  const b = await bindings();
  const queue = fakeQueue();
  const kv = memoryKv();
  mockGemini(t, () => dailyQuota429());
  const startedAt = Date.now();

  const message = new FakeMessage(JOB);
  await worker.queue({ messages: [message] }, envFor(b, queue, kv));

  assert.equal(message.acked, true);
  assert.equal(message.retried, false);
  assert.equal(queue.sent.length, 0, "the continuation is parked, not enqueued");

  const run = await runRow(b.SIM_DB);
  assert.equal(run.status, "paused", "paused, not failed: the data stays");
  assert.equal(run.error, null);
  assert.equal(run.paused_reason, "gemini_daily_cap");
  assert.ok(run.paused_at);
  const resumeAt = Date.parse(run.resume_after);
  assert.ok(resumeAt >= startedAt, "resume_after is in the future");
  assert.ok(resumeAt <= startedAt + (dailyQuotaCooldownSeconds() + 5) * 1000, "resume_after is no later than the daily cooldown");

  const envelope = JSON.parse(run.cursor);
  assert.equal(envelope.part, 2, "resume continues with the NEXT part");
  assert.equal(typeof envelope.cursor.clockNow, "string", "the run cursor is kept");
  assert.deepEqual(envelope.job, { id: JOB.id, tickers: JOB.tickers, testStart: JOB.testStart, testEnd: JOB.testEnd, graceDays: JOB.graceDays });

  assert.ok(kv.store.has("gemini:cooldown-map"), "the daily cooldown was recorded in the ONE cooldown-map key");
});

test("queue(): a plain transient Gemini outage (503) does NOT park -- the delayed continuation is sent and the run stays running", async (t) => {
  quiet(t);
  const b = await bindings();
  const queue = fakeQueue();
  const env = envFor(b, queue, memoryKv());
  mockGemini(t, () => overloaded503());

  const message = new FakeMessage(JOB);
  await worker.queue({ messages: [message] }, env);

  assert.equal(message.acked, true);
  assert.equal(message.retried, false);
  assert.equal(queue.sent.length, 1, "continuation enqueued");
  assert.equal(queue.sent[0].body.part, 2);
  assert.ok(queue.sent[0].options.delaySeconds >= loadConfig(env).backtestTransientPauseSeconds, "an outage asks for the longer transient delay");
  const run = await runRow(b.SIM_DB);
  assert.equal(run.status, "running");
  assert.equal(run.paused_reason, null);
  assert.equal(run.cursor, null);
});
