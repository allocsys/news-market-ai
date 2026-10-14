// Seeding a backtest from another run's checkpoints (src/backtest/seedCheckpoints.js, opt-in `seedFromRunId`): the copy
// and stage downgrade, the refusals that protect against stale cached output, idempotency, and the worker wiring.
// Real sqlite SIM_DB (state + sim schema); no LIVE_DB, no model call.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/backtest-worker.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { STATE_DIR, INPUTS_DIR, SIM_DIR, seedBar } from "./helpers/engine_ctx.js";
import { insertBacktestRun, completeBacktestRun } from "../src/storage/sim_registry.js";
import { seedCheckpointsFromRun, seedKnobMismatches, checkSeedSource, SEED_MATCH_KNOBS } from "../src/backtest/seedCheckpoints.js";

const TEST_START = "2026-01-01T00:00:00.000Z";
const TEST_END = "2026-01-03T00:00:00.000Z";
const SOURCE = "backtest-1000-source";
const TARGET = "backtest-2000-target";
const SAME_KNOBS = { mergedVerdict: false, macroEnabled: false, intradayTechnical: false, independenceNote: false, skipNoPriceImpact: true };

function simDb() {
  return createTestD1([STATE_DIR, SIM_DIR]);
}

async function addSourceRun(db, { id = SOURCE, tickers = ["AAPL"], testStart = TEST_START, knobs = SAME_KNOBS, complete = true } = {}) {
  await insertBacktestRun(db, { id, tickers, testStart, testEnd: TEST_END, trainDays: 0, testDays: 2, graceDays: 1, startedAt: "2026-01-04T00:00:00.000Z" });
  if (complete) await completeBacktestRun(db, { id, result: { knobs, overall: {}, perWindow: [] }, finishedAt: "2026-01-04T01:00:00.000Z" });
}

async function addCheckpoint(db, runId, pipelineRunId, ticker, stage, state) {
  await db
    .prepare(`INSERT INTO pipeline_checkpoints (run_id, pipeline_run_id, ticker, stage, state, updated_at) VALUES (?, ?, ?, ?, ?, 't0')`)
    .bind(runId, pipelineRunId, ticker, stage, state === null ? null : JSON.stringify(state))
    .run();
}

async function checkpointsOf(db, runId) {
  const { results } = await db.prepare(`SELECT pipeline_run_id, ticker, stage, state FROM pipeline_checkpoints WHERE run_id = ? ORDER BY pipeline_run_id`).bind(runId).all();
  return results.map((r) => ({ ...r, state: r.state ? JSON.parse(r.state) : null }));
}

async function seedSourceCheckpoints(db) {
  const verdictState = { opinions: [{ agent: "x" }], verdict: { confidence: 0.7 }, thesis: { direction: "long" }, evidence: { rangeFilter: { blocked: true }, entryConfirmation: { pending: true }, keep: 1 }, priceBars: [{ close: 1 }], portfolioDecision: { approvedForExecution: false } };
  await addCheckpoint(db, SOURCE, `${TEST_START}|AAPL|n1`, "AAPL", "portfolio_checked", verdictState);
  // A no-price-impact skip: finished, but never had a verdict.
  await addCheckpoint(db, SOURCE, `${TEST_START}|AAPL|n2`, "AAPL", "portfolio_checked", { opinions: [{ agent: "price_impact", relevance: "none" }], thesis: { direction: "flat" } });
  // An item that never got past the analysts.
  await addCheckpoint(db, SOURCE, `${TEST_START}|AAPL|n3`, "AAPL", "analyzed", { opinions: [] });
  // Not this run's window / not a requested ticker: must not be copied.
  await addCheckpoint(db, SOURCE, `2025-12-01T00:00:00.000Z|AAPL|n4`, "AAPL", "portfolio_checked", verdictState);
  await addCheckpoint(db, SOURCE, `${TEST_START}|MSFT|n5`, "MSFT", "portfolio_checked", verdictState);
}

test("seedCheckpointsFromRun copies this window's rows for the requested tickers, downgrading finished rows so the cached model output is reused", async () => {
  const db = simDb();
  await addSourceRun(db, { tickers: ["AAPL", "MSFT"] });
  await seedSourceCheckpoints(db);

  const out = await seedCheckpointsFromRun(db, { sourceId: SOURCE, targetId: TARGET, testStart: TEST_START, tickers: ["AAPL"], knobs: SAME_KNOBS });
  assert.equal(out.error, undefined);
  assert.equal(out.seeded, 3);

  const rows = await checkpointsOf(db, TARGET);
  assert.deepEqual(rows.map((r) => [r.pipeline_run_id, r.stage]), [
    [`${TEST_START}|AAPL|n1`, "traded"], // had a verdict: risk + portfolio re-run on the cached trader output
    [`${TEST_START}|AAPL|n2`, "analyzed"], // no verdict: the price-impact gate re-skips it, no model call
    [`${TEST_START}|AAPL|n3`, "analyzed"], // unfinished rows copy as they are
  ]);
  const n1 = rows[0].state;
  assert.deepEqual(n1.verdict, { confidence: 0.7 }, "the cached model output is kept");
  assert.deepEqual(n1.priceBars, [{ close: 1 }]);
  assert.equal(n1.evidence.rangeFilter, undefined, "the source's range-filter evidence must not linger");
  assert.equal(n1.evidence.entryConfirmation, undefined);
  assert.equal(n1.evidence.keep, 1, "other evidence stays");

  // The source is untouched.
  const source = await checkpointsOf(db, SOURCE);
  assert.equal(source.length, 5);
  assert.equal(source.find((r) => r.pipeline_run_id === `${TEST_START}|AAPL|n1`).stage, "portfolio_checked");
});

test("seedCheckpointsFromRun is idempotent and never overwrites progress the target already made (a redelivered part 1)", async () => {
  const db = simDb();
  await addSourceRun(db);
  await seedSourceCheckpoints(db);
  await seedCheckpointsFromRun(db, { sourceId: SOURCE, targetId: TARGET, testStart: TEST_START, tickers: ["AAPL"], knobs: SAME_KNOBS });
  // The target finishes n1 for real.
  await db.prepare(`UPDATE pipeline_checkpoints SET stage = 'portfolio_checked' WHERE run_id = ? AND pipeline_run_id = ?`).bind(TARGET, `${TEST_START}|AAPL|n1`).run();

  const again = await seedCheckpointsFromRun(db, { sourceId: SOURCE, targetId: TARGET, testStart: TEST_START, tickers: ["AAPL"], knobs: SAME_KNOBS });
  assert.equal(again.seeded, 0);
  const rows = await checkpointsOf(db, TARGET);
  assert.equal(rows.length, 3);
  assert.equal(rows.find((r) => r.pipeline_run_id === `${TEST_START}|AAPL|n1`).stage, "portfolio_checked", "progress survives");
});

test("seedCheckpointsFromRun refuses a source that could not have produced the same model output, copying nothing", async () => {
  const db = simDb();
  await addSourceRun(db);
  await addSourceRun(db, { id: "backtest-1001-running", complete: false });
  await addSourceRun(db, { id: "backtest-1002-otherwindow", testStart: "2026-02-01T00:00:00.000Z" });
  await addSourceRun(db, { id: "backtest-1003-oneticker", tickers: ["MSFT"] });
  await addSourceRun(db, { id: "backtest-1004-intraday", knobs: { ...SAME_KNOBS, intradayTechnical: true } });
  await addSourceRun(db, { id: "backtest-1005-noknobs", knobs: null });
  await seedSourceCheckpoints(db);
  const args = { targetId: TARGET, testStart: TEST_START, tickers: ["AAPL"], knobs: SAME_KNOBS };

  assert.match((await seedCheckpointsFromRun(db, { ...args, sourceId: "backtest-9-missing" })).error, /not found/);
  assert.match((await seedCheckpointsFromRun(db, { ...args, sourceId: "backtest-1001-running" })).error, /not complete/);
  assert.match((await seedCheckpointsFromRun(db, { ...args, sourceId: "backtest-1002-otherwindow" })).error, /testStart/);
  assert.match((await seedCheckpointsFromRun(db, { ...args, sourceId: "backtest-1003-oneticker" })).error, /did not cover AAPL/);
  assert.match((await seedCheckpointsFromRun(db, { ...args, sourceId: "backtest-1004-intraday" })).error, /intradayTechnical/);
  assert.match((await seedCheckpointsFromRun(db, { ...args, sourceId: "backtest-1005-noknobs" })).error, /no recorded knobs/);
  assert.match((await seedCheckpointsFromRun(db, { ...args, sourceId: TARGET })).error, /different/);
  assert.equal((await checkpointsOf(db, TARGET)).length, 0);
});

test("seedKnobMismatches: a missing skipNoPriceImpact means ON, every other missing knob means OFF", () => {
  assert.deepEqual(seedKnobMismatches({}, SAME_KNOBS), []);
  assert.deepEqual(seedKnobMismatches({ mergedVerdict: 0, skipNoPriceImpact: 1 }, SAME_KNOBS), []);
  assert.deepEqual(seedKnobMismatches(SAME_KNOBS, { ...SAME_KNOBS, skipNoPriceImpact: false }), ["skipNoPriceImpact"]);
  assert.deepEqual(seedKnobMismatches(SAME_KNOBS, { ...SAME_KNOBS, mergedVerdict: true, independenceNote: true }), ["mergedVerdict", "independenceNote"]);
  // Exit/gate knobs may differ freely: they are the point of a seeded run.
  assert.ok(!SEED_MATCH_KNOBS.includes("rangeLocationFilter"));
  assert.ok(!SEED_MATCH_KNOBS.includes("entryConfirmation"));
  assert.ok(!SEED_MATCH_KNOBS.includes("trailActivationR"));
});

test("checkSeedSource: shape checks the request handler can make without the worker's config", () => {
  const source = { status: "complete", testStart: TEST_START, tickers: ["AAPL", "MSFT"] };
  assert.equal(checkSeedSource(source, { sourceId: SOURCE, testStart: TEST_START, tickers: ["AAPL"] }), null);
  assert.match(checkSeedSource(null, { sourceId: SOURCE, testStart: TEST_START, tickers: ["AAPL"] }), /not found/);
  assert.match(checkSeedSource({ ...source, status: "failed" }, { sourceId: SOURCE, testStart: TEST_START, tickers: ["AAPL"] }), /not complete/);
});

// ---------------------------------------------------------------------------
// Worker wiring
// ---------------------------------------------------------------------------

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

const JOB = { type: "backtest", id: TARGET, tickers: ["AAPL"], testStart: TEST_START, testEnd: TEST_END, graceDays: 1 };

function bindings() {
  return { SIM_DB: simDb(), INPUTS_DB: createTestD1([INPUTS_DIR]) };
}

test("queue(): a job with seedFromRunId starts from the source's checkpoints and completes", async (t) => {
  const b = bindings();
  await seedBar(b.INPUTS_DB, { ticker: "AAPL", date: "2026-01-01", close: 100 });
  await seedBar(b.INPUTS_DB, { ticker: "AAPL", date: "2026-01-03", close: 110 });
  await addSourceRun(b.SIM_DB);
  await seedSourceCheckpoints(b.SIM_DB);
  t.mock.method(console, "log", () => {});

  const message = new FakeMessage({ ...JOB, seedFromRunId: SOURCE });
  await worker.queue({ messages: [message] }, { ...b });

  assert.equal(message.acked, true);
  assert.equal(message.retried, false);
  const run = await b.SIM_DB.prepare("SELECT status FROM backtest_runs WHERE id = ?").bind(TARGET).first();
  assert.equal(run.status, "complete");
  assert.equal((await checkpointsOf(b.SIM_DB, TARGET)).length, 3, "the seeded rows are under the new run id");
});

test("queue(): a refused seed fails the run before any work, records the reason, cleans up, and acks", async (t) => {
  const b = bindings();
  await addSourceRun(b.SIM_DB, { knobs: { ...SAME_KNOBS, mergedVerdict: true } });
  await seedSourceCheckpoints(b.SIM_DB);
  t.mock.method(console, "log", () => {});

  const message = new FakeMessage({ ...JOB, seedFromRunId: SOURCE });
  await worker.queue({ messages: [message] }, { ...b });

  assert.equal(message.acked, true);
  assert.equal(message.retried, false);
  const run = await b.SIM_DB.prepare("SELECT status, error FROM backtest_runs WHERE id = ?").bind(TARGET).first();
  assert.equal(run.status, "failed");
  assert.match(run.error, /mergedVerdict/);
  assert.equal((await checkpointsOf(b.SIM_DB, TARGET)).length, 0);
});

test("queue(): without seedFromRunId nothing is seeded (the default path is unchanged)", async (t) => {
  const b = bindings();
  await seedBar(b.INPUTS_DB, { ticker: "AAPL", date: "2026-01-01", close: 100 });
  await seedBar(b.INPUTS_DB, { ticker: "AAPL", date: "2026-01-03", close: 110 });
  await addSourceRun(b.SIM_DB);
  await seedSourceCheckpoints(b.SIM_DB);
  t.mock.method(console, "log", () => {});

  await worker.queue({ messages: [new FakeMessage(JOB)] }, { ...b });

  assert.equal((await checkpointsOf(b.SIM_DB, TARGET)).length, 0);
});
