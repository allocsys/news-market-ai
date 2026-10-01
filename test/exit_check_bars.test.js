// graph/exit_check.js end to end over real sqlite inputs + state DBs: the
// bar-based stop/target walk, the last_checked_at cursor, the entry-time
// policy and the closedAt = triggering-bar-close rule. The pure pieces have
// their own files (exit_bars, bar_window, inputs_view_bar_windows,
// run_store_bar_cursor); this file proves they are wired together correctly.
//
// Fixture: long AAPL, entry 100, stop 3% (97), target 6% (106), opened
// Mon 2026-01-05 14:30:00Z. splitGuardTolerance is absent -> guard disabled.

import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { checkOpenPositionExits } from "../src/graph/exit_check.js";
import { makeCtx, seedBarOhlc, seedIntradayBarOhlc, stateRows } from "./helpers/engine_ctx.js";
import { makeFakeLongModel } from "./helpers/fake_long_model.js";

const OPENED = "2026-01-05T14:30:00Z";

const makeConfig = () => ({ maxPositionHoldDays: 10, geminiQuickModel: "quick", fakeModel: makeFakeLongModel() });

async function openPosition(ctx, { id = "AAPL|t1", ticker = "AAPL", direction = "long", openedAt = OPENED, sl = 0.03, tp = 0.06 } = {}) {
  await ctx.store.openPosition({
    id, ticker, tradeThesisId: id, positionSizePct: 0.03, direction,
    entryPrice: 100, stopLossPct: sl, takeProfitPct: tp, openedAt,
  });
}

/** Seeds 5-minute bars on 2026-01-05 given [hhmm, open, high, low, close] rows (ts = bar OPEN). */
async function seedIntraday(ctx, rows, { ticker = "AAPL", day = "2026-01-05" } = {}) {
  for (const [hhmm, open, high, low, close] of rows) {
    await seedIntradayBarOhlc(ctx.inputs, { ticker, ts: `${day}T${hhmm}:00Z`, open, high, low, close });
  }
}

async function posRow(ctx, id = "AAPL|t1") {
  return (await stateRows(ctx.stateDb, "positions")).find((r) => r.id === id);
}

function near(actual, expected, msg) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < 1e-9, `${msg ?? "value"}: expected ~${expected}, got ${actual}`);
}

/** Runs `fn` with console.error captured; returns { result, logs } (first argument of every call). */
async function captureErrors(fn) {
  const spy = mock.method(console, "error", () => {});
  try {
    const result = await fn();
    return { result, logs: spy.mock.calls.map((c) => String(c.arguments[0])) };
  } finally {
    spy.mock.restore();
  }
}

// ---------------------------------------------------------------------------
// intrabar touch between checks
// ---------------------------------------------------------------------------

test("an intrabar low that recovered before the check still triggers the stop, at the stop level, stamped with that bar's close", async () => {
  const ctx = makeCtx();
  await openPosition(ctx);
  await seedIntraday(ctx, [
    ["14:30", 100, 100, 100, 100],
    ["14:35", 100, 101, 96, 99], // low 96 <= stop 97; closes back at 99 (a point-in-time price check would see no stop)
    ["14:40", 99, 105, 99, 99], // after the trigger: must not count towards MFE
  ]);

  const closed = await checkOpenPositionExits({}, makeConfig(), ctx, { asOf: "2026-01-05T15:00:00.000Z" });

  assert.deepEqual(closed, [{ id: "AAPL|t1", ticker: "AAPL", reason: "stop_loss" }]);
  const r = await posRow(ctx);
  assert.equal(r.close_reason, "stop_loss");
  near(r.exit_price, 97, "fills at the stop level, not the recovered close");
  assert.equal(r.closed_at, "2026-01-05T14:40:00.000Z"); // the 14:35 bar closes at 14:40, well before asOf 15:00
  near(r.mae_pct, -0.04, "MAE from the triggering bar's low");
  near(r.mfe_pct, 0.01, "MFE stops at the triggering bar (the 14:40 high of 105 is not counted)");
});

test("a short position: the target is touched by a bar low and fills at the target level", async () => {
  const ctx = makeCtx();
  await openPosition(ctx, { direction: "short" }); // stop 103, target 94
  await seedIntraday(ctx, [
    ["14:30", 100, 100, 100, 100],
    ["14:35", 100, 101, 93, 95], // low 93 <= target 94
  ]);

  const closed = await checkOpenPositionExits({}, makeConfig(), ctx, { asOf: "2026-01-05T15:00:00.000Z" });

  assert.deepEqual(closed, [{ id: "AAPL|t1", ticker: "AAPL", reason: "take_profit" }]);
  const r = await posRow(ctx);
  near(r.exit_price, 94);
  assert.equal(r.closed_at, "2026-01-05T14:40:00.000Z");
});

// ---------------------------------------------------------------------------
// the cursor
// ---------------------------------------------------------------------------

test("cursor: advances to the last walked bar's close when nothing fires; the next check walks only newer bars; an exit leaves it alone", async () => {
  const ctx = makeCtx();
  await openPosition(ctx);
  await seedIntraday(ctx, [
    ["14:30", 100, 100, 100, 100],
    ["14:35", 100, 101, 99, 100],
    ["14:40", 100, 100.5, 99.5, 100],
  ]);

  // Check 1: quiet window -> no exit, cursor moves to the close of the 14:40 bar.
  assert.deepEqual(await checkOpenPositionExits({}, makeConfig(), ctx, { asOf: "2026-01-05T15:00:00.000Z" }), []);
  let r = await posRow(ctx);
  assert.equal(r.last_checked_at, "2026-01-05T14:45:00Z");
  near(r.mae_pct, -0.01);
  near(r.mfe_pct, 0.01);
  assert.equal((await ctx.store.getOpenPositionsAsOf({ asOf: "2026-01-05T15:00:00.000Z" }))[0].lastCheckedAt, "2026-01-05T14:45:00Z");

  // Bars arrive after check 1: 14:45 quiet, 14:50 touches the stop.
  await seedIntraday(ctx, [
    ["14:45", 100, 100, 100, 100],
    ["14:50", 100, 101, 96, 99],
  ]);

  // Check 2 starts at the cursor: only 14:45 and 14:50 are walked, the stop fires at the 14:50 bar's close (14:55).
  const closed = await checkOpenPositionExits({}, makeConfig(), ctx, { asOf: "2026-01-05T15:30:00.000Z" });
  assert.deepEqual(closed, [{ id: "AAPL|t1", ticker: "AAPL", reason: "stop_loss" }]);
  r = await posRow(ctx);
  assert.equal(r.closed_at, "2026-01-05T14:55:00.000Z");
  near(r.mae_pct, -0.04);
  // Exit found: the cursor is deliberately NOT advanced (a crash between "exit found" and closePosition re-finds it).
  assert.equal(r.last_checked_at, "2026-01-05T14:45:00Z");
});

test("cursor: a check with no bars in the window moves nothing, and the next check re-reads from the same start", async () => {
  const ctx = makeCtx();
  await openPosition(ctx);

  assert.deepEqual(await checkOpenPositionExits({}, makeConfig(), ctx, { asOf: "2026-01-05T15:00:00.000Z" }), []);
  let r = await posRow(ctx);
  assert.equal(r.last_checked_at ?? null, null);
  assert.equal(r.mae_pct ?? null, null);
  assert.equal(r.mfe_pct ?? null, null);

  // Bars land later (late ingestion). The window still starts at opened_at, so the touch is not lost.
  await seedIntraday(ctx, [
    ["14:30", 100, 100, 100, 100],
    ["14:35", 100, 100, 96, 97.5],
  ]);
  const closed = await checkOpenPositionExits({}, makeConfig(), ctx, { asOf: "2026-01-05T16:00:00.000Z" });
  assert.deepEqual(closed, [{ id: "AAPL|t1", ticker: "AAPL", reason: "stop_loss" }]);
  r = await posRow(ctx);
  assert.equal(r.closed_at, "2026-01-05T14:40:00.000Z");
});

test("cursor: a bar that has not fully closed at asOf is not walked, and is picked up by the next check", async () => {
  const ctx = makeCtx();
  await openPosition(ctx);
  await seedIntraday(ctx, [
    ["14:30", 100, 100, 100, 100],
    ["14:35", 100, 101, 96, 99], // visible only from 14:40:00
  ]);

  // 14:39:59.999 -> the 14:35 bar is still forming; only 14:30 is walked.
  assert.deepEqual(await checkOpenPositionExits({}, makeConfig(), ctx, { asOf: "2026-01-05T14:39:59.999Z" }), []);
  assert.equal((await posRow(ctx)).last_checked_at, "2026-01-05T14:35:00Z");

  const closed = await checkOpenPositionExits({}, makeConfig(), ctx, { asOf: "2026-01-05T14:40:00.000Z" });
  assert.deepEqual(closed, [{ id: "AAPL|t1", ticker: "AAPL", reason: "stop_loss" }]);
  assert.equal((await posRow(ctx)).closed_at, "2026-01-05T14:40:00.000Z");
});

// ---------------------------------------------------------------------------
// entry-time policy
// ---------------------------------------------------------------------------

test("the intraday bar straddling the entry (ts before opened_at) is never counted, even with a low through the stop", async () => {
  const ctx = makeCtx();
  await openPosition(ctx, { openedAt: "2026-01-05T14:32:00Z" });
  await seedIntraday(ctx, [
    ["14:30", 100, 100, 90, 95], // 14:30-14:34:59 contains the entry: its low may predate the position
    ["14:35", 100, 100, 100, 100],
  ]);

  assert.deepEqual(await checkOpenPositionExits({}, makeConfig(), ctx, { asOf: "2026-01-05T15:00:00.000Z" }), []);
  const r = await posRow(ctx);
  assert.equal(r.closed_at ?? null, null);
  assert.equal(r.last_checked_at, "2026-01-05T14:40:00Z"); // only the 14:35 bar was walked
});

test("entry day with no intraday rows is not checked: its daily bar (which includes the pre-entry range) is never used", async () => {
  const ctx = makeCtx();
  await openPosition(ctx);
  await seedBarOhlc(ctx.inputs, { ticker: "AAPL", date: "2026-01-05", open: 100, high: 100, low: 90, close: 99 }); // entry day: low through the stop
  const { logs } = await captureErrors(async () => {
    // Jan 5's bar is not even visible until Jan 6 00:00Z, and is not used afterwards either.
    assert.deepEqual(await checkOpenPositionExits({}, makeConfig(), ctx, { asOf: "2026-01-06T12:00:00.000Z" }), []);
    assert.equal((await posRow(ctx)).last_checked_at ?? null, null);

    await seedBarOhlc(ctx.inputs, { ticker: "AAPL", date: "2026-01-06", open: 100, high: 101, low: 99, close: 100 });
    assert.deepEqual(await checkOpenPositionExits({}, makeConfig(), ctx, { asOf: "2026-01-07T00:00:00.000Z" }), []);
  });

  const r = await posRow(ctx);
  assert.equal(r.closed_at ?? null, null, "the entry-day low was never used");
  assert.equal(r.last_checked_at, "2026-01-07T00:00:00Z"); // first full day after entry walked
  assert.ok(logs.some((l) => /daily-bar fallback/.test(l)), "the daily fallback is logged");
});

// ---------------------------------------------------------------------------
// daily fallback and precedence
// ---------------------------------------------------------------------------

test("daily fallback: a bar touching both levels resolves stop-first; closedAt is that day's close, and the position reads open before it and closed at it", async () => {
  const ctx = makeCtx();
  await openPosition(ctx);
  await seedBarOhlc(ctx.inputs, { ticker: "AAPL", date: "2026-01-06", open: 100, high: 110, low: 90, close: 105 }); // touches 97 and 106

  const { result: closed, logs } = await captureErrors(() =>
    checkOpenPositionExits({}, makeConfig(), ctx, { asOf: "2026-01-08T00:00:00.000Z" })
  );

  assert.deepEqual(closed, [{ id: "AAPL|t1", ticker: "AAPL", reason: "stop_loss" }]);
  const r = await posRow(ctx);
  near(r.exit_price, 97, "stop level, not the 105 close");
  assert.equal(r.closed_at, "2026-01-07T00:00:00.000Z"); // Jan 6's bar closes at Jan 7 00:00Z, before the check's asOf
  assert.ok(logs.some((l) => /daily-bar fallback/.test(l)));

  assert.equal((await ctx.store.getOpenPositionsAsOf({ asOf: "2026-01-06T12:00:00.000Z" })).length, 1, "still open before the bar closed");
  assert.deepEqual(await ctx.store.getOpenPositionsAsOf({ asOf: "2026-01-07T00:00:00.000Z" }), [], "closed at the bar's close instant");
});

test("a UTC day that has intraday rows ignores that day's daily bar", async () => {
  const ctx = makeCtx();
  await openPosition(ctx);
  await seedIntraday(ctx, [["14:30", 100, 100, 100, 100]], { day: "2026-01-06" });
  await seedBarOhlc(ctx.inputs, { ticker: "AAPL", date: "2026-01-06", open: 100, high: 100, low: 90, close: 95 }); // would stop out if it were used

  assert.deepEqual(await checkOpenPositionExits({}, makeConfig(), ctx, { asOf: "2026-01-07T00:00:00.000Z" }), []);
  const r = await posRow(ctx);
  assert.equal(r.closed_at ?? null, null);
  assert.equal(r.last_checked_at, "2026-01-06T14:35:00Z");
});

// ---------------------------------------------------------------------------
// time exit: first bar open after the hold limit is reached
// ---------------------------------------------------------------------------
// Fixture: opened Thu 2026-01-01 00:00Z, max hold 10 trading days -> due Thu 2026-01-15 00:00Z.

const TIME_OPENED = "2026-01-01T00:00:00Z";

test("time exit: due but no bar after the due instant yet -> stays open (cursor still advances), then closes at the first bar's OPEN, stamped with its open time", async () => {
  const ctx = makeCtx();
  await openPosition(ctx, { openedAt: TIME_OPENED });
  await seedBarOhlc(ctx.inputs, { ticker: "AAPL", date: "2026-01-14", open: 101, high: 102, low: 100, close: 101 });

  // Check exactly at the due instant (the daily backtest walk's midnight check): no bar has opened since.
  const first = await captureErrors(() => checkOpenPositionExits({}, makeConfig(), ctx, { asOf: "2026-01-15T00:00:00.000Z" }));
  assert.deepEqual(first.result, [], "deferred: nothing tradable after the due instant yet");
  let r = await posRow(ctx);
  assert.equal(r.closed_at ?? null, null);
  assert.equal(r.last_checked_at, "2026-01-15T00:00:00Z", "the quiet window still moved the cursor");

  // The market opens. Its low (90) is through the stop (97), but the bar is AFTER the due instant: the price walk is capped there.
  await seedIntradayBarOhlc(ctx.inputs, { ticker: "AAPL", ts: "2026-01-15T14:30:00Z", open: 103, high: 104, low: 90, close: 100 });
  const closed = await checkOpenPositionExits({}, makeConfig(), ctx, { asOf: "2026-01-15T15:00:00.000Z" });

  assert.deepEqual(closed, [{ id: "AAPL|t1", ticker: "AAPL", reason: "time_based" }]);
  r = await posRow(ctx);
  assert.equal(r.close_reason, "time_based");
  assert.equal(r.exit_price, 103, "the first bar's open, not the stale 101 close and not the stop level");
  assert.equal(r.closed_at, "2026-01-15T14:30:00.000Z");
});

test("time exit: a UTC day with only a daily bar fills at that daily bar's open, closedAt = the day's start", async () => {
  const ctx = makeCtx();
  await openPosition(ctx, { openedAt: TIME_OPENED });
  await seedBarOhlc(ctx.inputs, { ticker: "AAPL", date: "2026-01-15", open: 102, high: 103, low: 101, close: 99 });

  // The 01-15 daily bar is not visible until 01-16 00:00Z.
  const { result: closed } = await captureErrors(() =>
    checkOpenPositionExits({}, makeConfig(), ctx, { asOf: "2026-01-16T00:00:00.000Z" })
  );

  assert.deepEqual(closed, [{ id: "AAPL|t1", ticker: "AAPL", reason: "time_based" }]);
  const r = await posRow(ctx);
  assert.equal(r.exit_price, 102);
  assert.equal(r.closed_at, "2026-01-15T00:00:00.000Z");
});

test("time exit: a price exit that happened BEFORE the due instant still wins", async () => {
  const ctx = makeCtx();
  await openPosition(ctx, { openedAt: TIME_OPENED });
  await seedBarOhlc(ctx.inputs, { ticker: "AAPL", date: "2026-01-12", open: 100, high: 100, low: 90, close: 95 }); // stop touched
  await seedBarOhlc(ctx.inputs, { ticker: "AAPL", date: "2026-01-15", open: 102, high: 103, low: 101, close: 102 });

  const { result: closed } = await captureErrors(() =>
    checkOpenPositionExits({}, makeConfig(), ctx, { asOf: "2026-01-16T00:00:00.000Z" })
  );

  assert.deepEqual(closed, [{ id: "AAPL|t1", ticker: "AAPL", reason: "stop_loss" }]);
  assert.equal((await posRow(ctx)).closed_at, "2026-01-13T00:00:00.000Z");
});

test("time exit: no bar within 5 days of the due instant falls back to closing at asOf with the legacy resolveCurrentPrice price", async () => {
  const ctx = makeCtx();
  await openPosition(ctx, { openedAt: TIME_OPENED });
  await seedBarOhlc(ctx.inputs, { ticker: "AAPL", date: "2026-01-14", open: 101, high: 102, low: 100, close: 101 });

  // Still inside the 5-day window at due + 5d exactly: keeps waiting.
  const early = await captureErrors(() => checkOpenPositionExits({}, makeConfig(), ctx, { asOf: "2026-01-20T00:00:00.000Z" }));
  assert.deepEqual(early.result, []);
  assert.equal((await posRow(ctx)).closed_at ?? null, null);

  const late = await captureErrors(() => checkOpenPositionExits({}, makeConfig(), ctx, { asOf: "2026-01-20T00:00:01.000Z" }));
  assert.deepEqual(late.result, [{ id: "AAPL|t1", ticker: "AAPL", reason: "time_based" }]);
  const r = await posRow(ctx);
  assert.equal(r.closed_at, "2026-01-20T00:00:01.000Z");
  assert.equal(r.exit_price, 101);
});
