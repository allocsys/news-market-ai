// Covers shared/intraday_sanity.js and its two call sites: the single writer
// (storage/inputs_view.js#insertPriceBarsIntraday) and the backfill job's
// bookkeeping (ingestion/intraday_backfill.js). Calendar used below (2026):
// Jan 15 Thu, Jan 16 Fri, Jan 17 Sat, Jan 18 Sun, Jan 19 Mon.

import test from "node:test";
import assert from "node:assert/strict";
import {
  gateIntradayBars,
  isInClosedWindow,
  summarizeIntradayRejections,
  FX_24X5_TICKERS,
  MAX_BAR_RANGE_PCT,
} from "../src/shared/intraday_sanity.js";
import { TIINGO_FX_INTRADAY_TICKERS } from "../src/ingestion/sources/tiingo_fx_intraday.js";
import { insertPriceBarsIntraday } from "../src/storage/inputs_view.js";
import { loadConfig } from "../src/config.js";
import { runIntradayBackfillTick } from "../src/ingestion/intraday_backfill.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { INPUTS_DIR } from "./helpers/engine_ctx.js";

const newDb = () => createTestD1([INPUTS_DIR]);

function bar(ticker, ts, close = 100, overrides = {}) {
  return { ticker, ts, open: close - 0.5, high: close + 1, low: close - 1, close, volume: 1000, source: "test", ...overrides };
}

const codes = (rejected) => rejected.map((r) => r.code);

// ---------------------------------------------------------------------------
// closed-market windows
// ---------------------------------------------------------------------------

test("equities: closed Sat 01:00Z through Mon 08:00Z, open on weekdays and Fri post-market", () => {
  const closed = ["2026-01-17T01:00:00Z", "2026-01-17T15:00:00Z", "2026-01-18T15:00:00Z", "2026-01-19T00:00:00Z", "2026-01-19T07:55:00Z"];
  for (const ts of closed) assert.equal(isInClosedWindow("AAPL", ts), true, ts);

  const open = ["2026-01-15T15:00:00Z", "2026-01-16T15:00:00Z", "2026-01-17T00:55:00Z", "2026-01-19T08:00:00Z", "2026-01-19T14:30:00Z"];
  for (const ts of open) assert.equal(isInClosedWindow("AAPL", ts), false, ts);
});

test("24x5 FX (XAUUSD): closed Fri 22:00Z through Sun 22:00Z, open Sunday evening through Friday", () => {
  const closed = ["2026-01-16T22:00:00Z", "2026-01-17T12:00:00Z", "2026-01-18T00:00:00Z", "2026-01-18T21:55:00Z"];
  for (const ts of closed) assert.equal(isInClosedWindow("XAUUSD", ts), true, ts);

  const open = ["2026-01-16T21:55:00Z", "2026-01-18T22:00:00Z", "2026-01-19T00:05:00Z", "2026-01-15T03:00:00Z"];
  for (const ts of open) assert.equal(isInClosedWindow("XAUUSD", ts), false, ts);
});

test("the same Saturday-midday instant is closed for both an equity and XAUUSD; Sunday 15:00Z is closed for both; Mon 03:00Z splits them", () => {
  assert.equal(isInClosedWindow("TSLA", "2026-01-17T12:00:00Z"), true);
  assert.equal(isInClosedWindow("XAUUSD", "2026-01-17T12:00:00Z"), true);
  assert.equal(isInClosedWindow("TSLA", "2026-01-18T15:00:00Z"), true);
  assert.equal(isInClosedWindow("XAUUSD", "2026-01-18T15:00:00Z"), true);
  assert.equal(isInClosedWindow("TSLA", "2026-01-19T03:00:00Z"), true, "equity still closed Monday 03:00Z");
  assert.equal(isInClosedWindow("XAUUSD", "2026-01-19T03:00:00Z"), false, "FX is trading Monday 03:00Z");
});

test("ticker matching for the 24x5 set is case-insensitive; an unparseable ts is not a closed-window verdict", () => {
  assert.equal(isInClosedWindow("xauusd", "2026-01-17T12:00:00Z"), true);
  assert.equal(isInClosedWindow("AAPL", "not-a-date"), false);
});

test("drift guard: FX_24X5_TICKERS equals the Tiingo FX adapter's TIINGO_FX_INTRADAY_TICKERS", () => {
  assert.deepEqual([...FX_24X5_TICKERS].sort(), [...TIINGO_FX_INTRADAY_TICKERS].sort());
});

// ---------------------------------------------------------------------------
// the gate itself
// ---------------------------------------------------------------------------

test("a clean weekday batch passes untouched apart from ts canonicalisation", () => {
  const { accepted, rejected } = gateIntradayBars([
    bar("AAPL", "2026-01-15T13:30:00.000Z", 100),
    bar("AAPL", "2026-01-15T13:35:00Z", 101),
  ]);
  assert.equal(rejected.length, 0);
  assert.deepEqual(accepted.map((b) => b.ts).sort(), ["2026-01-15T13:30:00Z", "2026-01-15T13:35:00Z"], "milliseconds stripped to the canonical form");
});

test("rejects weekend bars per instrument, with a closed_window code", () => {
  const { accepted, rejected } = gateIntradayBars([
    bar("AAPL", "2026-01-17T15:00:00Z"),
    bar("XAUUSD", "2026-01-17T15:00:00Z"),
    bar("XAUUSD", "2026-01-19T03:00:00Z"),
  ]);
  assert.deepEqual(codes(rejected), ["closed_window", "closed_window"]);
  assert.deepEqual(accepted.map((b) => `${b.ticker}@${b.ts}`), ["XAUUSD@2026-01-19T03:00:00Z"]);
});

test("rejects non-positive / non-finite / missing prices", () => {
  const { accepted, rejected } = gateIntradayBars([
    bar("AAPL", "2026-01-15T13:30:00Z", 100, { open: 0 }),
    bar("AAPL", "2026-01-15T13:35:00Z", 100, { close: Number.NaN }),
    bar("AAPL", "2026-01-15T13:40:00Z", 100, { high: undefined }),
    bar("AAPL", "2026-01-15T13:45:00Z", 100, { low: -1 }),
  ]);
  assert.equal(accepted.length, 0);
  assert.deepEqual(codes(rejected), ["non_positive_price", "non_positive_price", "non_positive_price", "non_positive_price"]);
});

test("rejects an unparseable ts", () => {
  const { accepted, rejected } = gateIntradayBars([bar("AAPL", "yesterday-ish")]);
  assert.equal(accepted.length, 0);
  assert.deepEqual(codes(rejected), ["unparseable_ts"]);
});

test("rejects a bar whose own range exceeds MAX_BAR_RANGE_PCT, accepts one just under it", () => {
  const under = 100 * (1 + MAX_BAR_RANGE_PCT - 0.01);
  const over = 100 * (1 + MAX_BAR_RANGE_PCT + 0.01);
  const { accepted, rejected } = gateIntradayBars([
    bar("AAPL", "2026-01-15T13:30:00Z", 100, { low: 100, high: under, open: 100, close: 100 }),
    bar("AAPL", "2026-01-15T13:35:00Z", 100, { low: 100, high: over, open: 100, close: 100 }),
  ]);
  assert.deepEqual(accepted.map((b) => b.ts), ["2026-01-15T13:30:00Z"]);
  assert.deepEqual(codes(rejected), ["range"]);
});

test("spike: a lone bar far from BOTH neighbours is rejected", () => {
  const { accepted, rejected } = gateIntradayBars([
    bar("XAUUSD", "2026-01-15T10:00:00Z", 3500),
    bar("XAUUSD", "2026-01-15T10:05:00Z", 350, { open: 350.5, high: 351, low: 349 }), // unit slip
    bar("XAUUSD", "2026-01-15T10:10:00Z", 3501),
  ]);
  assert.deepEqual(codes(rejected), ["spike"]);
  assert.equal(rejected[0].ts, "2026-01-15T10:05:00Z");
  assert.equal(accepted.length, 2);
});

test("spike: a REAL gap that price then stays at is NOT rejected (only one side differs)", () => {
  const { accepted, rejected } = gateIntradayBars([
    bar("TSLA", "2026-01-15T14:00:00Z", 200),
    bar("TSLA", "2026-01-15T14:05:00Z", 260),
    bar("TSLA", "2026-01-15T14:10:00Z", 261),
    bar("TSLA", "2026-01-15T14:15:00Z", 262),
  ]);
  assert.equal(rejected.length, 0);
  assert.equal(accepted.length, 4);
});

test("spike: a bad FIRST bar does not poison the ones after it (no cascade), and edge bars are never spike-checked", () => {
  const { accepted, rejected } = gateIntradayBars([
    bar("AAPL", "2026-01-15T14:00:00Z", 10), // bad, but only has one neighbour -> cannot be judged
    bar("AAPL", "2026-01-15T14:05:00Z", 100),
    bar("AAPL", "2026-01-15T14:10:00Z", 101),
  ]);
  assert.equal(rejected.length, 0, "an edge bar has one neighbour; the gate does not guess");
  assert.equal(accepted.length, 3);
});

test("spike checks are per ticker: interleaved tickers at different price levels never judge each other", () => {
  const { accepted, rejected } = gateIntradayBars([
    bar("AAPL", "2026-01-15T14:00:00Z", 100),
    bar("MSFT", "2026-01-15T14:00:00Z", 400),
    bar("AAPL", "2026-01-15T14:05:00Z", 101),
    bar("MSFT", "2026-01-15T14:05:00Z", 401),
    bar("AAPL", "2026-01-15T14:10:00Z", 102),
    bar("MSFT", "2026-01-15T14:10:00Z", 402),
  ]);
  assert.equal(rejected.length, 0);
  assert.equal(accepted.length, 6);
});

test("summarizeIntradayRejections counts by code", () => {
  assert.deepEqual(summarizeIntradayRejections([{ code: "range" }, { code: "range" }, { code: "spike" }]), { range: 2, spike: 1 });
  assert.deepEqual(summarizeIntradayRejections([]), {});
});

// ---------------------------------------------------------------------------
// the writer
// ---------------------------------------------------------------------------

test("insertPriceBarsIntraday drops rejected bars (never written), writes the rest, and returns {written, rejected}", async (t) => {
  t.mock.method(console, "error", () => {});
  const db = newDb();
  const result = await insertPriceBarsIntraday(db, [
    bar("AAPL", "2026-01-15T13:30:00Z", 100),
    bar("AAPL", "2026-01-17T15:00:00Z", 100), // Saturday
  ]);
  assert.equal(result.written, 1);
  assert.deepEqual(codes(result.rejected), ["closed_window"]);

  const { results } = await db.prepare("SELECT ts FROM price_bars_intraday").all();
  assert.deepEqual(results.map((r) => r.ts), ["2026-01-15T13:30:00Z"]);
});

test("insertPriceBarsIntraday logs loudly when it drops something, and stays quiet when it does not", async (t) => {
  const errorMock = t.mock.method(console, "error", () => {});
  const db = newDb();

  await insertPriceBarsIntraday(db, [bar("AAPL", "2026-01-15T13:30:00Z", 100)]);
  assert.equal(errorMock.mock.callCount(), 0);

  await insertPriceBarsIntraday(db, [bar("AAPL", "2026-01-17T15:00:00Z", 100)]);
  assert.equal(errorMock.mock.callCount(), 1);
  assert.match(String(errorMock.mock.calls[0].arguments[0]), /write gate rejected/);
});

test("insertPriceBarsIntraday canonicalises ts on the way in, so the stored form always matches the read's cutoff format", async () => {
  const db = newDb();
  await insertPriceBarsIntraday(db, [bar("AAPL", "2026-01-15T13:30:00.000Z", 100)]);
  const row = await db.prepare("SELECT ts FROM price_bars_intraday WHERE ticker = 'AAPL'").first();
  assert.equal(row.ts, "2026-01-15T13:30:00Z");
});

test("insertPriceBarsIntraday: an all-rejected batch writes nothing and does not touch the DB batch API", async (t) => {
  t.mock.method(console, "error", () => {});
  let batchCalls = 0;
  const fakeDb = { prepare: () => ({ bind: () => ({}) }), batch: async () => { batchCalls++; return []; } };
  const result = await insertPriceBarsIntraday(fakeDb, [bar("AAPL", "2026-01-17T15:00:00Z", 100)]);
  assert.equal(result.written, 0);
  assert.equal(batchCalls, 0);
});

// ---------------------------------------------------------------------------
// backfill bookkeeping
// ---------------------------------------------------------------------------

function tickConfig() {
  return {
    ...loadConfig({
      ALPACA_API_KEY_ID: "alpaca-key",
      ALPACA_API_SECRET_KEY: "alpaca-secret",
      TIINGO_API_KEY: "tiingo-key",
      WATCHLIST_TICKERS: "AAPL",
    }),
    retryBaseDelayMs: 1,
    alpacaMinRequestIntervalMs: 0,
    intradayBackfillLookbackDays: 1,
  };
}

function mockAlpaca(t, bars) {
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, json: async () => ({ bars, next_page_token: null }) }));
}

test("backfill: a day with gate rejections is still 'done' but carries a note and per-tick counts", async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});
  const db = newDb();
  mockAlpaca(t, [
    { t: "2026-01-14T13:30:00Z", o: 100, h: 101, l: 99, c: 100.5, v: 1000 },
    { t: "2026-01-17T15:00:00Z", o: 100, h: 101, l: 99, c: 100.5, v: 1000 }, // Saturday -> rejected
  ]);

  const result = await runIntradayBackfillTick(tickConfig(), db, { now: new Date("2026-01-15T12:00:00Z") });
  const aapl = result.results.find((r) => r.ticker === "AAPL");
  assert.equal(aapl.ok, true);
  assert.equal(aapl.bars, 2);
  assert.equal(aapl.written, 1);
  assert.equal(aapl.rejected, 1);

  const row = await db.prepare("SELECT status, error FROM intraday_backfill_status WHERE ticker = 'AAPL' AND date = ?").bind(aapl.date).first();
  assert.equal(row.status, "done");
  assert.match(row.error, /write gate rejected 1\/2/);
  assert.match(row.error, /closed_window/);
});

test("backfill: a clean day is 'done' with no note", async (t) => {
  t.mock.method(console, "log", () => {});
  const db = newDb();
  mockAlpaca(t, [{ t: "2026-01-14T13:30:00Z", o: 100, h: 101, l: 99, c: 100.5, v: 1000 }]);

  const result = await runIntradayBackfillTick(tickConfig(), db, { now: new Date("2026-01-15T12:00:00Z") });
  const aapl = result.results.find((r) => r.ticker === "AAPL");
  assert.equal(aapl.rejected, 0);

  const row = await db.prepare("SELECT status, error FROM intraday_backfill_status WHERE ticker = 'AAPL' AND date = ?").bind(aapl.date).first();
  assert.equal(row.status, "done");
  assert.equal(row.error, null);
});
