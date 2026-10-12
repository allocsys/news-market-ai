// Fix #1: confidence is not raised by analyst agreement. Judge prompts carry the evidence rule, and each decision
// stores an evidence record (decision.debate.evidence) so confidence can be checked against realized outcomes.
// The record never changes confidence, size or entries.

import test from "node:test";
import assert from "node:assert/strict";
import { collectEvidence, technicalAlignment, INDEPENDENCE_NOTE } from "../src/agents/managers/evidence.js";
import { classifyPosition, summarizePositions } from "../src/analysis/postmortem.js";
import { runPipelineForTicker } from "../src/graph/pipeline.js";
import { makeCtx, seedBar, seedIntradayBar, seedNews, stateRows } from "./helpers/engine_ctx.js";
import { makeFakeLongModel } from "./helpers/fake_long_model.js";
import { DebateVerdict, MergedVerdict } from "../src/schemas/index.js";

const snap = (over = {}) => ({ hasData: true, latestClose: 100, sma: 95, priceChangePct: 0.05, ...over });

test("technicalAlignment: with / against / mixed / unknown", () => {
  assert.equal(technicalAlignment(snap(), "long"), "with");
  assert.equal(technicalAlignment(snap(), "short"), "against");
  assert.equal(technicalAlignment(snap({ priceChangePct: -0.05 }), "long"), "mixed");
  assert.equal(technicalAlignment(snap({ sma: null }), "long"), "unknown");
  assert.equal(technicalAlignment({ hasData: false }, "long"), "unknown");
  assert.equal(technicalAlignment(snap(), "flat"), "unknown");
  assert.equal(technicalAlignment(snap({ currentPrice: 90 }), "long"), "mixed", "uses the current price when there is one");
});

test("collectEvidence keeps the raw confidence and the features, and survives missing input", () => {
  const opinions = [
    { agent: "price_impact", relevance: "direct", priceDirection: "bullish" },
    { agent: "sentiment", sentiment: "positive" },
  ];
  const e = collectEvidence({ verdict: { direction: "long", confidence: 0.9 }, opinions, snapshot: snap({ currentPrice: 104, currentVsLatestClosePct: 0.04 }) });
  assert.deepEqual(e, {
    rawConfidence: 0.9, relevance: "direct", technicalAlignment: "with", currentPriceUsed: true, currentVsLatestClosePct: 0.04,
    macroContext: false, analystsWithSide: 2, analystsAgreeing: 2,
  });
  const empty = collectEvidence({ verdict: { direction: "long", confidence: 0.7 }, opinions: null, snapshot: null });
  assert.equal(empty.relevance, null);
  assert.equal(empty.technicalAlignment, "unknown");
});

async function run(configOver = {}) {
  const ctx = makeCtx();
  const publishedAt = "2026-01-07T09:35:00.000Z";
  await seedNews(ctx.inputs, { id: "n1", tickers: ["AAPL"], publishedAt, title: "AAPL beats", body: "body" });
  for (const [i, c] of [90, 92, 94, 96, 100].entries()) await seedBar(ctx.inputs, { ticker: "AAPL", date: `2026-01-0${i + 1}`, close: c });
  await seedIntradayBar(ctx.inputs, { ticker: "AAPL", ts: "2026-01-07T09:25:00Z", close: 104 });
  const prompts = { judge: null, trader: null };
  const longModel = makeFakeLongModel();
  const config = {
    geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, maxPositionHoldDays: 10, intradayTechnical: true, independenceNote: true, ...configOver,
    fakeModel: async (p, opts) => {
      if (opts.schema === DebateVerdict || opts.schema === MergedVerdict) prompts.judge = p;
      if (/^You are a trader/.test(p)) prompts.trader = p;
      if (opts.schema === MergedVerdict) {
        return JSON.stringify({ bull: { argument: "b", justification: "j" }, bear: { argument: "r", justification: "j" }, direction: "long", confidence: 0.8, timeHorizon: "days", justification: "j" });
      }
      return longModel(p, opts);
    },
  };
  await runPipelineForTicker({}, config, ctx, {
    pipelineRunId: "run-1", ticker: "AAPL", asOf: publishedAt,
    newsItem: { id: "n1", tickers: ["AAPL"], title: "AAPL beats", body: "body", publishedAt },
  });
  return { ctx, prompts };
}

for (const [name, over] of [["debate judge", {}], ["merged judge", { mergedVerdict: true }]]) {
  test(`${name}: the prompt carries the evidence rule; independenceNote=false removes it`, async () => {
    const on = await run(over);
    assert.ok(on.prompts.judge.includes("EVIDENCE RULE"));
    const off = await run({ ...over, independenceNote: false });
    assert.ok(!off.prompts.judge.includes("EVIDENCE RULE"));
    const dflt = await run({ ...over, independenceNote: undefined });
    assert.ok(!dflt.prompts.judge.includes("EVIDENCE RULE"), "OFF by default: a config without the flag carries no evidence rule");
  });
}

test("the decision stores the evidence next to the verdict, without changing confidence, and the trader prompt does not see it", async () => {
  const { ctx, prompts } = await run();
  const [d] = await stateRows(ctx.stateDb, "trade_decisions");
  const debate = JSON.parse(d.debate);
  assert.ok(debate.evidence, "evidence stored");
  assert.equal(debate.evidence.rawConfidence, debate.confidence, "raw confidence is the judge's own number, untouched");
  assert.equal(debate.evidence.currentPriceUsed, true);
  assert.equal(debate.evidence.technicalAlignment, "with");
  if (prompts.trader) assert.ok(!prompts.trader.includes("rawConfidence"), "evidence is not printed into the trader prompt");
});

test("postmortem groups scored trades by technical alignment", () => {
  const pos = (alignment, ret) => ({ id: `${alignment}${ret}`, ticker: "A", direction: "long", realizedReturn: ret, closedAt: "x", closeReason: "stop_loss", decision: { opinions: [], debate: { direction: "long", confidence: 0.8, evidence: alignment ? { technicalAlignment: alignment } : undefined }, thesis: { direction: "long" } } });
  assert.equal(classifyPosition(pos("with", 0.02)).technicalAlignment, "with");
  assert.equal(classifyPosition(pos(null, 0.02)).technicalAlignment, "unknown", "decisions from before the record existed");
  const s = summarizePositions([pos("with", 0.02), pos("against", -0.03), pos(null, -0.01)]);
  assert.deepEqual(Object.keys(s.byTechnicalAlignment ?? {}).length > 0, true);
});

test("the rule text says agreement is one source", () => {
  assert.match(INDEPENDENCE_NOTE, /ONE piece of evidence/);
});
