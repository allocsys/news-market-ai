// Covers src/storage/run_store.js against a REAL sqlite-backed D1 (see
// test/helpers/sqlite_d1.js), not a hand-written fake -- this is what lets
// these tests actually exercise the SQL in commitThesis's WHERE-predicate
// guards and the partial unique index backstop, not just that RunStore
// issued the query text we expected it to.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { RunStore, readOnly } from "../src/storage/run_store.js";
import { LookaheadViolationError } from "../src/shared/errors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, "..", "migrations", "state");
const SIM_DIR = path.join(__dirname, "..", "migrations", "sim");

function liveDb() {
  return createTestD1([STATE_DIR]);
}

function simDb() {
  return createTestD1([STATE_DIR, SIM_DIR]);
}

function thesisArgs({ id, ticker, asOf, positionSizePct = 0.05 }) {
  return {
    id,
    ticker,
    tradeThesisId: id,
    positionSizePct,
    direction: "long",
    entryPrice: 100,
    stopLossPct: 0.03,
    takeProfitPct: 0.06,
    asOf,
    thesis: { ticker, asOf, direction: "long" },
    riskDecision: { approved: true, positionSizePct },
    createdAt: asOf,
  };
}

test("RunStore requires a runId", () => {
  assert.throws(() => new RunStore(liveDb(), undefined), /requires a runId/);
});

test("asOf-gated reads throw LookaheadViolationError when asOf is missing", async () => {
  const store = new RunStore(liveDb(), "live");
  await assert.rejects(() => store.getOpenPositionsAsOf({}), LookaheadViolationError);
  await assert.rejects(() => store.getOpenPositionForTickerAsOf({ ticker: "AAPL" }), LookaheadViolationError);
  await assert.rejects(() => store.getOpenPositionsRiskPctAsOf({}), LookaheadViolationError);
  await assert.rejects(() => store.getDecisionMemoryAsOf({ ticker: "AAPL" }), LookaheadViolationError);
  await assert.rejects(() => store.getRealizedReturnsInRange({ ticker: "AAPL", from: "2026-01-01" }), LookaheadViolationError);
  await assert.rejects(() => store.commitThesis({ ...thesisArgs({ id: "x", ticker: "AAPL" }), asOf: undefined }), LookaheadViolationError);
});

test("commitThesis opens a fresh position and records status 'opened'", async () => {
  const store = new RunStore(liveDb(), "live");
  await store.commitThesis(thesisArgs({ id: "AAPL|t1", ticker: "AAPL", asOf: "t1" }));

  const open = await store.getOpenPositionForTickerAsOf({ ticker: "AAPL", asOf: "t1" });
  assert.equal(open.id, "AAPL|t1");
  assert.equal(open.positionSizePct, 0.05);

  const decisions = await store.db
    .prepare(`SELECT status FROM trade_decisions WHERE run_id = 'live' AND id = 'AAPL|t1'`)
    .first();
  assert.equal(decisions.status, "opened");
});

test("commitThesis replaces an older open position for the same ticker (in-order asOf)", async () => {
  const store = new RunStore(liveDb(), "live");
  await store.commitThesis(thesisArgs({ id: "AAPL|t1", ticker: "AAPL", asOf: "t1" }));
  await store.commitThesis(thesisArgs({ id: "AAPL|t2", ticker: "AAPL", asOf: "t2" }));

  const old = await store.db.prepare(`SELECT closed_at, close_reason FROM positions WHERE run_id='live' AND id='AAPL|t1'`).first();
  assert.equal(old.close_reason, "replaced");
  assert.ok(old.closed_at);

  const current = await store.getOpenPositionForTickerAsOf({ ticker: "AAPL", asOf: "t2" });
  assert.equal(current.id, "AAPL|t2");
});

test("commitThesis with an out-of-order (late-arriving, older) asOf is superseded, not applied", async () => {
  const store = new RunStore(liveDb(), "live");
  // t2 (newer) commits first -- e.g. its pipeline run finished before t1's.
  await store.commitThesis(thesisArgs({ id: "AAPL|t2", ticker: "AAPL", asOf: "t2" }));
  // t1 (older) arrives late.
  await store.commitThesis(thesisArgs({ id: "AAPL|t1", ticker: "AAPL", asOf: "t1" }));

  // The late t1 thesis must never have opened a position or closed t2's.
  const t1Position = await store.db.prepare(`SELECT * FROM positions WHERE run_id='live' AND id='AAPL|t1'`).first();
  assert.equal(t1Position, null);

  const t2Position = await store.db.prepare(`SELECT closed_at FROM positions WHERE run_id='live' AND id='AAPL|t2'`).first();
  assert.equal(t2Position.closed_at, null, "the newer position must still be open");

  const t1Decision = await store.db.prepare(`SELECT status FROM trade_decisions WHERE run_id='live' AND id='AAPL|t1'`).first();
  assert.equal(t1Decision.status, "superseded");

  const current = await store.getOpenPositionForTickerAsOf({ ticker: "AAPL", asOf: "t2" });
  assert.equal(current.id, "AAPL|t2", "still open and untouched");
});

test("commitThesis rejects a thesis that would breach the portfolio risk ceiling (other tickers' exposure)", async () => {
  const store = new RunStore(liveDb(), "live");
  // Fill most of the 0.20 ceiling with two other tickers.
  await store.commitThesis(thesisArgs({ id: "MSFT|t1", ticker: "MSFT", asOf: "t1", positionSizePct: 0.09 }));
  await store.commitThesis(thesisArgs({ id: "GOOG|t1", ticker: "GOOG", asOf: "t1", positionSizePct: 0.09 }));

  // 0.09 + 0.09 + 0.05 = 0.23 > 0.20 -- should be rejected.
  await store.commitThesis(thesisArgs({ id: "AAPL|t1", ticker: "AAPL", asOf: "t1", positionSizePct: 0.05 }));

  const aapl = await store.db.prepare(`SELECT * FROM positions WHERE run_id='live' AND id='AAPL|t1'`).first();
  assert.equal(aapl, null, "no position should have been opened");

  const decision = await store.db.prepare(`SELECT status FROM trade_decisions WHERE run_id='live' AND id='AAPL|t1'`).first();
  assert.equal(decision.status, "rejected");

  // A smaller thesis that fits under the ceiling still opens fine.
  await store.commitThesis(thesisArgs({ id: "AAPL|t2", ticker: "AAPL", asOf: "t2", positionSizePct: 0.01 }));
  const openedDecision = await store.db.prepare(`SELECT status FROM trade_decisions WHERE run_id='live' AND id='AAPL|t2'`).first();
  assert.equal(openedDecision.status, "opened");
});

test("a ticker's own replaced position is not double-counted against the ceiling (2026-09-19 decision)", async () => {
  const store = new RunStore(liveDb(), "live");
  // AAPL alone occupies almost the whole ceiling.
  await store.commitThesis(thesisArgs({ id: "AAPL|t1", ticker: "AAPL", asOf: "t1", positionSizePct: 0.19 }));
  // Re-evaluating AAPL again (replacing its own position) at the same size must NOT be
  // rejected for "double counting" its own existing exposure.
  await store.commitThesis(thesisArgs({ id: "AAPL|t2", ticker: "AAPL", asOf: "t2", positionSizePct: 0.19 }));

  const decision = await store.db.prepare(`SELECT status FROM trade_decisions WHERE run_id='live' AND id='AAPL|t2'`).first();
  assert.equal(decision.status, "opened");
});

test("the partial unique index backstops commitThesis: a bypassed guard still can't double-open", async () => {
  const store = new RunStore(liveDb(), "live");
  await store.openPosition({ id: "AAPL|t1", ticker: "AAPL", tradeThesisId: "AAPL|t1", positionSizePct: 0.05, openedAt: "t1" });
  // Bypassing commitThesis entirely and trying to open a second concurrent AAPL position directly.
  await assert.rejects(
    () => store.openPosition({ id: "AAPL|t2", ticker: "AAPL", tradeThesisId: "AAPL|t2", positionSizePct: 0.05, openedAt: "t1" }),
    /UNIQUE constraint/
  );
});

test("interleaved commits for two DIFFERENT tickers at the same asOf both succeed independently (no false serialization)", async () => {
  const store = new RunStore(liveDb(), "live");
  await Promise.all([
    store.commitThesis(thesisArgs({ id: "AAPL|t1", ticker: "AAPL", asOf: "t1", positionSizePct: 0.05 })),
    store.commitThesis(thesisArgs({ id: "MSFT|t1", ticker: "MSFT", asOf: "t1", positionSizePct: 0.05 })),
  ]);

  const aapl = await store.getOpenPositionForTickerAsOf({ ticker: "AAPL", asOf: "t1" });
  const msft = await store.getOpenPositionForTickerAsOf({ ticker: "MSFT", asOf: "t1" });
  assert.equal(aapl.id, "AAPL|t1");
  assert.equal(msft.id, "MSFT|t1");
});

test("two 'concurrent' commits for the SAME ticker serialize through one batch each -- exactly one wins as 'opened'", async () => {
  // node:sqlite is synchronous under the hood, so this can't reproduce a
  // true multi-writer race the way Cloudflare's real D1 might -- what it
  // does prove is that RunStore's own batch is atomic and self-consistent
  // even when two commits for the same ticker are issued back-to-back
  // without waiting on each other, which is the property plan.md's
  // "concurrent same-ticker commits" test asks for at the SQL-logic level.
  // The cross-Worker-writer-serialization question itself stays open per
  // plan.md ("the M1 concurrency tests are the proof; the partial unique
  // index is the backstop") pending a real deployment to verify against.
  const store = new RunStore(liveDb(), "live");
  await Promise.all([
    store.commitThesis(thesisArgs({ id: "AAPL|t1", ticker: "AAPL", asOf: "t1", positionSizePct: 0.05 })),
    store.commitThesis(thesisArgs({ id: "AAPL|t1b", ticker: "AAPL", asOf: "t1", positionSizePct: 0.05 })),
  ]);

  const openCount = await store.db.prepare(`SELECT COUNT(*) AS c FROM positions WHERE run_id='live' AND ticker='AAPL' AND closed_at IS NULL`).first();
  assert.equal(openCount.c, 1, "the unique index guarantees at most one open position survives");
});

test("commitThesis issues exactly 3 prepared statements per call (measured locally; see header re: the 50/invocation cap)", async () => {
  const raw = liveDb();
  let prepareCount = 0;
  const counting = {
    prepare(sql) {
      prepareCount++;
      return raw.prepare(sql);
    },
    batch: (...args) => raw.batch(...args),
  };
  const store = new RunStore(counting, "live");
  await store.commitThesis(thesisArgs({ id: "AAPL|t1", ticker: "AAPL", asOf: "t1" }));
  assert.equal(prepareCount, 3, "commitThesis must stay at 3 statements per plan.md's 50-query/invocation budget note");
});

test("run isolation: two different runIds never see each other's positions or decisions", async () => {
  const db = liveDb();
  const live = new RunStore(db, "live");
  const backtest = new RunStore(db, "bt-2026-09-19-abc");

  await live.commitThesis(thesisArgs({ id: "AAPL|t1", ticker: "AAPL", asOf: "t1" }));
  await backtest.commitThesis(thesisArgs({ id: "AAPL|t1", ticker: "AAPL", asOf: "t1" }));

  const livePos = await live.getOpenPositionForTickerAsOf({ ticker: "AAPL", asOf: "t1" });
  const btPos = await backtest.getOpenPositionForTickerAsOf({ ticker: "AAPL", asOf: "t1" });
  assert.equal(livePos.id, "AAPL|t1");
  assert.equal(btPos.id, "AAPL|t1");
  // Same id string, but genuinely two independent rows -- closing one must not touch the other.
  await live.closePosition({ id: "AAPL|t1", closedAt: "t2", closeReason: "time_based" });

  const liveAfter = await live.getOpenPositionForTickerAsOf({ ticker: "AAPL", asOf: "t2" });
  const btAfter = await backtest.getOpenPositionForTickerAsOf({ ticker: "AAPL", asOf: "t2" });
  assert.equal(liveAfter, null, "live position was closed");
  assert.ok(btAfter, "backtest's identically-id'd position is untouched");
});

test("checkpoints: saveCheckpoint/getCheckpoint are run_id-scoped and pipelineRunId-keyed (distinct from the environment runId)", async () => {
  const db = liveDb();
  const live = new RunStore(db, "live");
  const backtest = new RunStore(db, "bt-1");

  await live.saveCheckpoint({ pipelineRunId: "news-item-42", ticker: "AAPL", stage: "analyzed", state: { foo: 1 } });
  await backtest.saveCheckpoint({ pipelineRunId: "news-item-42", ticker: "AAPL", stage: "debated", state: { foo: 2 } });

  const liveCkpt = await live.getCheckpoint({ pipelineRunId: "news-item-42", ticker: "AAPL" });
  const btCkpt = await backtest.getCheckpoint({ pipelineRunId: "news-item-42", ticker: "AAPL" });
  assert.equal(liveCkpt.stage, "analyzed");
  assert.equal(btCkpt.stage, "debated");
  assert.deepEqual(liveCkpt.state, { foo: 1 });

  const missing = await live.getCheckpoint({ pipelineRunId: "nope", ticker: "AAPL" });
  assert.equal(missing, null);
});

test("decision memory is run_id-scoped and asOf-gated (strictly before)", async () => {
  const store = new RunStore(liveDb(), "live");
  await store.recordDecisionOutcome({ id: "m1", decisionId: "AAPL|t1", ticker: "AAPL", realizedReturn: 0.02, alphaReturn: 0.01, reflection: "worked out", resolvedAt: "t5" });

  const before = await store.getDecisionMemoryAsOf({ ticker: "AAPL", asOf: "t5" });
  assert.equal(before.length, 0, "resolved_at < asOf is strict -- resolved exactly at asOf is not yet visible");

  const after = await store.getDecisionMemoryAsOf({ ticker: "AAPL", asOf: "t6" });
  assert.equal(after.length, 1);

  const returns = await store.getRealizedReturnsInRange({ ticker: "AAPL", from: "t0", to: "t9" });
  assert.deepEqual(returns, [0.02]);
});

test("deleteRun refuses to delete 'live'", async () => {
  const store = new RunStore(liveDb(), "live");
  await assert.rejects(() => store.deleteRun(), /refuses to delete the 'live'/);
});

test("deleteRun chunks and removes every row for a backtest run_id across every state table, including llm_calls' env_run_id", async () => {
  const db = simDb();
  const backtest = new RunStore(db, "bt-1");
  const other = new RunStore(db, "bt-2");

  await backtest.commitThesis(thesisArgs({ id: "AAPL|t1", ticker: "AAPL", asOf: "t1" }));
  await other.commitThesis(thesisArgs({ id: "AAPL|t1", ticker: "AAPL", asOf: "t1" }));
  await db.prepare(`INSERT INTO llm_calls (env_run_id, created_at, source, label, status) VALUES (?, ?, 'backtest', 'trader', 'ok')`).bind("bt-1", "t1").run();
  await db.prepare(`INSERT INTO llm_calls (env_run_id, created_at, source, label, status) VALUES (?, ?, 'backtest', 'trader', 'ok')`).bind("bt-2", "t1").run();

  const deleted = await backtest.deleteRun({ limit: 500 });
  assert.ok(deleted > 0);

  const remainingBt1 = await db.prepare(`SELECT COUNT(*) AS c FROM positions WHERE run_id = 'bt-1'`).first();
  assert.equal(remainingBt1.c, 0);
  const remainingBt1Llm = await db.prepare(`SELECT COUNT(*) AS c FROM llm_calls WHERE env_run_id = 'bt-1'`).first();
  assert.equal(remainingBt1Llm.c, 0);

  // bt-2's rows are untouched.
  const bt2Pos = await other.getOpenPositionForTickerAsOf({ ticker: "AAPL", asOf: "t1" });
  assert.ok(bt2Pos);
  const remainingBt2Llm = await db.prepare(`SELECT COUNT(*) AS c FROM llm_calls WHERE env_run_id = 'bt-2'`).first();
  assert.equal(remainingBt2Llm.c, 1);
});

test("readOnly(db) allows SELECT and rejects writes/batch/exec", async () => {
  const db = liveDb();
  const ro = readOnly(db);

  const row = await ro.prepare(`SELECT 1 AS one`).first();
  assert.equal(row.one, 1);

  assert.throws(() => ro.prepare(`INSERT INTO positions (run_id, id, ticker, trade_thesis_id, position_size_pct, opened_at) VALUES ('live','x','AAPL','x',0.1,'t1')`), /refusing non-SELECT/);
  assert.throws(() => ro.prepare(`DELETE FROM positions`), /refusing non-SELECT/);
  assert.throws(() => ro.prepare(`UPDATE positions SET closed_at = 't1'`), /refusing non-SELECT/);
  assert.throws(() => ro.batch([]), /not permitted through a read-only handle/);
  assert.throws(() => ro.exec("CREATE TABLE x (y)"), /not permitted through a read-only handle/);
});

test("sim schema includes backtest_runs on top of the shared state schema; live does not", async () => {
  const sim = simDb();
  const row = await sim.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='backtest_runs'`).first();
  assert.ok(row, "sim DB has backtest_runs");

  const live = liveDb();
  const missing = await live.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='backtest_runs'`).first();
  assert.equal(missing, null, "live DB (state schema only) has no backtest_runs");
});
