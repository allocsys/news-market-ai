// Backtest trade timeline (/dashboard/backtest/:id): the shared realized-return
// function, RunStore#listPositionsWithDecisions against a REAL sqlite D1, the
// chart/summary helpers, the view, and GET /api/backtest-runs/:id. (The
// /dashboard/backtest/:id page itself was served by the old dashboard Worker,
// retired in favor of dashboard-next.)

import test from "node:test";
import assert from "node:assert/strict";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { STATE_DIR, INPUTS_DIR, SIM_DIR } from "./helpers/engine_ctx.js";
import { RunStore } from "../src/storage/run_store.js";
import { insertBacktestRun, completeBacktestRun } from "../src/storage/sim_registry.js";
import { computeRealizedReturn } from "../src/shared/returns.js";
import { cumulativeReturns, signedPct, tradeTimelineChart, tradeTimelineDataTable, outcomeText, tradeTimelineSummary, newsBasis, backtestRunsList } from "../src/dashboard/helpers.js";
import { renderBacktestDetailView } from "../src/dashboard/views/backtest_detail.js";
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

test("cumulativeReturns compounds daily returns and treats a non-finite day as flat", () => {
  const c = cumulativeReturns([0.01, 0.02]);
  assert.ok(Math.abs(c[1] - 0.0302) < 1e-12);
  assert.deepEqual(cumulativeReturns([0.1, NaN, 0]).map((v) => Number(v.toFixed(4))), [0.1, 0.1, 0.1]);
  assert.equal(signedPct(0.012), "+1.2%");
  assert.equal(signedPct(-0.004), "-0.4%");
  assert.equal(signedPct(null), "\u2014");
});

test("tradeTimelineChart draws both curves and one marker per position, colored by outcome and shaped by side", () => {
  const html = tradeTimelineChart(SERIES, [
    { ticker: "AAPL", direction: "long", openedAt: "2026-09-15T10:00:00Z", realizedReturn: 0.1, closedAt: "x" },
    { ticker: "TSLA", direction: "short", openedAt: "2026-09-16T10:00:00Z", realizedReturn: -0.1, closedAt: "x" },
    { ticker: "MSFT", direction: null, openedAt: "2026-09-17T10:00:00Z", realizedReturn: null, closedAt: null },
  ]);
  assert.equal((html.match(/<path /g) ?? []).length, 2);
  assert.equal((html.match(/<polygon /g) ?? []).length, 2);
  assert.equal((html.match(/<circle /g) ?? []).length, 1);
  assert.ok(html.includes('fill="var(--color-success-text)"') && html.includes('fill="var(--color-danger-text)"'));
  assert.match(html, /MSFT \? opened 2026-09-17 \u2014 still open/);
  assert.match(html, /Strategy \(\+2\.5%\)/);
});

test("outcomeText and tradeTimelineDataTable give the chart a no-color, no-hover text alternative", () => {
  assert.equal(outcomeText({ realizedReturn: 0.1 }), "\u2713 profit +10.0%");
  assert.equal(outcomeText({ realizedReturn: -0.1 }), "\u2715 loss -10.0%");
  assert.equal(outcomeText({ realizedReturn: 0 }), "\u2014 flat 0.0%");
  assert.equal(outcomeText({ realizedReturn: null, closedAt: null }), "\u2014 still open");
  assert.equal(outcomeText({ realizedReturn: null, closedAt: "x" }), "\u2014 closed, return unknown");
  const html = tradeTimelineDataTable(SERIES, [{ ticker: "A<b>", direction: "long", openedAt: "2026-09-15T10:00:00Z", realizedReturn: 0.1, closedAt: "x" }]);
  assert.match(html, /<details class="llm-answer chart-data">/);
  assert.equal((html.match(/<td data-label="Date">/g) ?? []).length, 4, "one row per scored day");
  assert.ok(html.includes("+2.5%") || html.includes("+2.0%"), "cumulative return values are printed");
  assert.ok(html.includes("\u2713 profit +10.0%") && html.includes("A&lt;b&gt;") && !html.includes("A<b>"));
  assert.equal(tradeTimelineDataTable(undefined, []), "");
  assert.equal(tradeTimelineDataTable({ dates: ["a", "b"], on: [0], off: [0, 0] }, []), "");
});

test("tradeTimelineChart places a weekend open on the next scored day, clamps out-of-span opens, and escapes text", () => {
  const html = tradeTimelineChart(SERIES, [
    { ticker: "A<b>", direction: "long", openedAt: "2026-09-13T10:00:00Z", realizedReturn: 0.01, closedAt: "x" },
    { ticker: "Z", direction: "long", openedAt: "2026-09-25T00:00:00Z", realizedReturn: 0.01, closedAt: "x" },
  ]);
  assert.match(html, /<polygon points="46\.0,/, "before the span -> first scored day (left edge)");
  assert.match(html, /<polygon points="626\.0,/, "after the span -> last scored day (right edge)");
  assert.ok(html.includes("A&lt;b&gt;") && !html.includes("A<b>"));
});

test("tradeTimelineChart spreads same-day markers sideways and degrades to messages for bad or missing series", () => {
  const same = [1, 2].map((i) => ({ ticker: `T${i}`, direction: "long", openedAt: "2026-09-15T10:00:00Z", realizedReturn: 0.01, closedAt: "x" }));
  const xs = [...tradeTimelineChart(SERIES, same).matchAll(/<polygon points="([\d.]+),/g)].map((m) => Number(m[1]));
  assert.equal(xs.length, 2);
  assert.notEqual(xs[0], xs[1]);
  assert.match(tradeTimelineChart(undefined, []), /saved before daily equity curves/);
  assert.match(tradeTimelineChart({ dates: ["2026-09-14"], on: [0], off: [0] }, []), /Fewer than two/);
  assert.match(tradeTimelineChart({ dates: ["a", "b"], on: [0], off: [0, 0] }, []), /malformed/);
  assert.match(tradeTimelineChart({ dates: ["2026-09-14", "2026-09-15"], on: [0, 0], off: [0, 0] }, []), /<svg/, "a dead-flat run still draws");
});

test("tradeTimelineSummary and newsBasis", () => {
  const s = tradeTimelineSummary(SERIES, [{ realizedReturn: 0.1, closedAt: "x" }, { realizedReturn: -0.1, closedAt: "x" }, { realizedReturn: null, closedAt: null }]);
  assert.deepEqual([s.opened, s.closed, s.stillOpen, s.wins, s.losses, s.winRate], [3, 2, 1, 1, 1, 0.5]);
  assert.equal(s.from, "2026-09-14");
  assert.equal(tradeTimelineSummary(undefined, []).onReturn, null);
  assert.equal(newsBasis({ opinions: [{ agent: "news_event", eventType: "earnings", summary: "Beat" }] }), "earnings \u2014 Beat");
  assert.equal(newsBasis({ opinions: [{ agent: "technical", summary: "x" }] }), null);
  assert.equal(newsBasis(null), null);
});

function detail(overrides = {}) {
  return {
    run: { id: RUN, tickers: ["AAPL", "T<S>"], testStart: "2026-09-14T00:00:00.000Z", testEnd: "2026-09-18T00:00:00.000Z", status: "complete", result: RESULT, error: null },
    positions: [
      { ticker: "AAPL", direction: "long", positionSizePct: 0.05, entryPrice: 100, exitPrice: 110, openedAt: "2026-09-15T10:00:00.000Z", closedAt: "2026-09-16T12:00:00.000Z", closeReason: "take_profit", realizedReturn: 0.1,
        decision: { thesis: { instrument: "AAPL", rationale: "r" }, opinions: [{ agent: "news_event", eventType: "earnings", summary: "Apple beat estimates", justification: "j" }], debate: null } },
      { ticker: "TSLA", direction: "short", positionSizePct: 0.05, entryPrice: 100, exitPrice: null, openedAt: "2026-09-16T10:00:00.000Z", closedAt: null, closeReason: null, realizedReturn: null, decision: null },
    ],
    positionsError: null, truncated: false, error: null, ...overrides,
  };
}

test("renderBacktestDetailView shows headline, chart, news basis, why, P&L and an env-scoped LLM link", () => {
  const html = renderBacktestDetailView(detail());
  assert.match(html, /2 positions opened, ending with \+2\.5% for the signal against \+4\.1% for buy &amp; hold/);
  assert.match(html, /<svg/);
  assert.match(html, /earnings \u2014 Apple beat estimates/);
  assert.match(html, /\+10\.0%/);
  assert.match(html, /open<\/td>/);
  assert.match(html, /<details class="llm-answer">/);
  assert.match(html, /Not recorded for this decision/, "position with no decision row");
  assert.ok(html.includes(`env=${RUN}`) && html.includes(`llmJob=${RUN}`));
  assert.ok(html.includes("T&lt;S&gt;") && !html.includes("T<S>"));
});

test("renderBacktestDetailView shows MAE/MFE stats on position cards: signed percents when sampled, a dash when not", () => {
  const d = detail();
  const html = renderBacktestDetailView({ ...d, positions: [{ ...d.positions[0], maePct: -0.021, mfePct: 0.034 }, { ...d.positions[1], maePct: null, mfePct: null }] });
  assert.match(html, /class="pos-card"/);
  assert.doesNotMatch(html, /<th>MAE<\/th>/, "no table header any more");
  assert.match(html, /<dt[^>]*>MAE<\/dt><dd class="pos-neg">-2\.1%<\/dd>/);
  assert.match(html, /<dt[^>]*>MFE<\/dt><dd class="pos-pos">\+3\.4%<\/dd>/);
  assert.match(html, /<dt[^>]*>MAE<\/dt><dd class="pos-flat">\u2014<\/dd>/, "unsampled position shows a dash");
});

test("renderBacktestDetailView handles not-found, error, running, failed, truncated and a positions error", () => {
  assert.match(renderBacktestDetailView({ run: null }), /Backtest run not found/);
  assert.match(renderBacktestDetailView({ error: "boom" }), /boom/);
  const running = renderBacktestDetailView(detail({ run: { ...detail().run, status: "running", result: null } }));
  assert.match(running, /Still running/);
  assert.doesNotMatch(running, /<svg/);
  assert.match(renderBacktestDetailView(detail({ run: { ...detail().run, status: "failed", result: null, error: "price gap" } })), /price gap/);
  assert.match(renderBacktestDetailView(detail({ truncated: true })), /Showing the first 2 positions only/);
  assert.match(renderBacktestDetailView(detail({ positions: [], positionsError: "d1 down" })), /d1 down/);
  assert.match(renderBacktestDetailView(detail({ positions: [] })), /no positions/);
});

const RUNNING_RUN = "backtest-1789990000000-runnin";
const STILL_RUNNING = /Still running/;
const PROGRESS_BAR = /id="run-progress-bar"/;
const runningRun = () => ({ ...detail().run, status: "running", result: null });
const activeJob = () => ({ id: RUN, type: "backtest", status: "running", params: { tickers: ["AAPL"], testStart: "2026-09-14", testEnd: "2026-09-18" } });

test("renderBacktestDetailView swaps the static 'Still running' text for a live progress panel when given an activeJob", () => {
  const html = renderBacktestDetailView(detail({ run: runningRun(), activeJob: activeJob() }));
  assert.match(html, PROGRESS_BAR);
  assert.ok(html.includes(`var pollUrl = "/dashboard/jobs/${RUN}?env=${RUN}";`));
  assert.match(html, /var reloadOnComplete = true;/);
  assert.doesNotMatch(html, STILL_RUNNING);
  assert.doesNotMatch(html, /<svg/, "the equity chart still waits for a complete run");
});

test("renderBacktestDetailView keeps the static 'Still running' text with no activeJob, or an activeJob it cannot draw (no id)", () => {
  for (const active of [undefined, null, {}, { status: "running" }]) {
    const html = renderBacktestDetailView(detail({ run: runningRun(), activeJob: active }));
    assert.match(html, STILL_RUNNING, `activeJob=${JSON.stringify(active)}`);
    assert.doesNotMatch(html, PROGRESS_BAR);
  }
});

test("renderBacktestDetailView ignores an activeJob once the run is failed or complete", () => {
  const failed = renderBacktestDetailView(detail({ run: { ...runningRun(), status: "failed", error: "price gap" }, activeJob: activeJob() }));
  assert.match(failed, /price gap/);
  assert.doesNotMatch(failed, PROGRESS_BAR);
  const complete = renderBacktestDetailView(detail({ activeJob: activeJob() }));
  assert.match(complete, /<svg/);
  assert.doesNotMatch(complete, PROGRESS_BAR);
});

test("backtestRunsList links to the timeline for complete runs only", () => {
  const run = (status) => ({ id: RUN, tickers: ["AAPL"], testStart: "2026-09-14T00:00:00.000Z", testEnd: "2026-09-18T00:00:00.000Z", status, result: null, error: "e" });
  assert.ok(backtestRunsList([{ ...run("complete"), result: RESULT }]).includes(`href="/dashboard/backtest/${RUN}"`));
  assert.ok(!backtestRunsList([run("running")]).includes("View trade timeline"));
  assert.ok(!backtestRunsList([run("failed")]).includes("View trade timeline"));
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

