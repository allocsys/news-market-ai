// Live ticker selection (storage/active_tickers.js + its gates in backend's scheduled()/fetch, the
// ingest Worker, the llm Worker and the Controls page). Real SQL through the sqlite D1 adapter.

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { getPauseFlags } from "../src/storage/pause_flags.js";
import { checkTickerSelection, getActiveTickers, getDisabledTickers, normalizeTickers, setActiveTickers } from "../src/storage/active_tickers.js";
import backend from "../src/index.js";
import ingestWorker from "../src/ingest-worker.js";
import llmWorker from "../src/llm-worker.js";

const STATE_DIR = fileURLToPath(new URL("../migrations/state", import.meta.url));
const WATCHLIST = ["AAPL", "MSFT", "XAUUSD"];

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
    WATCHLIST_TICKERS: WATCHLIST.join(","),
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

async function call(env, path, method = "GET") {
  const res = await backend.fetch(new Request(`https://backend${path}`, { method }), env, {});
  return { status: res.status, body: await res.json() };
}

// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------

test("normalizeTickers / checkTickerSelection: dedupes, upper-cases, needs one known ticker", () => {
  assert.deepEqual(normalizeTickers(["xauusd, aapl", "AAPL", " "]), ["XAUUSD", "AAPL"]);
  assert.deepEqual(checkTickerSelection(WATCHLIST, ["xauusd"]), { tickers: ["XAUUSD"] });
  assert.match(checkTickerSelection(WATCHLIST, []).error, /at least one ticker/);
  assert.match(checkTickerSelection(WATCHLIST, ["NVDA"]).error, /not in the watchlist: NVDA/);
});

test("getActiveTickers: empty table means every watchlist ticker is active", async () => {
  const db = createTestD1([STATE_DIR]);
  const res = await getActiveTickers(db, WATCHLIST);
  assert.equal(res.error, null);
  assert.deepEqual(res.active, WATCHLIST);
  assert.deepEqual(res.disabled, []);
});

test("setActiveTickers: selects exactly the chosen tickers, records who/when, and can re-enable all", async () => {
  const db = createTestD1([STATE_DIR]);
  await setActiveTickers(db, WATCHLIST, ["XAUUSD"], { by: "op", now: "2026-10-04T12:00:00.000Z" });
  let res = await getActiveTickers(db, WATCHLIST);
  assert.deepEqual(res.active, ["XAUUSD"]);
  assert.deepEqual(res.disabled, ["AAPL", "MSFT"]);
  assert.deepEqual(res.meta.AAPL, { updatedAt: "2026-10-04T12:00:00.000Z", updatedBy: "op" });

  await setActiveTickers(db, WATCHLIST, WATCHLIST);
  res = await getActiveTickers(db, WATCHLIST);
  assert.deepEqual(res.active, WATCHLIST);
  assert.deepEqual(res.disabled, []);
});

test("setActiveTickers rejects an empty or unknown selection without writing", async () => {
  const db = createTestD1([STATE_DIR]);
  await assert.rejects(() => setActiveTickers(db, WATCHLIST, []), /at least one ticker/);
  await assert.rejects(() => setActiveTickers(db, WATCHLIST, ["NVDA"]), /not in the watchlist/);
  assert.equal((await getDisabledTickers(db)).disabled.size, 0);
});

test("a ticker added to the watchlist later starts active; rows for removed tickers are ignored", async () => {
  const db = createTestD1([STATE_DIR]);
  await setActiveTickers(db, ["AAPL", "XAUUSD"], ["XAUUSD"]);
  const res = await getActiveTickers(db, ["XAUUSD", "AAPL", "USO"]);
  assert.deepEqual(res.active, ["XAUUSD", "USO"]);
  assert.deepEqual(res.disabled, ["AAPL"]);
});

test("ticker rows do not leak into the pause switches", async () => {
  const db = createTestD1([STATE_DIR]);
  await setActiveTickers(db, WATCHLIST, ["XAUUSD"]);
  const { flags, meta } = await getPauseFlags(db);
  assert.ok(Object.values(flags).every((v) => v === false));
  assert.deepEqual(meta, {});
});

test("getDisabledTickers fails open: no db, or a db that throws, reads as nothing disabled", async (t) => {
  t.mock.method(console, "warn", () => {});
  assert.equal((await getDisabledTickers(undefined)).disabled.size, 0);
  const broken = { prepare() { throw new Error("d1 down"); } };
  const res = await getDisabledTickers(broken);
  assert.equal(res.disabled.size, 0);
  assert.match(res.error, /d1 down/);
});

// ---------------------------------------------------------------------------
// backend scheduled() + routes
// ---------------------------------------------------------------------------

test("scheduled(): only the selected tickers get an ingest_ticker message (feeds and exit_check unchanged)", async () => {
  const env = baseEnv();
  await setActiveTickers(env.LIVE_DB, WATCHLIST, ["XAUUSD"]);
  await backend.scheduled({ cron: "*/15 * * * *" }, env);
  assert.deepEqual(
    env.INGEST.sent.filter((m) => m.type === "ingest_ticker").map((m) => m.ticker),
    ["XAUUSD"]
  );
  assert.ok(env.INGEST.sent.some((m) => m.type === "ingest_feeds"));
  assert.deepEqual(env.LLM_JOBS.sent.map((m) => m.type), ["exit_check"]);
  assert.ok(env.BACKFILL.sent.some((m) => m.type === "intraday_backfill_tick"));
});

test("scheduled(): with nothing selected (default) every watchlist ticker is fanned out", async () => {
  const env = baseEnv();
  await backend.scheduled({ cron: "*/15 * * * *" }, env);
  assert.deepEqual(
    env.INGEST.sent.filter((m) => m.type === "ingest_ticker").map((m) => m.ticker),
    WATCHLIST
  );
});

test("GET /api/active-tickers and POST /controls/tickers round-trip", async () => {
  const env = baseEnv();
  let res = await call(env, "/api/active-tickers");
  assert.deepEqual(res.body.active, WATCHLIST);

  res = await call(env, "/controls/tickers?tickers=xauusd&by=alice", "POST");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.active, ["XAUUSD"]);
  assert.deepEqual(res.body.disabled, ["AAPL", "MSFT"]);
  assert.equal(res.body.meta.AAPL.updatedBy, "alice");

  res = await call(env, "/controls/tickers?tickers=AAPL,XAUUSD", "POST");
  assert.deepEqual(res.body.active, ["AAPL", "XAUUSD"]);

  res = await call(env, "/controls/tickers?tickers=all", "POST");
  assert.deepEqual(res.body.active, WATCHLIST);
  assert.deepEqual(res.body.disabled, []);
});

test("POST /controls/tickers validates the selection and writes nothing on a bad one", async () => {
  const env = baseEnv();
  assert.equal((await call(env, "/controls/tickers", "POST")).status, 400);
  const unknown = await call(env, "/controls/tickers?tickers=NVDA", "POST");
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error, /not in the watchlist/);
  assert.deepEqual((await call(env, "/api/active-tickers")).body.active, WATCHLIST);
});

// ---------------------------------------------------------------------------
// ingest + llm workers
// ---------------------------------------------------------------------------

test("ingest worker: ingest_ticker for a disabled ticker is acked without running", async (t) => {
  const logs = [];
  const errors = [];
  t.mock.method(console, "log", (...args) => logs.push(args[0]));
  t.mock.method(console, "error", (...args) => errors.push(args[0]));
  const env = baseEnv();
  await setActiveTickers(env.LIVE_DB, WATCHLIST, ["XAUUSD"]);
  const message = fakeMessage({ type: "ingest_ticker", ticker: "AAPL", asOf: "2026-10-04T00:00:00.000Z" });
  await ingestWorker.queue({ messages: [message] }, env);
  assert.ok(message.acked && !message.retried);
  assert.equal(logs.filter((l) => String(l).includes("ticker disabled by the operator")).length, 1);
  assert.equal(errors.filter((e) => String(e).includes("ingest_ticker job failed")).length, 0);
});

test("llm worker: analyze for a disabled ticker is acked without running", async (t) => {
  const logs = [];
  t.mock.method(console, "log", (...args) => logs.push(args[0]));
  const env = baseEnv();
  await setActiveTickers(env.LIVE_DB, WATCHLIST, ["XAUUSD"]);
  const message = fakeMessage({ type: "analyze", runId: "n1", ticker: "AAPL", newsItem: {}, asOf: "2026-10-04T00:00:00.000Z" });
  await llmWorker.queue({ messages: [message] }, env);
  assert.ok(message.acked && !message.retried);
  assert.equal(logs.filter((l) => String(l).includes("ticker disabled by the operator")).length, 1);
});
