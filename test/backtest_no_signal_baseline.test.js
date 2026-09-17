// Covers src/backtest/noSignalBaseline.js -- the "signal off" baseline
// closing plan.md's "comparable no-signal baseline strategy" gap for the
// signal on/off backtest harness. Uses a minimal in-memory fake of the
// price_bars table's SELECT shape only (getPriceBarsAsOf), same narrow-fake
// convention as test/price_bars_pointintime.test.js's FakePriceBarsDb --
// this file doesn't need the INSERT path since it only ever reads bars.

import test from "node:test";
import assert from "node:assert/strict";
import { computeBuyAndHoldReturn, computeBuyAndHoldReturns, makeBuyAndHoldOffReturns } from "../src/backtest/noSignalBaseline.js";

class FakePriceBarsDb {
  constructor(bars) {
    this.bars = bars; // [{ticker, date, close}, ...]
  }
  prepare(sql) {
    const db = this;
    return {
      bind(...args) {
        return {
          async all() {
            if (!/FROM price_bars/.test(sql)) throw new Error(`unsupported query: ${sql}`);
            const [ticker, asOf, limit] = args;
            const results = db.bars
              .filter((b) => b.ticker === ticker && b.date <= asOf)
              .sort((a, b) => (a.date < b.date ? 1 : -1))
              .slice(0, limit);
            return { results };
          },
        };
      },
    };
  }
}

test("computeBuyAndHoldReturn computes (exitClose - entryClose) / entryClose across the window", async () => {
  const db = new FakePriceBarsDb([
    { ticker: "AAPL", date: "2024-01-01", close: 100 },
    { ticker: "AAPL", date: "2024-01-15", close: 110 },
    { ticker: "AAPL", date: "2024-01-31", close: 121 },
  ]);

  const r = await computeBuyAndHoldReturn(db, { ticker: "AAPL", testStart: "2024-01-01", testEnd: "2024-01-31" });
  assert.ok(Math.abs(r - 0.21) < 1e-9); // (121 - 100) / 100
});

test("computeBuyAndHoldReturn ignores bars outside [testStart, testEnd]", async () => {
  const db = new FakePriceBarsDb([
    { ticker: "AAPL", date: "2023-12-01", close: 50 }, // before window -- must not become the entry bar
    { ticker: "AAPL", date: "2024-01-05", close: 100 },
    { ticker: "AAPL", date: "2024-01-25", close: 120 },
  ]);

  const r = await computeBuyAndHoldReturn(db, { ticker: "AAPL", testStart: "2024-01-01", testEnd: "2024-01-31" });
  assert.ok(Math.abs(r - 0.2) < 1e-9); // (120 - 100) / 100, NOT (120 - 50) / 50
});

test("computeBuyAndHoldReturn returns null (never fabricates) when no bar falls in the window", async () => {
  const db = new FakePriceBarsDb([{ ticker: "AAPL", date: "2023-06-01", close: 80 }]);
  const r = await computeBuyAndHoldReturn(db, { ticker: "AAPL", testStart: "2024-01-01", testEnd: "2024-01-31" });
  assert.equal(r, null);
});

test("computeBuyAndHoldReturn returns null when only one bar falls in the window (no hold period to measure)", async () => {
  const db = new FakePriceBarsDb([{ ticker: "AAPL", date: "2024-01-15", close: 100 }]);
  const r = await computeBuyAndHoldReturn(db, { ticker: "AAPL", testStart: "2024-01-01", testEnd: "2024-01-31" });
  assert.equal(r, null);
});

test("computeBuyAndHoldReturns pools returns across tickers, silently dropping a ticker with no computable return", async () => {
  const db = new FakePriceBarsDb([
    { ticker: "AAPL", date: "2024-01-01", close: 100 },
    { ticker: "AAPL", date: "2024-01-31", close: 110 },
    { ticker: "MSFT", date: "2024-01-01", close: 200 },
    { ticker: "MSFT", date: "2024-01-31", close: 180 },
    // TSLA has no bars at all -- should be silently absent, not a fabricated 0
  ]);

  const returns = await computeBuyAndHoldReturns(db, { tickers: ["AAPL", "MSFT", "TSLA"], testStart: "2024-01-01", testEnd: "2024-01-31" });
  assert.equal(returns.length, 2);
  assert.ok(returns.some((r) => Math.abs(r - 0.1) < 1e-9)); // AAPL: +10%
  assert.ok(returns.some((r) => Math.abs(r - -0.1) < 1e-9)); // MSFT: -10%
});

test("makeBuyAndHoldOffReturns returns a function matching compareSignalOnOffByWindow's getOffReturns(window) signature", async () => {
  const db = new FakePriceBarsDb([
    { ticker: "AAPL", date: "2024-01-01", close: 100 },
    { ticker: "AAPL", date: "2024-01-31", close: 105 },
  ]);

  const getOffReturns = makeBuyAndHoldOffReturns(db, { tickers: ["AAPL"] });
  // Same window shape walkForwardWindows yields (trainStart/trainEnd/testStart/testEnd) --
  // this function only reads testStart/testEnd, ignoring the train fields.
  const returns = await getOffReturns({ trainStart: "2023-12-01", trainEnd: "2024-01-01", testStart: "2024-01-01", testEnd: "2024-01-31" });
  assert.equal(returns.length, 1);
  assert.ok(Math.abs(returns[0] - 0.05) < 1e-9);
});
