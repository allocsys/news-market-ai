// Covers src/backtest/noSignalBaseline.js -- the "signal off" baseline
// closing plan.md's "comparable no-signal baseline strategy" gap for the
// signal on/off backtest harness. Since plan.md step C it runs against a REAL
// sqlite inputs DB (it used to use a hand-written fake of the price_bars
// SELECT), so the "a bar is visible from the UTC day after its date" rule is
// the real SQL's.
// The exit bar of a window is the last bar STRICTLY BEFORE testEnd's date
// (testEnd is exclusive and that day's own bar is not final at testEnd).

import test from "node:test";
import assert from "node:assert/strict";
import { computeBuyAndHoldReturn, computeBuyAndHoldReturns, makeBuyAndHoldOffReturns } from "../src/backtest/noSignalBaseline.js";
import { makeCtx, seedBar } from "./helpers/engine_ctx.js";

/** A real sqlite-backed inputs DB (real migrations, real getPriceBarsAsOf SQL) holding exactly `bars` ([{ticker, date, close}]). */
async function dbWith(bars) {
  const ctx = makeCtx();
  for (const bar of bars) await seedBar(ctx.inputs, bar);
  return ctx.inputs;
}

test("computeBuyAndHoldReturn computes (exitClose - entryClose) / entryClose across the window", async () => {
  const db = await dbWith([
    { ticker: "AAPL", date: "2024-01-01", close: 100 },
    { ticker: "AAPL", date: "2024-01-15", close: 110 },
    { ticker: "AAPL", date: "2024-01-30", close: 121 },
  ]);

  const r = await computeBuyAndHoldReturn(db, { ticker: "AAPL", testStart: "2024-01-01", testEnd: "2024-01-31" });
  assert.ok(Math.abs(r - 0.21) < 1e-9); // (121 - 100) / 100
});

test("computeBuyAndHoldReturn ignores bars outside [testStart, testEnd]", async () => {
  const db = await dbWith([
    { ticker: "AAPL", date: "2023-12-01", close: 50 }, // before window -- must not become the entry bar
    { ticker: "AAPL", date: "2024-01-05", close: 100 },
    { ticker: "AAPL", date: "2024-01-25", close: 120 },
    { ticker: "AAPL", date: "2024-01-31", close: 999 }, // testEnd's own day: not visible at testEnd, must not become the exit bar
  ]);

  const r = await computeBuyAndHoldReturn(db, { ticker: "AAPL", testStart: "2024-01-01", testEnd: "2024-01-31" });
  assert.ok(Math.abs(r - 0.2) < 1e-9); // (120 - 100) / 100, NOT (120 - 50) / 50
});

test("computeBuyAndHoldReturn returns null (never fabricates) when no bar falls in the window", async () => {
  const db = await dbWith([{ ticker: "AAPL", date: "2023-06-01", close: 80 }]);
  const r = await computeBuyAndHoldReturn(db, { ticker: "AAPL", testStart: "2024-01-01", testEnd: "2024-01-31" });
  assert.equal(r, null);
});

test("computeBuyAndHoldReturn returns null when only one bar falls in the window (no hold period to measure)", async () => {
  const db = await dbWith([{ ticker: "AAPL", date: "2024-01-15", close: 100 }]);
  const r = await computeBuyAndHoldReturn(db, { ticker: "AAPL", testStart: "2024-01-01", testEnd: "2024-01-31" });
  assert.equal(r, null);
});

test("computeBuyAndHoldReturns pools returns across tickers, silently dropping a ticker with no computable return", async () => {
  const db = await dbWith([
    { ticker: "AAPL", date: "2024-01-01", close: 100 },
    { ticker: "AAPL", date: "2024-01-30", close: 110 },
    { ticker: "MSFT", date: "2024-01-01", close: 200 },
    { ticker: "MSFT", date: "2024-01-30", close: 180 },
    // TSLA has no bars at all -- should be silently absent, not a fabricated 0
  ]);

  const returns = await computeBuyAndHoldReturns(db, { tickers: ["AAPL", "MSFT", "TSLA"], testStart: "2024-01-01", testEnd: "2024-01-31" });
  assert.equal(returns.length, 2);
  assert.ok(returns.some((r) => Math.abs(r - 0.1) < 1e-9)); // AAPL: +10%
  assert.ok(returns.some((r) => Math.abs(r - -0.1) < 1e-9)); // MSFT: -10%
});

test("makeBuyAndHoldOffReturns returns a function matching compareSignalOnOffByWindow's getOffReturns(window) signature", async () => {
  const db = await dbWith([
    { ticker: "AAPL", date: "2024-01-01", close: 100 },
    { ticker: "AAPL", date: "2024-01-30", close: 105 },
  ]);

  const getOffReturns = makeBuyAndHoldOffReturns(db, { tickers: ["AAPL"] });
  // Same window shape walkForwardWindows yields (trainStart/trainEnd/testStart/testEnd) --
  // this function only reads testStart/testEnd, ignoring the train fields.
  const returns = await getOffReturns({ trainStart: "2023-12-01", trainEnd: "2024-01-01", testStart: "2024-01-01", testEnd: "2024-01-31" });
  assert.equal(returns.length, 1);
  assert.ok(Math.abs(returns[0] - 0.05) < 1e-9);
});
