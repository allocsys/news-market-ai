// runManualBacktest's continuation contract: with a SubrequestBudget it returns
// {status:'continue', cursor} instead of finishing; called again with that
// cursor it picks up where it stopped, and the last part scores + completes.
// Real sqlite DBs, fake model, D1 calls counted through countedD1.

import test from "node:test";
import assert from "node:assert/strict";
import { runManualBacktest } from "../src/backtest/runBacktest.js";
import { SimClock } from "../src/backtest/simClock.js";
import { SubrequestBudget, countedD1 } from "../src/backtest/subrequestBudget.js";
import { insertBacktestRun } from "../src/storage/sim_registry.js";
import { RunStore } from "../src/storage/run_store.js";
import { AnalystOpinion, DebateSide, DebateVerdict, TradeThesis } from "../src/schemas/index.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { makeCtx, seedNews, seedBar, STATE_DIR, SIM_DIR } from "./helpers/engine_ctx.js";

const ID = "bt-cont";
const RUN = { id: ID, tickers: ["AAPL"], testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-04T00:00:00.000Z", graceDays: 2 };
const NOW = "2026-06-01T00:00:00.000Z";

function fakeModel() {
  return async (prompt, opts) => {
    if (prompt.startsWith("A trade decision for")) return JSON.stringify({ reflection: "played out" });
    if (opts.schema === AnalystOpinion) {
      if (opts.extraFields.agent === "news_event") return JSON.stringify({ eventType: "earnings_beat", entities: [], summary: "beat", justification: "guidance" });
      if (opts.extraFields.agent === "sentiment") return JSON.stringify({ sentiment: "positive", summary: "pos", justification: "beat" });
      return JSON.stringify({ summary: "flat", justification: "few bars" });
    }
    if (opts.schema === DebateSide) return JSON.stringify({ argument: "a", justification: "j" });
    if (opts.schema === DebateVerdict) return JSON.stringify({ direction: "long", confidence: 0.8, timeHorizon: "days", justification: "j" });
    if (opts.schema === TradeThesis) return JSON.stringify({ instrument: "equity", rationale: "ride it" });
    throw new Error("unexpected schema");
  };
}
const config = () => ({ geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, maxPositionHoldDays: 2, fakeModel: fakeModel() });

async function seeded() {
  const ctx = makeCtx({ runId: ID });
  const registryDb = createTestD1([SIM_DIR]);
  for (const date of ["2025-12-31", "2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05"]) await seedBar(ctx.inputs, { ticker: "AAPL", date, close: 100 });
  await seedNews(ctx.inputs, { id: "n1", tickers: ["AAPL"], publishedAt: "2026-01-01T10:00:00.000Z" });
  await seedNews(ctx.inputs, { id: "n2", tickers: ["AAPL"], publishedAt: "2026-01-02T09:00:00.000Z" });
  return { ...ctx, registryDb };
}

const wrap = (ctx, budget) => ({
  inputs: countedD1(ctx.inputsDb, budget),
  store: new RunStore(countedD1(ctx.stateDb, budget), ID),
  registryDb: countedD1(ctx.registryDb, budget),
});

/** One budgeted part. */
function part(ctx, { totalLimit, cursor = null, n = 1, maxParts = Infinity, onProgress, budget = new SubrequestBudget({ externalLimit: 40, totalLimit }) }) {
  return runManualBacktest({}, { ...config() }, wrap(ctx, budget), { ...RUN, cursor, budget, part: n, maxParts, onProgress, clock: new SimClock(NOW) });
}

async function chain(ctx, { totalLimit, max = 200, onProgress }) {
  const outcomes = [];
  let cursor = null;
  for (let n = 1; n <= max; n++) {
    const o = await part(ctx, { totalLimit, cursor, n, onProgress });
    outcomes.push(o);
    if (o.status !== "continue") return outcomes;
    cursor = o.cursor;
  }
  throw new Error("did not finish");
}

test("a budgeted run returns 'continue' with a cursor, and chaining the parts ends 'complete' with the SAME result as an unbudgeted run", async () => {
  const single = await seeded();
  const base = await runManualBacktest({}, config(), single, { ...RUN, clock: new SimClock(NOW) });
  assert.equal(base.status, "complete", base.error);

  const ctx = await seeded();
  const outcomes = await chain(ctx, { totalLimit: 30 });
  assert.ok(outcomes.length > 1, "the budget forced a split");
  assert.deepEqual(outcomes.slice(0, -1).map((o) => o.status), outcomes.slice(0, -1).map(() => "continue"));
  const last = outcomes.at(-1);
  assert.equal(last.status, "complete", last.error);
  assert.deepEqual(last.result, base.result);

  for (const o of outcomes.slice(0, -1)) {
    assert.ok(["budget", "exhausted"].includes(o.reason));
    assert.equal(o.cursor.clockNow, NOW, "the clock is pinned in the cursor");
    assert.ok(["walk", "score"].includes(o.cursor.phase));
  }
  const completed = outcomes.slice(0, -1).map((o) => o.cursor.completed);
  assert.deepEqual([...completed].sort((a, b) => a - b), completed, "completed ticker-days only ever grows across parts");
});

test("the registry row is inserted by part 1 only: it stays 'running' between parts and keeps its started_at", async () => {
  const ctx = await seeded();
  const first = await part(ctx, { totalLimit: 30 });
  assert.equal(first.status, "continue");
  const row1 = await ctx.registryDb.prepare("SELECT status, started_at FROM backtest_runs WHERE id = ?").bind(ID).first();
  assert.equal(row1.status, "running");
  const second = await part(ctx, { totalLimit: 30, cursor: first.cursor, n: 2 });
  assert.ok(["continue", "complete"].includes(second.status));
  const rows = await ctx.registryDb.prepare("SELECT started_at FROM backtest_runs WHERE id = ?").bind(ID).all();
  assert.equal(rows.results.length, 1);
  assert.equal(rows.results[0].started_at, row1.started_at);
});

test("before returning 'continue' a forced progress update is emitted, carrying the part number", async () => {
  const ctx = await seeded();
  const updates = [];
  const o = await part(ctx, { totalLimit: 30, onProgress: (p) => updates.push(p) });
  assert.equal(o.status, "continue");
  const last = updates.at(-1);
  assert.equal(last.force, true);
  assert.match(last.detail, /Continuing in part 2/);
  assert.equal(last.phase, "simulating");
});

test("a part that finds the walk done but too little budget for scoring yields phase 'score'; the next part scores and completes", async () => {
  const ctx = await seeded();
  // Part 1 of the walk finishing needs a big budget; then hand part 2 a nearly-spent one.
  const walkDone = await part(ctx, { totalLimit: 10000 });
  assert.equal(walkDone.status, "complete", "sanity: enough budget completes in one part");

  const ctx2 = await seeded();
  // Register the run, then enter directly at the end of the walk with a budget that already did a unit and has little left.
  await insertBacktestRun(ctx2.registryDb, { id: ID, tickers: RUN.tickers, testStart: RUN.testStart, testEnd: RUN.testEnd, trainDays: 0, testDays: 3, graceDays: 2, startedAt: NOW });
  const spent = new SubrequestBudget({ externalLimit: 40, totalLimit: 30 });
  spent.recordUnit("item", spent.mark());
  for (let i = 0; i < 20; i++) spent.chargeInternal("d1"); // 10 left < score estimate (tickers + 8 = 9)? make it clearly short
  spent.chargeInternal("d1");
  spent.chargeInternal("d1");
  const cursorAtScore = { clockNow: NOW, phase: "walk", window: 1, walk: null, completed: 0 }; // window index past the last window: the walk loop is skipped
  const yielded = await runManualBacktest({}, config(), wrap(ctx2, spent), { ...RUN, cursor: cursorAtScore, budget: spent, part: 2, clock: new SimClock(NOW) });
  assert.equal(yielded.status, "continue");
  assert.equal(yielded.reason, "budget");
  assert.equal(yielded.cursor.phase, "score");

  const finished = await part(ctx2, { totalLimit: 30, cursor: yielded.cursor, n: 3 });
  assert.equal(finished.status, "complete", finished.error);
  assert.ok(finished.result.overall);
});

test("needing a continuation at part >= maxParts fails the run: 'failed' registry row naming the cap, no cursor returned", async () => {
  const ctx = await seeded();
  const capped = await part(ctx, { totalLimit: 30, n: 1, maxParts: 1 }); // part 1 cannot finish in 30 ops, and 1 part is all that is allowed
  assert.equal(capped.status, "failed");
  assert.match(capped.error, /exceeded 1 continuation parts/);
  assert.equal(capped.cursor, undefined);
  const row = await ctx.registryDb.prepare("SELECT status, error FROM backtest_runs WHERE id = ?").bind(ID).first();
  assert.equal(row.status, "failed");
  assert.match(row.error, /exceeded 1 continuation parts/);
});

test("a failure in a continuation part is recorded on the row like any failed run", async () => {
  const ctx = await seeded();
  const first = await part(ctx, { totalLimit: 30 });
  assert.equal(first.status, "continue");
  const bad = { ...first.cursor, walk: first.cursor.walk && { ...first.cursor.walk, day: "2031-01-01T00:00:00.000Z" } };
  assert.ok(bad.walk, "sanity: part 1 paused inside the walk");
  const out = await part(ctx, { totalLimit: 30, cursor: bad, n: 2 });
  assert.equal(out.status, "failed");
  assert.match(out.error, /not one of this window's walk days/);
  assert.equal((await ctx.registryDb.prepare("SELECT status FROM backtest_runs WHERE id = ?").bind(ID).first()).status, "failed");
});
