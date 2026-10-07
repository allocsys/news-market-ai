// Covers the `ingest` Worker's backfill_macro queue branch (src/ingest-worker.js) -- the
// worker half of the operator-triggered macro (FRED + CFTC COT) history backfill:
//   * a good run stores both halves, completes the job with the real counts and a
//     "Stored N FRED + M COT rows from <from>" detail, and acks;
//   * `from` reaches BOTH vendors as the observation start;
//   * it runs ingestMacro in backfill mode (older COT weeks keep release-derived
//     availability even when live ticks already stored a recent week);
//   * it does NOT read the feature:macro flag (that gates live ticks only);
//   * a missing FRED_API_KEY skips FRED only and says so in the detail;
//   * "nothing stored from either half" is a FAILED job (ingestMacro swallows vendor
//     errors per half, so 'complete, 0 rows' would hide exactly that), still acked;
//   * LIVE_DB (progress store) down does not stop the backfill -- progress is best-effort.
// The route half is in test/index_backfill_macro.test.js; ingestMacro's own backfill options
// are in test/macro_backfill_ingest.test.js.
//
// Real SQL through the sqlite D1 adapter; global fetch mocked. Nothing here has touched the
// real FRED or CFTC APIs.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/ingest-worker.js";
import { loadConfig } from "../src/config.js";
import { ingestMacro } from "../src/ingestion/ingest.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { STATE_DIR, INPUTS_DIR } from "./helpers/engine_ctx.js";
import { BrokenDb } from "./helpers/broken_db.js";
import { RunStore } from "../src/storage/run_store.js";
import { DEFAULT_FRED_SERIES } from "../src/ingestion/sources/fred.js";
import { COT_SERIES, GOLD_COT_CODE, cotAvailableAt } from "../src/ingestion/sources/cftc_cot.js";

const FRED_BASE = "https://fred.example/series/observations";
const COT_BASE = "https://cot.example/resource/72hh-3qpy.json";

const VENDOR_ENV = {
  FRED_API_KEY: "test-fred-key",
  FRED_API_BASE: FRED_BASE,
  FRED_MIN_REQUEST_INTERVAL_MS: "1", // "0" would fall back to the 250ms default
  COT_API_BASE: COT_BASE,
};

const N_FRED = DEFAULT_FRED_SERIES.length;

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

function workerEnv(overrides = {}) {
  return {
    LIVE_DB: createTestD1([STATE_DIR]),
    INPUTS_DB: createTestD1([INPUTS_DIR]),
    WATCHLIST_TICKERS: "XAUUSD",
    ...VENDOR_ENV,
    ...overrides,
  };
}

function silenceLogs(t) {
  for (const m of ["warn", "error", "log", "info"]) t.mock.method(console, m, () => {});
}

function cotRow(date, { long = 100000, short = 20000, oi = 500000 } = {}) {
  return {
    cftc_contract_market_code: GOLD_COT_CODE,
    report_date_as_yyyy_mm_dd: `${date}T00:00:00.000`,
    m_money_positions_long_all: String(long),
    m_money_positions_short_all: String(short),
    open_interest_all: String(oi),
  };
}

const okFred = () => ({ body: { observations: [{ realtime_start: "2026-10-01", date: "2026-09-30", value: "1.9" }] } });

/** Routes global fetch by URL prefix; `fred`/`cot` are specs ({status, body}) or (url) => spec. Calls are recorded per route. */
function mockVendors(t, { fred, cot }) {
  const calls = { fred: [], cot: [] };
  t.mock.method(global, "fetch", async (url) => {
    const u = new URL(String(url));
    const kind = String(url).startsWith(FRED_BASE) ? "fred" : String(url).startsWith(COT_BASE) ? "cot" : null;
    if (!kind) return { ok: false, status: 404, json: async () => ({}), text: async () => "{}" };
    calls[kind].push({ url: u });
    const route = { fred, cot }[kind];
    const { status = 200, body = {} } = (typeof route === "function" ? route(u) : route) ?? {};
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
  });
  return calls;
}

async function macroRows(db) {
  const { results } = await db.prepare(`SELECT series, obs_date, available_at, val, source FROM macro_observations ORDER BY series, obs_date, available_at`).all();
  return results;
}

const getJob = (env, id) => new RunStore(env.LIVE_DB, "live").getJob(id);

// ---------------------------------------------------------------------------
// a good run
// ---------------------------------------------------------------------------

test("queue() runs a backfill_macro job: stores FRED + COT from `from`, completes the job with the real counts and acks", async (t) => {
  silenceLogs(t);
  const env = workerEnv();
  const calls = mockVendors(t, { fred: okFred, cot: { body: [cotRow("2026-01-06")] } });

  const message = new FakeMessage({ type: "backfill_macro", id: "backfill-macro-1", from: "2026-01-01" });
  await worker.queue({ messages: [message] }, env);

  assert.equal(message.acked, true);
  assert.equal(message.retried, false);

  // `from` is the observation start for BOTH vendors
  assert.equal(calls.fred.length, N_FRED);
  assert.ok(calls.fred.every((c) => c.url.searchParams.get("observation_start") === "2026-01-01"));
  assert.match(calls.cot[0].url.searchParams.get("$where"), /report_date_as_yyyy_mm_dd >= '2026-01-01T00:00:00\.000'/);

  const rows = await macroRows(env.INPUTS_DB);
  assert.equal(rows.length, N_FRED + 3);
  assert.equal(rows.filter((r) => r.source === "fred").length, N_FRED);
  assert.equal(rows.filter((r) => r.source === "cftc").length, 3);

  const job = await getJob(env, "backfill-macro-1");
  assert.equal(job.status, "complete");
  assert.equal(job.type, "backfill_macro");
  assert.equal(job.percent, 100);
  assert.equal(job.params.from, "2026-01-01");
  assert.deepEqual(job.result, { fredCount: N_FRED, cotCount: 3, fredSkipped: false });
  assert.equal(job.detail, `Stored ${N_FRED} FRED + 3 COT rows from 2026-01-01`);
});

test("queue() backfill_macro is not gated on the feature:macro live flag (no flag row at all, and it still stores)", async (t) => {
  silenceLogs(t);
  const env = workerEnv(); // fresh LIVE_DB: the flag has never been set, which reads as OFF for live ticks
  mockVendors(t, { fred: okFred, cot: { body: [cotRow("2026-01-06")] } });

  const message = new FakeMessage({ type: "backfill_macro", id: "backfill-macro-2", from: "2026-01-01" });
  await worker.queue({ messages: [message] }, env);

  assert.ok((await macroRows(env.INPUTS_DB)).length > 0);
  assert.equal((await getJob(env, "backfill-macro-2")).status, "complete");
});

test("queue() backfill_macro runs ingestMacro in backfill mode: an older COT week keeps release-derived availability even though a recent week was already stored", async (t) => {
  silenceLogs(t);
  const env = workerEnv({ FRED_API_KEY: "" }); // COT only; also keeps the throttle off the frozen clock
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-14T13:45:00Z") });
  let cotBody = [cotRow("2026-09-29")];
  mockVendors(t, { cot: () => ({ body: cotBody }) });

  // a live (seeding) tick stored the latest week first
  await ingestMacro(loadConfig(env), env.INPUTS_DB, { asOf: "2026-10-14T13:45:00Z" });
  assert.equal((await macroRows(env.INPUTS_DB)).filter((r) => r.series === COT_SERIES.MM_LONG).length, 1);

  // then the operator backfills from January
  cotBody = [cotRow("2026-01-06"), cotRow("2026-09-29")];
  const message = new FakeMessage({ type: "backfill_macro", id: "backfill-macro-3", from: "2026-01-01" });
  await worker.queue({ messages: [message] }, env);

  const long = (await macroRows(env.INPUTS_DB)).filter((r) => r.series === COT_SERIES.MM_LONG);
  assert.deepEqual(
    long.map((r) => [r.obs_date, r.available_at]),
    [
      ["2026-01-06", cotAvailableAt("2026-01-06")], // release-derived, NOT first-seen-today (2026-10-15)
      ["2026-09-29", cotAvailableAt("2026-09-29")],
    ]
  );
  assert.equal((await getJob(env, "backfill-macro-3")).status, "complete");
});

// ---------------------------------------------------------------------------
// detail wording / partial runs
// ---------------------------------------------------------------------------

test("queue() backfill_macro: a failing COT half still completes the job on the FRED rows alone", async (t) => {
  silenceLogs(t);
  const env = workerEnv();
  mockVendors(t, { fred: okFred, cot: { status: 404 } });

  const message = new FakeMessage({ type: "backfill_macro", id: "backfill-macro-4", from: "2026-01-01" });
  await worker.queue({ messages: [message] }, env);

  const job = await getJob(env, "backfill-macro-4");
  assert.equal(job.status, "complete");
  assert.deepEqual(job.result, { fredCount: N_FRED, cotCount: 0, fredSkipped: false });
  assert.equal(job.detail, `Stored ${N_FRED} FRED + 0 COT rows from 2026-01-01`);
});

test("queue() backfill_macro: the detail is singular for exactly one stored row", async (t) => {
  silenceLogs(t);
  const env = workerEnv({ FRED_SERIES: "DFII10" });
  mockVendors(t, { fred: okFred, cot: { status: 404 } });

  const message = new FakeMessage({ type: "backfill_macro", id: "backfill-macro-5", from: "2026-01-01" });
  await worker.queue({ messages: [message] }, env);

  const job = await getJob(env, "backfill-macro-5");
  assert.equal(job.status, "complete");
  assert.equal(job.detail, "Stored 1 FRED + 0 COT row from 2026-01-01");
});

test("queue() backfill_macro without FRED_API_KEY makes no FRED request, stores COT, completes, and says FRED was skipped", async (t) => {
  silenceLogs(t);
  const env = workerEnv({ FRED_API_KEY: "" });
  const calls = mockVendors(t, { fred: okFred, cot: { body: [cotRow("2026-01-06")] } });

  const message = new FakeMessage({ type: "backfill_macro", id: "backfill-macro-6", from: "2026-01-01" });
  await worker.queue({ messages: [message] }, env);

  assert.equal(calls.fred.length, 0);
  assert.equal(message.acked, true);
  const job = await getJob(env, "backfill-macro-6");
  assert.equal(job.status, "complete");
  assert.deepEqual(job.result, { fredCount: 0, cotCount: 3, fredSkipped: true });
  assert.equal(job.detail, "Stored 0 FRED + 3 COT rows from 2026-01-01 (FRED skipped: no API key)");
});

// ---------------------------------------------------------------------------
// nothing stored = failed
// ---------------------------------------------------------------------------

test("queue() backfill_macro FAILS the job (not 'complete, 0 rows') when neither vendor stores anything, and still acks", async (t) => {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "warn", () => {});
  const errorLogs = [];
  t.mock.method(console, "error", (...args) => errorLogs.push(args));
  const env = workerEnv();
  mockVendors(t, { fred: { status: 404 }, cot: { status: 404 } });

  const message = new FakeMessage({ type: "backfill_macro", id: "backfill-macro-7", from: "2026-01-01" });
  await worker.queue({ messages: [message] }, env);

  assert.equal(message.acked, true, "no lasting state to retry into");
  assert.equal(message.retried, false);
  assert.equal((await macroRows(env.INPUTS_DB)).length, 0);
  const job = await getJob(env, "backfill-macro-7");
  assert.equal(job.status, "failed");
  assert.equal(job.error, "No macro rows stored from 2026-01-01 -- check the vendor logs");
  assert.ok(errorLogs.some(([msg]) => msg.includes("backfill_macro job failed")));
});

test("queue() backfill_macro: a missing FRED key plus a failing COT is a failure that names the missing key", async (t) => {
  silenceLogs(t);
  const env = workerEnv({ FRED_API_KEY: "" });
  const calls = mockVendors(t, { fred: okFred, cot: { status: 404 } });

  const message = new FakeMessage({ type: "backfill_macro", id: "backfill-macro-8", from: "2026-01-01" });
  await worker.queue({ messages: [message] }, env);

  assert.equal(calls.fred.length, 0);
  assert.equal(message.acked, true);
  const job = await getJob(env, "backfill-macro-8");
  assert.equal(job.status, "failed");
  assert.equal(job.error, "No macro rows stored from 2026-01-01 (FRED skipped: FRED_API_KEY is not set) -- check the vendor logs");
});

// ---------------------------------------------------------------------------
// best-effort progress
// ---------------------------------------------------------------------------

test("queue() backfill_macro still stores the rows and acks when LIVE_DB (the progress store) is down -- progress is best-effort", async (t) => {
  silenceLogs(t);
  const env = workerEnv({ LIVE_DB: new BrokenDb() });
  mockVendors(t, { fred: okFred, cot: { body: [cotRow("2026-01-06")] } });

  const message = new FakeMessage({ type: "backfill_macro", id: "backfill-macro-9", from: "2026-01-01" });
  await worker.queue({ messages: [message] }, env);

  assert.equal((await macroRows(env.INPUTS_DB)).length, N_FRED + 3, "the backfill itself is unaffected");
  assert.equal(message.acked, true);
  assert.equal(message.retried, false);
});
