// A news item whose model output is UNUSABLE (not JSON, or failing the schema) is
// SKIPPED by the backtest walk instead of failing the whole run. A live run
// (backtest-1790858728197-ukmfl3) died at AAPL 2026-08-10 because a lite model omitted
// one field of one answer. callStructured tags such errors (markLlmOutputError),
// walkOnSignalWindow skips the item via onItemSkipped, runBacktest.js counts the skips
// (carried across continuation parts), caps them (a systematic mismatch must still
// fail the run) and reports them in result.skippedItems. Real sqlite DBs, a fake model.

import test from "node:test";
import assert from "node:assert/strict";
import { runManualBacktest } from "../src/backtest/runBacktest.js";
import { SimClock } from "../src/backtest/simClock.js";
import { SubrequestBudget, countedD1 } from "../src/backtest/subrequestBudget.js";
import { RunStore } from "../src/storage/run_store.js";
import { VendorError } from "../src/shared/errors.js";
import { AnalystTeamOpinion, DebateSide, DebateVerdict, TradeThesis } from "../src/schemas/index.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { makeCtx, seedNews, seedBar, SIM_DIR } from "./helpers/engine_ctx.js";

const ID = "bt-skip";
const RUN = { id: ID, tickers: ["AAPL"], testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-04T00:00:00.000Z", graceDays: 2 };
const NOW = "2026-06-01T00:00:00.000Z";
const BAD = "BADITEM"; // in the title of every news item the fake model must answer badly

/**
 * `state.badMode`: "schema" (valid JSON missing a required analyst field) or "json"
 * (not JSON at all); `state.error`: thrown for every OTHER item's analyst call while set.
 * `state.verdicts` counts the items that got all the way to a verdict.
 */
function model(state) {
  return async (prompt, opts) => {
    if (prompt.startsWith("A trade decision for")) return JSON.stringify({ reflection: "played out" });
    if (opts.schema === AnalystTeamOpinion) {
      if (prompt.includes(BAD)) {
        if (state.badMode === "json") return "this is not json at all";
        return JSON.stringify({ sentiment: { sentiment: "positive", summary: "pos", justification: "beat" } }); // news_event + technical missing
      }
      if (state.error) throw state.error;
      return JSON.stringify({
        news_event: { eventType: "earnings_beat", entities: [], summary: "beat", justification: "guidance" },
        sentiment: { sentiment: "positive", summary: "pos", justification: "beat" },
        technical: { summary: "flat", justification: "few bars" },
      });
    }
    if (opts.schema === DebateSide) return JSON.stringify({ argument: "a", justification: "j" });
    if (opts.schema === DebateVerdict) {
      state.verdicts++;
      return JSON.stringify({ direction: "long", confidence: 0.8, timeHorizon: "days", justification: "j" });
    }
    if (opts.schema === TradeThesis) return JSON.stringify({ instrument: "equity", rationale: "ride it" });
    throw new Error("unexpected schema");
  };
}

const newState = (extra = {}) => ({ badMode: "schema", error: null, verdicts: 0, ...extra });

const config = (state, extra = {}) => ({
  geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, maxPositionHoldDays: 2,
  backtestTransientPauseSeconds: 90, backtestMaxTransientStalls: 30,
  fakeModel: model(state), ...extra,
});

/** `titles`: one news item per entry, on consecutive days from 2026-01-01. */
async function seeded(titles) {
  const ctx = makeCtx({ runId: ID });
  const registryDb = createTestD1([SIM_DIR]);
  for (const date of ["2025-12-31", "2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05"]) await seedBar(ctx.inputs, { ticker: "AAPL", date, close: 100 });
  for (const [i, title] of titles.entries()) {
    await seedNews(ctx.inputs, { id: `n${i + 1}`, tickers: ["AAPL"], publishedAt: `2026-01-0${i + 1}T10:00:00.000Z`, title });
  }
  return { ...ctx, registryDb };
}

const wrap = (ctx, budget) => ({
  inputs: countedD1(ctx.inputsDb, budget),
  store: new RunStore(countedD1(ctx.stateDb, budget), ID),
  registryDb: countedD1(ctx.registryDb, budget),
});

function part(ctx, state, { cursor = null, n = 1, extra = {} } = {}) {
  const budget = new SubrequestBudget({ externalLimit: 40, totalLimit: 10000 });
  return runManualBacktest({}, config(state, extra), wrap(ctx, budget), { ...RUN, cursor, budget, part: n, clock: new SimClock(NOW) });
}

const registryRow = (ctx) => ctx.registryDb.prepare("SELECT status, error FROM backtest_runs WHERE id = ?").bind(ID).first();

test("a news item whose answer fails the schema is SKIPPED: the run completes, the other item is processed, the skip is reported", async () => {
  const ctx = await seeded([`${BAD} headline`, "good headline"]);
  const state = newState();
  const out = await runManualBacktest({}, config(state), ctx, { ...RUN, clock: new SimClock(NOW) });

  assert.equal(out.status, "complete", out.error);
  assert.equal(state.verdicts, 1, "the good item still went all the way to a verdict");
  assert.equal(out.result.skippedItems.count, 1);
  assert.equal(out.result.skippedItems.listed, 1);
  const [skip] = out.result.skippedItems.items;
  assert.equal(skip.ticker, "AAPL");
  assert.equal(skip.day, "2026-01-01");
  assert.equal(skip.itemId, "n1");
  assert.equal(skip.stage, "validation");
  assert.equal((await registryRow(ctx)).status, "complete");
});

test("a model answer that is not JSON at all is skipped too (stage 'parse')", async () => {
  const ctx = await seeded([`${BAD} headline`, "good headline"]);
  const state = newState({ badMode: "json" });
  const out = await runManualBacktest({}, config(state), ctx, { ...RUN, clock: new SimClock(NOW) });

  assert.equal(out.status, "complete", out.error);
  assert.equal(out.result.skippedItems.count, 1);
  assert.equal(out.result.skippedItems.items[0].stage, "parse");
});

test("a clean run has no skippedItems key", async () => {
  const ctx = await seeded(["good one", "good two"]);
  const out = await runManualBacktest({}, config(newState()), ctx, { ...RUN, clock: new SimClock(NOW) });
  assert.equal(out.status, "complete", out.error);
  assert.equal("skippedItems" in out.result, false);
});

test("past backtestMaxSkippedItems the run FAILS and says it is systematic (a prompt/schema mismatch must not hollow out a backtest)", async () => {
  const ctx = await seeded([`${BAD} one`, `${BAD} two`, "good"]);
  const out = await runManualBacktest({}, config(newState(), { backtestMaxSkippedItems: 1 }), ctx, { ...RUN, clock: new SimClock(NOW) });

  assert.equal(out.status, "failed");
  assert.match(out.error, /More than 1 news items were skipped for unusable model output \(validation\)/);
  assert.match(out.error, /AAPL 2026-01-02 item n2/);
  assert.equal((await registryRow(ctx)).status, "failed");
});

test("backtestMaxSkippedItems of 0 turns skipping off: the first unusable answer fails the run, as before", async () => {
  const ctx = await seeded([`${BAD} one`, "good"]);
  const out = await runManualBacktest({}, config(newState(), { backtestMaxSkippedItems: 0 }), ctx, { ...RUN, clock: new SimClock(NOW) });

  assert.equal(out.status, "failed");
  assert.doesNotMatch(out.error, /skipped/);
  assert.equal((await registryRow(ctx)).status, "failed");
});

test("skips survive continuation parts: the count rides the cursor and lands in the final result", async () => {
  const ctx = await seeded([`${BAD} headline`, "good headline"]);
  const state = newState({ error: new VendorError("gemini", "cascade exhausted: high demand", { status: 503, transient: true, retryAfterSeconds: 60 }) });

  // Part 1: n1 is skipped, then n2 hits a Gemini outage and the part pauses.
  const p1 = await part(ctx, state);
  assert.equal(p1.status, "continue", p1.error);
  assert.equal(p1.reason, "transient");
  assert.equal(p1.cursor.skipped.count, 1);
  assert.equal(p1.cursor.skipped.items[0].itemId, "n1");

  // Part 2: Gemini is back; the chain completes and still reports the part-1 skip.
  state.error = null;
  const done = await part(ctx, state, { cursor: p1.cursor, n: 2 });
  assert.equal(done.status, "complete", done.error);
  assert.equal(done.result.skippedItems.count, 1);
  assert.equal(done.result.skippedItems.items[0].itemId, "n1");
  assert.equal(state.verdicts, 1);
});

test("only unusable MODEL OUTPUT is skipped: a plain error still fails the run", async () => {
  const ctx = await seeded(["good headline"]);
  const state = newState({ error: new Error("boom") });
  const out = await runManualBacktest({}, config(state), ctx, { ...RUN, clock: new SimClock(NOW) });

  assert.equal(out.status, "failed");
  assert.match(out.error, /boom/);
});
