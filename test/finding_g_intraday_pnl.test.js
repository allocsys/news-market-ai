// plan.md finding G, step 5 ("Tests"): the integration-level coverage step 4
// deliberately left out (see price_resolution.test.js's header) -- proving
// the fix through the actual pipeline/exit-check callers, on real sqlite
// inputs+state DBs, not just unit tests of resolveCurrentPrice in isolation.
//
// Three things, per plan.md's step-5 scope:
//   1. same-day-replace-has-real-PnL -- the actual finding-G regression:
//      two news items, one ticker, one UTC day, distinct intraday prices,
//      driven through runPipelineForTicker end to end -> nonzero realized
//      return on the replaced position (pre-fix this was always exactly 0,
//      see plan.md's root-cause writeup).
//   2. a lookahead leak-check on the resolver's CALLERS (pipeline.js,
//      exit_check.js) -- shared/intraday_availability.js already has its own
//      unit-level guard/tests; this proves the callers actually go through
//      it and never see a bar that has not fully closed at asOf.
//   3. fallback-to-daily coverage under real pipeline/exit-check conditions
//      (not just the bare resolveCurrentPrice unit test in
//      price_resolution.test.js) -- a ticker with no intraday bars at all
//      (the realistic case: the intraday backfill, plan.md step 6, isn't
//      built yet, so nothing has ever written price_bars_intraday in
//      production) still opens/exits off the daily close, and the fallback
//      is logged (Adopted Pattern #11).

import test from "node:test";
import assert from "node:assert/strict";
import { runPipelineForTicker } from "../src/graph/pipeline.js";
import { checkOpenPositionExits } from "../src/graph/exit_check.js";
import { TRADE_DECISION_STATUS } from "../src/shared/constants.js";
import { makeCtx, seedBar, seedIntradayBar, stateRows } from "./helpers/engine_ctx.js";
import { makeFakeLongModel } from "./helpers/fake_long_model.js";

const config = () => ({
  geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, maxPositionHoldDays: 10,
  fakeModel: makeFakeLongModel(),
});

function newsItem(id, publishedAt) {
  return { id, tickers: ["AAPL"], title: "AAPL news", body: "body", publishedAt };
}

async function withSuppressedConsoleError(fn) {
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args);
  try {
    return { result: await fn(), errors };
  } finally {
    console.error = original;
  }
}

// --- 1. same-day-replace-has-real-PnL (the actual finding-G regression) ----

test("finding G: two same-day, same-ticker theses replace at DISTINCT intraday prices and settle a nonzero realized return", async () => {
  const ctx = makeCtx();
  // Previous day's close: what BOTH legs would have priced at pre-fix (the
  // bug), producing a fabricated realized_return of exactly 0.
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-14", close: 180 });
  // Two distinct intraday bars, same UTC day (2026-01-15).
  await seedIntradayBar(ctx.inputs, { ticker: "AAPL", ts: "2026-01-15T13:30:00Z", close: 181.2 }); // visible from 13:35
  await seedIntradayBar(ctx.inputs, { ticker: "AAPL", ts: "2026-01-15T15:45:00Z", close: 179.4 }); // visible from 15:50

  const morningAsOf = "2026-01-15T13:36:00Z";
  const afternoonAsOf = "2026-01-15T15:51:00Z";
  // Same UTC calendar day for both -- this is the exact scenario the bug
  // required (getPriceBarsAsOf's daily-only read collapses both to Jan 14's
  // close); asserted explicitly so the test can't accidentally drift into
  // testing a cross-day replace instead.
  assert.equal(morningAsOf.slice(0, 10), afternoonAsOf.slice(0, 10));

  await runPipelineForTicker({}, config(), ctx, { pipelineRunId: "news-1", ticker: "AAPL", newsItem: newsItem("news-1", morningAsOf), asOf: morningAsOf });
  const opened = await stateRows(ctx.stateDb, "positions");
  assert.equal(opened.length, 1);
  assert.equal(opened[0].entry_price, 181.2, "opened at the morning intraday bar, not the prior daily close");

  await runPipelineForTicker({}, config(), ctx, { pipelineRunId: "news-2", ticker: "AAPL", newsItem: newsItem("news-2", afternoonAsOf), asOf: afternoonAsOf });

  const positions = await stateRows(ctx.stateDb, "positions", "opened_at");
  assert.equal(positions.length, 2);
  assert.equal(positions[0].close_reason, "replaced");
  assert.equal(positions[0].exit_price, 179.4, "replaced-leg exit priced off the afternoon intraday bar, not the same morning entry");
  assert.equal(positions[1].entry_price, 179.4, "new leg opened at the same afternoon bar");
  assert.notEqual(positions[0].entry_price, positions[0].exit_price, "finding G's bug: same-day replace priced both legs identically");

  const memory = await stateRows(ctx.stateDb, "decision_memory");
  assert.equal(memory.length, 1);
  const expectedReturn = (179.4 - 181.2) / 181.2;
  assert.ok(Math.abs(memory[0].realized_return - expectedReturn) < 1e-9);
  assert.notEqual(memory[0].realized_return, 0, "finding G's fabricated outcome: a real same-day replace must never settle as exactly 0 PnL");
});

// --- 2. lookahead leak-check on the resolver's callers ----------------------

test("pipeline never opens a position off an intraday bar that has not fully closed at asOf", async () => {
  const ctx = makeCtx();
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-14", close: 180 });
  await seedIntradayBar(ctx.inputs, { ticker: "AAPL", ts: "2026-01-15T13:30:00Z", close: 999 }); // would be a screaming leak if visible

  // asOf sits INSIDE the 13:30-13:34:59 bar's own window: not visible yet
  // (shared/intraday_availability.js: visible only from ts + 5min).
  const asOf = "2026-01-15T13:32:00Z";
  await runPipelineForTicker({}, config(), ctx, { pipelineRunId: "news-1", ticker: "AAPL", newsItem: newsItem("news-1", asOf), asOf });

  const [position] = await stateRows(ctx.stateDb, "positions");
  assert.equal(position.entry_price, 180, "must fall back to the daily close -- the 999 intraday bar has not closed yet");
  assert.notEqual(position.entry_price, 999);
});

test("exit-check never prices a stop-loss/take-profit off an intraday bar that has not fully closed at asOf", async () => {
  const ctx = makeCtx();
  // openedAt is well within maxPositionHoldDays (10) of every asOf used below,
  // so the (correctly lower-priority, see evaluateExit's own doc comment)
  // time_based exit can never fire here -- this test is isolated to the
  // price-based lookahead path only.
  await ctx.store.openPosition({
    id: "AAPL|t1", ticker: "AAPL", tradeThesisId: "AAPL|t1", positionSizePct: 0.03,
    direction: "long", entryPrice: 100, stopLossPct: 0.03, takeProfitPct: 0.06, openedAt: "2026-01-14T00:00:00Z",
  });
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-14", close: 100 }); // flat -- would NOT trigger the stop
  // A not-yet-closed intraday bar deep past the stop -- must not leak in early.
  await seedIntradayBar(ctx.inputs, { ticker: "AAPL", ts: "2026-01-15T13:30:00Z", close: 50 });

  const insideBarWindow = "2026-01-15T13:33:00Z"; // before ts+5min
  assert.deepEqual(await checkOpenPositionExits({}, { maxPositionHoldDays: 10 }, ctx, { asOf: insideBarWindow }), [], "the crash bar must not be visible before it has closed");

  // Once the SAME bar has actually closed, the stop correctly fires off it.
  const afterBarCloses = "2026-01-15T13:35:00Z"; // exactly ts+5min
  const closed = await checkOpenPositionExits({}, { maxPositionHoldDays: 10 }, ctx, { asOf: afterBarCloses });
  assert.deepEqual(closed, [{ id: "AAPL|t1", ticker: "AAPL", reason: "stop_loss" }]);
  const [position] = await stateRows(ctx.stateDb, "positions");
  assert.equal(position.exit_price, 50);
});

// --- 3. fallback-to-daily under real pipeline/exit-check conditions --------

test("pipeline falls back to the daily close, logged, for a ticker with NO intraday bars at all (the realistic pre-backfill case)", async () => {
  const ctx = makeCtx();
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-14", close: 150 });
  // No seedIntradayBar call at all -- price_bars_intraday is empty for AAPL,
  // the honest current-production state (plan.md step 6, the backfill
  // writer, is not built yet).
  const asOf = "2026-01-15T13:36:00Z";

  const { errors } = await withSuppressedConsoleError(() =>
    runPipelineForTicker({}, config(), ctx, { pipelineRunId: "news-1", ticker: "AAPL", newsItem: newsItem("news-1", asOf), asOf })
  );

  const [position] = await stateRows(ctx.stateDb, "positions");
  assert.equal(position.entry_price, 150, "opened off the daily close with no intraday data at all");
  assert.ok(
    errors.some((args) => /falling back to daily close/.test(String(args[0])) && args[1]?.ticker === "AAPL"),
    "the daily fallback must be logged (Adopted Pattern #11), even though the pipeline otherwise succeeds"
  );
});

test("exit-check falls back to the daily close, logged, for a ticker with no intraday bars, and can still trigger a stop off it", async () => {
  const ctx = makeCtx();
  await ctx.store.openPosition({
    id: "AAPL|t1", ticker: "AAPL", tradeThesisId: "AAPL|t1", positionSizePct: 0.03,
    direction: "long", entryPrice: 100, stopLossPct: 0.03, takeProfitPct: 0.06, openedAt: "2026-01-01T00:00:00Z",
  });
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-14", close: 50 }); // -50%, past the 3% stop
  // No intraday bars at all.

  const { result: closed, errors } = await withSuppressedConsoleError(() =>
    checkOpenPositionExits({}, { maxPositionHoldDays: 10 }, ctx, { asOf: "2026-01-15T13:36:00Z" })
  );

  assert.deepEqual(closed, [{ id: "AAPL|t1", ticker: "AAPL", reason: "stop_loss" }]);
  const [position] = await stateRows(ctx.stateDb, "positions");
  assert.equal(position.exit_price, 50);
  assert.ok(
    errors.some((args) => /falling back to daily close/.test(String(args[0])) && args[1]?.ticker === "AAPL"),
    "exit-check's daily fallback must also be logged"
  );
});

// --- SKIPPED_NO_PRICE_DATA still holds with neither source available -------

test("a ticker with neither intraday nor daily data still records SKIPPED_NO_PRICE_DATA (unchanged by finding G's fix)", async () => {
  const ctx = makeCtx(); // nothing seeded at all
  const asOf = "2026-01-15T13:36:00Z";
  await runPipelineForTicker({}, config(), ctx, { pipelineRunId: "news-1", ticker: "AAPL", newsItem: newsItem("news-1", asOf), asOf });

  const decisions = await stateRows(ctx.stateDb, "trade_decisions");
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].status, TRADE_DECISION_STATUS.SKIPPED_NO_PRICE_DATA);
  assert.equal((await stateRows(ctx.stateDb, "positions")).length, 0);
});
