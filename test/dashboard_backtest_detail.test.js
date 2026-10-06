// Backtest trade timeline data path: the shared realized-return function,
// RunStore#listPositionsWithDecisions against a REAL sqlite D1, and
// GET /api/backtest-runs/:id. (The server-rendered /dashboard/backtest/:id
// page and its chart/summary helpers were retired in favor of dashboard-next.)

import test from "node:test";
import assert from "node:assert/strict";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { STATE_DIR, INPUTS_DIR, SIM_DIR } from "./helpers/engine_ctx.js";
import { RunStore } from "../src/storage/run_store.js";
import { insertBacktestRun, completeBacktestRun } from "../src/storage/sim_registry.js";
import { computeRealizedReturn } from "../src/shared/returns.js";
import backendWorker from "../src/index.js";

const RUN = "backtest-1789988827184-yk8suu";
const SERIES = { dates: ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17"], on: [0, 0.01, -0.005, 0.02], off: [0.01, 0.01, 0.01, 0.01], onExposure: [0, 0.05, 0.05, 0.05] };
const SIDE = { n: 4, cumulativeReturn: 0.02, meanReturn: 0, sharpeRatio: 1, maxDrawdown: 0.01, winRate: 0.5 };
const RESULT = { overall: { on: SIDE, off: SIDE, delta: { cumulativeReturn: 0, sharpeRatio: 0, winRate: 0, maxDrawdown: 0 } }, perWindow: [{}], portfolio: { series: SERIES, days: 4, from: "2026-09-14", to: "2026-09-18", tickers: ["AAPL", "TSLA"], on: {}, off: {} } };

function seedThesis(store, { ticker, asOf, direction = "long", opinions = null, debate = null }) {
  const id = `${ticker}|${asOf}`;
  return store.commitThesis({
    id, ticker, tradeThesisId: id, positionSizePct: 0.05, direction, entryPrice: 100, stopLossPct: 0.03, takeProfitPct: 0.06, asOf,
    thesis: { ticker, direction, rationale: `why ${ticker}` }, riskDecision: { approved: true, positionSizePct: 0.05 }, opinions, debate, createdAt: asOf,
  });
}

async function seededSim() {
  const sim = createTestD1([STATE_DIR, SIM_DIR]);
  await insertBacktestRun(sim, { id: RUN, tickers: ["AAPL", "TSLA"], testStart: "2026-09-14T00:00:00.000Z", testEnd: "2026-09-18T00:00:00.000Z", trainDays: 0, testDays: 4, startedAt: "2026-09-19T00:00:00.000Z" });
  await completeBacktestRun(sim, { id: RUN, result: RESULT, finishedAt: "2026-09-19T01:00:00.000Z" });
  const store = new RunStore(sim, RUN);
  const news = [{ agent: "news_event", eventType: "earnings", summary: "Apple beat estimates", justification: "j" }];
  await seedThesis(store, { ticker: "AAPL", asOf: "2026-09-15T10:00:00.000Z", opinions: news });
  await seedThesis(store, { ticker: "TSLA", asOf: "2026-09-16T10:00:00.000Z", direction: "short" });
  // Older asOf than the AAPL position already open -> a 'superseded' decision with NO position.
  await seedThesis(store, { ticker: "AAPL", asOf: "2026-09-14T10:00:00.000Z" });
  await store.closePosition({ id: "AAPL|2026-09-15T10:00:00.000Z", closedAt: "2026-09-16T12:00:00.000Z", closeReason: "take_profit", exitPrice: 110 });
  await store.closePosition({ id: "TSLA|2026-09-16T10:00:00.000Z", closedAt: "2026-09-17T12:00:00.000Z", closeReason: "stop_loss", exitPrice: 110 });
  return sim;
}

test("computeRealizedReturn is direction-aware and never fabricates", () => {
  assert.equal(computeRealizedReturn({ direction: "long", entryPrice: 100, exitPrice: 110 }), 0.1);
  assert.equal(computeRealizedReturn({ direction: "short", entryPrice: 100, exitPrice: 110 }), -0.1);
  assert.equal(computeRealizedReturn({ direction: "long", entryPrice: 100, exitPrice: null }), null);
  assert.equal(computeRealizedReturn({ direction: null, entryPrice: 100, exitPrice: 110 }), null);
});

test("listPositionsWithDecisions joins each position to its decision, omits position-less decisions, and is run-scoped", async () => {
  const sim = await seededSim();
  await seedThesis(new RunStore(sim, "backtest-2-other"), { ticker: "MSFT", asOf: "2026-09-15T10:00:00.000Z" });
  const { positions, truncated } = await new RunStore(sim, RUN).listPositionsWithDecisions();
  assert.equal(truncated, false);
  assert.deepEqual(positions.map((p) => p.ticker), ["AAPL", "TSLA"], "oldest first; superseded decision and other run excluded");
  assert.equal(positions[0].exitPrice, 110);
  assert.equal(positions[0].decision.status, "opened");
  assert.equal(positions[0].decision.opinions[0].summary, "Apple beat estimates");
  assert.equal(positions[1].decision.opinions, null);
});

test("listPositionsWithDecisions reports truncation instead of silently cutting off, and null decision when none exists", async () => {
  const sim = await seededSim();
  const store = new RunStore(sim, RUN);
  const { positions, truncated } = await store.listPositionsWithDecisions({ limit: 1 });
  assert.equal(positions.length, 1);
  assert.equal(truncated, true);
  await store.openPosition({ id: "MSFT|x", ticker: "MSFT", tradeThesisId: "MSFT|x", positionSizePct: 0.02, direction: "long", entryPrice: 5, openedAt: "2026-09-18T00:00:00.000Z" });
  const all = await store.listPositionsWithDecisions();
  assert.equal(all.positions.at(-1).decision, null);
});

test("listPositionsWithDecisions returns each position's stored MAE/MFE, null until a check has sampled it", async () => {
  const sim = await seededSim();
  await sim.prepare(`UPDATE positions SET mae_pct = ?, mfe_pct = ? WHERE run_id = ? AND id = ?`).bind(-0.021, 0.034, RUN, "AAPL|2026-09-15T10:00:00.000Z").run();
  const { positions } = await new RunStore(sim, RUN).listPositionsWithDecisions();
  assert.equal(positions[0].maePct, -0.021);
  assert.equal(positions[0].mfePct, 0.034);
  assert.equal(positions[1].maePct, null, "never sampled -> null, not 0");
  assert.equal(positions[1].mfePct, null);
});

async function backendEnv() {
  return { LIVE_DB: createTestD1([STATE_DIR]), INPUTS_DB: createTestD1([INPUTS_DIR]), SIM_DB: await seededSim() };
}

test("GET /api/backtest-runs/:id returns 400 for a malformed id, 404 for an unknown one, and run + positions with realized returns", async () => {
  const env = await backendEnv();
  const get = (path) => backendWorker.fetch(new Request(`https://backend.example${path}`), env);
  assert.equal((await get("/api/backtest-runs/nope!")).status, 400);
  assert.equal((await get("/api/backtest-runs/backtest-1-abc")).status, 404);
  const res = await get(`/api/backtest-runs/${RUN}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.run.id, RUN);
  assert.deepEqual(body.positions.map((p) => [p.ticker, p.realizedReturn]), [["AAPL", 0.1], ["TSLA", -0.1]]);
  assert.equal(body.truncated, false);
  assert.equal((await get("/api/backtest-runs")).status, 200, "the list route is unaffected");
});

test("GET /api/backtest-runs/:id nets realizedReturn by the run's recorded tradeCostBps (round trip = 2 sides) and stays gross when no knobs were recorded", async () => {
  const env = await backendEnv();
  const get = async () => (await backendWorker.fetch(new Request(`https://backend.example/api/backtest-runs/${RUN}`), env)).json();
  const returns = async () => (await get()).positions.map((p) => p.realizedReturn);
  assert.deepEqual(await returns(), [0.1, -0.1], "no result.knobs -> gross, exactly as the run computed it");

  // 50 bps per side -> 100 bps round trip = 0.01 off every closed position.
  const withKnobs = { ...RESULT, knobs: { tradeCostBps: 50 } };
  await env.SIM_DB.prepare(`UPDATE backtest_runs SET result = ? WHERE id = ?`).bind(JSON.stringify(withKnobs), RUN).run();
  const [aapl, tsla] = await returns();
  assert.ok(Math.abs(aapl - 0.09) < 1e-12, `long: 0.10 - 0.01, got ${aapl}`);
  assert.ok(Math.abs(tsla - -0.11) < 1e-12, `short: -0.10 - 0.01, got ${tsla}`);

  // A zero (costs off) or non-numeric recorded value is gross too.
  for (const tradeCostBps of [0, null, "5"]) {
    await env.SIM_DB.prepare(`UPDATE backtest_runs SET result = ? WHERE id = ?`).bind(JSON.stringify({ ...RESULT, knobs: { tradeCostBps } }), RUN).run();
    assert.deepEqual(await returns(), [0.1, -0.1], `tradeCostBps=${JSON.stringify(tradeCostBps)}`);
  }
});
