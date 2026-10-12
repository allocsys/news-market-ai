// Stale technical read fix: the technical analyst used to see only the last COMPLETED daily close (up to ~a day
// old at decision time). With a visible intraday bar it now also gets the current price, and the SMA / price change
// are taken from it. Point-in-time: only a bar fully closed at asOf may be used (getIntradayPriceAsOf).

import test from "node:test";
import assert from "node:assert/strict";
import { computeTechnicalSnapshot } from "../src/agents/analysts/technicalIndicators.js";
import { runPipelineForTicker } from "../src/graph/pipeline.js";
import { makeCtx, seedBar, seedIntradayBar, seedNews } from "./helpers/engine_ctx.js";
import { makeFakeLongModel } from "./helpers/fake_long_model.js";
import { AnalystTeamOpinion } from "../src/schemas/index.js";

// Most-recent-first, like getPriceBarsAsOf.
const bars = [100, 98, 96, 94, 92, 90].map((close, i) => ({ date: `2026-01-0${6 - i}`, close, volume: 1000 }));
const live = (over = {}) => ({ price: 110, ts: "2026-01-07T09:30:00Z", availableAt: "2026-01-07T09:35:00Z", ageMinutes: 5, ...over });

test("no current price: the snapshot is exactly what it was before", () => {
  const s = computeTechnicalSnapshot(bars);
  assert.equal(s.latestClose, 100);
  assert.equal(s.sma, (100 + 98 + 96 + 94 + 92) / 5);
  assert.equal(s.currentPrice, undefined);
  assert.deepEqual(computeTechnicalSnapshot(bars, undefined, null), s);
});

test("a current price from a newer session feeds the SMA and price change, and keeps the last daily close visible", () => {
  const s = computeTechnicalSnapshot(bars, undefined, live());
  assert.equal(s.currentPrice, 110);
  assert.equal(s.latestClose, 100);
  assert.equal(s.currentVsLatestClosePct, 0.1);
  assert.equal(s.sma, (110 + 100 + 98 + 96 + 94) / 5);
  assert.equal(s.priceChangePct, (110 - 92) / 92); // current vs the close 5 sessions back
  assert.equal(s.volumeRatio, 1); // still the last completed bar
});

test("an intraday bar from the SAME session as the newest daily bar is ignored (it would count that session twice)", () => {
  const s = computeTechnicalSnapshot(bars, undefined, live({ ts: "2026-01-06T21:55:00Z" }));
  assert.equal(s.currentPrice, undefined);
  assert.equal(s.sma, (100 + 98 + 96 + 94 + 92) / 5);
});

test("a junk current price falls back to the daily snapshot", () => {
  for (const bad of [live({ price: 0 }), live({ price: NaN }), live({ price: null }), live({ ts: undefined })]) {
    assert.equal(computeTechnicalSnapshot(bars, undefined, bad).currentPrice, undefined);
  }
});

test("no daily bars at all still means no technical data, whatever the intraday price", () => {
  assert.deepEqual(computeTechnicalSnapshot([], undefined, live()), { hasData: false });
});

async function runWith({ seed, configOver = {} }) {
  const ctx = makeCtx();
  const publishedAt = "2026-01-07T09:35:00.000Z";
  await seedNews(ctx.inputs, { id: "n1", tickers: ["AAPL"], publishedAt, title: "AAPL beats", body: "body" });
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-06", close: 100 });
  await seed(ctx);
  let prompt = null;
  const config = {
    geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, maxPositionHoldDays: 10, intradayTechnical: true, ...configOver,
    fakeModel: makeFakeLongModel({ onCall: (opts, p) => { if (opts.schema === AnalystTeamOpinion) prompt = p; } }),
  };
  await runPipelineForTicker({}, config, ctx, {
    pipelineRunId: "run-1", ticker: "AAPL", asOf: publishedAt,
    newsItem: { id: "n1", tickers: ["AAPL"], title: "AAPL beats", body: "body", publishedAt },
  });
  return prompt;
}

test("pipeline: the analyst prompt carries the intraday price visible at asOf, and nothing newer", async () => {
  const prompt = await runWith({
    seed: async (ctx) => {
      await seedIntradayBar(ctx.inputs, { ticker: "AAPL", ts: "2026-01-07T09:25:00Z", close: 105 }); // closed 09:30 <= asOf
      await seedIntradayBar(ctx.inputs, { ticker: "AAPL", ts: "2026-01-07T09:30:00Z", close: 106 }); // closes 09:35 == asOf: visible
      await seedIntradayBar(ctx.inputs, { ticker: "AAPL", ts: "2026-01-07T09:35:00Z", close: 999 }); // still forming at asOf: NOT visible
    },
  });
  assert.match(prompt, /"currentPrice": 106/);
  assert.ok(!prompt.includes("999"), "no bar that had not closed at asOf");
  assert.match(prompt, /"latestDate": "2026-01-06"/);
});

test("pipeline: no intraday bar means the daily-only snapshot, as before", async () => {
  const prompt = await runWith({ seed: async () => {} });
  assert.ok(!prompt.includes("currentPrice"));
  assert.match(prompt, /"latestClose": 100/);
});

test("pipeline: config.intradayTechnical === false turns it off even when an intraday bar exists", async () => {
  const prompt = await runWith({
    seed: async (ctx) => { await seedIntradayBar(ctx.inputs, { ticker: "AAPL", ts: "2026-01-07T09:25:00Z", close: 105 }); },
    configOver: { intradayTechnical: false },
  });
  assert.ok(!prompt.includes("currentPrice"));
});

test("pipeline: OFF by default -- a config without the flag keeps the daily-close-only snapshot even when an intraday bar exists", async () => {
  const prompt = await runWith({
    seed: async (ctx) => { await seedIntradayBar(ctx.inputs, { ticker: "AAPL", ts: "2026-01-07T09:25:00Z", close: 105 }); },
    configOver: { intradayTechnical: undefined },
  });
  assert.ok(!prompt.includes("currentPrice"));
  assert.match(prompt, /"latestClose": 100/);
});
