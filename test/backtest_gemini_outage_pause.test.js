// A Gemini outage PAUSES a budgeted backtest instead of failing it. A live run
// (backtest-1789988827184-yk8suu) died -- and its data were deleted -- 72 minutes
// in, because the Gemini client's whole model cascade came up empty for under a
// minute and runManualBacktest treats ANY throw as a failed run. Now a transient
// Gemini VendorError inside a news item's pipeline ends the part with reason
// 'transient' (walkOnSignalWindow), runManualBacktest turns that into a delayed
// continuation carrying a stall counter, and only N pauses in a row on the same
// item fail the run. Real sqlite DBs, a fake model that throws on demand.

import test from "node:test";
import assert from "node:assert/strict";
import { runManualBacktest } from "../src/backtest/runBacktest.js";
import { SimClock } from "../src/backtest/simClock.js";
import { SubrequestBudget, countedD1 } from "../src/backtest/subrequestBudget.js";
import { RunStore } from "../src/storage/run_store.js";
import { VendorError } from "../src/shared/errors.js";
import { AnalystOpinion, DebateSide, DebateVerdict, TradeThesis } from "../src/schemas/index.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { makeCtx, seedNews, seedBar, SIM_DIR } from "./helpers/engine_ctx.js";

const ID = "bt-outage";
const RUN = { id: ID, tickers: ["AAPL"], testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-04T00:00:00.000Z", graceDays: 2 };
const NOW = "2026-06-01T00:00:00.000Z";

const OUTAGE_MESSAGE = "Gemini cascade exhausted after 81234ms with no usable model [m-a#0 error 503; m-b#0 error 429]; last error: high demand";
const outage = (retryAfterSeconds = 60) => new VendorError("gemini", OUTAGE_MESSAGE, { status: 503, transient: true, retryAfterSeconds });

function healthyModel() {
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

/** A model that throws `state.error` on every call while it is set, and behaves normally otherwise -- flip it between parts to end the "outage". */
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

/** One budgeted part with a budget big enough that only the outage (never the budget) can end it early. */
function part(ctx, state, { cursor = null, n = 1, extra = {}, onProgress } = {}) {
  const budget = new SubrequestBudget({ externalLimit: 40, totalLimit: 10000 });
  return runManualBacktest({}, config(state, extra), wrap(ctx, budget), { ...RUN, cursor, budget, part: n, onProgress, clock: new SimClock(NOW) });
}

const registryRow = (ctx) => ctx.registryDb.prepare("SELECT status, error FROM backtest_runs WHERE id = ?").bind(ID).first();

test("an outage inside a news item PAUSES the run ('continue' + delay + stall counter, row still 'running'); once Gemini is back the chain completes with the SAME result as an uninterrupted run", async () => {
  const single = await seeded();
  const base = await runManualBacktest({}, config({}), single, { ...RUN, clock: new SimClock(NOW) });
  assert.equal(base.status, "complete", base.error);

  const ctx = await seeded();
  const state = { error: outage(60) };
  const updates = [];
  const p1 = await part(ctx, state, { onProgress: (u) => updates.push(u) });
  assert.equal(p1.status, "continue", p1.error);
  assert.equal(p1.reason, "transient");
  assert.equal(p1.delaySeconds, 90, "the configured pause, being longer than the cascade's 60s hint");
  assert.equal(p1.cursor.stall.count, 1);
  assert.match(p1.cursor.stall.firstError, /high demand/);
  assert.match(updates.at(-1).detail, /Gemini unavailable \(pause 1\).*part 2/);
  assert.equal((await registryRow(ctx)).status, "running", "an outage is not a failure");

  state.error = outage(300);
  const p2 = await part(ctx, state, { cursor: p1.cursor, n: 2 });
  assert.equal(p2.status, "continue", p2.error);
  assert.equal(p2.delaySeconds, 300, "the cascade's own hint wins when it is longer than the configured pause");
  assert.equal(p2.cursor.stall.count, 2, "the same item, second pause in a row");
  assert.equal(p2.cursor.stall.key, p1.cursor.stall.key);
  assert.equal(p2.cursor.stall.firstError, p1.cursor.stall.firstError, "the FIRST outage's trace is kept");

  state.error = null; // Gemini is back
  const done = await part(ctx, state, { cursor: p2.cursor, n: 3 });
  assert.equal(done.status, "complete", done.error);
  assert.deepEqual(done.result, base.result);
  assert.equal((await registryRow(ctx)).status, "complete");
});

test("the run gives up after backtestMaxTransientStalls pauses IN A ROW on the same item: 'failed', naming the count, the item and the FIRST outage's trace", async () => {
  const ctx = await seeded();
  const state = { error: outage() };
  const extra = { backtestMaxTransientStalls: 2 };

  const p1 = await part(ctx, state, { extra });
  const p2 = await part(ctx, state, { cursor: p1.cursor, n: 2, extra });
  assert.equal(p1.status, "continue");
  assert.equal(p2.status, "continue");
  assert.equal(p2.cursor.stall.count, 2, "at the limit, still allowed");

  const p3 = await part(ctx, state, { cursor: p2.cursor, n: 3, extra });
  assert.equal(p3.status, "failed");
  assert.equal(p3.cursor, undefined);
  assert.match(p3.error, /stayed unavailable through 2 consecutive pauses on the same news item/);
  assert.match(p3.error, /AAPL 2026-01-01/);
  assert.match(p3.error, /First outage: .*m-a#0 error 503; m-b#0 error 429/);
  const row = await registryRow(ctx);
  assert.equal(row.status, "failed");
  assert.match(row.error, /stayed unavailable/);
});

test("the stall counter belongs to ONE spot: a pause somewhere else starts again at 1 and keeps its own first-outage trace", async () => {
  const ctx = await seeded();
  const state = { error: outage() };
  const extra = { backtestMaxTransientStalls: 2 };
  const p1 = await part(ctx, state, { extra });

  const stale = { ...p1.cursor, stall: { key: "somewhere-else", count: 99, firstError: "an old outage" } };
  const p2 = await part(ctx, state, { cursor: stale, n: 2, extra });

  assert.equal(p2.status, "continue", "99 stalls elsewhere do not count against this item");
  assert.equal(p2.cursor.stall.count, 1);
  assert.match(p2.cursor.stall.firstError, /high demand/);
});

test("a backtestMaxTransientStalls of 0 never gives up on that ground", async () => {
  const ctx = await seeded();
  const state = { error: outage() };
  const extra = { backtestMaxTransientStalls: 0 };
  let cursor = null;
  for (let n = 1; n <= 5; n++) {
    const out = await part(ctx, state, { cursor, n, extra });
    assert.equal(out.status, "continue", `pause ${n}: ${out.error}`);
    assert.equal(out.cursor.stall.count, n);
    cursor = out.cursor;
  }
});

test("without a budget (no continuation chain to resume in) an outage still fails the run, as before", async () => {
  const ctx = await seeded();
  const out = await runManualBacktest({}, config({ error: outage() }), ctx, { ...RUN, clock: new SimClock(NOW) });
  assert.equal(out.status, "failed");
  assert.match(out.error, /Gemini cascade exhausted/);
  assert.equal((await registryRow(ctx)).status, "failed");
});

for (const [label, error, pattern] of [
  ["a NON-transient Gemini error (bad request)", new VendorError("gemini", "API key not valid", { status: 400 }), /API key not valid/],
  ["a transient error from ANOTHER vendor", new VendorError("yfinance", "quote source rate limited", { status: 429, transient: true }), /quote source rate limited/],
  ["a plain Error", new Error("boom"), /boom/],
]) {
  test(`only a transient GEMINI error pauses: ${label} still fails the run`, async () => {
    const ctx = await seeded();
    const out = await part(ctx, { error });
    assert.equal(out.status, "failed");
    assert.match(out.error, pattern);
    assert.equal((await registryRow(ctx)).status, "failed");
  });
}
