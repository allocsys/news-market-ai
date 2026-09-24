// Pause switches (storage/pause_flags.js + their gates in backend's
// scheduled()/fetch, the ingest Worker and the llm Worker). Real SQL through
// the sqlite D1 adapter, so the migration itself is exercised.

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { PAUSE_KEYS, getPauseFlags, isPaused, setPauseFlags } from "../src/storage/pause_flags.js";
import backend from "../src/index.js";
import ingestWorker from "../src/ingest-worker.js";
import llmWorker from "../src/llm-worker.js";
import { renderControlsView, renderPausedBanner } from "../src/dashboard/views/controls.js";

const STATE_DIR = fileURLToPath(new URL("../migrations/state", import.meta.url));

class FakeQueue {
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

function fakeMessage(body) {
  return {
    body,
    acked: false,
    retried: false,
    ack() { this.acked = true; },
    retry() { this.retried = true; },
  };
}

function baseEnv(overrides = {}) {
  return {
    WATCHLIST_TICKERS: "AAPL,MSFT",
    ENTITY_RESOLUTION_USE_NAME_INDEX: "false",
    LIVE_DB: createTestD1([STATE_DIR]),
    INGEST: new FakeQueue(),
    ANALYZE: new FakeQueue(),
    LLM_JOBS: new FakeQueue(),
    BACKFILL: new FakeQueue(),
    BACKTEST: new FakeQueue(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------

test("getPauseFlags: empty table means nothing is paused", async () => {
  const db = createTestD1([STATE_DIR]);
  const { flags, error } = await getPauseFlags(db);
  assert.equal(error, null);
  assert.deepEqual(flags, { ingestion: false, trading: false, llm: false, backtests: false });
});

test("setPauseFlags: flips one switch, then all, and records who/when", async () => {
  const db = createTestD1([STATE_DIR]);
  await setPauseFlags(db, ["trading"], true, { by: "op", now: "2026-09-24T12:00:00.000Z" });
  let res = await getPauseFlags(db);
  assert.deepEqual(res.flags, { ingestion: false, trading: true, llm: false, backtests: false });
  assert.deepEqual(res.meta.trading, { updatedAt: "2026-09-24T12:00:00.000Z", updatedBy: "op" });
  assert.equal(await isPaused(db, "trading"), true);
  assert.equal(await isPaused(db, "llm"), false);

  await setPauseFlags(db, PAUSE_KEYS, true);
  assert.ok(Object.values((await getPauseFlags(db)).flags).every(Boolean));
  await setPauseFlags(db, PAUSE_KEYS, false);
  assert.ok(Object.values((await getPauseFlags(db)).flags).every((v) => v === false));
});

test("setPauseFlags rejects an unknown key without writing", async () => {
  const db = createTestD1([STATE_DIR]);
  await assert.rejects(() => setPauseFlags(db, ["trading", "bogus"], true), /unknown pause key/);
  assert.equal(await isPaused(db, "trading"), false);
});

test("getPauseFlags fails open: no db, or a db that throws, reads as nothing paused", async (t) => {
  t.mock.method(console, "warn", () => {});
  assert.equal((await getPauseFlags(undefined)).flags.ingestion, false);
  const broken = { prepare() { throw new Error("d1 down"); } };
  const res = await getPauseFlags(broken);
  assert.ok(Object.values(res.flags).every((v) => v === false));
  assert.match(res.error, /d1 down/);
});

// ---------------------------------------------------------------------------
// backend scheduled()
// ---------------------------------------------------------------------------

test("scheduled(): Ingestion paused skips INGEST fan-out but still sends exit_check and the backfill tick", async () => {
  const env = baseEnv();
  await setPauseFlags(env.LIVE_DB, ["ingestion"], true);
  await backend.scheduled({ cron: "*/15 * * * *" }, env);
  assert.equal(env.INGEST.sent.length, 0);
  assert.deepEqual(env.LLM_JOBS.sent.map((m) => m.type), ["exit_check"]);
  assert.ok(env.BACKFILL.sent.some((m) => m.type === "intraday_backfill_tick"));
});

test("scheduled(): Trading (or LLM) paused skips exit_check but keeps ingestion and the backfill tick", async () => {
  for (const key of ["trading", "llm"]) {
    const env = baseEnv();
    await setPauseFlags(env.LIVE_DB, [key], true);
    await backend.scheduled({ cron: "*/15 * * * *" }, env);
    assert.equal(env.LLM_JOBS.sent.length, 0, key);
    assert.equal(env.INGEST.sent.length, 3, key); // 2 tickers + feeds
    assert.ok(env.BACKFILL.sent.some((m) => m.type === "intraday_backfill_tick"), key);
  }
});

test("scheduled(): everything paused still sends the intraday backfill tick", async () => {
  const env = baseEnv();
  await setPauseFlags(env.LIVE_DB, PAUSE_KEYS, true);
  await backend.scheduled({ cron: "*/15 * * * *" }, env);
  assert.equal(env.INGEST.sent.length, 0);
  assert.equal(env.LLM_JOBS.sent.length, 0);
  assert.ok(env.BACKFILL.sent.some((m) => m.type === "intraday_backfill_tick"));
});

test("scheduled(): with no LIVE_DB bound (fails open) the fan-out is unchanged", async () => {
  const env = baseEnv({ LIVE_DB: undefined });
  await backend.scheduled({ cron: "*/15 * * * *" }, env);
  assert.equal(env.INGEST.sent.length, 3);
  assert.equal(env.LLM_JOBS.sent.length, 1);
});

// ---------------------------------------------------------------------------
// backend routes
// ---------------------------------------------------------------------------

async function call(env, path, method = "GET") {
  const res = await backend.fetch(new Request(`https://backend${path}`, { method }), env, {});
  return { status: res.status, body: await res.json() };
}

test("GET /api/controls and POST /controls/set round-trip", async () => {
  const env = baseEnv();
  assert.equal((await call(env, "/api/controls")).body.flags.llm, false);

  let res = await call(env, "/controls/set?key=llm&paused=1&by=alice", "POST");
  assert.equal(res.status, 200);
  assert.equal(res.body.flags.llm, true);
  assert.equal(res.body.meta.llm.updatedBy, "alice");

  res = await call(env, "/controls/set?key=all&paused=1", "POST");
  assert.ok(PAUSE_KEYS.every((k) => res.body.flags[k] === true));
  res = await call(env, "/controls/set?key=all&paused=0", "POST");
  assert.ok(PAUSE_KEYS.every((k) => res.body.flags[k] === false));
});

test("POST /controls/set validates key and paused", async () => {
  const env = baseEnv();
  assert.equal((await call(env, "/controls/set?key=bogus&paused=1", "POST")).status, 400);
  assert.equal((await call(env, "/controls/set?key=llm&paused=yes", "POST")).status, 400);
});

test("POST /backtest/run is refused (409) when Backtests or LLM calls is paused, and nothing is enqueued", async () => {
  for (const key of ["backtests", "llm"]) {
    const env = baseEnv();
    await setPauseFlags(env.LIVE_DB, [key], true);
    const res = await call(env, "/backtest/run?testStart=2026-01-01&testEnd=2026-02-01", "POST");
    assert.equal(res.status, 409, key);
    assert.match(res.body.error, /paused/);
    assert.equal(env.BACKTEST.sent.length, 0, key);
  }
});

// ---------------------------------------------------------------------------
// ingest + llm workers
// ---------------------------------------------------------------------------

test("ingest worker: Ingestion paused acks ingest_ticker/ingest_feeds without running them", async (t) => {
  const logs = [];
  t.mock.method(console, "log", (...args) => logs.push(args[0]));
  const env = baseEnv();
  await setPauseFlags(env.LIVE_DB, ["ingestion"], true);
  const messages = [fakeMessage({ type: "ingest_ticker", ticker: "AAPL", asOf: "2026-09-24T00:00:00.000Z" }), fakeMessage({ type: "ingest_feeds", asOf: "2026-09-24T00:00:00.000Z" })];
  await ingestWorker.queue({ messages }, env);
  assert.ok(messages.every((m) => m.acked && !m.retried));
  assert.equal(logs.filter((l) => String(l).includes("ingestion is paused")).length, 2);
});

test("llm worker: Trading or LLM paused acks analyze and exit_check without running them", async (t) => {
  t.mock.method(console, "log", () => {});
  for (const key of ["trading", "llm"]) {
    const env = baseEnv();
    await setPauseFlags(env.LIVE_DB, [key], true);
    const messages = [fakeMessage({ type: "analyze", runId: "n1", ticker: "AAPL", newsItem: {}, asOf: "2026-09-24T00:00:00.000Z" }), fakeMessage({ type: "exit_check", asOf: "2026-09-24T00:00:00.000Z" })];
    await llmWorker.queue({ messages }, env);
    assert.ok(messages.every((m) => m.acked && !m.retried), key);
  }
});

// ---------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------

test("controls view: banner only when something is paused; page lists all four switches", () => {
  assert.equal(renderPausedBanner({ ingestion: false, trading: false, llm: false, backtests: false }), "");
  assert.match(renderPausedBanner({ trading: true }), /PAUSED:<\/strong> Trading/);
  const html = renderControlsView({ flags: { llm: true }, meta: {}, error: null });
  for (const label of ["Ingestion", "Trading", "LLM calls", "Backtests"]) assert.ok(html.includes(label), label);
  assert.match(html, /Resume all/);
  assert.match(html, /Pause all/);
});
