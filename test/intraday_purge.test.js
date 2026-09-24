// Covers ingestion/intraday_purge.js#purgeOldIntradayBars (plan.md finding G,
// step 6): retention-window deletion, chunked deletes, and gating on an
// active (queued/running) backtest via SIM_DB's job_progress. Against REAL
// sqlite inputs/state+sim DBs (migrations/inputs/, migrations/state/,
// migrations/sim/).

import test from "node:test";
import assert from "node:assert/strict";
import { purgeOldIntradayBars } from "../src/ingestion/intraday_purge.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { INPUTS_DIR, STATE_DIR, SIM_DIR } from "./helpers/engine_ctx.js";

const newInputsDb = () => createTestD1([INPUTS_DIR]);
const newSimDb = () => createTestD1([STATE_DIR, SIM_DIR]);

async function putBar(db, ticker, ts, close = 100) {
  await db
    .prepare("INSERT INTO price_bars_intraday (ticker, ts, open, high, low, close, volume, source, ingested_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(ticker, ts, close, close, close, close, 100, "alpaca", "2026-01-01T00:00:00Z")
    .run();
}

async function insertJobProgress(simDb, { id = "backtest-1", type = "backtest", status = "running", updatedAt }) {
  await simDb
    .prepare(
      `INSERT INTO job_progress (run_id, id, type, status, percent, done, total, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?)`
    )
    .bind(id, id, type, status, updatedAt, updatedAt)
    .run();
}

test("deletes rows older than the retention window, keeps rows within it", async () => {
  const inputsDb = newInputsDb();
  const simDb = newSimDb();
  const now = new Date("2026-07-01T00:00:00Z");

  await putBar(inputsDb, "AAPL", "2026-01-01T00:00:00Z"); // ~181 days old -- older than 180
  await putBar(inputsDb, "AAPL", "2026-06-01T00:00:00Z"); // ~30 days old -- within window

  const result = await purgeOldIntradayBars(inputsDb, simDb, { retentionDays: 180, now });
  assert.equal(result.skipped, false);
  assert.equal(result.deleted, 1);

  const { results } = await inputsDb.prepare("SELECT ts FROM price_bars_intraday").all();
  assert.deepEqual(results.map((r) => r.ts), ["2026-06-01T00:00:00Z"]);
});

test("skips entirely when a backtest is queued or running -- deletes nothing", async () => {
  const inputsDb = newInputsDb();
  const simDb = newSimDb();
  const now = new Date("2026-07-01T00:00:00Z");
  await putBar(inputsDb, "AAPL", "2026-01-01T00:00:00Z");
  await insertJobProgress(simDb, { id: "backtest-active", status: "running", updatedAt: now.toISOString() });

  const result = await purgeOldIntradayBars(inputsDb, simDb, { retentionDays: 180, now });
  assert.equal(result.skipped, true);
  assert.match(result.reason, /backtest-active/);
  assert.equal(result.deleted, 0);

  const { results } = await inputsDb.prepare("SELECT COUNT(*) AS n FROM price_bars_intraday").all();
  assert.equal(results[0].n, 1, "nothing was deleted");
});

test("a terminal (complete/failed/cancelled) job does NOT gate the purge -- only queued/running does", async () => {
  const inputsDb = newInputsDb();
  const simDb = newSimDb();
  const now = new Date("2026-07-01T00:00:00Z");
  await putBar(inputsDb, "AAPL", "2026-01-01T00:00:00Z");
  await insertJobProgress(simDb, { id: "backtest-done", status: "complete", updatedAt: now.toISOString() });

  const result = await purgeOldIntradayBars(inputsDb, simDb, { retentionDays: 180, now });
  assert.equal(result.skipped, false);
  assert.equal(result.deleted, 1);
});

test("chunked delete: more than one chunk's worth of stale rows still all get deleted across chunks", async () => {
  const inputsDb = newInputsDb();
  const simDb = newSimDb();
  const now = new Date("2026-07-01T00:00:00Z");
  for (let i = 0; i < 25; i++) {
    await putBar(inputsDb, "AAPL", new Date(Date.parse("2026-01-01T00:00:00Z") + i * 60_000).toISOString());
  }

  const result = await purgeOldIntradayBars(inputsDb, simDb, { retentionDays: 180, chunkSize: 10, maxChunks: 20, now });
  assert.equal(result.deleted, 25);
  assert.equal(result.chunks, 3, "10 + 10 + 5");

  const { results } = await inputsDb.prepare("SELECT COUNT(*) AS n FROM price_bars_intraday").all();
  assert.equal(results[0].n, 0);
});

test("maxChunks caps one call's work -- remaining stale rows are left for the next scheduled call, not abandoned", async () => {
  const inputsDb = newInputsDb();
  const simDb = newSimDb();
  const now = new Date("2026-07-01T00:00:00Z");
  for (let i = 0; i < 25; i++) {
    await putBar(inputsDb, "AAPL", new Date(Date.parse("2026-01-01T00:00:00Z") + i * 60_000).toISOString());
  }

  const result = await purgeOldIntradayBars(inputsDb, simDb, { retentionDays: 180, chunkSize: 10, maxChunks: 2, now });
  assert.equal(result.deleted, 20, "capped at 2 chunks x 10");
  assert.equal(result.chunks, 2);

  const remaining = await inputsDb.prepare("SELECT COUNT(*) AS n FROM price_bars_intraday").first();
  assert.equal(remaining.n, 5, "the rest is still there for a later purge call");

  // A follow-up call finishes the job.
  const second = await purgeOldIntradayBars(inputsDb, simDb, { retentionDays: 180, chunkSize: 10, maxChunks: 20, now });
  assert.equal(second.deleted, 5);
});

test("rejects a non-positive retentionDays rather than silently deleting everything", async () => {
  const inputsDb = newInputsDb();
  const simDb = newSimDb();
  await assert.rejects(() => purgeOldIntradayBars(inputsDb, simDb, { retentionDays: 0 }), /retentionDays/);
  await assert.rejects(() => purgeOldIntradayBars(inputsDb, simDb, { retentionDays: -5 }), /retentionDays/);
});
