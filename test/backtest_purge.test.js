// Covers src/backtest/cleanup.js#purgeFailedAndCancelledRuns and its two
// sim_registry.js helpers (getFailedOrCancelledBacktestRuns,
// deleteFailedOrCancelledBacktestRun): the one cleanup path that removes the
// backtest_runs registry row itself, not just a run's state-table data --
// see cleanup.js's own header comment on this function for why that's safe
// here (failed/cancelled only) but never done for a complete run. Real
// sqlite SIM_DB (state + sim schema), same convention as
// backtest_cleanup.test.js.

import test from "node:test";
import assert from "node:assert/strict";
import { purgeFailedAndCancelledRuns } from "../src/backtest/cleanup.js";
import { RunStore } from "../src/storage/run_store.js";
import { insertBacktestRun, failBacktestRun, cancelBacktestRun, completeBacktestRun, getFailedOrCancelledBacktestRuns, deleteFailedOrCancelledBacktestRun } from "../src/storage/sim_registry.js";
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
  if (status === "failed") await failBacktestRun(db, { id, error: "boom", finishedAt: "2026-01-04T00:01:00.000Z" });
  if (status === "cancelled") await cancelBacktestRun(db, { id, finishedAt: "2026-01-04T00:01:00.000Z" });
  if (status === "complete") await completeBacktestRun(db, { id, result: { ok: true }, finishedAt: "2026-01-04T00:01:00.000Z" });
  // "running" is insertBacktestRun's own default status -- nothing more to do.
}

/** Data + error trail for one run: `positions` positions, one ok + one errored llm_call, one job_progress row. */
async function seedRun(db, id, { positions = 1 } = {}) {
  const store = new RunStore(db, id);
  for (let i = 0; i < positions; i++) await store.commitThesis(thesisArgs(`T${i}|t1`, `T${i}`, "t1"));
  await db.prepare(`INSERT INTO llm_calls (env_run_id, created_at, source, label, status) VALUES (?, 't1', 'backtest', 'trader', 'ok')`).bind(id).run();
  await db.prepare(`INSERT INTO llm_calls (env_run_id, created_at, source, label, status, error) VALUES (?, 't2', 'backtest', 'trader', 'error', 'boom')`).bind(id).run();
  await db.prepare(`INSERT INTO job_progress (run_id, id, type, status, created_at, updated_at) VALUES (?, ?, 'backtest', ?, 't1', 't2')`).bind(id, id, "failed").run();
  return store;
}

async function count(db, table, id, col = "run_id") {
  return (await db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${col} = ?`).bind(id).first()).c;
}

const DATA_TABLES = ["positions", "trade_decisions", "decision_memory", "pipeline_checkpoints"];

test("getFailedOrCancelledBacktestRuns lists only failed/cancelled rows, oldest first, never complete or running", async () => {
  const db = createTestD1([STATE_DIR, SIM_DIR]);
  await registryRow(db, "done", "complete");
  await registryRow(db, "going", "running");
  await registryRow(db, "bad-1", "failed");
  await registryRow(db, "bad-2", "cancelled");

  const rows = await getFailedOrCancelledBacktestRuns(db, { limit: 20 });
  assert.deepEqual(rows.map((r) => r.id).sort(), ["bad-1", "bad-2"]);
  assert.deepEqual(new Set(rows.map((r) => r.status)), new Set(["failed", "cancelled"]));
});

test("deleteFailedOrCancelledBacktestRun deletes only when status is failed/cancelled, and reports whether it changed anything", async () => {
  const db = createTestD1([STATE_DIR, SIM_DIR]);
  await registryRow(db, "bad-1", "failed");
  await registryRow(db, "done", "complete");
  await registryRow(db, "going", "running");

  assert.equal(await deleteFailedOrCancelledBacktestRun(db, "done"), false, "a complete row is never deleted");
  assert.equal(await deleteFailedOrCancelledBacktestRun(db, "going"), false, "a running row is never deleted");
  assert.ok(await db.prepare(`SELECT 1 FROM backtest_runs WHERE id = 'done'`).first());
  assert.ok(await db.prepare(`SELECT 1 FROM backtest_runs WHERE id = 'going'`).first());

  assert.equal(await deleteFailedOrCancelledBacktestRun(db, "bad-1"), true);
  assert.equal(await db.prepare(`SELECT 1 FROM backtest_runs WHERE id = 'bad-1'`).first(), null);
  assert.equal(await deleteFailedOrCancelledBacktestRun(db, "bad-1"), false, "already gone -- a second call changes nothing");
});

test("purgeFailedAndCancelledRuns deletes a failed run's data, ALL its llm_calls (errored ones too), job_progress, AND the registry row", async () => {
  const db = createTestD1([STATE_DIR, SIM_DIR]);
  await registryRow(db, "bt-1", "failed");
  await seedRun(db, "bt-1", { positions: 3 });

  const out = await purgeFailedAndCancelledRuns(db);
  assert.equal(out.scanned, 1);
  assert.equal(out.purged, 1);
  assert.ok(out.totalDeleted > 0);
  assert.deepEqual(out.processed, [{ id: "bt-1", status: "failed", deleted: out.totalDeleted, complete: true, purged: true }]);

  for (const t of DATA_TABLES) assert.equal(await count(db, t, "bt-1"), 0, `${t} deleted`);
  assert.equal(await count(db, "llm_calls", "bt-1", "env_run_id"), 0, "errored llm_calls are ALSO gone, unlike cleanupFailedRun");
  assert.equal(await count(db, "job_progress", "bt-1"), 0);
  assert.equal(await db.prepare(`SELECT 1 FROM backtest_runs WHERE id = 'bt-1'`).first(), null, "registry row is gone too");
});

test("purgeFailedAndCancelledRuns handles a cancelled run the same way as a failed one", async () => {
  const db = createTestD1([STATE_DIR, SIM_DIR]);
  await registryRow(db, "bt-1", "cancelled");
  await seedRun(db, "bt-1", { positions: 1 });

  const out = await purgeFailedAndCancelledRuns(db);
  assert.equal(out.purged, 1);
  assert.equal(await count(db, "positions", "bt-1"), 0);
  assert.equal(await db.prepare(`SELECT 1 FROM backtest_runs WHERE id = 'bt-1'`).first(), null);
});

test("purgeFailedAndCancelledRuns NEVER touches a complete or running run, and refuses a 'live' row even if somehow marked failed/cancelled", async () => {
  const db = createTestD1([STATE_DIR, SIM_DIR]);
  await registryRow(db, "done", "complete");
  await registryRow(db, "going", "running");
  await seedRun(db, "done", { positions: 1 });
  await seedRun(db, "going", { positions: 1 });
  // A nonsensical 'live'-id failed row must never be purged (cleanup.js's own guard).
  await registryRow(db, "live", "failed");
  await seedRun(db, "live", { positions: 1 });

  const out = await purgeFailedAndCancelledRuns(db);
  assert.equal(out.scanned, 1, "only 'live' was ever a failed/cancelled candidate");
  assert.equal(out.purged, 0);
  assert.equal(out.processed[0].skipped, "refuses the live run");

  assert.equal(await count(db, "positions", "done"), 1);
  assert.equal(await count(db, "positions", "going"), 1);
  assert.equal(await count(db, "positions", "live"), 1);
  assert.ok(await db.prepare(`SELECT 1 FROM backtest_runs WHERE id = 'live'`).first(), "live's registry row is untouched");
});

test("purgeFailedAndCancelledRuns is bounded by maxRuns and best-effort per run: one run's DB error never stops the rest", async (t) => {
  const db = createTestD1([STATE_DIR, SIM_DIR]);
  await registryRow(db, "bad-1", "failed");
  await registryRow(db, "bad-2", "failed");
  await registryRow(db, "bad-3", "cancelled");
  await seedRun(db, "bad-1", { positions: 1 });
  await seedRun(db, "bad-2", { positions: 1 });
  await seedRun(db, "bad-3", { positions: 1 });

  const limited = await purgeFailedAndCancelledRuns(db, { maxRuns: 2 });
  assert.equal(limited.scanned, 2, "maxRuns caps how many candidates are even listed");
  assert.equal(limited.purged, 2);
  assert.ok(await db.prepare(`SELECT 1 FROM backtest_runs WHERE id = 'bad-3'`).first(), "bad-3 wasn't touched this call");

  // A later call with no cap finishes the rest.
  const rest = await purgeFailedAndCancelledRuns(db);
  assert.equal(rest.scanned, 1);
  assert.equal(rest.purged, 1);
  assert.equal(await db.prepare(`SELECT 1 FROM backtest_runs WHERE id = 'bad-3'`).first(), null);
});

test("purgeFailedAndCancelledRuns never throws: a listing failure is logged and reported with empty results", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const broken = { prepare() { throw new Error("registry down"); } };

  const out = await purgeFailedAndCancelledRuns(broken);
  assert.deepEqual(out, { processed: [], purged: 0, totalDeleted: 0, scanned: 0, error: "registry down" });
  assert.equal(warn.mock.callCount(), 1);
});
