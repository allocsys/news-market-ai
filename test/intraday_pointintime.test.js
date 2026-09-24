// Covers plan.md finding G step 3: storage/inputs_view.js#getIntradayPriceAsOf
// and shared/intraday_availability.js, against a REAL sqlite
// price_bars_intraday table built from migrations/inputs/.
//
// The rule under test: an intraday bar is stamped with its OPEN time and is
// visible only once it has FULLY CLOSED (ts + 5 minutes <= asOf). Mirrors
// test/price_bars_no_same_day_leak.test.js, one granularity finer: the leak
// checks here are the ones that would catch a decision at 13:35:00 being
// shown the 13:35 bar, whose close was not set until 13:40.

import test from "node:test";
import assert from "node:assert/strict";
import { getIntradayPriceAsOf, getPriceBarsAsOf, insertPriceBar } from "../src/storage/inputs_view.js";
import {
  INTRADAY_BAR_MS,
  assertNoIntradayLookahead,
  canonicalIntradayTs,
  intradayBarAvailableAt,
  intradayCutoffTs,
} from "../src/shared/intraday_availability.js";
import { LookaheadViolationError } from "../src/shared/errors.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { INPUTS_DIR } from "./helpers/engine_ctx.js";

const newDb = () => createTestD1([INPUTS_DIR]);

/** One intraday bar; `close` is the value tests assert on, the rest is a consistent OHLC around it. */
async function putBar(db, ticker, ts, close, { source = "alpaca" } = {}) {
  await db
    .prepare("INSERT INTO price_bars_intraday (ticker, ts, open, high, low, close, volume, source, ingested_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(ticker, ts, close - 0.5, close + 1, close - 1, close, 1000, source, "2025-09-03T00:00:00Z")
    .run();
}

// ---------------------------------------------------------------------------
// the visibility rule: a bar is visible only once it has fully closed
// ---------------------------------------------------------------------------

test("a bar is NOT visible at its own open time: the 13:35 bar (13:35-13:39:59) appears at 13:40:00, not before", async () => {
  const db = newDb();
  await putBar(db, "AAPL", "2025-09-02T13:30:00Z", 100);
  await putBar(db, "AAPL", "2025-09-02T13:35:00Z", 101);
  await putBar(db, "AAPL", "2025-09-02T13:40:00Z", 102);

  const at = (asOf) => getIntradayPriceAsOf(db, { ticker: "AAPL", asOf });

  assert.equal((await at("2025-09-02T13:35:00Z"))?.ts, "2025-09-02T13:30:00Z", "at 13:35:00 the 13:35 bar has only just opened");
  assert.equal((await at("2025-09-02T13:39:59Z"))?.ts, "2025-09-02T13:30:00Z", "one second before it closes it is still hidden");
  assert.equal((await at("2025-09-02T13:39:59.999Z"))?.ts, "2025-09-02T13:30:00Z", "even one millisecond before");
  assert.equal((await at("2025-09-02T13:40:00Z"))?.ts, "2025-09-02T13:35:00Z", "the instant it closes it becomes visible");
  assert.equal((await at("2025-09-02T13:40:00Z"))?.close, 101);
  assert.equal((await at("2025-09-02T13:45:00Z"))?.ts, "2025-09-02T13:40:00Z");
});

test("the same instant written three ways (Z, .000Z, an explicit offset) resolves to the same bar, on the boundary too", async () => {
  const db = newDb();
  await putBar(db, "AAPL", "2025-09-02T13:30:00Z", 100);
  await putBar(db, "AAPL", "2025-09-02T13:35:00Z", 101);

  for (const asOf of ["2025-09-02T13:40:00Z", "2025-09-02T13:40:00.000Z", "2025-09-02T09:40:00-04:00"]) {
    assert.equal((await getIntradayPriceAsOf(db, { ticker: "AAPL", asOf }))?.ts, "2025-09-02T13:35:00Z", asOf);
  }
  for (const asOf of ["2025-09-02T13:39:59Z", "2025-09-02T13:39:59.999Z", "2025-09-02T09:39:59-04:00"]) {
    assert.equal((await getIntradayPriceAsOf(db, { ticker: "AAPL", asOf }))?.ts, "2025-09-02T13:30:00Z", asOf);
  }
});

test("sweep: at every minute of a session the reader returns exactly the newest fully-closed bar, and never one that has not closed", async () => {
  const db = newDb();
  const first = Date.parse("2025-09-02T13:30:00Z");
  const barCount = 78; // a regular US session at 5 minutes
  for (let i = 0; i < barCount; i++) {
    await putBar(db, "AAPL", canonicalIntradayTs(new Date(first + i * INTRADAY_BAR_MS).toISOString()), 100 + i);
  }
  const last = first + (barCount - 1) * INTRADAY_BAR_MS;

  for (let asOfMs = first - 20 * 60_000; asOfMs <= last + 20 * 60_000; asOfMs += 60_000) {
    const asOf = new Date(asOfMs).toISOString();
    const row = await getIntradayPriceAsOf(db, { ticker: "AAPL", asOf });

    const newestClosedMs = Math.floor((asOfMs - INTRADAY_BAR_MS) / INTRADAY_BAR_MS) * INTRADAY_BAR_MS;
    if (newestClosedMs < first) {
      assert.equal(row, null, `${asOf}: no bar has closed yet`);
      continue;
    }
    const expectedMs = Math.min(newestClosedMs, last);
    assert.equal(row.ts, canonicalIntradayTs(new Date(expectedMs).toISOString()), asOf);
    assert.ok(Date.parse(row.ts) + INTRADAY_BAR_MS <= asOfMs, `${asOf}: returned a bar that had not closed (${row.ts})`);
  }
});

test("a bar stamped after asOf is never returned, however near", async () => {
  const db = newDb();
  await putBar(db, "AAPL", "2025-09-02T14:00:00Z", 100);
  await putBar(db, "AAPL", "2025-09-02T14:05:00Z", 999);
  await putBar(db, "AAPL", "2025-09-03T14:00:00Z", 998);

  const row = await getIntradayPriceAsOf(db, { ticker: "AAPL", asOf: "2025-09-02T14:06:00Z" });
  assert.equal(row.ts, "2025-09-02T14:00:00Z");
  assert.equal(row.close, 100);
});

test("null, not a stale or invented price, when there is no closed bar: an empty table, a time before the first bar, another ticker's bars only", async () => {
  const db = newDb();
  assert.equal(await getIntradayPriceAsOf(db, { ticker: "AAPL", asOf: "2025-09-02T14:00:00Z" }), null);

  await putBar(db, "MSFT", "2025-09-02T13:30:00Z", 400);
  assert.equal(await getIntradayPriceAsOf(db, { ticker: "AAPL", asOf: "2025-09-02T14:00:00Z" }), null, "MSFT's bar is not AAPL's");

  await putBar(db, "AAPL", "2025-09-02T14:00:00Z", 100);
  assert.equal(await getIntradayPriceAsOf(db, { ticker: "AAPL", asOf: "2025-09-02T14:04:59Z" }), null, "the only bar has not closed yet");
});

test("tickers are isolated and each carries its own vendor's source", async () => {
  const db = newDb();
  await putBar(db, "AAPL", "2025-09-02T13:30:00Z", 100, { source: "alpaca" });
  await putBar(db, "XAUUSD", "2025-09-02T13:30:00Z", 3500, { source: "twelvedata" });

  const a = await getIntradayPriceAsOf(db, { ticker: "AAPL", asOf: "2025-09-02T14:00:00Z" });
  const g = await getIntradayPriceAsOf(db, { ticker: "XAUUSD", asOf: "2025-09-02T14:00:00Z" });
  assert.deepEqual([a.close, a.source], [100, "alpaca"]);
  assert.deepEqual([g.close, g.source], [3500, "twelvedata"]);
});

test("the row has the OHLCV fields plus availableAt (ts + 5 minutes), and no storage internals", async () => {
  const db = newDb();
  await putBar(db, "AAPL", "2025-09-02T13:30:00Z", 100);

  const row = await getIntradayPriceAsOf(db, { ticker: "AAPL", asOf: "2025-09-02T14:00:00Z" });

  assert.deepEqual(row, {
    ticker: "AAPL",
    ts: "2025-09-02T13:30:00Z",
    open: 99.5,
    high: 101,
    low: 99,
    close: 100,
    volume: 1000,
    source: "alpaca",
    availableAt: "2025-09-02T13:35:00Z",
  });
});

// ---------------------------------------------------------------------------
// the reason this exists (finding G): two decisions on one day, two real prices
// ---------------------------------------------------------------------------

test("two decisions on the SAME UTC day see different prices intraday, where the daily reader gives them the identical one", async () => {
  const db = newDb();
  await insertPriceBar(db, { ticker: "AAPL", date: "2025-09-01", open: 99, high: 101, low: 98, close: 100, volume: 5e6, source: "tiingo" });
  await insertPriceBar(db, { ticker: "AAPL", date: "2025-09-02", open: 100, high: 110, low: 95, close: 104, volume: 5e6, source: "tiingo" });
  await putBar(db, "AAPL", "2025-09-02T14:00:00Z", 103);
  await putBar(db, "AAPL", "2025-09-02T15:30:00Z", 98);

  const morning = "2025-09-02T14:10:00Z";
  const afternoon = "2025-09-02T15:40:00Z";

  // The problem: the daily reader cannot tell 14:10 from 15:40 on the same day, so a replacement between them books 0 P&L.
  assert.deepEqual(await getPriceBarsAsOf(db, { ticker: "AAPL", asOf: morning }), await getPriceBarsAsOf(db, { ticker: "AAPL", asOf: afternoon }));

  // The fix: the intraday reader can.
  const m = await getIntradayPriceAsOf(db, { ticker: "AAPL", asOf: morning });
  const a = await getIntradayPriceAsOf(db, { ticker: "AAPL", asOf: afternoon });
  assert.equal(m.close, 103);
  assert.equal(a.close, 98);
  assert.notEqual(m.close, a.close);
});

// ---------------------------------------------------------------------------
// maxAgeMs: refuse a stale price instead of returning it
// ---------------------------------------------------------------------------

test("maxAgeMs: a bar whose close became visible longer ago than the bound is null; within the bound (inclusive) it is returned", async () => {
  const db = newDb();
  await putBar(db, "AAPL", "2025-09-02T13:30:00Z", 100); // closes / becomes visible at 13:35:00

  const at = (asOf, maxAgeMs) => getIntradayPriceAsOf(db, { ticker: "AAPL", asOf, maxAgeMs });

  assert.equal((await at("2025-09-02T13:35:00Z", 0))?.ts, "2025-09-02T13:30:00Z", "age 0 within a bound of 0");
  assert.equal(await at("2025-09-02T13:35:01Z", 0), null);
  assert.equal((await at("2025-09-02T13:40:00Z", 5 * 60_000))?.ts, "2025-09-02T13:30:00Z", "age exactly at the bound");
  assert.equal(await at("2025-09-02T13:41:00Z", 5 * 60_000), null, "one minute past it");
});

test("with no maxAgeMs (or null) the newest visible bar is returned however old; a weekend-old price is only refused when the caller sets a bound", async () => {
  const db = newDb();
  await putBar(db, "AAPL", "2025-09-05T19:55:00Z", 100); // Friday's last regular-session bar

  const monday = "2025-09-08T13:30:00Z";
  assert.equal((await getIntradayPriceAsOf(db, { ticker: "AAPL", asOf: monday }))?.close, 100);
  assert.equal((await getIntradayPriceAsOf(db, { ticker: "AAPL", asOf: monday, maxAgeMs: null }))?.close, 100);
  assert.equal(await getIntradayPriceAsOf(db, { ticker: "AAPL", asOf: monday, maxAgeMs: 60 * 60_000 }), null);
});

test("maxAgeMs must be a non-negative finite number", async () => {
  const db = newDb();
  for (const bad of [-1, Number.NaN, Infinity, "5"]) {
    await assert.rejects(() => getIntradayPriceAsOf(db, { ticker: "AAPL", asOf: "2025-09-02T14:00:00Z", maxAgeMs: bad }), /maxAgeMs must be a non-negative finite number/, String(bad));
  }
});

// ---------------------------------------------------------------------------
// the required-asOf convention and the tripwire
// ---------------------------------------------------------------------------

test("a missing or unparseable asOf is a LookaheadViolationError, never 'no cutoff'", async () => {
  const db = newDb();
  await putBar(db, "AAPL", "2025-09-02T13:30:00Z", 100);

  for (const asOf of [undefined, null, ""]) {
    await assert.rejects(() => getIntradayPriceAsOf(db, { ticker: "AAPL", asOf }), (err) => err instanceof LookaheadViolationError && /requires an explicit asOf/.test(err.message), String(asOf));
  }
  await assert.rejects(() => getIntradayPriceAsOf(db, { ticker: "AAPL" }), LookaheadViolationError);
  await assert.rejects(() => getIntradayPriceAsOf(db), LookaheadViolationError);
  for (const asOf of ["yesterday", "2025-13-45T00:00:00Z", new Date("2025-09-02T14:00:00Z")]) {
    await assert.rejects(() => getIntradayPriceAsOf(db, { ticker: "AAPL", asOf }), (err) => err instanceof LookaheadViolationError && /parseable ISO timestamp/.test(err.message), String(asOf));
  }
});

test("a ticker is required", async () => {
  await assert.rejects(() => getIntradayPriceAsOf(newDb(), { asOf: "2025-09-02T14:00:00Z" }), /requires a ticker/);
});

test("the tripwire: even if the query returns a bar that has not closed (a fake db that ignores the cutoff), the read throws instead of leaking it", async () => {
  const leakyDb = (row) => ({ prepare: () => ({ bind: () => ({ first: async () => row }) }) });
  const bar = (ts) => ({ ticker: "AAPL", ts, open: 1, high: 2, low: 1, close: 1.5, volume: 10, source: "alpaca" });

  // in the future
  await assert.rejects(() => getIntradayPriceAsOf(leakyDb(bar("2025-09-02T15:00:00Z")), { ticker: "AAPL", asOf: "2025-09-02T14:00:00Z" }), LookaheadViolationError);
  // open at asOf, not yet closed: the subtle one
  await assert.rejects(() => getIntradayPriceAsOf(leakyDb(bar("2025-09-02T14:00:00Z")), { ticker: "AAPL", asOf: "2025-09-02T14:00:00Z" }), LookaheadViolationError);
  await assert.rejects(() => getIntradayPriceAsOf(leakyDb(bar("2025-09-02T13:56:00Z")), { ticker: "AAPL", asOf: "2025-09-02T14:00:00Z" }), LookaheadViolationError);
  // an unparseable stored ts is not waved through
  await assert.rejects(() => getIntradayPriceAsOf(leakyDb(bar("garbage")), { ticker: "AAPL", asOf: "2025-09-02T14:00:00Z" }), LookaheadViolationError);
  // and a properly closed one passes
  const ok = await getIntradayPriceAsOf(leakyDb(bar("2025-09-02T13:55:00Z")), { ticker: "AAPL", asOf: "2025-09-02T14:00:00Z" });
  assert.equal(ok.ts, "2025-09-02T13:55:00Z");
});

// ---------------------------------------------------------------------------
// shared/intraday_availability.js
// ---------------------------------------------------------------------------

test("INTRADAY_BAR_MS is 5 minutes", () => {
  assert.equal(INTRADAY_BAR_MS, 300_000);
});

test("canonicalIntradayTs: UTC, whole seconds, Z; an unparseable value comes back unchanged for the writer's own validation to reject", () => {
  assert.equal(canonicalIntradayTs("2025-09-02T13:30:00Z"), "2025-09-02T13:30:00Z");
  assert.equal(canonicalIntradayTs("2025-09-02T13:30:00.000Z"), "2025-09-02T13:30:00Z");
  assert.equal(canonicalIntradayTs("2025-09-02T13:30:00.987Z"), "2025-09-02T13:30:00Z");
  assert.equal(canonicalIntradayTs("2025-09-02T09:30:00-04:00"), "2025-09-02T13:30:00Z");
  assert.equal(canonicalIntradayTs("garbage"), "garbage");
  assert.equal(canonicalIntradayTs(""), "");
  assert.equal(canonicalIntradayTs(undefined), undefined);
});

test("intradayCutoffTs is asOf minus one bar, canonical, floored to the second; unparseable input throws", () => {
  assert.equal(intradayCutoffTs("2025-09-02T13:40:00Z"), "2025-09-02T13:35:00Z");
  assert.equal(intradayCutoffTs("2025-09-02T13:40:00.000Z"), "2025-09-02T13:35:00Z");
  assert.equal(intradayCutoffTs("2025-09-02T13:39:59.999Z"), "2025-09-02T13:34:59Z");
  assert.equal(intradayCutoffTs("2025-09-03T00:02:00Z"), "2025-09-02T23:57:00Z", "crosses midnight");
  assert.throws(() => intradayCutoffTs("nope"), LookaheadViolationError);
  assert.throws(() => intradayCutoffTs(undefined), LookaheadViolationError);
});

test("intradayBarAvailableAt is ts plus one bar; assertNoIntradayLookahead passes closed bars and throws on the rest", () => {
  assert.equal(intradayBarAvailableAt("2025-09-02T13:55:00Z"), "2025-09-02T14:00:00Z");
  assert.equal(intradayBarAvailableAt("2025-09-02T23:55:00Z"), "2025-09-03T00:00:00Z");
  assert.throws(() => intradayBarAvailableAt("nope"), LookaheadViolationError);

  const asOf = "2025-09-02T14:00:00Z";
  assert.doesNotThrow(() => assertNoIntradayLookahead([{ ts: "2025-09-02T13:55:00Z" }, { ts: "2025-09-02T13:00:00Z" }], asOf));
  assert.doesNotThrow(() => assertNoIntradayLookahead([], asOf));
  assert.throws(() => assertNoIntradayLookahead([{ ts: "2025-09-02T13:00:00Z" }, { ts: "2025-09-02T13:56:00Z" }], asOf), LookaheadViolationError);
  assert.throws(() => assertNoIntradayLookahead([{ ts: "2025-09-02T13:55:00Z" }], "not a time"), LookaheadViolationError);
});
