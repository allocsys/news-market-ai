// technical_analyst test (plan.md open item: "build a technical analyst
// agent to consume price_bars"). Covers two things: pure indicator math in
// technicalIndicators.js (no DB/LLM needed), and technicalAnalyst.js's
// grounding guarantee -- it must NEVER call the LLM when there's no price
// data (proven here via a mocked global.fetch that asserts it's not
// invoked), same "don't ask a model to analyze nothing" convention as
// evaluateExit's null-price handling.
//
// Does NOT exercise a real LLM call (the "has data" path) end-to-end --
// same convention as newsEventAnalyst.js/sentimentAnalyst.js, neither of
// which has its own unit test either (see plan.md's checkpoint_resume note
// on why: true LLM-call testing needs structured.js to expose a fake-model
// injection point, not attempted here).

import test from "node:test";
import assert from "node:assert/strict";
import {
  computeSMA,
  computePriceChangePct,
  computeVolumeRatio,
  computeTechnicalSnapshot,
} from "../src/agents/analysts/technicalIndicators.js";
import { runTechnicalAnalyst } from "../src/agents/analysts/technicalAnalyst.js";

// Bars in most-recent-first order, matching storage/inputs_view.js#getPriceBarsAsOf.
const BARS = [
  { ticker: "AAPL", date: "2026-01-10", close: 110, volume: 2000 },
  { ticker: "AAPL", date: "2026-01-09", close: 108, volume: 1200 },
  { ticker: "AAPL", date: "2026-01-08", close: 106, volume: 1100 },
  { ticker: "AAPL", date: "2026-01-07", close: 104, volume: 1000 },
  { ticker: "AAPL", date: "2026-01-06", close: 102, volume: 900 },
  { ticker: "AAPL", date: "2026-01-05", close: 100, volume: 800 },
];

// ---------------------------------------------------------------------
// computeSMA
// ---------------------------------------------------------------------

test("computeSMA averages the N most recent closes", () => {
  assert.equal(computeSMA(BARS, 3), (110 + 108 + 106) / 3);
});

test("computeSMA returns null when there aren't enough bars for the window", () => {
  assert.equal(computeSMA(BARS, 10), null);
});

test("computeSMA with window equal to bars.length uses every bar", () => {
  const sum = BARS.reduce((s, b) => s + b.close, 0);
  assert.equal(computeSMA(BARS, BARS.length), sum / BARS.length);
});

// ---------------------------------------------------------------------
// computePriceChangePct
// ---------------------------------------------------------------------

test("computePriceChangePct compares latest close to the close `window` bars ago", () => {
  // latest (110) vs 5 bars ago (100, the oldest bar since BARS has 6 entries, indices 0..5)
  const pct = computePriceChangePct(BARS, 5);
  assert.equal(pct, (110 - 100) / 100);
});

test("computePriceChangePct returns null when there's no bar that far back", () => {
  assert.equal(computePriceChangePct(BARS, 10), null);
});

test("computePriceChangePct returns null when window equals bars.length (no anchor bar beyond it)", () => {
  assert.equal(computePriceChangePct(BARS, BARS.length), null);
});

// ---------------------------------------------------------------------
// computeVolumeRatio
// ---------------------------------------------------------------------

test("computeVolumeRatio compares latest volume to the average of the prior `window` bars", () => {
  // latest volume 2000; prior 3 bars: 1200, 1100, 1000 -> avg 1100
  const ratio = computeVolumeRatio(BARS, 3);
  assert.equal(ratio, 2000 / 1100);
});

test("computeVolumeRatio returns null when there aren't enough prior bars", () => {
  assert.equal(computeVolumeRatio(BARS, 10), null);
});

test("computeVolumeRatio returns null rather than dividing by zero when prior average volume is 0", () => {
  const zeroVolBars = [{ date: "d2", close: 10, volume: 5 }, { date: "d1", close: 10, volume: 0 }];
  assert.equal(computeVolumeRatio(zeroVolBars, 1), null);
});

// ---------------------------------------------------------------------
// computeTechnicalSnapshot
// ---------------------------------------------------------------------

test("computeTechnicalSnapshot returns hasData:false for an empty bars array", () => {
  assert.deepEqual(computeTechnicalSnapshot([]), { hasData: false });
});

test("computeTechnicalSnapshot returns hasData:false for null/undefined bars", () => {
  assert.deepEqual(computeTechnicalSnapshot(null), { hasData: false });
  assert.deepEqual(computeTechnicalSnapshot(undefined), { hasData: false });
});

test("computeTechnicalSnapshot bundles all indicators with hasData:true when there's data", () => {
  const snapshot = computeTechnicalSnapshot(BARS, { smaWindow: 3, momentumWindow: 5, volumeWindow: 3 });
  assert.equal(snapshot.hasData, true);
  assert.equal(snapshot.latestClose, 110);
  assert.equal(snapshot.latestDate, "2026-01-10");
  assert.equal(snapshot.barsAvailable, 6);
  assert.equal(snapshot.sma, (110 + 108 + 106) / 3);
  assert.equal(snapshot.priceChangePct, (110 - 100) / 100);
  assert.equal(snapshot.volumeRatio, 2000 / 1100);
});

test("computeTechnicalSnapshot leaves an individual indicator null (not fabricated) when its own window can't be satisfied, while others still compute", () => {
  const thinBars = BARS.slice(0, 2); // only 2 bars
  const snapshot = computeTechnicalSnapshot(thinBars, { smaWindow: 2, momentumWindow: 5, volumeWindow: 5 });
  assert.equal(snapshot.hasData, true);
  assert.equal(snapshot.sma, (110 + 108) / 2); // satisfiable with 2 bars
  assert.equal(snapshot.priceChangePct, null); // window 5 not satisfiable
  assert.equal(snapshot.volumeRatio, null); // window 5 not satisfiable
});

// ---------------------------------------------------------------------
// runTechnicalAnalyst -- must never call the LLM with no price data
// ---------------------------------------------------------------------

test("runTechnicalAnalyst returns null and never calls fetch (the LLM) when bars is empty", async (t) => {
  let fetchCalled = false;
  t.mock.method(global, "fetch", async () => {
    fetchCalled = true;
    throw new Error("fetch should never be called when there is no price data");
  });

  const result = await runTechnicalAnalyst(
    {},
    { geminiQuickModel: "test-model", geminiApiKeys: ["k"], geminiApiBase: "https://example.invalid", geminiRequestTimeoutMs: 1000 },
    { ticker: "AAPL", newsItem: { id: "news1" }, bars: [] }
  );

  assert.equal(result, null);
  assert.equal(fetchCalled, false);
});

test("runTechnicalAnalyst returns null and never calls fetch when bars is undefined", async (t) => {
  let fetchCalled = false;
  t.mock.method(global, "fetch", async () => {
    fetchCalled = true;
    throw new Error("fetch should never be called when there is no price data");
  });

  const result = await runTechnicalAnalyst(
    {},
    { geminiQuickModel: "test-model", geminiApiKeys: ["k"], geminiApiBase: "https://example.invalid", geminiRequestTimeoutMs: 1000 },
    { ticker: "AAPL", newsItem: { id: "news1" }, bars: undefined }
  );

  assert.equal(result, null);
  assert.equal(fetchCalled, false);
});

test("runTechnicalAnalyst DOES call the LLM (fetch) when there is price data, grounded in the real snapshot", async (t) => {
  let capturedBody = null;
  t.mock.method(global, "fetch", async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return {
      ok: true,
      text: async () =>
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify({ summary: "up trend", justification: "price above SMA" }) }] } }],
        }),
    };
  });

  const result = await runTechnicalAnalyst(
    {},
    {
      geminiQuickModel: "test-model",
      geminiApiKeys: ["k"],
      geminiFallbackModels: [],
      geminiApiBase: "https://example.invalid",
      geminiRequestTimeoutMs: 1000,
    },
    { ticker: "AAPL", newsItem: { id: "news1" }, bars: BARS }
  );

  assert.ok(capturedBody, "fetch should have been called with a request body");
  // The prompt must contain the REAL computed close, not a placeholder --
  // grounding check (plan.md Adopted Pattern #9).
  const promptText = JSON.stringify(capturedBody);
  assert.ok(promptText.includes("110"), "prompt should ground on the real latest close (110)");

  assert.equal(result.agent, "technical");
  assert.equal(result.newsItemId, "news1");
  assert.equal(result.summary, "up trend");
  assert.equal(result.justification, "price above SMA");
});
