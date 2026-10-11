// Merged verdict (knob mergedVerdict): ONE model call replaces bull + bear + judge. Same style as price_impact_gate.test.js:
// real sqlite engine ctx, model replaced by config.fakeModel dispatching on schema identity, zero real Gemini calls.

import test from "node:test";
import assert from "node:assert/strict";
import { runPipelineForTicker } from "../src/graph/pipeline.js";
import { AnalystTeamOpinion, DebateSide, DebateVerdict, MergedVerdict, TradeThesis } from "../src/schemas/index.js";
import { parseKnobOverrides, applyKnobOverrides, effectiveKnobs } from "../src/backtest/knobOverrides.js";
import { makeCtx, seedBar, seedIntradayBar, stateRows } from "./helpers/engine_ctx.js";

const AS_OF = "2026-01-15T00:00:00Z";
const NEWS_ITEM = { id: "news-1", title: "Some headline", body: "Some body text." };

async function ctxWithEntryBar() {
  const ctx = makeCtx();
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-14", close: 181 });
  await seedIntradayBar(ctx.inputs, { ticker: "AAPL", ts: "2026-01-14T23:55:00Z", close: 181 });
  return ctx;
}

function makeModel(calls = []) {
  return async (prompt, opts) => {
    calls.push({ schema: opts.schema, label: opts.extraFields });
    if (opts.schema === AnalystTeamOpinion) {
      return JSON.stringify({
        news_event: { eventType: "commentary", entities: [], summary: "a headline", justification: "j" },
        sentiment: { sentiment: "positive", summary: "upbeat", justification: "j" },
        price_impact: { relevance: "direct", direction: "bullish", channel: "earnings" },
        technical: { summary: "flat", justification: "one bar" },
      });
    }
    if (opts.schema === DebateSide) {
      return JSON.stringify({ argument: `${opts.extraFields.stance} case`, justification: "j" });
    }
    if (opts.schema === DebateVerdict) return JSON.stringify({ direction: "long", confidence: 0.8, timeHorizon: "days", justification: "j" });
    if (opts.schema === MergedVerdict) {
      return JSON.stringify({
        bull: { argument: "merged bull", justification: "jb" },
        bear: { argument: "merged bear", justification: "jr" },
        direction: "long",
        confidence: 0.7,
        timeHorizon: "days",
        justification: "merged j",
      });
    }
    if (opts.schema === TradeThesis) return JSON.stringify({ instrument: "equity", rationale: "r" });
    throw new Error("unexpected schema in test fake model");
  };
}

const configFor = (fakeModel, extra = {}) => ({ geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, fakeModel, ...extra });
const run = (ctx, config) => runPipelineForTicker({}, config, ctx, { pipelineRunId: "news-1", ticker: "AAPL", newsItem: NEWS_ITEM, asOf: AS_OF });

test("mergedVerdict on: 3 calls (analyst, merged judge, trader), no bull/bear/judge, and the stored debate has the DebateVerdict shape", async () => {
  const ctx = await ctxWithEntryBar();
  const calls = [];

  const result = await run(ctx, configFor(makeModel(calls), { mergedVerdict: true }));

  assert.deepEqual(calls.map((c) => c.schema), [AnalystTeamOpinion, MergedVerdict, TradeThesis]);
  assert.equal(result.approvedForExecution, true);

  const decision = (await stateRows(ctx.stateDb, "trade_decisions"))[0];
  assert.equal(decision.status, "opened");
  const debate = JSON.parse(decision.debate);
  assert.equal(debate.ticker, "AAPL");
  assert.equal(debate.asOf, AS_OF);
  assert.equal(debate.direction, "long");
  assert.equal(debate.confidence, 0.7);
  assert.equal(debate.bull.stance, "bull");
  assert.equal(debate.bull.argument, "merged bull");
  assert.equal(debate.bear.stance, "bear");
  assert.equal(debate.bear.argument, "merged bear");
});

test("mergedVerdict off or missing: the normal 5-call pipeline, unchanged", async () => {
  for (const extra of [{}, { mergedVerdict: false }]) {
    const ctx = await ctxWithEntryBar();
    const calls = [];

    await run(ctx, configFor(makeModel(calls), extra));

    assert.equal(calls.length, 5);
    assert.ok(!calls.some((c) => c.schema === MergedVerdict));
  }
});

test("mergedVerdict ignores maxDebateRounds: a low-confidence verdict still makes ONE judge call", async () => {
  const ctx = await ctxWithEntryBar();
  const calls = [];
  const base = makeModel(calls);
  const config = configFor(
    async (prompt, opts) => {
      if (opts.schema === MergedVerdict) {
        calls.push({ schema: opts.schema });
        return JSON.stringify({ bull: { argument: "a", justification: "j" }, bear: { argument: "b", justification: "j" }, direction: "flat", confidence: 0.1, timeHorizon: "days", justification: "unsure" });
      }
      return base(prompt, opts);
    },
    { mergedVerdict: true, maxDebateRounds: 3 },
  );

  await run(ctx, config);

  assert.equal(calls.filter((c) => c.schema === MergedVerdict).length, 1);
});

test("knob: mergedVerdict parses 0/1, applies as a boolean, and is recorded in effectiveKnobs (default false)", () => {
  const get = (v) => (name) => (name === "mergedVerdict" ? v : undefined);
  assert.deepEqual(parseKnobOverrides(get("1")), { overrides: { mergedVerdict: 1 } });
  assert.deepEqual(parseKnobOverrides(get("")), { overrides: {} });
  assert.ok(parseKnobOverrides(get("2")).error);
  assert.ok(parseKnobOverrides(get("0.5")).error);

  assert.equal(applyKnobOverrides({}, { mergedVerdict: 1 }).mergedVerdict, true);
  assert.equal(applyKnobOverrides({}, { mergedVerdict: 0 }).mergedVerdict, false);
  assert.equal(effectiveKnobs({}).mergedVerdict, false);
  assert.equal(effectiveKnobs({ mergedVerdict: true }).mergedVerdict, true);
});
