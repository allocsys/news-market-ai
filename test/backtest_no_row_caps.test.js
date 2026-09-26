// plan.md "Next steps: make backtests trustworthy", step B (audit finding 2):
// `getNewsItemsInRange` defaulted to `limit = 500` and `getRealizedReturnsInRange`
// did too, and the backtest passed no limit, so a long window silently
// processed only the first 500 news items per ticker and scored only the first
// 500 realized returns. These tests fail on that behavior: every one uses more
// than 500 rows (or a page size smaller than the data) and asserts nothing is
// dropped, repeated or reordered. Real sqlite-backed D1s, the real migrations
// and the real SQL (test/helpers/engine_ctx.js).

import test from "node:test";
import assert from "node:assert/strict";
import { getNewsItemsInRange, NEWS_RANGE_PAGE_SIZE } from "../src/storage/inputs_view.js";
import { readOnly } from "../src/storage/run_store.js";
import { LookaheadViolationError } from "../src/shared/errors.js";
import { runOnSignalForTicker } from "../src/backtest/onSignalRunner.js";
import { AnalystTeamOpinion, DebateSide, DebateVerdict, TradeThesis } from "../src/schemas/index.js";
import { makeCtx, seedNews, seedBar, stateRows } from "./helpers/engine_ctx.js";

const BASE_MS = Date.UTC(2026, 0, 1, 0, 0, 0);
const isoAt = (offsetSeconds) => new Date(BASE_MS + offsetSeconds * 1000).toISOString();
const pad = (n) => String(n).padStart(5, "0");

test("the default page size is 500, so the tests below really do cross page boundaries", () => {
  assert.equal(NEWS_RANGE_PAGE_SIZE, 500);
});

test("getNewsItemsInRange returns every item in the range when there are more than 500, oldest first, through a read-only handle", async () => {
  const ctx = makeCtx();
  const COUNT = 1203; // 500 + 500 + 203: three pages at the default size
  for (let i = 0; i < COUNT; i++) {
    await seedNews(ctx.inputs, { id: `n-${pad(i)}`, tickers: ["AAPL"], publishedAt: isoAt(i) });
  }
  // Neighbours that must NOT come back: one second before `from`, one exactly at `to` (exclusive), another ticker.
  await seedNews(ctx.inputs, { id: "before", tickers: ["AAPL"], publishedAt: isoAt(-1) });
  await seedNews(ctx.inputs, { id: "at-to", tickers: ["AAPL"], publishedAt: isoAt(COUNT) });
  await seedNews(ctx.inputs, { id: "other-ticker", tickers: ["MSFT"], publishedAt: isoAt(10) });

  const items = await getNewsItemsInRange(readOnly(ctx.inputs), { ticker: "AAPL", from: isoAt(0), to: isoAt(COUNT) });

  assert.equal(items.length, COUNT);
  assert.deepEqual(items.map((r) => r.id), Array.from({ length: COUNT }, (_, i) => `n-${pad(i)}`));
});

test("getNewsItemsInRange never skips or repeats a row when a page boundary falls inside identical timestamps", async () => {
  const ctx = makeCtx();
  const sameTime = isoAt(100);
  // Seeded out of id order on purpose; 2 earlier, 7 tied, 2 later, and page sizes
  // that put boundaries mid-tie.
  for (const id of ["t-d", "t-a", "t-g", "t-c", "t-f", "t-b", "t-e"]) {
    await seedNews(ctx.inputs, { id, tickers: ["AAPL"], publishedAt: sameTime });
  }
  await seedNews(ctx.inputs, { id: "early-2", tickers: ["AAPL"], publishedAt: isoAt(2) });
  await seedNews(ctx.inputs, { id: "early-1", tickers: ["AAPL"], publishedAt: isoAt(1) });
  await seedNews(ctx.inputs, { id: "late-2", tickers: ["AAPL"], publishedAt: isoAt(201) });
  await seedNews(ctx.inputs, { id: "late-1", tickers: ["AAPL"], publishedAt: isoAt(200) });

  for (const pageSize of [1, 2, 3, 4, 11, 12]) {
    const items = await getNewsItemsInRange(ctx.inputs, { ticker: "AAPL", from: isoAt(0), to: isoAt(1000), pageSize });
    assert.deepEqual(
      items.map((r) => r.id),
      ["early-1", "early-2", "t-a", "t-b", "t-c", "t-d", "t-e", "t-f", "t-g", "late-1", "late-2"],
      `pageSize ${pageSize}`
    );
  }
});

test("getNewsItemsInRange still requires an explicit {from, to} and a sane pageSize", async () => {
  const ctx = makeCtx();
  await assert.rejects(() => getNewsItemsInRange(ctx.inputs, { ticker: "AAPL", from: isoAt(0) }), LookaheadViolationError);
  await assert.rejects(() => getNewsItemsInRange(ctx.inputs, { ticker: "AAPL", to: isoAt(0) }), LookaheadViolationError);
  for (const pageSize of [0, -1, 1.5, "10"]) {
    await assert.rejects(() => getNewsItemsInRange(ctx.inputs, { ticker: "AAPL", from: isoAt(0), to: isoAt(10), pageSize }), /pageSize/);
  }
});

test("getRealizedReturnsInRange returns every realized return when there are more than 500, oldest first", async () => {
  const ctx = makeCtx();
  const COUNT = 620;
  for (let i = 0; i < COUNT; i++) {
    await ctx.store.recordDecisionOutcome({
      id: `m-${pad(i)}`, decisionId: `AAPL|${isoAt(i)}`, ticker: "AAPL",
      realizedReturn: i / 1000, alphaReturn: null, reflection: "r", resolvedAt: isoAt(i),
    });
  }
  // Must NOT come back: a null return, one resolved exactly at `to` (exclusive), another ticker.
  await ctx.store.recordDecisionOutcome({ id: "m-null", decisionId: "d-null", ticker: "AAPL", realizedReturn: null, alphaReturn: null, reflection: "r", resolvedAt: isoAt(5) });
  await ctx.store.recordDecisionOutcome({ id: "m-at-to", decisionId: "d-at-to", ticker: "AAPL", realizedReturn: 9, alphaReturn: null, reflection: "r", resolvedAt: isoAt(COUNT) });
  await ctx.store.recordDecisionOutcome({ id: "m-msft", decisionId: "d-msft", ticker: "MSFT", realizedReturn: 9, alphaReturn: null, reflection: "r", resolvedAt: isoAt(5) });

  const returns = await ctx.store.getRealizedReturnsInRange({ ticker: "AAPL", from: isoAt(0), to: isoAt(COUNT) });

  assert.deepEqual(returns, Array.from({ length: COUNT }, (_, i) => i / 1000));
});

// Same dispatch-on-schema fake model as test/backtest_on_signal_runner.test.js:
// always a confident long thesis, so every news item runs the whole pipeline.
function makeFakeModel({ onCall } = {}) {
  return async (prompt, opts) => {
    onCall?.(opts);
    if (prompt.startsWith("A trade decision for")) {
      return JSON.stringify({ reflection: "the long thesis played out as expected" });
    }
    if (opts.schema === AnalystTeamOpinion) {
      return JSON.stringify({
        news_event: { eventType: "earnings_beat", entities: [], summary: "beat on EPS", justification: "guidance raised" },
        sentiment: { sentiment: "positive", summary: "positive reaction", justification: "beat + raised guidance" },
        technical: { summary: "flat", justification: "not enough bars for a real trend read" },
      });
    }
    if (opts.schema === DebateSide) {
      return opts.extraFields.stance === "bull"
        ? JSON.stringify({ argument: "earnings beat justifies a long position", justification: "fundamentals improved" })
        : JSON.stringify({ argument: "one beat doesn't confirm a trend", justification: "macro risk remains" });
    }
    if (opts.schema === DebateVerdict) return JSON.stringify({ direction: "long", confidence: 0.8, timeHorizon: "days", justification: "bull case outweighs bear case" });
    if (opts.schema === TradeThesis) return JSON.stringify({ instrument: "equity", rationale: "ride the post-earnings momentum" });
    throw new Error(`unexpected schema/prompt in test fake model: ${prompt.slice(0, 60)}`);
  };
}

test("runOnSignalForTicker processes every news item in the window and scores every realized return, past 500", async () => {
  const ctx = makeCtx();
  const COUNT = 505; // one more than the old cap. One item a minute, all on 2026-01-01 (08:24 for the last).
  const minuteIso = (i) => new Date(BASE_MS + i * 60000).toISOString();
  for (let i = 0; i < COUNT; i++) {
    await seedNews(ctx.inputs, { id: `run-${pad(i)}`, tickers: ["AAPL"], publishedAt: minuteIso(i), title: `AAPL headline ${i}`, body: "body" });
  }
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2025-12-31", close: 100 });

  const calls = [];
  const config = {
    geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1,
    maxPositionHoldDays: 1, // so the last open position closes inside the grace period
    fakeModel: makeFakeModel({ onCall: (opts) => calls.push(opts) }),
  };

  const returns = await runOnSignalForTicker({}, config, ctx, {
    ticker: "AAPL",
    testStart: "2026-01-01T00:00:00.000Z",
    testEnd: "2026-01-02T00:00:00.000Z",
    graceDays: 2,
  });

  // Every item ran the full pipeline: one judge verdict and one trade decision each (the old cap stopped at 500).
  assert.equal(calls.filter((c) => c.schema === DebateVerdict).length, COUNT);
  const decisions = await stateRows(ctx.stateDb, "trade_decisions");
  assert.equal(decisions.length, COUNT);
  assert.ok(decisions.some((d) => d.id === `AAPL|${minuteIso(COUNT - 1)}`), "the newest item was processed too");

  // And every realized return that landed in the DB came back (the old cap returned at most 500).
  const scored = (await stateRows(ctx.stateDb, "decision_memory")).filter((m) => m.realized_return !== null);
  assert.ok(scored.length > 500, `expected more than 500 scored returns, got ${scored.length}`);
  assert.equal(returns.length, scored.length);
});
