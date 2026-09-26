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

test("runAnalystTeam's schema rejects a section missing its required justification", async () => {
  const config = baseConfig(async () =>
    JSON.stringify({
      news_event: { eventType: "e", entities: [], summary: "s" }, // no justification
      sentiment: { sentiment: "neutral", summary: "s", justification: "j" },
    })
  );

  await assert.rejects(() =>
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
