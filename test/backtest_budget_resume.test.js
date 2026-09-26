// The Free-plan continuation machinery end to end at the walk level:
// walkOnSignalWindow paused by a SubrequestBudget and resumed from its cursor
// must leave EXACTLY what an uninterrupted walk leaves. Real sqlite D1s, the
// real pipeline, a fake model (no Gemini), D1 calls counted through countedD1.

import test from "node:test";
import assert from "node:assert/strict";
import { walkOnSignalWindow } from "../src/backtest/onSignalRunner.js";
import { SubrequestBudget, countedD1 } from "../src/backtest/subrequestBudget.js";
import { RunStore } from "../src/storage/run_store.js";
import { AnalystTeamOpinion, DebateSide, DebateVerdict, TradeThesis } from "../src/schemas/index.js";
import { makeCtx, seedNews, seedBar, stateRows } from "./helpers/engine_ctx.js";

function makeFakeModel() {
  return async (prompt, opts) => {
    if (prompt.startsWith("A trade decision for")) return JSON.stringify({ reflection: "the long thesis played out" });
    if (opts.schema === AnalystTeamOpinion) {
      return JSON.stringify({
        news_event: { eventType: "earnings_beat", entities: [], summary: "beat", justification: "guidance" },
        sentiment: { sentiment: "positive", summary: "positive", justification: "beat" },
        technical: { summary: "flat", justification: "few bars" },
      });
    }
    if (opts.schema === DebateSide) return JSON.stringify({ argument: "a", justification: "j" });
    if (opts.schema === DebateVerdict) return JSON.stringify({ direction: "long", confidence: 0.8, timeHorizon: "days", justification: "j" });
    if (opts.schema === TradeThesis) return JSON.stringify({ instrument: "equity", rationale: "ride it" });
    throw new Error(`unexpected schema/prompt: ${prompt.slice(0, 60)}`);
  };
}

const WINDOW = { tickers: ["AAPL", "MSFT"], testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-03T00:00:00.000Z", graceDays: 3 };
const RUN_ID = "run-budget";

const NEWS = [
  { id: "n1", tickers: ["AAPL"], publishedAt: "2026-01-01T10:00:00.000Z" },
  { id: "n2", tickers: ["AAPL"], publishedAt: "2026-01-01T11:00:00.000Z" },
  { id: "n3", tickers: ["AAPL"], publishedAt: "2026-01-02T09:00:00.000Z" },
  { id: "n4", tickers: ["MSFT"], publishedAt: "2026-01-01T12:00:00.000Z" },
];

async function seeded() {
  const ctx = makeCtx({ runId: RUN_ID });
  for (const ticker of WINDOW.tickers) await seedBar(ctx.inputs, { ticker, date: "2025-12-31", close: 100 });
  for (const n of NEWS) await seedNews(ctx.inputs, n);
  return ctx;
}

const config = () => ({ geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, maxPositionHoldDays: 2, fakeModel: makeFakeModel() });

/** What a run leaves behind, in a comparable form. */
async function outcomeOf(ctx) {
  // created_at is the wall clock at insert time -- the only column that differs between two runs of the same walk.
  const stable = (rows) => rows.map(({ created_at, ...rest }) => rest);
  return {
    positions: stable(await stateRows(ctx.stateDb, "positions", "id")),
    decisions: stable(await stateRows(ctx.stateDb, "trade_decisions", "id")),
  };
}

/** Walks the window in budgeted parts (a fresh budget each) until it completes. Returns the parts' results. */
async function walkInParts(ctx, { totalLimit, externalLimit = 40, maxParts = 400, cfg = config() }) {
  const parts = [];
  let cursor = null;
  for (let part = 1; part <= maxParts; part++) {
    const budget = new SubrequestBudget({ externalLimit, totalLimit });
    const counted = { inputs: countedD1(ctx.inputsDb, budget), store: new RunStore(countedD1(ctx.stateDb, budget), RUN_ID) };
    const res = await walkOnSignalWindow({}, { ...cfg, subrequestBudget: budget }, counted, { ...WINDOW, cursor, budget });
    parts.push({ ...res, used: budget.snapshot() });
    if (res.complete) return parts;
    cursor = res.cursor;
  }
  throw new Error(`walk did not finish in ${maxParts} parts (limit ${totalLimit}); last cursor ${JSON.stringify(cursor)}`);
}

test("a walk paused by the budget and resumed part after part leaves EXACTLY what an uninterrupted walk leaves, at every limit", async () => {
  const baselineCtx = await seeded();
  const baseRes = await walkOnSignalWindow({}, config(), baselineCtx, { ...WINDOW });
  assert.deepEqual(baseRes, { complete: true });
  const baseline = await outcomeOf(baselineCtx);
  assert.equal(baseline.decisions.length, 4, "sanity: all four news items produced a decision");
  assert.ok(baseline.positions.length > 0);

  // Limits chosen to force pauses between units (large), inside a unit (small), and everything in between.
  // +1 vs. the original [8, 15, 30, 60, 120]: Finding G step 4's resolveCurrentPrice (price_resolution.js)
  // adds one extra D1 read (intraday lookup before the daily-close fallback) to the portfolio_checked stage,
  // so a limit that was an exact fit before now overflows by exactly one charge and can never complete.
  for (const totalLimit of [9, 16, 31, 61, 121]) {
    const ctx = await seeded();
    const parts = await walkInParts(ctx, { totalLimit });
    assert.deepEqual(await outcomeOf(ctx), baseline, `limit ${totalLimit}: same positions and decisions as the uninterrupted walk`);
    if (totalLimit <= 60) assert.ok(parts.length > 1, `limit ${totalLimit}: the budget actually forced a pause (${parts.length} parts)`);
  }
});

test("a small budget pauses INSIDE an item ('exhausted') and the next part resumes it from its checkpoints without redoing the finished stages", async () => {
  const ctx = await seeded();
  const modelCalls = [];
  const cfg = { ...config(), fakeModel: async (prompt, opts) => { modelCalls.push(prompt.slice(0, 30)); return makeFakeModel()(prompt, opts); } };
  const parts = await walkInParts(ctx, { totalLimit: 9, cfg }); // was 8 -- see the +1 note on the totalLimit sweep above
  assert.ok(parts.some((p) => p.reason === "exhausted"), "at least one mid-item pause");

  const baselineCalls = [];
  const baselineCtx = await seeded();
  await walkOnSignalWindow({}, { ...config(), fakeModel: async (prompt, opts) => { baselineCalls.push(prompt.slice(0, 30)); return makeFakeModel()(prompt, opts); } }, baselineCtx, { ...WINDOW });
  assert.equal(modelCalls.length, baselineCalls.length, "checkpoints mean no model call is repeated across the pauses");
});

test("the exit check never throws mid-phase: a budget smaller than its estimate still completes the walk (exits run unenforced)", async () => {
  const ctx = await seeded();
  const parts = await walkInParts(ctx, { totalLimit: 9 }); // was 8 (see the +1 note above); the exits estimate is 13 post-step-4, so the gate defers them a part but never cuts them off
  assert.equal(parts.at(-1).complete, true);
  assert.ok(parts.every((p) => p.complete || p.cursor));
  const baselineCtx = await seeded();
  await walkOnSignalWindow({}, config(), baselineCtx, { ...WINDOW });
  assert.deepEqual(await outcomeOf(ctx), await outcomeOf(baselineCtx));
});

test("every part makes progress: each non-final part's cursor is strictly ahead of the previous one", async () => {
  const ctx = await seeded();
  const parts = await walkInParts(ctx, { totalLimit: 16 }); // was 15 -- see the +1 note on the totalLimit sweep above
  const key = (c) => JSON.stringify([c.day, c.exits ? 1 : 0, c.ticker, c.after?.publishedAt ?? "", c.after?.id ?? ""]);
  const keys = parts.filter((p) => !p.complete).map((p) => key(p.cursor));
  assert.equal(new Set(keys).size, keys.length, "no two parts paused at the same place");
});

test("resume skips items by their (published_at, id) key: news ingested mid-run BEFORE the cursor is not run, AFTER it is", async () => {
  // Measure what one item costs here, then give the first part just enough for one item.
  const probeCtx = await seeded();
  const probeBudget = new SubrequestBudget({ externalLimit: 40, totalLimit: 500 });
  await walkOnSignalWindow({}, { ...config(), subrequestBudget: probeBudget }, { inputs: countedD1(probeCtx.inputsDb, probeBudget), store: new RunStore(countedD1(probeCtx.stateDb, probeBudget), RUN_ID) }, { ...WINDOW, budget: probeBudget });
  const itemCost = probeBudget.observed.item.total;

  const ctx = await seeded();
  const budget = new SubrequestBudget({ externalLimit: 40, totalLimit: itemCost + 4 });
  const first = await walkOnSignalWindow({}, { ...config(), subrequestBudget: budget }, { inputs: countedD1(ctx.inputsDb, budget), store: new RunStore(countedD1(ctx.stateDb, budget), RUN_ID) }, { ...WINDOW, budget });
  assert.equal(first.complete, false);
  assert.equal(first.reason, "budget", "paused cleanly between units");
  assert.deepEqual(first.cursor.after, { publishedAt: "2026-01-01T10:00:00.000Z", id: "n1" }, "stopped right after n1");

  // While the run is paused two more items land: one before the cursor's key, one after it.
  await seedNews(ctx.inputs, { id: "n0-early", tickers: ["AAPL"], publishedAt: "2026-01-01T08:00:00.000Z" });
  await seedNews(ctx.inputs, { id: "n1b-late", tickers: ["AAPL"], publishedAt: "2026-01-01T10:30:00.000Z" });

  const big = new SubrequestBudget({ externalLimit: 40, totalLimit: 1000 });
  const done = await walkOnSignalWindow({}, { ...config(), subrequestBudget: big }, { inputs: countedD1(ctx.inputsDb, big), store: new RunStore(countedD1(ctx.stateDb, big), RUN_ID) }, { ...WINDOW, cursor: first.cursor, budget: big });
  assert.equal(done.complete, true);

  const ids = (await stateRows(ctx.stateDb, "trade_decisions", "id")).map((r) => r.id.split("|").slice(1).join("|"));
  assert.ok(!ids.some((i) => i.includes("08:00")), "the item that sorts before the cursor is not picked up");
  assert.ok(ids.some((i) => i.includes("10:30")), "the item after the cursor is");
  assert.equal(ids.length, 5, "n1, n2, n3, n4 + the late one");
});

test("resuming with a cursor day that is not in the window's walk days is refused loudly", async () => {
  const ctx = await seeded();
  await assert.rejects(
    walkOnSignalWindow({}, config(), ctx, { ...WINDOW, cursor: { day: "2030-01-01T00:00:00.000Z", ticker: 0, after: null, exits: false } }),
    /not one of this window's walk days/,
  );
});

test("with no budget the walk is unchanged: one call, complete, no cursor", async () => {
  const ctx = await seeded();
  assert.deepEqual(await walkOnSignalWindow({}, config(), ctx, { ...WINDOW }), { complete: true });
});

test("FLOOR: a total limit too small to persist even one pipeline stage (<= 6 here) makes no progress -- the parts cap is what ends such a run", async () => {
  const ctx = await seeded();
  await assert.rejects(walkInParts(ctx, { totalLimit: 3, maxParts: 25 }), /did not finish in 25 parts/);
});
