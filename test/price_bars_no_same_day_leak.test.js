// plan.md "Next steps", step C (audit finding 3) and Backtesting Integrity
// points 1 and 6. `price_bars.date` is a bare YYYY-MM-DD holding that day's
// FINAL OHLCV, and getPriceBarsAsOf used to compare `date <= asOf`, so a 09:35
// decision on day D saw day D's close. The rule now (shared/price_availability.js):
// the bar for day D is visible only from D+1 00:00Z, i.e. `date < UTC date of
// asOf`. These tests use INTRADAY asOf values, the case the old leak-check test
// (backtest.leakcheck.test.js, timestamps only) never covered, against a real
// sqlite inputs DB and the real pipeline / exit-check code.

import test from "node:test";
import assert from "node:assert/strict";
import { getPriceBarsAsOf } from "../src/storage/inputs_view.js";
import { priceBarCutoffDate, assertNoPriceBarLookahead, utcDateOf } from "../src/shared/price_availability.js";
import { LookaheadViolationError } from "../src/shared/errors.js";
import { runPipelineForTicker } from "../src/graph/pipeline.js";
import { checkOpenPositionExits } from "../src/graph/exit_check.js";
import { makeCtx, seedBar, seedNews, stateRows } from "./helpers/engine_ctx.js";
import { makeFakeLongModel } from "./helpers/fake_long_model.js";

test("priceBarCutoffDate is the UTC calendar date of asOf, whatever the time of day or offset", () => {
  for (const asOf of ["2026-01-05T00:00:00.000Z", "2026-01-05T09:35:00Z", "2026-01-05T23:59:59.999Z", "2026-01-05"]) {
    assert.equal(priceBarCutoffDate(asOf), "2026-01-05", asOf);
  }
  assert.equal(priceBarCutoffDate("2026-01-05T23:30:00-05:00"), "2026-01-06"); // 04:30Z the next day
  assert.equal(priceBarCutoffDate("2026-01-06T01:00:00+05:00"), "2026-01-05"); // 20:00Z the day before
});

test("utcDateOf lines a timestamp up with a bar date; a raw string compare does not", () => {
  assert.equal(utcDateOf("2026-01-05T00:00:00.000Z"), "2026-01-05");
  assert.equal(utcDateOf("2026-01-05"), "2026-01-05");
  assert.equal("2026-01-05" >= "2026-01-05T00:00:00.000Z", false); // the trap utcDateOf exists to avoid
  assert.equal("2026-01-05" >= utcDateOf("2026-01-05T00:00:00.000Z"), true);
  assert.throws(() => utcDateOf("garbage"), LookaheadViolationError);
});

test("priceBarCutoffDate refuses an asOf it cannot parse (no cutoff is never the fallback)", () => {
  for (const bad of ["garbage", "", undefined, null, 12345, {}]) {
    assert.throws(() => priceBarCutoffDate(bad), LookaheadViolationError, String(bad));
  }
});

test("getPriceBarsAsOf never returns the bar of asOf's own UTC day, at any time of that day", async () => {
  const ctx = makeCtx();
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-02", close: 100 });
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-05", close: 200 });
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-06", close: 300 });

  for (const asOf of ["2026-01-05T00:00:00.000Z", "2026-01-05T09:35:00.000Z", "2026-01-05T16:00:00Z", "2026-01-05T23:59:59.999Z", "2026-01-05"]) {
    const bars = await getPriceBarsAsOf(ctx.inputs, { ticker: "AAPL", asOf });
    assert.deepEqual(bars.map((b) => b.date), ["2026-01-02"], asOf);
    const [latest] = await getPriceBarsAsOf(ctx.inputs, { ticker: "AAPL", asOf, limit: 1 });
    assert.equal(latest.close, 100, `the freshest price at ${asOf} is the PRIOR close`);
  }

  // ...and it appears the moment the day is over.
  const nextDay = await getPriceBarsAsOf(ctx.inputs, { ticker: "AAPL", asOf: "2026-01-06T00:00:00.000Z" });
  assert.deepEqual(nextDay.map((b) => b.date), ["2026-01-05", "2026-01-02"]);
});

test("getPriceBarsAsOf compares in UTC: an offset timestamp late on Jan 5 in New York is already Jan 6", async () => {
  const ctx = makeCtx();
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-05", close: 200 });

  assert.deepEqual(await getPriceBarsAsOf(ctx.inputs, { ticker: "AAPL", asOf: "2026-01-05T18:00:00-05:00" }), []); // 23:00Z Jan 5
  assert.equal((await getPriceBarsAsOf(ctx.inputs, { ticker: "AAPL", asOf: "2026-01-05T23:30:00-05:00" })).length, 1); // 04:30Z Jan 6
});

test("getPriceBarsAsOf throws on an unparseable asOf instead of reading unfiltered", async () => {
  const ctx = makeCtx();
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-05", close: 200 });
  await assert.rejects(() => getPriceBarsAsOf(ctx.inputs, { ticker: "AAPL", asOf: "not-a-date" }), LookaheadViolationError);
});

test("assertNoPriceBarLookahead flags a same-day or future bar and passes prior days", () => {
  const asOf = "2026-01-05T09:35:00.000Z";
  assert.doesNotThrow(() => assertNoPriceBarLookahead([], asOf));
  assert.doesNotThrow(() => assertNoPriceBarLookahead([{ date: "2026-01-04" }, { date: "2026-01-02" }], asOf));
  assert.throws(() => assertNoPriceBarLookahead([{ date: "2026-01-05" }], asOf), LookaheadViolationError); // same day
  assert.throws(() => assertNoPriceBarLookahead([{ date: "2026-01-04" }, { date: "2026-01-09" }], asOf), LookaheadViolationError); // future
});

test("getPriceBarsAsOf re-checks what it returns: a result set that ignores the rule fails loudly, not quietly", async () => {
  const leakyDb = { prepare: () => ({ bind: () => ({ all: async () => ({ results: [{ ticker: "AAPL", date: "2026-01-05", close: 200 }] }) }) }) };
  await assert.rejects(() => getPriceBarsAsOf(leakyDb, { ticker: "AAPL", asOf: "2026-01-05T09:35:00.000Z" }), LookaheadViolationError);
});

test("the pipeline opens a position at the PRIOR close and shows the technical analyst only prior-day bars", async () => {
  const ctx = makeCtx();
  const publishedAt = "2026-01-05T09:35:00.000Z";
  await seedNews(ctx.inputs, { id: "n1", tickers: ["AAPL"], publishedAt, title: "AAPL beats", body: "body" });
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-02", close: 100 }); // Friday: the prior close
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-05", close: 200 }); // the article's own day: NOT knowable at 09:35

  let technicalPrompt = null;
  const config = {
    geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, maxPositionHoldDays: 10,
    fakeModel: makeFakeLongModel({ onCall: (opts, prompt) => { if (opts.extraFields?.agent === "technical") technicalPrompt = prompt; } }),
  };

  await runPipelineForTicker({}, config, ctx, {
    pipelineRunId: "run-1", ticker: "AAPL", asOf: publishedAt,
    newsItem: { id: "n1", tickers: ["AAPL"], title: "AAPL beats", body: "body", publishedAt },
  });

  const positions = await stateRows(ctx.stateDb, "positions");
  assert.equal(positions.length, 1);
  assert.equal(positions[0].entry_price, 100, "entry price is the prior close, not the same-day 200");

  assert.ok(technicalPrompt, "the technical analyst ran");
  assert.match(technicalPrompt, /"latestDate": "2026-01-02"/);
  assert.ok(!technicalPrompt.includes("2026-01-05"), "no same-day bar in the technical snapshot");
});

test("an exit check during day D does not see day D's bar: a same-day crash closes the position on D+1, at D's close", async () => {
  const ctx = makeCtx();
  const config = { maxPositionHoldDays: 10, geminiQuickModel: "quick", fakeModel: makeFakeLongModel() };
  await ctx.store.openPosition({
    id: "AAPL|t1", ticker: "AAPL", tradeThesisId: "AAPL|t1", positionSizePct: 0.03,
    direction: "long", entryPrice: 100, stopLossPct: 0.03, takeProfitPct: 0.06, openedAt: "2026-01-01T00:00:00Z",
  });
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-02", close: 100 }); // flat
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-03", close: 50 }); // -50%, far past the 3% stop

  // During Jan 3 the crash is not knowable yet: the latest visible close is Jan 2's.
  assert.deepEqual(await checkOpenPositionExits({}, config, ctx, { asOf: "2026-01-03T09:00:00.000Z" }), []);
  assert.deepEqual(await checkOpenPositionExits({}, config, ctx, { asOf: "2026-01-03T23:59:59.999Z" }), []);

  // From Jan 4 00:00Z the Jan 3 bar exists, and the stop fires at ITS close.
  const closed = await checkOpenPositionExits({}, config, ctx, { asOf: "2026-01-04T00:00:00.000Z" });
  assert.deepEqual(closed, [{ id: "AAPL|t1", ticker: "AAPL", reason: "stop_loss" }]);
  const [position] = await stateRows(ctx.stateDb, "positions");
  assert.equal(position.exit_price, 50);
  assert.equal(position.closed_at, "2026-01-04T00:00:00.000Z");
});
