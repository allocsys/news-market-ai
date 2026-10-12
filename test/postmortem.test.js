// Post-mortem: the pure classifier (analysis/postmortem.js) and GET /api/postmortem over a REAL sqlite D1.

import test from "node:test";
import assert from "node:assert/strict";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { STATE_DIR, INPUTS_DIR, SIM_DIR } from "./helpers/engine_ctx.js";
import { RunStore } from "../src/storage/run_store.js";
import { insertBacktestRun, completeBacktestRun } from "../src/storage/sim_registry.js";
import { classifyPosition, summarizePositions, classifyMissed, summarizeMissed, compareDecisions, analystView, confidenceBucket, TAGS } from "../src/analysis/postmortem.js";
import backendWorker from "../src/index.js";

const opinions = (dir) => [{ agent: "price_impact", priceDirection: dir, relevance: "direct" }];
const pos = (over = {}) => ({
  id: "X|1", ticker: "X", direction: "long", openedAt: "2026-09-15T10:00:00.000Z", closedAt: "2026-09-16T10:00:00.000Z",
  closeReason: "stop_loss", realizedReturn: -0.04, stopLossPct: 0.04, maePct: -0.04, mfePct: 0.001,
  decision: { opinions: opinions("bullish"), debate: { direction: "long", confidence: 0.85 }, thesis: { direction: "long" } },
  ...over,
});

test("analystView / confidenceBucket read stored opinions defensively", () => {
  assert.deepEqual(analystView(opinions("bearish")), { direction: "short", relevance: "direct", channel: null });
  assert.equal(analystView(null).direction, "flat");
  assert.equal(analystView(opinions("neutral")).direction, "flat");
  assert.equal(confidenceBucket(0.85), "0.8+");
  assert.equal(confidenceBucket(0.75), "0.7-0.8");
  assert.equal(confidenceBucket(0.5), "<0.7");
  assert.equal(confidenceBucket(null), "unknown");
});

test("classifyPosition: open, no return, win", () => {
  assert.equal(classifyPosition(pos({ closedAt: null })).tag, TAGS.OPEN);
  assert.equal(classifyPosition(pos({ realizedReturn: null })).tag, TAGS.NO_RETURN);
  const w = classifyPosition(pos({ realizedReturn: 0.03, closeReason: "take_profit" }));
  assert.equal(w.tag, TAGS.WIN);
  assert.equal(w.stage, null, "wins carry no blame");
});

test("classifyPosition: stop-loss losses split on whether the trade was ever in profit", () => {
  assert.equal(classifyPosition(pos()).tag, TAGS.LOSS_WRONG_FROM_START);
  assert.equal(classifyPosition(pos({ mfePct: 0.02 })).tag, TAGS.LOSS_REVERSED);
  assert.equal(classifyPosition(pos({ mfePct: null })).tag, TAGS.LOSS_WRONG_FROM_START, "never sampled -> not 'in profit'");
});

test("classifyPosition: flips, and a flip that filled past an already-breached stop", () => {
  const flip = classifyPosition(pos({ closeReason: "flipped", realizedReturn: -0.07, maePct: -0.02 }));
  assert.equal(flip.tag, TAGS.LOSS_FLIP);
  const pre = classifyPosition(pos({ closeReason: "flipped", realizedReturn: -0.07, maePct: -0.05 }));
  assert.equal(pre.tag, TAGS.LOSS_STOP_PRE_EMPTED);
  assert.equal(classifyPosition(pos({ closeReason: "replaced", realizedReturn: -0.01, maePct: -0.01 })).tag, TAGS.LOSS_FLIP);
});

test("classifyPosition: other close reasons", () => {
  assert.equal(classifyPosition(pos({ closeReason: "time_based" })).tag, TAGS.LOSS_TIME_EXIT);
  assert.equal(classifyPosition(pos({ closeReason: "manual" })).tag, TAGS.LOSS_OTHER);
});

test("classifyPosition: blame goes to the first stage that called the losing direction", () => {
  assert.equal(classifyPosition(pos()).stage, "analyst", "analyst, debate and thesis all long");
  const debate = classifyPosition(pos({ decision: { opinions: opinions("bearish"), debate: { direction: "long", confidence: 0.8 }, thesis: { direction: "long" } } }));
  assert.equal(debate.stage, "debate", "debate overrode an opposite analyst");
  const trader = classifyPosition(pos({ decision: { opinions: opinions("bearish"), debate: { direction: "short", confidence: 0.8 }, thesis: { direction: "long" } } }));
  assert.equal(trader.stage, "trader");
  assert.equal(classifyPosition(pos({ decision: null, direction: null })).stage, "unknown");
});

test("summarizePositions aggregates by tag and reports whether every stage always agreed", () => {
  const s = summarizePositions([
    pos({ id: "a", realizedReturn: 0.03, closeReason: "take_profit" }),
    pos({ id: "b" }),
    pos({ id: "c", closeReason: "flipped", realizedReturn: -0.07, maePct: -0.02 }),
    pos({ id: "d", closedAt: null, realizedReturn: null }),
  ]);
  assert.equal(s.n, 4);
  assert.equal(s.open, 1);
  assert.equal(s.scored, 3);
  assert.ok(Math.abs(s.winRate - 1 / 3) < 1e-12);
  assert.ok(Math.abs(s.sumReturn - -0.08) < 1e-12);
  assert.deepEqual(s.byTag.map((g) => g.key), [TAGS.LOSS_FLIP, TAGS.LOSS_WRONG_FROM_START, TAGS.WIN], "worst total first");
  assert.equal(s.stagesAlwaysAgreed, true);
  assert.equal(summarizePositions([pos({ decision: { opinions: opinions("bearish"), debate: { direction: "long" }, thesis: { direction: "long" } } })]).stagesAlwaysAgreed, false);
  assert.equal(summarizePositions([]).winRate, null);
});

// Hourly bars starting at the decision time.
const T0 = Date.parse("2026-09-15T10:00:00.000Z");
const bar = (h, open, high, low) => ({ tsMs: T0 + h * 3600000, open, high, low });

test("classifyMissed: target first -> missed winner; stop first -> good skip; neither -> inconclusive; stop wins ties", () => {
  const long = { asOf: "2026-09-15T10:00:00.000Z", thesis: { direction: "long" }, riskDecision: { stopLossPct: 0.02, takeProfitPct: 0.04 } };
  const up = classifyMissed(long, [bar(0, 100, 101, 99.5), bar(1, 101, 105, 100.5)]);
  assert.equal(up.outcome, "missed_winner");
  assert.equal(up.hoursToHit, 1);
  assert.equal(classifyMissed(long, [bar(0, 100, 100.5, 97)]).outcome, "good_skip");
  assert.equal(classifyMissed(long, [bar(0, 100, 105, 97)]).outcome, "good_skip", "a bar touching both counts as stop-first");
  const flat = classifyMissed(long, [bar(0, 100, 101, 99.5), bar(1, 100.5, 101.5, 99.6)]);
  assert.equal(flat.outcome, "inconclusive");
  assert.ok(Math.abs(flat.forwardMovePct - 0.015) < 1e-12);

  const short = { asOf: "2026-09-15T10:00:00.000Z", thesis: { direction: "short" }, riskDecision: { stopLossPct: 0.02, takeProfitPct: 0.04 } };
  assert.equal(classifyMissed(short, [bar(0, 100, 100.5, 95)]).outcome, "missed_winner");
});

test("classifyMissed: no data for flat thesis, bad time, no bars, and bars past the horizon are ignored", () => {
  const base = { asOf: "2026-09-15T10:00:00.000Z", thesis: { direction: "long" } };
  assert.equal(classifyMissed({ ...base, thesis: { direction: "flat" } }, [bar(0, 100, 101, 99)]).outcome, "no_data");
  assert.equal(classifyMissed({ ...base, asOf: "nope" }, [bar(0, 100, 101, 99)]).outcome, "no_data");
  assert.equal(classifyMissed(base, []).outcome, "no_data");
  assert.equal(classifyMissed(base, [bar(0, 100, 100.5, 99.5), bar(100, 100, 200, 50)]).outcome, "inconclusive", "the 100h bar is past the 72h horizon");
});

test("summarizeMissed tallies per status and overall", () => {
  const s = summarizeMissed([
    { status: "held", outcome: "missed_winner" },
    { status: "held", outcome: "good_skip" },
    { status: "rejected", outcome: "missed_winner" },
  ]);
  assert.equal(s.total, 3);
  assert.deepEqual(s.byOutcome, { missed_winner: 2, good_skip: 1 });
  assert.deepEqual(s.byStatus.held, { missed_winner: 1, good_skip: 1 });
});

test("compareDecisions matches on id and reports agreement + confidence delta", () => {
  const a = [{ id: "1", status: "opened", direction: "long", confidence: 0.8 }, { id: "2", status: "held", direction: "long", confidence: 0.6 }, { id: "3", status: "held", direction: null, confidence: null }];
  const b = [{ id: "1", status: "opened", direction: "long", confidence: 0.9 }, { id: "2", status: "rejected", direction: "short", confidence: 0.5 }, { id: "9", status: "held", direction: "long", confidence: 0.5 }];
  const c = compareDecisions(a, b);
  assert.equal(c.matched, 2);
  assert.equal(c.sameDirection, 1);
  assert.equal(c.sameStatus, 1);
  assert.equal(c.directionAgreement, 0.5);
  assert.ok(Math.abs(c.avgConfidenceDeltaBMinusA - 0) < 1e-12, "(+0.1 + -0.1) / 2");
  assert.equal(compareDecisions([], []).directionAgreement, null);
});

// ---- GET /api/postmortem ----

const RUN_A = "backtest-1789988827184-aaa111";
const RUN_B = "backtest-1789988827185-bbb222";
const SIDE = { n: 4, cumulativeReturn: 0.02, meanReturn: 0, sharpeRatio: 1, maxDrawdown: 0.01, winRate: 0.5 };
const RESULT = { overall: { on: SIDE, off: SIDE, delta: { cumulativeReturn: 0, sharpeRatio: 0, winRate: 0, maxDrawdown: 0 } }, perWindow: [{}] };

function seedThesis(store, { ticker, asOf, direction = "long", opinions: ops = null, debate = null }) {
  const id = `${ticker}|${asOf}`;
  return store.commitThesis({
    id, ticker, tradeThesisId: id, positionSizePct: 0.05, direction, entryPrice: 100, stopLossPct: 0.03, takeProfitPct: 0.06, asOf,
    thesis: { ticker, direction, rationale: `why ${ticker}` }, riskDecision: { approved: true, positionSizePct: 0.05 }, opinions: ops, debate, createdAt: asOf,
  });
}

async function seededEnv() {
  const sim = createTestD1([STATE_DIR, SIM_DIR]);
  for (const id of [RUN_A, RUN_B]) {
    await insertBacktestRun(sim, { id, tickers: ["AAPL", "TSLA"], testStart: "2026-09-14T00:00:00.000Z", testEnd: "2026-09-18T00:00:00.000Z", trainDays: 0, testDays: 4, startedAt: "2026-09-19T00:00:00.000Z" });
    await completeBacktestRun(sim, { id, result: RESULT, finishedAt: "2026-09-19T01:00:00.000Z" });
  }
  const a = new RunStore(sim, RUN_A);
  const debate = { direction: "long", confidence: 0.8 };
  await seedThesis(a, { ticker: "AAPL", asOf: "2026-09-15T10:00:00.000Z", opinions: opinions("bullish"), debate });
  await seedThesis(a, { ticker: "TSLA", asOf: "2026-09-16T10:00:00.000Z", direction: "short", opinions: opinions("bullish"), debate: { direction: "short", confidence: 0.7 } });
  await a.closePosition({ id: "AAPL|2026-09-15T10:00:00.000Z", closedAt: "2026-09-16T12:00:00.000Z", closeReason: "take_profit", exitPrice: 110 });
  await a.closePosition({ id: "TSLA|2026-09-16T10:00:00.000Z", closedAt: "2026-09-17T12:00:00.000Z", closeReason: "stop_loss", exitPrice: 110 });
  await seedThesis(new RunStore(sim, RUN_B), { ticker: "AAPL", asOf: "2026-09-15T10:00:00.000Z", opinions: opinions("bullish"), debate });
  return { LIVE_DB: createTestD1([STATE_DIR]), INPUTS_DB: createTestD1([INPUTS_DIR]), SIM_DB: sim };
}

test("GET /api/postmortem validates ids, 404s an unknown run, and tags a real run's positions", async () => {
  const env = await seededEnv();
  const get = (qs) => backendWorker.fetch(new Request(`https://backend.example/api/postmortem${qs}`), env);
  assert.equal((await get("")).status, 400);
  assert.equal((await get("?runId=nope!")).status, 400);
  assert.equal((await get(`?runId=${RUN_A}&compareTo=nope!`)).status, 400);
  assert.equal((await get("?runId=backtest-1-abc")).status, 404);

  const res = await get(`?runId=${RUN_A}&missed=0`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.run.id, RUN_A);
  assert.equal(body.summary.n, 2);
  assert.deepEqual(body.summary.positions.map((p) => [p.ticker, p.tag]), [["AAPL", TAGS.WIN], ["TSLA", TAGS.LOSS_WRONG_FROM_START]]);
  assert.equal(body.summary.positions[1].stage, "debate", "TSLA short: analyst said bullish, the debate called the short");
  assert.equal(body.missed, null, "missed=0 skips the look-ahead");
  assert.equal(body.decisions, undefined, "per-decision rows are not shipped on the single-run route");
  assert.equal(body.statusCounts.opened, 2);
});

test("GET /api/postmortem?runId=A&compareTo=B compares two runs, and 404s when either is missing", async () => {
  const env = await seededEnv();
  const get = (qs) => backendWorker.fetch(new Request(`https://backend.example/api/postmortem${qs}`), env);
  const res = await get(`?runId=${RUN_A}&compareTo=${RUN_B}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.a.run.id, RUN_A);
  assert.equal(body.b.run.id, RUN_B);
  assert.equal(body.comparison.matched, 1);
  assert.equal(body.comparison.sameDirection, 1);
  assert.equal(body.a.decisions, undefined);
  assert.equal((await get(`?runId=backtest-1-abc&compareTo=${RUN_B}`)).status, 404);
  assert.equal((await get(`?runId=${RUN_A}&compareTo=backtest-1-abc`)).status, 404);
});
