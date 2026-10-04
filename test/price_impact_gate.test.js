// Price-impact gate (graph/pipeline.js): the analyst call also judges whether the article can move the ticker's
// price. A confident 'none' ends the run BEFORE the debate/trader calls and records a 'skipped_irrelevant'
// decision; anything else (indirect, direct, missing, or the switch turned off) runs the full pipeline as before.
//
// Same style as checkpoint_resume.test.js: real sqlite state + inputs DBs (test/helpers/engine_ctx.js), the model
// replaced by config.fakeModel dispatching on schema identity, zero real Gemini calls.

import test from "node:test";
import assert from "node:assert/strict";
import { runPipelineForTicker } from "../src/graph/pipeline.js";
import { checkpoint, resumeFrom } from "../src/graph/checkpointer.js";
import { AnalystTeamOpinion, DebateSide, DebateVerdict, TradeThesis } from "../src/schemas/index.js";
import { TRADE_DECISION_STATUS } from "../src/shared/constants.js";
import { decisionBadge } from "../src/dashboard/helpers.js";
import { makeCtx, seedBar, seedIntradayBar, stateRows } from "./helpers/engine_ctx.js";

const AS_OF = "2026-01-15T00:00:00Z";
const NEWS_ITEM = { id: "news-1", title: "Some headline", body: "Some body text." };

/** ctx with the fresh entry bar a full run needs to open a position (same fixture as checkpoint_resume.test.js). */
async function ctxWithEntryBar() {
  const ctx = makeCtx();
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-14", close: 181 });
  await seedIntradayBar(ctx.inputs, { ticker: "AAPL", ts: "2026-01-14T23:55:00Z", close: 181 });
  return ctx;
}

/** A model that records every call. `impact` is the price_impact section it answers with (undefined = it omits the section). */
function makeModel({ impact, calls = [] } = {}) {
  return async (prompt, opts) => {
    calls.push(opts);
    if (opts.schema === AnalystTeamOpinion) {
      return JSON.stringify({
        news_event: { eventType: "commentary", entities: [], summary: "a headline", justification: "j" },
        sentiment: { sentiment: "positive", summary: "upbeat", justification: "j" },
        ...(impact ? { price_impact: impact } : {}),
        technical: { summary: "flat", justification: "one bar" },
      });
    }
    if (opts.schema === DebateSide) {
      return opts.extraFields.stance === "bull"
        ? JSON.stringify({ argument: "bull case", justification: "j" })
        : JSON.stringify({ argument: "bear case", justification: "j" });
    }
    if (opts.schema === DebateVerdict) return JSON.stringify({ direction: "long", confidence: 0.8, timeHorizon: "days", justification: "j" });
    if (opts.schema === TradeThesis) return JSON.stringify({ instrument: "equity", rationale: "r" });
    throw new Error("unexpected schema in test fake model");
  };
}

const NONE = { relevance: "none", direction: "neutral", channel: "none", summary: "personal-finance advice", justification: "no link to the price" };

function configFor(fakeModel, extra = {}) {
  return { geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, fakeModel, ...extra };
}

const run = (ctx, config, pipelineRunId = "news-1") =>
  runPipelineForTicker({}, config, ctx, { pipelineRunId, ticker: "AAPL", newsItem: { ...NEWS_ITEM, id: pipelineRunId }, asOf: AS_OF });

test("a confident 'none' ends the run after the ONE analyst call: no debate, no trader, no position, a skipped_irrelevant decision", async () => {
  const ctx = await ctxWithEntryBar();
  const calls = [];

  const result = await run(ctx, configFor(makeModel({ impact: NONE, calls })));

  assert.equal(calls.length, 1, "only the analyst-team call was made (a full run is 5)");
  assert.equal(calls[0].schema, AnalystTeamOpinion);
  assert.equal(result.approvedForExecution, false);
  assert.equal(result.finalPositionSizePct, 0);
  assert.match(result.reason, /no price impact/);

  assert.equal((await stateRows(ctx.stateDb, "positions")).length, 0);
  const decisions = await stateRows(ctx.stateDb, "trade_decisions");
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].status, TRADE_DECISION_STATUS.SKIPPED_IRRELEVANT);
  assert.equal(decisions[0].status, "skipped_irrelevant");
  assert.equal(decisions[0].id, `AAPL|${AS_OF}`, "same ticker|asOf id every other decision uses");
  assert.equal(decisions[0].debate, null, "the debate never ran");
  assert.equal(JSON.parse(decisions[0].thesis).direction, "flat");
  assert.match(JSON.parse(decisions[0].risk_decision).reason, /no price impact on AAPL/);

  // The analyst opinions stay on the row, price_impact included, so a skipped item can be audited later.
  const opinions = JSON.parse(decisions[0].opinions);
  const impact = opinions.find((o) => o.agent === "price_impact");
  assert.ok(impact);
  assert.equal(impact.relevance, "none");
  assert.equal(impact.justification, "no link to the price");

  // The run is checkpointed as complete, in the same batch as the decision.
  const checkpoints = await stateRows(ctx.stateDb, "pipeline_checkpoints");
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].stage, "portfolio_checked");
});

test("'indirect' and 'direct' impact run the full pipeline (analyst + bull + bear + judge + trader) and open a position", async () => {
  for (const relevance of ["indirect", "direct"]) {
    const ctx = await ctxWithEntryBar();
    const calls = [];

    const result = await run(ctx, configFor(makeModel({ impact: { relevance, direction: "bearish", channel: "rates/yields" }, calls })));

    assert.equal(calls.length, 5, relevance);
    assert.equal(result.approvedForExecution, true, relevance);
    assert.equal((await stateRows(ctx.stateDb, "trade_decisions"))[0].status, "opened", relevance);
    assert.equal((await stateRows(ctx.stateDb, "positions")).length, 1, relevance);
  }
});

test("the debate prompts still carry the price_impact opinion, so bull/bear argue about the asset's price", async () => {
  const ctx = await ctxWithEntryBar();
  const prompts = [];
  const model = makeModel({ impact: { relevance: "indirect", direction: "bearish", channel: "rates/yields", summary: "hike odds up", justification: "j" } });
  const config = configFor(async (prompt, opts) => {
    if (opts.schema === DebateSide) prompts.push(prompt);
    return model(prompt, opts);
  });

  await run(ctx, config);

  assert.equal(prompts.length, 2);
  for (const prompt of prompts) {
    assert.ok(prompt.includes("price_impact"));
    assert.ok(prompt.includes("rates/yields"));
  }
});

test("a model that gives no price_impact verdict runs the full pipeline exactly as before", async () => {
  const ctx = await ctxWithEntryBar();
  const calls = [];

  const result = await run(ctx, configFor(makeModel({ calls })));

  assert.equal(calls.length, 5);
  assert.equal(result.approvedForExecution, true);
  assert.equal((await stateRows(ctx.stateDb, "trade_decisions"))[0].status, "opened");
});

test("skipNoPriceImpact: false turns the gate off -- a 'none' verdict still runs the full pipeline", async () => {
  const ctx = await ctxWithEntryBar();
  const calls = [];

  await run(ctx, configFor(makeModel({ impact: NONE, calls }), { skipNoPriceImpact: false }));

  assert.equal(calls.length, 5);
  assert.equal((await stateRows(ctx.stateDb, "trade_decisions"))[0].status, "opened");
});

test("an unclear relevance never skips: the model's garbage answer is treated as 'indirect' and the item continues", async () => {
  const ctx = await ctxWithEntryBar();
  const calls = [];

  await run(ctx, configFor(makeModel({ impact: { relevance: "kind of irrelevant?", direction: "neutral", channel: "" }, calls })));

  assert.equal(calls.length, 5);
  assert.equal((await stateRows(ctx.stateDb, "trade_decisions"))[0].status, "opened");
});

test("a retry of a skipped run returns the cached decision without calling the model, and writes no second row", async () => {
  const ctx = await ctxWithEntryBar();
  const first = await run(ctx, configFor(makeModel({ impact: NONE })));

  const calls = [];
  const second = await run(ctx, configFor(makeModel({ impact: NONE, calls })));

  assert.equal(calls.length, 0);
  assert.deepEqual(second, first);
  assert.equal((await stateRows(ctx.stateDb, "trade_decisions")).length, 1);
  assert.equal((await resumeFrom(ctx.store, { pipelineRunId: "news-1", ticker: "AAPL" })).stage, null);
});

test("a run resumed from 'analyzed' whose checkpointed opinions say 'none' is skipped without any model call", async () => {
  const ctx = await ctxWithEntryBar();
  const opinions = [
    { agent: "news_event", newsItemId: "news-1", entities: [], summary: "s", justification: "j" },
    { agent: "price_impact", newsItemId: "news-1", entities: [], relevance: "none", priceDirection: "neutral", channel: "none", summary: "none price impact, neutral", justification: "no link" },
  ];
  await checkpoint(ctx.store, { pipelineRunId: "news-1", ticker: "AAPL", stage: "analyzed", state: { opinions } });

  const calls = [];
  const result = await run(ctx, configFor(async (prompt, opts) => {
    calls.push(opts);
    throw new Error("no model call is expected on this resume");
  }));

  assert.equal(calls.length, 0);
  assert.equal(result.approvedForExecution, false);
  assert.equal((await stateRows(ctx.stateDb, "trade_decisions"))[0].status, "skipped_irrelevant");
});

test("skipped_irrelevant shows as a neutral 'skipped (no impact)' badge and is a filterable status", () => {
  const html = decisionBadge("skipped_irrelevant");
  assert.match(html, /status-neutral/);
  assert.match(html, /skipped \(no impact\)/);
});
