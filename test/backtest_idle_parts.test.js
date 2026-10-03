// Idle continuation parts (no unit completed, no external call, no ticker-day finished) must not count toward
// BACKTEST_MAX_PARTS; a long enough streak of them still fails the run. Real sqlite DBs, fake model.
// An idle part is forced with a budget that is already halted: canStart() refuses every unit, so the part
// reads the day's news (counted, unenforced) and hands over.

import test from "node:test";
import assert from "node:assert/strict";
import { runManualBacktest } from "../src/backtest/runBacktest.js";
import { SimClock } from "../src/backtest/simClock.js";
import { SubrequestBudget, countedD1 } from "../src/backtest/subrequestBudget.js";
import { RunStore } from "../src/storage/run_store.js";
import { AnalystTeamOpinion, DebateSide, DebateVerdict, TradeThesis } from "../src/schemas/index.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { makeCtx, seedNews, seedBar, SIM_DIR } from "./helpers/engine_ctx.js";

const ID = "bt-idle";
const RUN = { id: ID, tickers: ["AAPL"], testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-04T00:00:00.000Z", graceDays: 2 };
const NOW = "2026-06-01T00:00:00.000Z";

function fakeModel() {
  return async (prompt, opts) => {
    if (prompt.startsWith("A trade decision for")) return JSON.stringify({ reflection: "played out" });
    if (opts.schema === AnalystTeamOpinion) {
      return JSON.stringify({
        news_event: { eventType: "earnings_beat", entities: [], summary: "beat", justification: "guidance" },
        sentiment: { sentiment: "positive", summary: "pos", justification: "beat" },
        technical: { summary: "flat", justification: "few bars" },
      });
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

/** One budgeted part; `halted` makes it idle (the budget refuses every unit). */
function part(ctx, { halted = false, totalLimit = 30, cursor = null, n = 1, maxParts = Infinity }) {
  const budget = new SubrequestBudget({ externalLimit: 40, totalLimit });
  if (halted) budget.halted = true;
  return runManualBacktest({}, config(), wrap(ctx, budget), { ...RUN, cursor, budget, part: n, maxParts, clock: new SimClock(NOW) });
}

test("idle parts do not count toward maxParts and are tallied as an idle streak", async () => {
  const ctx = await seeded();
  const first = await part(ctx, { halted: true, n: 1, maxParts: 1 });
  assert.equal(first.status, "continue", first.error);
  assert.equal(first.cursor.countedParts, 0);
  assert.equal(first.cursor.idleStreak, 1);
  const second = await part(ctx, { halted: true, n: 2, cursor: first.cursor, maxParts: 1 });
  assert.equal(second.status, "continue", second.error);
  assert.equal(second.cursor.countedParts, 0);
  assert.equal(second.cursor.idleStreak, 2);
});

test("a productive part counts again and resets the idle streak", async () => {
  const ctx = await seeded();
  const idle = await part(ctx, { halted: true, n: 1 });
  assert.equal(idle.status, "continue", idle.error);
  const productive = await part(ctx, { n: 2, cursor: idle.cursor });
  assert.equal(productive.status, "continue", productive.error);
  assert.equal(productive.cursor.countedParts, 1);
  assert.equal(productive.cursor.idleStreak, 0);
});

test("a productive part still fails at the cap once it is counted", async () => {
  const ctx = await seeded();
  const idle = await part(ctx, { halted: true, n: 1, maxParts: 1 });
  assert.equal(idle.status, "continue", idle.error);
  const capped = await part(ctx, { n: 2, cursor: idle.cursor, maxParts: 1 });
  assert.equal(capped.status, "failed");
  assert.match(capped.error, /exceeded 1 continuation parts/);
});

test("too many idle parts in a row fail the run", async () => {
  const ctx = await seeded();
  const first = await part(ctx, { halted: true, n: 1 });
  assert.equal(first.status, "continue", first.error);
  const out = await part(ctx, { halted: true, n: 2, cursor: { ...first.cursor, idleStreak: 1000 } });
  assert.equal(out.status, "failed");
  assert.match(out.error, /no progress in 1000 consecutive parts/);
});
