// analystTeam test (issue #1, part A: batch the 3 parallel analysts --
// news_event, sentiment, technical -- into ONE Gemini call instead of 3,
// since graph/pipeline.js already ran them via Promise.all with no
// cross-dependency). Uses config.fakeModel (see structured_fakemodel.test.js)
// rather than mocking fetch, consistent with how callStructured's injection
// point is meant to be exercised.
//
// Does NOT re-test the pure indicator math (computeSMA etc.) -- that's
// technical_analyst.test.js's job, unchanged and still valid since
// analystTeam.js calls the same computeTechnicalSnapshot.

import test from "node:test";
import assert from "node:assert/strict";
import { runAnalystTeam } from "../src/agents/analysts/analystTeam.js";

const BARS = [
  { ticker: "AAPL", date: "2026-01-10", close: 110, volume: 2000 },
  { ticker: "AAPL", date: "2026-01-09", close: 108, volume: 1200 },
  { ticker: "AAPL", date: "2026-01-08", close: 106, volume: 1100 },
  { ticker: "AAPL", date: "2026-01-07", close: 104, volume: 1000 },
  { ticker: "AAPL", date: "2026-01-06", close: 102, volume: 900 },
  { ticker: "AAPL", date: "2026-01-05", close: 100, volume: 800 },
];

function baseConfig(fakeModel) {
  return { geminiQuickModel: "test-model", fakeModel };
}

test("runAnalystTeam makes exactly ONE model call for the whole team (not three)", async () => {
  let callCount = 0;
  const config = baseConfig(async () => {
    callCount += 1;
    return JSON.stringify({
      news_event: { eventType: "earnings", entities: ["AAPL"], summary: "beat estimates", justification: "eps up" },
      sentiment: { sentiment: "positive", summary: "market pleased", justification: "beat + guidance raise" },
      technical: { summary: "up trend", justification: "price above SMA" },
    });
  });

  await runAnalystTeam({}, config, { ticker: "AAPL", newsItem: { id: "news1", title: "t", body: "b" }, bars: BARS });

  assert.equal(callCount, 1);
});

test("runAnalystTeam returns all three opinions, correctly agent-tagged, when there is bar data", async () => {
  const config = baseConfig(async () =>
    JSON.stringify({
      news_event: { eventType: "earnings", entities: ["AAPL"], summary: "beat estimates", justification: "eps up" },
      sentiment: { sentiment: "positive", summary: "market pleased", justification: "beat + guidance raise" },
      technical: { summary: "up trend", justification: "price above SMA" },
    })
  );

  const opinions = await runAnalystTeam({}, config, { ticker: "AAPL", newsItem: { id: "news1", title: "t", body: "b" }, bars: BARS });

  assert.equal(opinions.length, 3);
  const byAgent = Object.fromEntries(opinions.map((o) => [o.agent, o]));
  assert.equal(byAgent.news_event.newsItemId, "news1");
  assert.equal(byAgent.news_event.eventType, "earnings");
  assert.deepEqual(byAgent.news_event.entities, ["AAPL"]);
  assert.equal(byAgent.sentiment.sentiment, "positive");
  assert.equal(byAgent.technical.summary, "up trend");
  for (const o of opinions) {
    assert.equal(o.modelUsed, "test-model");
    assert.equal(o.newsItemId, "news1");
  }
});

test("runAnalystTeam omits the technical opinion (not null, not present) when there is no bar data, and never asks the model for one", async () => {
  let capturedPrompt = null;
  const config = baseConfig(async (prompt) => {
    capturedPrompt = prompt;
    // Model correctly omits `technical` entirely -- must be schema-valid.
    return JSON.stringify({
      news_event: { eventType: "earnings", entities: ["AAPL"], summary: "beat estimates", justification: "eps up" },
      sentiment: { sentiment: "positive", summary: "market pleased", justification: "beat + guidance raise" },
    });
  });

  const opinions = await runAnalystTeam({}, config, { ticker: "AAPL", newsItem: { id: "news1", title: "t", body: "b" }, bars: [] });

  assert.equal(opinions.length, 2);
  assert.equal(opinions.some((o) => o.agent === "technical"), false);
  assert.ok(capturedPrompt.includes("do NOT include a \"technical\" key"), "prompt should tell the model to omit technical when there's no bar data");
});

test("runAnalystTeam still calls the model with no bars available (news_event/sentiment don't need price data)", async () => {
  let called = false;
  const config = baseConfig(async () => {
    called = true;
    return JSON.stringify({
      news_event: { eventType: "e", entities: [], summary: "s", justification: "j" },
      sentiment: { sentiment: "neutral", summary: "s", justification: "j" },
    });
  });

  await runAnalystTeam({}, config, { ticker: "AAPL", newsItem: { id: "news1", title: "t", body: "b" }, bars: undefined });

  assert.equal(called, true);
});

test("runAnalystTeam's schema rejects a response missing a required section (e.g. no sentiment at all)", async () => {
  const config = baseConfig(async () =>
    JSON.stringify({
      news_event: { eventType: "e", entities: [], summary: "s", justification: "j" },
      // sentiment missing entirely -- AnalystTeamOpinion requires it
    })
  );

  await assert.rejects(() =>
    runAnalystTeam({}, config, { ticker: "AAPL", newsItem: { id: "news1", title: "t", body: "b" }, bars: BARS })
  );
});

test("runAnalystTeam's schema tolerates a section missing justification or summary (lite models omit them)", async () => {
  const config = baseConfig(async () =>
    JSON.stringify({
      news_event: { eventType: "e", entities: [], summary: "s" }, // no justification
      sentiment: { sentiment: "neutral", justification: "j" }, // no summary
    })
  );

  await assert.doesNotReject(() =>
    runAnalystTeam({}, config, { ticker: "AAPL", newsItem: { id: "news1", title: "t", body: "b" }, bars: BARS })
  );
});

test("runAnalystTeam grounds the technical section's prompt in the real computed snapshot, not a placeholder", async () => {
  let capturedPrompt = null;
  const config = baseConfig(async (prompt) => {
    capturedPrompt = prompt;
    return JSON.stringify({
      news_event: { eventType: "e", entities: [], summary: "s", justification: "j" },
      sentiment: { sentiment: "neutral", summary: "s", justification: "j" },
      technical: { summary: "s", justification: "j" },
    });
  });

  await runAnalystTeam({}, config, { ticker: "AAPL", newsItem: { id: "news1", title: "t", body: "b" }, bars: BARS });

  assert.ok(capturedPrompt.includes("110"), "prompt should ground on the real latest close (110)");
});

// ---------------------------------------------------------------------------
// price_impact: does the article move THIS ticker's price? (gates the debate in graph/pipeline.js)
// ---------------------------------------------------------------------------

const BASE_SECTIONS = {
  news_event: { eventType: "e", entities: [], summary: "s", justification: "j" },
  sentiment: { sentiment: "neutral", summary: "s", justification: "j" },
};

async function runWithImpact(price_impact, { ticker = "XAUUSD" } = {}) {
  const config = baseConfig(async () => JSON.stringify({ ...BASE_SECTIONS, price_impact }));
  return runAnalystTeam({}, config, { ticker, newsItem: { id: "news1", title: "t", body: "b" }, bars: [] });
}

test("runAnalystTeam returns a price_impact opinion with relevance, price direction and channel, still in ONE model call", async () => {
  let callCount = 0;
  const config = baseConfig(async () => {
    callCount += 1;
    return JSON.stringify({ ...BASE_SECTIONS, price_impact: { relevance: "indirect", direction: "bearish", channel: "rates/yields", summary: "hot PPI lifts hike odds", justification: "higher real yields weigh on gold" } });
  });

  const opinions = await runAnalystTeam({}, config, { ticker: "XAUUSD", newsItem: { id: "news1", title: "t", body: "b" }, bars: [] });

  assert.equal(callCount, 1);
  const impact = opinions.find((o) => o.agent === "price_impact");
  assert.ok(impact);
  assert.equal(impact.relevance, "indirect");
  assert.equal(impact.priceDirection, "bearish");
  assert.equal(impact.channel, "rates/yields");
  assert.equal(impact.newsItemId, "news1");
  assert.equal(impact.modelUsed, "test-model");
  assert.match(impact.summary, /indirect price impact, bearish via rates\/yields/);
  assert.match(impact.summary, /hot PPI lifts hike odds/);
  assert.equal(impact.justification, "higher real yields weigh on gold");
});

test("runAnalystTeam adds no price_impact opinion when the model omits the section (older fake models, resumed checkpoints)", async () => {
  const config = baseConfig(async () => JSON.stringify(BASE_SECTIONS));
  const opinions = await runAnalystTeam({}, config, { ticker: "AAPL", newsItem: { id: "news1", title: "t", body: "b" }, bars: [] });
  assert.equal(opinions.some((o) => o.agent === "price_impact"), false);
  assert.equal(opinions.length, 2);
});

test("runAnalystTeam asks the model about price impact on THIS ticker's price, and to answer 'none' only when confident", async () => {
  let capturedPrompt = null;
  const config = baseConfig(async (prompt) => {
    capturedPrompt = prompt;
    return JSON.stringify(BASE_SECTIONS);
  });

  await runAnalystTeam({}, config, { ticker: "XAUUSD", newsItem: { id: "news1", title: "t", body: "b" }, bars: [] });

  assert.ok(capturedPrompt.includes("PRICE IMPACT"));
  assert.ok(capturedPrompt.includes("PRICE of XAUUSD"));
  assert.ok(capturedPrompt.includes('answer "none" only when you are confident'));
  assert.ok(capturedPrompt.includes('"price_impact": {'), "the JSON shape lists the section");
});

test("price_impact relevance is case/space tolerant: ' NONE ' is none", async () => {
  const opinions = await runWithImpact({ relevance: " NONE ", direction: "neutral", channel: "none" });
  assert.equal(opinions.find((o) => o.agent === "price_impact").relevance, "none");
});

test("an unclear price_impact relevance becomes 'indirect' (keeps the item in the pipeline), never 'none'", async () => {
  for (const relevance of ["maybe", "", "no impact at all", 3, null]) {
    const opinions = await runWithImpact({ relevance, direction: "bullish", channel: "x" });
    assert.equal(opinions.find((o) => o.agent === "price_impact").relevance, "indirect", `relevance ${JSON.stringify(relevance)}`);
  }
});

test("a missing or unclear price direction becomes 'neutral', and a missing relevance becomes 'indirect'", async () => {
  const opinions = await runWithImpact({ direction: "sideways" });
  const impact = opinions.find((o) => o.agent === "price_impact");
  assert.equal(impact.priceDirection, "neutral");
  assert.equal(impact.relevance, "indirect");
});
