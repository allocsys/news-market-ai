// plan.md step D: the two scoring reads (inputs_view#getPriceBarsInRange,
// RunStore#getPositionsInRange) and the preflight built on them
// (backtest/priceGrid.js), against real sqlite D1s. The scoring reads are the
// deliberate, both-bounds-required exceptions to "every read takes an asOf".

import test from "node:test";
import assert from "node:assert/strict";
import { getPriceBarsInRange } from "../src/storage/inputs_view.js";
import { LookaheadViolationError } from "../src/shared/errors.js";
import { loadPriceGrid, assertPriceCoverage } from "../src/backtest/priceGrid.js";
import { offEquityReturns } from "../src/backtest/equity.js";
import { makeCtx, seedBar } from "./helpers/engine_ctx.js";

// ---------------------------------------------------------------------------
// getPriceBarsInRange
// ---------------------------------------------------------------------------

test("getPriceBarsInRange returns [fromDate, toDate) oldest first, one ticker only, no row cap", async () => {
  const ctx = makeCtx();
  const COUNT = 620; // more than the 500 the old reads capped at
  const day = (i) => new Date(Date.UTC(2020, 0, 1) + i * 86400000).toISOString().slice(0, 10);
  for (let i = 0; i < COUNT; i++) await seedBar(ctx.inputs, { ticker: "AAPL", date: day(i), close: 100 + i });
  await seedBar(ctx.inputs, { ticker: "MSFT", date: day(5), close: 1 });

  const bars = await getPriceBarsInRange(ctx.inputs, { ticker: "AAPL", fromDate: day(0), toDate: day(COUNT) });
  assert.equal(bars.length, COUNT);
  assert.deepEqual(bars.map((b) => b.date), Array.from({ length: COUNT }, (_, i) => day(i)));
  assert.deepEqual(Object.keys(bars[0]).sort(), ["close", "date", "ticker"]);

  const window = await getPriceBarsInRange(ctx.inputs, { ticker: "AAPL", fromDate: day(10), toDate: day(13) });
  assert.deepEqual(window.map((b) => b.date), [day(10), day(11), day(12)]); // toDate exclusive
});

test("getPriceBarsInRange requires both bounds", async () => {
  const ctx = makeCtx();
  await assert.rejects(() => getPriceBarsInRange(ctx.inputs, { ticker: "AAPL", fromDate: "2024-01-01" }), LookaheadViolationError);
  await assert.rejects(() => getPriceBarsInRange(ctx.inputs, { ticker: "AAPL", toDate: "2024-01-01" }), LookaheadViolationError);
});

// ---------------------------------------------------------------------------
// RunStore#getPositionsInRange
// ---------------------------------------------------------------------------

async function open(store, id, ticker, openedAt, extra = {}) {
  await store.openPosition({ id, ticker, tradeThesisId: id, positionSizePct: 0.04, direction: "long", entryPrice: 100, stopLossPct: 0.03, takeProfitPct: 0.06, openedAt, ...extra });
}

test("getPositionsInRange returns the run's positions open at any point in [from, to), closed or not, with what the scorer needs", async () => {
  const ctx = makeCtx();
  await open(ctx.store, "before", "AAPL", "2025-12-01T00:00:00.000Z"); // closed before `from`: excluded
  await ctx.store.closePosition({ id: "before", closedAt: "2025-12-20T00:00:00.000Z", closeReason: "time_based", exitPrice: 101 });
  await open(ctx.store, "carried", "AAPL2", "2025-12-30T00:00:00.000Z"); // opened before, still open: included
  await open(ctx.store, "closed-in", "MSFT", "2026-01-02T00:00:00.000Z");
  await ctx.store.closePosition({ id: "closed-in", closedAt: "2026-01-04T00:00:00.000Z", closeReason: "stop_loss", exitPrice: 97 });
  await open(ctx.store, "after", "TSLA", "2026-01-06T00:00:00.000Z"); // opened at `to`: excluded

  const rows = await ctx.store.getPositionsInRange({ from: "2026-01-01T00:00:00.000Z", to: "2026-01-06T00:00:00.000Z" });

  assert.deepEqual(rows.map((r) => r.id), ["carried", "closed-in"]); // oldest opened first
  assert.deepEqual(rows[1], {
    id: "closed-in", ticker: "MSFT", direction: "long", positionSizePct: 0.04, entryPrice: 100, exitPrice: 97,
    closeReason: "stop_loss", openedAt: "2026-01-02T00:00:00.000Z", closedAt: "2026-01-04T00:00:00.000Z",
  });
  assert.equal(rows[0].closedAt, null);
});

test("getPositionsInRange reads only its own run's positions, and requires both bounds", async () => {
  const ctx = makeCtx({ runId: "bt-1" });
  await open(ctx.store, "mine", "AAPL", "2026-01-02T00:00:00.000Z");
  const other = new ctx.store.constructor(ctx.stateDb, "bt-2");
  await open(other, "theirs", "MSFT", "2026-01-02T00:00:00.000Z");

  const rows = await ctx.store.getPositionsInRange({ from: "2026-01-01T00:00:00.000Z", to: "2026-01-06T00:00:00.000Z" });
  assert.deepEqual(rows.map((r) => r.id), ["mine"]);

  await assert.rejects(() => ctx.store.getPositionsInRange({ from: "2026-01-01T00:00:00.000Z" }), LookaheadViolationError);
});

// ---------------------------------------------------------------------------
// loadPriceGrid / assertPriceCoverage
// ---------------------------------------------------------------------------

test("loadPriceGrid takes the bar dated on testStart's own day when testStart is an ISO timestamp (the late-entry bug), and buys at the prior close", async () => {
  const ctx = makeCtx();
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2023-12-29", close: 100 }); // the last bar before the span: the entry price
  for (const [date, c] of [["2024-01-01", 105], ["2024-01-02", 105], ["2024-01-03", 105], ["2024-01-04", 105]]) {
    await seedBar(ctx.inputs, { ticker: "AAPL", date, close: c });
  }

  const grid = await loadPriceGrid(ctx.inputs, { tickers: ["AAPL"], testStart: "2024-01-01T00:00:00.000Z", testEnd: "2024-01-05T00:00:00.000Z" });

  assert.deepEqual(grid.problems, []);
  assert.deepEqual(grid.dates, ["2024-01-01", "2024-01-02", "2024-01-03", "2024-01-04"]); // Jan 1 is IN
  const { returns } = offEquityReturns(grid);
  assert.ok(Math.abs(returns[0] - 0.05) < 1e-9, `Jan 1 earns the 100 -> 105 move, got ${returns[0]}`);
  assert.deepEqual(returns.slice(1), [0, 0, 0]);
});

test("loadPriceGrid ignores bars dated on or after testEnd (not visible at the end of the span)", async () => {
  const ctx = makeCtx();
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2024-01-01", close: 100 });
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2024-01-02", close: 110 });
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2024-01-03", close: 9999 }); // == testEnd's date

  const grid = await loadPriceGrid(ctx.inputs, { tickers: ["AAPL"], testStart: "2024-01-01T00:00:00.000Z", testEnd: "2024-01-03T00:00:00.000Z" });
  assert.deepEqual(grid.dates, ["2024-01-01", "2024-01-02"]);
  assert.deepEqual(grid.closes.AAPL, [100, 110]);
});

test("assertPriceCoverage passes a clean grid and otherwise names every ticker and reason, says no LLM calls were made, and says what to backfill", async () => {
  const ctx = makeCtx();
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2024-01-01", close: 100 });
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2024-01-02", close: 100 });
  await seedBar(ctx.inputs, { ticker: "TSLA", date: "2023-11-01", close: 100 }); // far too old

  const clean = await loadPriceGrid(ctx.inputs, { tickers: ["AAPL"], testStart: "2024-01-01T00:00:00.000Z", testEnd: "2024-01-03T00:00:00.000Z" });
  assert.doesNotThrow(() => assertPriceCoverage(clean));

  const bad = await loadPriceGrid(ctx.inputs, { tickers: ["AAPL", "MSFT", "TSLA"], testStart: "2024-01-01T00:00:00.000Z", testEnd: "2024-01-03T00:00:00.000Z" });
  assert.throws(() => assertPriceCoverage(bad), (err) => {
    assert.match(err.message, /no LLM calls were made/);
    assert.match(err.message, /MSFT: no price bars/);
    assert.match(err.message, /TSLA: no price bars/);
    assert.doesNotMatch(err.message, /AAPL: /); // AAPL is fine and is not blamed
    assert.match(err.message, /Backfill daily price bars for MSFT, TSLA covering 2024-01-01 to 2024-01-03/);
    return true;
  });
});
