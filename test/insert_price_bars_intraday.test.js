// Covers storage/inputs_view.js#insertPriceBarsIntraday (plan.md finding G,
// step 6) -- the write path getIntradayPriceAsOf (step 3) reads from.
// Against a REAL sqlite price_bars_intraday table (migrations/inputs/).

import test from "node:test";
import assert from "node:assert/strict";
import { insertPriceBarsIntraday, getIntradayPriceAsOf } from "../src/storage/inputs_view.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { INPUTS_DIR } from "./helpers/engine_ctx.js";

const newDb = () => createTestD1([INPUTS_DIR]);

function bar(ticker, ts, close, { source = "alpaca" } = {}) {
  return { ticker, ts, open: close - 0.5, high: close + 1, low: close - 1, close, volume: 1000, source };
}

test("no-op on an empty array", async () => {
  const db = newDb();
  await insertPriceBarsIntraday(db, []);
  const { results } = await db.prepare("SELECT COUNT(*) AS n FROM price_bars_intraday").all();
  assert.equal(results[0].n, 0);
});

test("inserts multiple bars in one batch, readable via getIntradayPriceAsOf", async () => {
  const db = newDb();
  await insertPriceBarsIntraday(db, [
    bar("AAPL", "2026-01-15T13:30:00Z", 100),
    bar("AAPL", "2026-01-15T13:35:00Z", 101),
    bar("MSFT", "2026-01-15T13:30:00Z", 400),
  ]);

  const { results } = await db.prepare("SELECT ticker, ts, close, source FROM price_bars_intraday ORDER BY ticker, ts").all();
  assert.equal(results.length, 3);

  const row = await getIntradayPriceAsOf(db, { ticker: "AAPL", asOf: "2026-01-15T13:40:00Z" });
  assert.equal(row.ts, "2026-01-15T13:35:00Z");
  assert.equal(row.close, 101);
});

test("re-inserting the same (ticker, ts) UPSERTS, never duplicates -- a re-fetched backfill day overwrites cleanly", async () => {
  const db = newDb();
  await insertPriceBarsIntraday(db, [bar("AAPL", "2026-01-15T13:30:00Z", 100)]);
  await insertPriceBarsIntraday(db, [bar("AAPL", "2026-01-15T13:30:00Z", 105, { source: "alpaca" })]);

  const { results } = await db.prepare("SELECT ticker, ts, close FROM price_bars_intraday WHERE ticker = ? AND ts = ?").bind("AAPL", "2026-01-15T13:30:00Z").all();
  assert.equal(results.length, 1, "no duplicate row");
  assert.equal(results[0].close, 105, "the second write's values win");
});

test("a chunk larger than one page (~300 bars, a full trading day) round-trips correctly in one batch call", async () => {
  const db = newDb();
  const bars = [];
  const first = Date.parse("2026-01-15T13:30:00Z");
  for (let i = 0; i < 300; i++) {
    bars.push(bar("AAPL", new Date(first + i * 5 * 60_000).toISOString(), 100 + i));
  }
  await insertPriceBarsIntraday(db, bars);

  const { results } = await db.prepare("SELECT COUNT(*) AS n FROM price_bars_intraday").all();
  assert.equal(results[0].n, 300);
});
