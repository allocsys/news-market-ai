// price_bars_pointintime test (plan.md open item: yfinance price/volume
// ingestion). Covers two things: market_data_validator.js#validatePriceBar's
// sanity checks (pure function, no DB needed), and storage/d1.js's
// insertPriceBar/getPriceBarsAsOf point-in-time cutoff, against a minimal
// in-memory fake of the `price_bars` table (same honest, narrow-fake
// convention as the other *_pointintime tests in this directory).
//
// Does NOT exercise ingestion/sources/yfinance.js's live HTTP call -- see
// that file's own header for the unresolved cookie/crumb auth risk that
// makes a live spot-check premature. A separate test below exercises just
// its response-parsing logic against a mocked fetch, which IS safe/useful
// to verify without hitting the real (possibly gated) endpoint.

import test from "node:test";
import assert from "node:assert/strict";
import { validatePriceBar } from "../src/ingestion/market_data_validator.js";
import { insertPriceBar, getPriceBarsAsOf } from "../src/storage/d1.js";
import { VendorError, LookaheadViolationError } from "../src/shared/errors.js";
import { fetchDailyBars } from "../src/ingestion/sources/yfinance.js";

const VALID_BAR = { ticker: "AAPL", date: "2026-01-05", open: 100, high: 105, low: 99, close: 103, volume: 1000, source: "yfinance" };

test("validatePriceBar accepts an internally consistent bar", () => {
  assert.doesNotThrow(() => validatePriceBar(VALID_BAR));
});

test("validatePriceBar rejects a bar dated in the future", () => {
  const bar = { ...VALID_BAR, date: "2099-01-01" };
  assert.throws(() => validatePriceBar(bar), VendorError);
});

test("validatePriceBar rejects an unparseable date", () => {
  const bar = { ...VALID_BAR, date: "not-a-date" };
  assert.throws(() => validatePriceBar(bar), VendorError);
});

test("validatePriceBar rejects negative volume", () => {
  const bar = { ...VALID_BAR, volume: -5 };
  assert.throws(() => validatePriceBar(bar), VendorError);
});

test("validatePriceBar rejects high < low", () => {
  const bar = { ...VALID_BAR, high: 90, low: 99 };
  assert.throws(() => validatePriceBar(bar), VendorError);
});

test("validatePriceBar rejects high less than open or close", () => {
  const bar = { ...VALID_BAR, high: 101, open: 100, close: 103 }; // close (103) > high (101)
  assert.throws(() => validatePriceBar(bar), VendorError);
});

test("validatePriceBar rejects low greater than open or close", () => {
  const bar = { ...VALID_BAR, low: 102, open: 100, close: 103 }; // open (100) < low (102)
  assert.throws(() => validatePriceBar(bar), VendorError);
});

test("validatePriceBar rejects a non-numeric field", () => {
  const bar = { ...VALID_BAR, close: "103" };
  assert.throws(() => validatePriceBar(bar), VendorError);
});

class FakePriceBarsDb {
  constructor() {
    this.rows = new Map(); // `${ticker}|${date}` -> row
  }

  prepare(sql) {
    const db = this;
    return {
      bind(...args) {
        return {
          async run() {
            if (!/INSERT INTO price_bars/.test(sql)) {
              throw new Error(`FakePriceBarsDb: unsupported run() query: ${sql}`);
            }
            const [ticker, date, open, high, low, close, volume, source, ingestedAt] = args;
            db.rows.set(`${ticker}|${date}`, { ticker, date, open, high, low, close, volume, source, ingested_at: ingestedAt });
          },
          async all() {
            if (!/FROM price_bars/.test(sql)) {
              throw new Error(`FakePriceBarsDb: unsupported all() query: ${sql}`);
            }
            const [ticker, asOf, limit] = args;
            const results = [...db.rows.values()]
              .filter((r) => r.ticker === ticker && r.date <= asOf)
              .sort((a, b) => (a.date < b.date ? 1 : -1))
              .slice(0, limit)
              .map(({ ticker, date, open, high, low, close, volume, source }) => ({ ticker, date, open, high, low, close, volume, source }));
            return { results };
          },
        };
      },
    };
  }
}

test("getPriceBarsAsOf throws LookaheadViolationError when asOf is omitted", async () => {
  const db = new FakePriceBarsDb();
  await assert.rejects(() => getPriceBarsAsOf(db, { ticker: "AAPL" }), LookaheadViolationError);
});

test("getPriceBarsAsOf returns only bars dated at or before asOf, most recent first", async () => {
  const db = new FakePriceBarsDb();
  await insertPriceBar(db, { ...VALID_BAR, date: "2026-01-05" });
  await insertPriceBar(db, { ...VALID_BAR, date: "2026-01-06" });
  await insertPriceBar(db, { ...VALID_BAR, date: "2026-01-10" }); // future relative to asOf below

  const results = await getPriceBarsAsOf(db, { ticker: "AAPL", asOf: "2026-01-07" });

  assert.equal(results.length, 2);
  assert.equal(results[0].date, "2026-01-06"); // most recent eligible first
  assert.ok(!results.some((r) => r.date === "2026-01-10"));
});

test("insertPriceBar upserts on (ticker, date) rather than duplicating", async () => {
  const db = new FakePriceBarsDb();
  await insertPriceBar(db, { ...VALID_BAR, close: 103 });
  await insertPriceBar(db, { ...VALID_BAR, close: 999 }); // re-ingest same trading day with a corrected close

  const results = await getPriceBarsAsOf(db, { ticker: "AAPL", asOf: "2026-01-05" });
  assert.equal(results.length, 1);
  assert.equal(results[0].close, 999); // overwritten, not duplicated
});

// --- yfinance.js response-parsing logic, against a mocked fetch ---

function mockYahooResponse({ timestamps, open, high, low, close, volume }) {
  return {
    chart: {
      result: [{ timestamp: timestamps, indicators: { quote: [{ open, high, low, close, volume }] } }],
      error: null,
    },
  };
}

test("fetchDailyBars parses a well-formed Yahoo chart response into valid PriceBars", async (t) => {
  const config = { watchlist: [{ ticker: "AAPL" }], yfinanceApiBase: "https://fake.test/chart", yfinanceInterval: "1d", yfinanceRange: "5d" };
  const body = mockYahooResponse({
    timestamps: [1767571200], // 2026-01-05T00:00:00Z
    open: [100],
    high: [105],
    low: [99],
    close: [103],
    volume: [1000],
  });

  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, json: async () => body }));

  const bars = await fetchDailyBars(config, { tickers: ["AAPL"] });
  assert.equal(bars.length, 1);
  assert.equal(bars[0].ticker, "AAPL");
  assert.equal(bars[0].date, "2026-01-05");
  assert.equal(bars[0].close, 103);
});

test("fetchDailyBars skips a bar with a null field instead of fabricating a value", async (t) => {
  const config = { watchlist: [{ ticker: "AAPL" }], yfinanceApiBase: "https://fake.test/chart", yfinanceInterval: "1d", yfinanceRange: "5d" };
  const body = mockYahooResponse({
    timestamps: [1767571200, 1767657600],
    open: [100, 101],
    high: [105, null], // halted-session-style gap on the second bar
    low: [99, 100],
    close: [103, 102],
    volume: [1000, 500],
  });

  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, json: async () => body }));

  const bars = await fetchDailyBars(config, { tickers: ["AAPL"] });
  assert.equal(bars.length, 1); // second bar skipped, not inserted with a fake high
});

test("fetchDailyBars throws a transient VendorError on HTTP 429", async (t) => {
  const config = { watchlist: [{ ticker: "AAPL" }], yfinanceApiBase: "https://fake.test/chart", yfinanceInterval: "1d", yfinanceRange: "5d" };
  t.mock.method(global, "fetch", async () => ({ ok: false, status: 429 }));

  await assert.rejects(() => fetchDailyBars(config, { tickers: ["AAPL"] }), (err) => {
    assert.ok(err instanceof VendorError);
    assert.equal(err.transient, true);
    return true;
  });
});
