// runManualBacktest's DAILY-quota branch: when the Gemini cascade fails because EVERY model/key is on a
// daily quota cooldown (VendorError.dailyQuota), the part ends with a 'continue' outcome flagged
// `dailyQuota: true` + `retryAfterSeconds`, which backtest-worker.js turns into a parked run
// (gemini_daily_cap). Unlike an ordinary transient outage it asks for no short delay and is NOT counted
// as a stall (retrying in minutes cannot help, so the stall counter must not run out and fail the run).
// Same fixtures as backtest_gemini_outage_pause.test.js: real sqlite DBs, a fake model that throws on demand.

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

const ID = "bt-dailyquota";
const RUN = { id: ID, tickers: ["AAPL"], testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-04T00:00:00.000Z", graceDays: 2 };
const NOW = "2026-06-01T00:00:00.000Z";

const DAILY_MESSAGE = "Gemini cascade exhausted after 120ms with no usable model [m-a#0 daily quota cooldown; m-b#0 daily quota cooldown]";
const dailyQuota = (retryAfterSeconds = 3600) => new VendorError("gemini", DAILY_MESSAGE, { status: 429, transient: true, retryAfterSeconds, dailyQuota: true });

function healthyModel() {
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

/** Throws `state.error` on every call while it is set; behaves normally otherwise. */
function modelWith(state) {
  const ok = healthyModel();
  return async (prompt, opts) => {
    if (state.error) throw state.error;
    return ok(prompt, opts);
  };
}

const config = (state, extra = {}) => ({
  geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, maxPositionHoldDays: 2,
  backtestTransientPauseSeconds: 90, backtestMaxTransientStalls: 30,
  fakeModel: modelWith(state), ...extra,
});

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

/** One budgeted part with a budget big enough that only the quota error (never the budget) can end it early. */
function part(ctx, state, { cursor = null, n = 1, extra = {}, onProgress } = {}) {
  const budget = new SubrequestBudget({ externalLimit: 40, totalLimit: 10000 });
  return runManualBacktest({}, config(state, extra), wrap(ctx, budget), { ...RUN, cursor, budget, part: n, onProgress, clock: new SimClock(NOW) });
}

const registryRow = (ctx) => ctx.registryDb.prepare("SELECT status, error FROM backtest_runs WHERE id = ?").bind(ID).first();

test("a DAILY quota exhaustion ends the part with 'continue' flagged dailyQuota + the cooldown's retryAfterSeconds, no short delay, no stall counter, row still 'running'", async () => {
  const ctx = await seeded();
  const updates = [];
  const out = await part(ctx, { error: dailyQuota(5400) }, { onProgress: (u) => updates.push(u) });

  assert.equal(out.status, "continue", out.error);
  assert.equal(out.reason, "transient");
  assert.equal(out.dailyQuota, true);
  assert.equal(out.retryAfterSeconds, 5400);
  assert.equal(out.delaySeconds, undefined, "no minutes-long retry delay: the worker parks the run instead");
  assert.equal(out.cursor.stall, undefined, "a daily-quota pause is not a stall");
  assert.equal(typeof out.cursor.clockNow, "string");
  assert.match(updates.at(-1).detail, /Gemini daily quota exhausted; paused until it resets/);
  assert.equal((await registryRow(ctx)).status, "running", "a daily quota is not a failure");
});

test("retryAfterSeconds is null when the error carries no hint", async () => {
  const ctx = await seeded();
  const out = await part(ctx, { error: dailyQuota(null) }); // null, not undefined: undefined would pick the helper's 3600 default
  assert.equal(out.status, "continue", out.error);
  assert.equal(out.dailyQuota, true);
  assert.equal(out.retryAfterSeconds, null);
});

test("daily-quota pauses never count toward backtestMaxTransientStalls: even with a limit of 1, three in a row keep continuing", async () => {
  const ctx = await seeded();
  const state = { error: dailyQuota() };
  const extra = { backtestMaxTransientStalls: 1 };
  let cursor = null;
  for (let n = 1; n <= 3; n++) {
    const out = await part(ctx, state, { cursor, n, extra });
    assert.equal(out.status, "continue", `pause ${n}: ${out.error}`);
    assert.equal(out.dailyQuota, true);
    assert.equal(out.cursor.stall, undefined);
    cursor = out.cursor;
  }
  assert.equal((await registryRow(ctx)).status, "running");
});

test("once the quota is back, the parked cursor resumes and the chain completes with the SAME result as an uninterrupted run", async () => {
  const single = await seeded();
  const base = await runManualBacktest({}, config({}), single, { ...RUN, clock: new SimClock(NOW) });
  assert.equal(base.status, "complete", base.error);

  const ctx = await seeded();
  const state = { error: dailyQuota() };
  const p1 = await part(ctx, state);
  assert.equal(p1.status, "continue", p1.error);

  state.error = null; // next UTC/Pacific day: the keys are usable again
  const done = await part(ctx, state, { cursor: p1.cursor, n: 2 });
  assert.equal(done.status, "complete", done.error);
  assert.deepEqual(done.result, base.result);
  assert.equal((await registryRow(ctx)).status, "complete");
});

test("a transient Gemini error WITHOUT dailyQuota still behaves as before: delayed continuation with a stall counter, no dailyQuota flag", async () => {
  const ctx = await seeded();
  const out = await part(ctx, { error: new VendorError("gemini", "Gemini cascade exhausted: high demand", { status: 503, transient: true, retryAfterSeconds: 60 }) });
  assert.equal(out.status, "continue", out.error);
  assert.equal(out.dailyQuota, undefined);
  assert.equal(out.delaySeconds, 90);
  assert.equal(out.cursor.stall.count, 1);
});
