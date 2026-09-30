// Point-in-time WINDOW reads for the bar-based exit walk
// (storage/inputs_view.js#getIntradayBarsWindowAsOf / getDailyBarsWindowAsOf).
// Real sqlite inputs DB. The properties that matter: nothing newer than the
// asOf cutoff can leave the function, the lower bound is inclusive, rows come
// back oldest first, and a row-cap cut-off is reported (`truncated`) rather
// than silently passed off as "no more data".

import test from "node:test";
import assert from "node:assert/strict";
import { getIntradayBarsWindowAsOf, getDailyBarsWindowAsOf } from "../src/storage/inputs_view.js";
import { LookaheadViolationError } from "../src/shared/errors.js";
import { makeCtx, seedBarOhlc, seedIntradayBarOhlc } from "./helpers/engine_ctx.js";

const AAPL = "AAPL";

async function seedIntradaySeries(inputs, ticker = AAPL) {
  // 5-minute bars opening 14:30, 14:35, 14:40, 14:45 (visible from 14:35, 14:40, 14:45, 14:50).
  const opens = ["14:30", "14:35", "14:40", "14:45"];
  for (const [i, hm] of opens.entries()) {
    await seedIntradayBarOhlc(inputs, {
      ticker,
      ts: `2026-01-05T${hm}:00Z`,
      open: 100 + i,
      high: 102 + i,
      low: 98 + i,
      close: 101 + i,
    });
  }
}

async function seedDailySeries(inputs, ticker = AAPL) {
  for (const [i, date] of ["2026-01-02", "2026-01-05", "2026-01-06", "2026-01-07"].entries()) {
    await seedBarOhlc(inputs, { ticker, date, open: 100 + i, high: 105 + i, low: 95 + i, close: 101 + i });
  }
}

// ---------------------------------------------------------------------------
// getIntradayBarsWindowAsOf
// ---------------------------------------------------------------------------

test("intraday window: returns only bars that have FULLY CLOSED at asOf, oldest first, with full OHLC", async () => {
  const { inputs } = makeCtx();
  await seedIntradaySeries(inputs);

  // At 14:45:00 the 14:40 bar (14:40:00-14:44:59) has just closed; the 14:45 bar is still forming.
  const { rows, truncated } = await getIntradayBarsWindowAsOf(inputs, {
    ticker: AAPL,
    fromTs: "2026-01-05T14:30:00Z",
    asOf: "2026-01-05T14:45:00Z",
  });

  assert.equal(truncated, false);
  assert.deepEqual(rows.map((r) => r.ts), ["2026-01-05T14:30:00Z", "2026-01-05T14:35:00Z", "2026-01-05T14:40:00Z"]);
  assert.deepEqual(
    { open: rows[0].open, high: rows[0].high, low: rows[0].low, close: rows[0].close, ticker: rows[0].ticker },
    { open: 100, high: 102, low: 98, close: 101, ticker: AAPL },
  );
  assert.ok("volume" in rows[0] && "source" in rows[0]);
});

test("intraday window: one second before a bar closes it is still hidden; the millisecond-form asOf reads the same", async () => {
  const { inputs } = makeCtx();
  await seedIntradaySeries(inputs);
  const args = { ticker: AAPL, fromTs: "2026-01-05T14:30:00Z" };

  const early = await getIntradayBarsWindowAsOf(inputs, { ...args, asOf: "2026-01-05T14:44:59Z" });
  assert.deepEqual(early.rows.map((r) => r.ts), ["2026-01-05T14:30:00Z", "2026-01-05T14:35:00Z"]); // 14:40 closes at 14:45:00

  const exact = await getIntradayBarsWindowAsOf(inputs, { ...args, asOf: "2026-01-05T14:45:00Z" });
  const ms = await getIntradayBarsWindowAsOf(inputs, { ...args, asOf: "2026-01-05T14:45:00.000Z" });
  assert.deepEqual(ms.rows, exact.rows);
});

test("intraday window: the lower bound is inclusive and later bars are not skipped", async () => {
  const { inputs } = makeCtx();
  await seedIntradaySeries(inputs);

  const { rows } = await getIntradayBarsWindowAsOf(inputs, {
    ticker: AAPL,
    fromTs: "2026-01-05T14:35:00Z",
    asOf: "2026-01-05T15:00:00Z",
  });
  assert.deepEqual(rows.map((r) => r.ts), ["2026-01-05T14:35:00Z", "2026-01-05T14:40:00Z", "2026-01-05T14:45:00Z"]);
});

test("intraday window: other tickers' bars never appear", async () => {
  const { inputs } = makeCtx();
  await seedIntradaySeries(inputs, AAPL);
  await seedIntradaySeries(inputs, "MSFT");

  const { rows } = await getIntradayBarsWindowAsOf(inputs, { ticker: "MSFT", fromTs: "2026-01-05T14:30:00Z", asOf: "2026-01-05T15:00:00Z" });
  assert.equal(rows.length, 4);
  assert.ok(rows.every((r) => r.ticker === "MSFT"));
});

test("intraday window: fromTs past the cutoff (or no data at all) is an empty, non-truncated window", async () => {
  const { inputs } = makeCtx();
  await seedIntradaySeries(inputs);

  const future = await getIntradayBarsWindowAsOf(inputs, { ticker: AAPL, fromTs: "2026-01-05T16:00:00Z", asOf: "2026-01-05T15:00:00Z" });
  assert.deepEqual(future, { rows: [], truncated: false });

  const none = await getIntradayBarsWindowAsOf(inputs, { ticker: "TSLA", fromTs: "2026-01-05T14:30:00Z", asOf: "2026-01-05T15:00:00Z" });
  assert.deepEqual(none, { rows: [], truncated: false });
});

test("intraday window: `truncated` is true only when MORE rows exist than the limit", async () => {
  const { inputs } = makeCtx();
  await seedIntradaySeries(inputs);
  const args = { ticker: AAPL, fromTs: "2026-01-05T14:30:00Z", asOf: "2026-01-05T15:00:00Z" }; // 4 visible bars

  const cut = await getIntradayBarsWindowAsOf(inputs, { ...args, limit: 3 });
  assert.equal(cut.truncated, true);
  assert.deepEqual(cut.rows.map((r) => r.ts), ["2026-01-05T14:30:00Z", "2026-01-05T14:35:00Z", "2026-01-05T14:40:00Z"]); // the OLDEST rows are kept

  const exact = await getIntradayBarsWindowAsOf(inputs, { ...args, limit: 4 });
  assert.equal(exact.truncated, false);
  assert.equal(exact.rows.length, 4);

  const roomy = await getIntradayBarsWindowAsOf(inputs, { ...args, limit: 100 });
  assert.equal(roomy.truncated, false);
});

test("intraday window: invalid arguments throw instead of reading 'everything'", async () => {
  const { inputs } = makeCtx();
  const ok = { ticker: AAPL, fromTs: "2026-01-05T14:30:00Z", asOf: "2026-01-05T15:00:00Z" };

  await assert.rejects(getIntradayBarsWindowAsOf(inputs, { ...ok, asOf: undefined }), LookaheadViolationError);
  await assert.rejects(getIntradayBarsWindowAsOf(inputs, { ...ok, asOf: "garbage" }), LookaheadViolationError);
  await assert.rejects(getIntradayBarsWindowAsOf(inputs, { ...ok, fromTs: undefined }), LookaheadViolationError);
  await assert.rejects(getIntradayBarsWindowAsOf(inputs, { ...ok, ticker: undefined }), /requires a ticker/);
  await assert.rejects(getIntradayBarsWindowAsOf(inputs, { ...ok, limit: 0 }), /limit must be a positive integer/);
  await assert.rejects(getIntradayBarsWindowAsOf(inputs, { ...ok, limit: 1.5 }), /limit must be a positive integer/);
  await assert.rejects(getIntradayBarsWindowAsOf(inputs), LookaheadViolationError);
});

test("intraday window: the post-read tripwire fires if a db returns a bar that has not closed yet", async () => {
  // A fake that ignores the SQL cutoff: the 14:45 bar is still forming at asOf 14:45.
  const leakyDb = {
    prepare: () => ({
      bind: () => ({
        all: async () => ({ results: [{ ticker: AAPL, ts: "2026-01-05T14:45:00Z", open: 1, high: 1, low: 1, close: 1, volume: 0, source: "x" }] }),
      }),
    }),
  };
  await assert.rejects(
    getIntradayBarsWindowAsOf(leakyDb, { ticker: AAPL, fromTs: "2026-01-05T14:00:00Z", asOf: "2026-01-05T14:45:00Z" }),
    LookaheadViolationError,
  );
});

// ---------------------------------------------------------------------------
// getDailyBarsWindowAsOf
// ---------------------------------------------------------------------------

test("daily window: bars dated strictly BEFORE asOf's UTC date and on/after fromDate, oldest first, full OHLC", async () => {
  const { inputs } = makeCtx();
  await seedDailySeries(inputs);

  const { rows, truncated } = await getDailyBarsWindowAsOf(inputs, { ticker: AAPL, fromDate: "2026-01-05", asOf: "2026-01-07T10:00:00Z" });

  assert.equal(truncated, false);
  assert.deepEqual(rows.map((r) => r.date), ["2026-01-05", "2026-01-06"]); // 01-02 is before fromDate, 01-07 is 'today'
  assert.deepEqual({ open: rows[0].open, high: rows[0].high, low: rows[0].low, close: rows[0].close }, { open: 101, high: 106, low: 96, close: 102 });
});

test("daily window: a day's bar appears at the next 00:00:00Z and never earlier", async () => {
  const { inputs } = makeCtx();
  await seedDailySeries(inputs);
  const args = { ticker: AAPL, fromDate: "2026-01-05" };

  const lastSecond = await getDailyBarsWindowAsOf(inputs, { ...args, asOf: "2026-01-06T23:59:59Z" });
  assert.deepEqual(lastSecond.rows.map((r) => r.date), ["2026-01-05"]); // 01-06 still in progress

  const midnight = await getDailyBarsWindowAsOf(inputs, { ...args, asOf: "2026-01-07T00:00:00Z" });
  assert.deepEqual(midnight.rows.map((r) => r.date), ["2026-01-05", "2026-01-06"]);
});

test("daily window: fromDate at or after the cutoff date is an empty, non-truncated window", async () => {
  const { inputs } = makeCtx();
  await seedDailySeries(inputs);

  assert.deepEqual(await getDailyBarsWindowAsOf(inputs, { ticker: AAPL, fromDate: "2026-01-07", asOf: "2026-01-07T10:00:00Z" }), { rows: [], truncated: false });
  assert.deepEqual(await getDailyBarsWindowAsOf(inputs, { ticker: AAPL, fromDate: "2026-02-01", asOf: "2026-01-07T10:00:00Z" }), { rows: [], truncated: false });
  assert.deepEqual(await getDailyBarsWindowAsOf(inputs, { ticker: "TSLA", fromDate: "2026-01-02", asOf: "2026-01-07T10:00:00Z" }), { rows: [], truncated: false });
});

test("daily window: `truncated` only when more rows exist than the limit; the oldest rows are kept", async () => {
  const { inputs } = makeCtx();
  await seedDailySeries(inputs);
  const args = { ticker: AAPL, fromDate: "2026-01-02", asOf: "2026-01-08T00:00:00Z" }; // 4 visible bars

  const cut = await getDailyBarsWindowAsOf(inputs, { ...args, limit: 2 });
  assert.equal(cut.truncated, true);
  assert.deepEqual(cut.rows.map((r) => r.date), ["2026-01-02", "2026-01-05"]);

  const exact = await getDailyBarsWindowAsOf(inputs, { ...args, limit: 4 });
  assert.equal(exact.truncated, false);
  assert.equal(exact.rows.length, 4);
});

test("daily window: other tickers never appear, and invalid arguments throw", async () => {
  const { inputs } = makeCtx();
  await seedDailySeries(inputs, AAPL);
  await seedDailySeries(inputs, "MSFT");

  const { rows } = await getDailyBarsWindowAsOf(inputs, { ticker: "MSFT", fromDate: "2026-01-02", asOf: "2026-01-08T00:00:00Z" });
  assert.ok(rows.length > 0 && rows.every((r) => r.ticker === "MSFT"));

  const ok = { ticker: AAPL, fromDate: "2026-01-05", asOf: "2026-01-07T10:00:00Z" };
  await assert.rejects(getDailyBarsWindowAsOf(inputs, { ...ok, asOf: undefined }), LookaheadViolationError);
  await assert.rejects(getDailyBarsWindowAsOf(inputs, { ...ok, asOf: "garbage" }), LookaheadViolationError);
  await assert.rejects(getDailyBarsWindowAsOf(inputs, { ...ok, fromDate: undefined }), LookaheadViolationError);
  await assert.rejects(getDailyBarsWindowAsOf(inputs, { ...ok, ticker: undefined }), /requires a ticker/);
  await assert.rejects(getDailyBarsWindowAsOf(inputs, { ...ok, limit: 0 }), /limit must be a positive integer/);
  await assert.rejects(getDailyBarsWindowAsOf(inputs), LookaheadViolationError);
});

test("daily window: the post-read tripwire fires if a db returns today's bar", async () => {
  const leakyDb = {
    prepare: () => ({
      bind: () => ({
        all: async () => ({ results: [{ ticker: AAPL, date: "2026-01-07", open: 1, high: 1, low: 1, close: 1, volume: 0, source: "x" }] }),
      }),
    }),
  };
  await assert.rejects(
    getDailyBarsWindowAsOf(leakyDb, { ticker: AAPL, fromDate: "2026-01-05", asOf: "2026-01-07T10:00:00Z" }),
    LookaheadViolationError,
  );
});
