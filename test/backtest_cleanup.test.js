// Covers src/backtest/cleanup.js#cleanupFailedRun: a FAILED backtest run's
// data is deleted, its error trail (registry row, errored llm_calls, the one
// job_progress row) is kept, and it is best-effort -- guarded, bounded, and
// never throws. Real sqlite SIM_DB (state + sim schema).

import test from "node:test";
import assert from "node:assert/strict";
import { cleanupFailedRun } from "../src/backtest/cleanup.js";
import { RunStore } from "../src/storage/run_store.js";
import { insertBacktestRun, failBacktestRun, completeBacktestRun } from "../src/storage/sim_registry.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { STATE_DIR, SIM_DIR } from "./helpers/engine_ctx.js";

function thesisArgs(id, ticker, asOf) {
  return {
    id, ticker, tradeThesisId: id, positionSizePct: 0.05, direction: "long", entryPrice: 100, stopLossPct: 0.03, takeProfitPct: 0.06, asOf,
    thesis: { ticker, asOf, direction: "long" }, riskDecision: { approved: true, positionSizePct: 0.05 }, createdAt: asOf,
  };
}

async function registryRow(db, id, status) {
  await insertBacktestRun(db, { id, tickers: ["AAPL"], testStart: "2026-01-01", testEnd: "2026-01-03", trainDays: 0, testDays: 2, startedAt: "2026-01-04T00:00:00.000Z" });
  if (status === "failed") await failBacktestRun(db, { id, error: "boom [while processing AAPL 2026-01-02]", finishedAt: "2026-01-04T00:01:00.000Z" });
  if (status === "complete") await completeBacktestRun(db, { id, result: { ok: true }, finishedAt: "2026-01-04T00:01:00.000Z" });
}

/** Data + error trail for one run: `positions` positions (distinct tickers), one ok + one errored llm_call, one job_progress row. */
async function seedRun(db, id, { positions = 1 } = {}) {
  const store = new RunStore(db, id);
  for (let i = 0; i < positions; i++) await store.commitThesis(thesisArgs(`T${i}|t1`, `T${i}`, "t1"));
  await db.prepare(`INSERT INTO llm_calls (env_run_id, created_at, source, label, status) VALUES (?, 't1', 'backtest', 'trader', 'ok')`).bind(id).run();
  await db.prepare(`INSERT INTO llm_calls (env_run_id, created_at, source, label, status, error) VALUES (?, 't2', 'backtest', 'trader', 'error', 'boom')`).bind(id).run();
  await db.prepare(`INSERT INTO job_progress (run_id, id, type, status, created_at, updated_at) VALUES (?, ?, 'backtest', 'failed', 't1', 't2')`).bind(id, id).run();
  return store;
}

async function count(db, table, id, col = "run_id") {
  return (await db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${col} = ?`).bind(id).first()).c;
}

const DATA_TABLES = ["positions", "trade_decisions", "decision_memory", "pipeline_checkpoints"];

test("cleanupFailedRun deletes a failed run's data but keeps the registry row, the errored llm_calls and the job_progress row; other runs are untouched", async () => {
  const db = createTestD1([STATE_DIR, SIM_DIR]);
  await registryRow(db, "bt-1", "failed");
  await registryRow(db, "bt-2", "failed");
  const store = await seedRun(db, "bt-1", { positions: 3 });
  await seedRun(db, "bt-2", { positions: 2 });

  const out = await cleanupFailedRun(db, store, "bt-1");
  assert.equal(out.complete, true);
  assert.ok(out.deleted > 0);

  for (const t of DATA_TABLES) assert.equal(await count(db, t, "bt-1"), 0, `${t} deleted`);
  assert.deepEqual((await db.prepare(`SELECT status FROM llm_calls WHERE env_run_id = 'bt-1'`).all()).results.map((r) => r.status), ["error"]);
  assert.equal(await count(db, "job_progress", "bt-1"), 1);
  const reg = await db.prepare(`SELECT status, error FROM backtest_runs WHERE id = 'bt-1'`).first();
  assert.equal(reg.status, "failed");
  assert.match(reg.error, /while processing AAPL/);

  // bt-2 untouched.
  assert.equal(await count(db, "positions", "bt-2"), 2);
  assert.equal(await count(db, "llm_calls", "bt-2", "env_run_id"), 2);
  assert.equal(await count(db, "job_progress", "bt-2"), 1);
});

test("cleanupFailedRun NEVER touches a complete or still-running run, or one with no registry row", async () => {
  const db = createTestD1([STATE_DIR, SIM_DIR]);
  await registryRow(db, "done", "complete");
  await registryRow(db, "going", "running");
  const done = await seedRun(db, "done");
  const going = await seedRun(db, "going");
  const ghost = await seedRun(db, "ghost");

  for (const [store, id] of [[done, "done"], [going, "going"], [ghost, "ghost"]]) {
    const out = await cleanupFailedRun(db, store, id);
    assert.equal(out.deleted, 0, id);
    assert.equal(out.complete, false, id);
    assert.ok(out.skipped, id);
    assert.equal(await count(db, "positions", id), 1, `${id}: data intact`);
    assert.equal(await count(db, "llm_calls", id, "env_run_id"), 2, `${id}: llm_calls intact`);
  }
});

test("cleanupFailedRun refuses 'live' and a store/id mismatch (checked before any query)", async () => {
  const db = createTestD1([STATE_DIR, SIM_DIR]);
  await registryRow(db, "live", "failed"); // even a (nonsensical) failed 'live' registry row must not unlock deletion
  const live = new RunStore(db, "live");
  await live.commitThesis(thesisArgs("AAPL|t1", "AAPL", "t1"));
  let attempts = 0;
  const realDelete = live.deleteRun.bind(live);
  live.deleteRun = (...a) => { attempts++; return realDelete(...a); };
  assert.equal((await cleanupFailedRun(db, live, "live")).deleted, 0);
  assert.equal(attempts, 0, "the guard stops it before deleteRun is even attempted (deleteRun's own refusal is a second layer, not the first)");
  assert.equal(await count(db, "positions", "live"), 1);

  await registryRow(db, "bt-1", "failed");
  await registryRow(db, "bt-2", "failed");
  const other = await seedRun(db, "bt-2");
  const out = await cleanupFailedRun(db, other, "bt-1"); // store scoped to bt-2, asked to clean bt-1
  assert.equal(out.deleted, 0);
  assert.equal(await count(db, "positions", "bt-2"), 1);
});

test("cleanupFailedRun reports complete:false when maxChunks cuts it short, leaves leftovers, and a later call finishes the job", async (t) => {
  const db = createTestD1([STATE_DIR, SIM_DIR]);
  await registryRow(db, "bt-1", "failed");
  const store = await seedRun(db, "bt-1", { positions: 5 });
  const warn = t.mock.method(console, "warn", () => {});

  const cut = await cleanupFailedRun(db, store, "bt-1", { limit: 1, maxChunks: 2 });
  assert.equal(cut.complete, false);
  assert.ok(cut.deleted > 0);
  assert.ok((await count(db, "positions", "bt-1")) > 0, "leftover rows remain");
  assert.equal(warn.mock.callCount(), 1, "the cut-short is logged");

  const finish = await cleanupFailedRun(db, store, "bt-1", { limit: 500 });
  assert.equal(finish.complete, true);
  assert.equal(await count(db, "positions", "bt-1"), 0);
});

test("cleanupFailedRun never throws: a DB error mid-cleanup is logged and reported, with the partial count", async (t) => {
  const db = createTestD1([STATE_DIR, SIM_DIR]);
  await registryRow(db, "bt-1", "failed");
  const store = await seedRun(db, "bt-1");
  const warn = t.mock.method(console, "warn", () => {});
  let calls = 0;
  const real = store.deleteRun.bind(store);
  store.deleteRun = async (opts) => {
    if (++calls === 2) throw new Error("simulated D1 outage");
    return real(opts);
  };

  const out = await cleanupFailedRun(db, store, "bt-1");
  assert.equal(out.complete, false);
  assert.ok(out.deleted > 0, "the first chunk's count is kept");
  assert.match(out.skipped, /simulated D1 outage/);
  assert.equal(warn.mock.callCount(), 1);

  // And a registry read that throws is swallowed too.
  const broken = { prepare() { throw new Error("registry down"); } };
  await assert.doesNotReject(() => cleanupFailedRun(broken, store, "bt-1"));
});
