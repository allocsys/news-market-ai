// The trend filter wired through graph/pipeline.js, on real sqlite state + inputs DBs (knobs trendFilterAgainst / trendFilterMixed, default OFF).
// Seeded markets give a known technicalAlignment for a LONG: falling closes + price below -> 'against'; flat closes + price far above -> 'mixed';
// rising closes + price above -> 'with'. A block takes the REJECTED path (no position) and records decision.debate.evidence.trendFilter.

import test from "node:test";
import assert from "node:assert/strict";
import { runPipelineForTicker } from "../src/graph/pipeline.js";
import { TRADE_DECISION_STATUS } from "../src/shared/constants.js";
import { makeCtx, seedBarOhlc, seedIntradayBar, stateRows } from "./helpers/engine_ctx.js";
import { makeFakeLongModel } from "./helpers/fake_long_model.js";

const ASOF = "2026-01-15T13:36:00Z";
const newsItem = { id: "news-1", tickers: ["AAPL"], title: "AAPL news", body: "body", publishedAt: ASOF };

const MARKETS = {
  against: { closes: [100, 110, 120, 130, 140, 150, 160, 170, 180, 190], price: 110 }, // newest first: falling into the entry
  mixed: { closes: Array(10).fill(150), price: 190 },
  with: { closes: [190, 180, 170, 160, 150, 140, 130, 120, 110, 100], price: 200 },
};

async function run(market, extra = {}) {
  const ctx = makeCtx();
  const { closes, price } = MARKETS[market];
  for (let i = 0; i < 10; i++) {
    const date = new Date(Date.parse("2026-01-14T00:00:00Z") - i * 86400000).toISOString().slice(0, 10);
    await seedBarOhlc(ctx.inputs, { ticker: "AAPL", date, open: closes[i], high: closes[i] + 5, low: closes[i] - 5, close: closes[i] });
  }
  await seedIntradayBar(ctx.inputs, { ticker: "AAPL", ts: "2026-01-15T13:30:00Z", close: price });
  const cfg = { geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, maxPositionHoldDays: 10, fakeModel: makeFakeLongModel(), ...extra };
  const originalError = console.error;
  console.error = () => {};
  let decision;
  try {
    decision = await runPipelineForTicker({}, cfg, ctx, { pipelineRunId: "news-1", ticker: "AAPL", newsItem, asOf: ASOF });
  } finally {
    console.error = originalError;
  }
  const [row] = await stateRows(ctx.stateDb, "trade_decisions");
  return { decision, row, debate: JSON.parse(row.debate), positions: await stateRows(ctx.stateDb, "positions") };
}

test("trend filter OFF (default): every alignment opens and no trendFilter evidence is written", async () => {
  for (const market of ["against", "mixed", "with"]) {
    const { decision, row, debate, positions } = await run(market);
    assert.equal(debate.evidence.technicalAlignment, market, market);
    assert.equal(decision.approvedForExecution, true, market);
    assert.equal(row.status, TRADE_DECISION_STATUS.OPENED, market);
    assert.equal(positions.length, 1, market);
    assert.equal(debate.evidence.trendFilter, undefined, market);
  }
});

test("trendFilterAgainst ON: an 'against' entry is REJECTED -- no position, reason and evidence recorded", async () => {
  const { decision, row, debate, positions } = await run("against", { trendFilterAgainst: true });
  assert.equal(decision.approvedForExecution, false);
  assert.equal(decision.finalPositionSizePct, 0);
  assert.match(decision.reason, /^trend filter: entry is against the trend$/);
  assert.equal(positions.length, 0);
  assert.equal(row.status, TRADE_DECISION_STATUS.REJECTED);
  assert.deepEqual([debate.evidence.trendFilter.applied, debate.evidence.trendFilter.blocked, debate.evidence.trendFilter.alignment], [true, true, "against"]);
});

test("trendFilterAgainst ON: 'mixed' and 'with' entries still open, and the pass is recorded", async () => {
  for (const market of ["mixed", "with"]) {
    const { decision, row, debate, positions } = await run(market, { trendFilterAgainst: true });
    assert.equal(decision.approvedForExecution, true, market);
    assert.equal(row.status, TRADE_DECISION_STATUS.OPENED, market);
    assert.equal(positions.length, 1, market);
    assert.equal(debate.evidence.trendFilter.blocked, false, market);
    assert.equal(debate.evidence.trendFilter.alignment, market, market);
  }
});

test("trendFilterMixed ON: a 'mixed' entry is REJECTED, an 'against' one is not", async () => {
  const mixed = await run("mixed", { trendFilterMixed: true });
  assert.equal(mixed.decision.approvedForExecution, false);
  assert.match(mixed.decision.reason, /^trend filter: entry is mixed the trend$/);
  assert.equal(mixed.positions.length, 0);
  assert.equal(mixed.row.status, TRADE_DECISION_STATUS.REJECTED);
  const against = await run("against", { trendFilterMixed: true });
  assert.equal(against.decision.approvedForExecution, true);
  assert.equal(against.positions.length, 1);
});

test("both selected: 'against' and 'mixed' are REJECTED, 'with' opens", async () => {
  const both = { trendFilterAgainst: true, trendFilterMixed: true };
  for (const market of ["against", "mixed"]) {
    const out = await run(market, both);
    assert.equal(out.decision.approvedForExecution, false, market);
    assert.equal(out.positions.length, 0, market);
    assert.equal(out.row.status, TRADE_DECISION_STATUS.REJECTED, market);
  }
  const withTrend = await run("with", both);
  assert.equal(withTrend.decision.approvedForExecution, true);
  assert.equal(withTrend.positions.length, 1);
  assert.equal(withTrend.debate.evidence.trendFilter.blocked, false);
});
