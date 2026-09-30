// RunStore's bar-based-exit state (migrations/state/0006 last_checked_at):
//   advancePositionCheck          -- the cursor: forward only, open rows only
//   recordPositionExcursionRange  -- window MAE/MFE folded in one write
// Real sqlite state DB via makeCtx, so the WHERE-guards are the real ones.

import test from "node:test";
import assert from "node:assert/strict";
import { RunStore } from "../src/storage/run_store.js";
import { makeCtx, stateRows } from "./helpers/engine_ctx.js";

const ASOF = "2026-01-10T00:00:00.000Z";

async function openLong(store, id = "AAPL|t1", ticker = "AAPL") {
  await store.openPosition({
    id, ticker, tradeThesisId: id, positionSizePct: 0.03, direction: "long",
    entryPrice: 100, stopLossPct: 0.05, takeProfitPct: 0.1, openedAt: "2026-01-05T14:30:00Z",
  });
}

async function row(ctx, id = "AAPL|t1") {
  return (await stateRows(ctx.stateDb, "positions")).find((r) => r.id === id);
}

// ---------------------------------------------------------------------------
// advancePositionCheck
// ---------------------------------------------------------------------------

test("advancePositionCheck: a fresh position has no cursor; the first advance sets it and getOpenPositionsAsOf exposes it", async () => {
  const ctx = makeCtx();
  await openLong(ctx.store);

  assert.equal((await row(ctx)).last_checked_at ?? null, null);
  assert.equal((await ctx.store.getOpenPositionsAsOf({ asOf: ASOF }))[0].lastCheckedAt, null);

  assert.equal(await ctx.store.advancePositionCheck({ id: "AAPL|t1", lastCheckedAt: "2026-01-06T10:00:00Z" }), true);

  assert.equal((await row(ctx)).last_checked_at, "2026-01-06T10:00:00Z");
  assert.equal((await ctx.store.getOpenPositionsAsOf({ asOf: ASOF }))[0].lastCheckedAt, "2026-01-06T10:00:00Z");
});

test("advancePositionCheck: only ever moves FORWARD (an earlier or equal value is a no-op)", async () => {
  const ctx = makeCtx();
  await openLong(ctx.store);
  await ctx.store.advancePositionCheck({ id: "AAPL|t1", lastCheckedAt: "2026-01-06T10:00:00Z" });

  assert.equal(await ctx.store.advancePositionCheck({ id: "AAPL|t1", lastCheckedAt: "2026-01-06T09:55:00Z" }), false); // stale
  assert.equal(await ctx.store.advancePositionCheck({ id: "AAPL|t1", lastCheckedAt: "2026-01-06T10:00:00Z" }), false); // same
  assert.equal((await row(ctx)).last_checked_at, "2026-01-06T10:00:00Z");

  assert.equal(await ctx.store.advancePositionCheck({ id: "AAPL|t1", lastCheckedAt: "2026-01-06T10:05:00Z" }), true);
  assert.equal((await row(ctx)).last_checked_at, "2026-01-06T10:05:00Z");
});

test("advancePositionCheck: an empty or missing timestamp is a no-op that never writes NULL over a real cursor", async () => {
  const ctx = makeCtx();
  await openLong(ctx.store);
  await ctx.store.advancePositionCheck({ id: "AAPL|t1", lastCheckedAt: "2026-01-06T10:00:00Z" });

  assert.equal(await ctx.store.advancePositionCheck({ id: "AAPL|t1", lastCheckedAt: null }), false);
  assert.equal(await ctx.store.advancePositionCheck({ id: "AAPL|t1", lastCheckedAt: "" }), false);
  assert.equal(await ctx.store.advancePositionCheck({ id: "AAPL|t1" }), false);
  assert.equal((await row(ctx)).last_checked_at, "2026-01-06T10:00:00Z");
});

test("advancePositionCheck: a CLOSED position's cursor is left alone", async () => {
  const ctx = makeCtx();
  await openLong(ctx.store);
  await ctx.store.advancePositionCheck({ id: "AAPL|t1", lastCheckedAt: "2026-01-06T10:00:00Z" });
  await ctx.store.closePosition({ id: "AAPL|t1", closedAt: "2026-01-06T10:05:00Z", closeReason: "stop_loss", exitPrice: 95 });

  assert.equal(await ctx.store.advancePositionCheck({ id: "AAPL|t1", lastCheckedAt: "2026-01-07T00:00:00Z" }), false);
  assert.equal((await row(ctx)).last_checked_at, "2026-01-06T10:00:00Z");
});

test("advancePositionCheck: scoped to its own run_id and to the one position id", async () => {
  const ctx = makeCtx({ runId: "run-a" });
  const other = new RunStore(ctx.stateDb, "run-b");
  await openLong(ctx.store, "AAPL|t1");
  await openLong(ctx.store, "MSFT|t1", "MSFT");
  await openLong(other, "AAPL|t1");

  assert.equal(await ctx.store.advancePositionCheck({ id: "AAPL|t1", lastCheckedAt: "2026-01-06T10:00:00Z" }), true);

  const rows = await stateRows(ctx.stateDb, "positions");
  const get = (run, id) => rows.find((r) => r.run_id === run && r.id === id);
  assert.equal(get("run-a", "AAPL|t1").last_checked_at, "2026-01-06T10:00:00Z");
  assert.equal(get("run-a", "MSFT|t1").last_checked_at ?? null, null);
  assert.equal(get("run-b", "AAPL|t1").last_checked_at ?? null, null);
});

test("advancePositionCheck: a position id that does not exist is a harmless false", async () => {
  const ctx = makeCtx();
  assert.equal(await ctx.store.advancePositionCheck({ id: "nope", lastCheckedAt: "2026-01-06T10:00:00Z" }), false);
});

// ---------------------------------------------------------------------------
// recordPositionExcursionRange
// ---------------------------------------------------------------------------

test("recordPositionExcursionRange: the first window sets both extremes in one write", async () => {
  const ctx = makeCtx();
  await openLong(ctx.store);

  assert.equal(await ctx.store.recordPositionExcursionRange({ id: "AAPL|t1", maePct: -0.04, mfePct: 0.02 }), true);

  const r = await row(ctx);
  assert.equal(r.mae_pct, -0.04);
  assert.equal(r.mfe_pct, 0.02);
});

test("recordPositionExcursionRange: a window inside the existing range writes nothing", async () => {
  const ctx = makeCtx();
  await openLong(ctx.store);
  await ctx.store.recordPositionExcursionRange({ id: "AAPL|t1", maePct: -0.04, mfePct: 0.02 });

  assert.equal(await ctx.store.recordPositionExcursionRange({ id: "AAPL|t1", maePct: -0.03, mfePct: 0.01 }), false);
  assert.equal(await ctx.store.recordPositionExcursionRange({ id: "AAPL|t1", maePct: -0.04, mfePct: 0.02 }), false); // equal is not a new extreme

  const r = await row(ctx);
  assert.equal(r.mae_pct, -0.04);
  assert.equal(r.mfe_pct, 0.02);
});

test("recordPositionExcursionRange: each side only ever widens, independently", async () => {
  const ctx = makeCtx();
  await openLong(ctx.store);
  await ctx.store.recordPositionExcursionRange({ id: "AAPL|t1", maePct: -0.04, mfePct: 0.02 });

  // New adverse extreme only; the smaller mfe must not pull mfe_pct down.
  assert.equal(await ctx.store.recordPositionExcursionRange({ id: "AAPL|t1", maePct: -0.06, mfePct: 0.01 }), true);
  let r = await row(ctx);
  assert.equal(r.mae_pct, -0.06);
  assert.equal(r.mfe_pct, 0.02);

  // New favorable extreme only; the shallower mae must not pull mae_pct up.
  assert.equal(await ctx.store.recordPositionExcursionRange({ id: "AAPL|t1", maePct: -0.01, mfePct: 0.05 }), true);
  r = await row(ctx);
  assert.equal(r.mae_pct, -0.06);
  assert.equal(r.mfe_pct, 0.05);
});

test("recordPositionExcursionRange: a null side is ignored; the other side still lands, on a 0 baseline", async () => {
  const ctx = makeCtx();
  await openLong(ctx.store);

  assert.equal(await ctx.store.recordPositionExcursionRange({ id: "AAPL|t1", maePct: null, mfePct: 0.03 }), true);
  let r = await row(ctx);
  assert.equal(r.mae_pct, 0); // the entry itself is the baseline, so the row is never left half-null
  assert.equal(r.mfe_pct, 0.03);

  assert.equal(await ctx.store.recordPositionExcursionRange({ id: "AAPL|t1", maePct: -0.02, mfePct: undefined }), true);
  r = await row(ctx);
  assert.equal(r.mae_pct, -0.02);
  assert.equal(r.mfe_pct, 0.03);
});

test("recordPositionExcursionRange: nothing usable (null / NaN / undefined on both sides) is a no-op", async () => {
  const ctx = makeCtx();
  await openLong(ctx.store);

  assert.equal(await ctx.store.recordPositionExcursionRange({ id: "AAPL|t1", maePct: null, mfePct: null }), false);
  assert.equal(await ctx.store.recordPositionExcursionRange({ id: "AAPL|t1", maePct: NaN, mfePct: Infinity }), false);
  assert.equal(await ctx.store.recordPositionExcursionRange({ id: "AAPL|t1" }), false);

  const r = await row(ctx);
  assert.equal(r.mae_pct ?? null, null);
  assert.equal(r.mfe_pct ?? null, null);
});

test("recordPositionExcursionRange: a wrong-signed extreme is clamped to the 0 baseline, never raising mae or lowering mfe", async () => {
  const ctx = makeCtx();
  await openLong(ctx.store);
  await ctx.store.recordPositionExcursionRange({ id: "AAPL|t1", maePct: -0.05, mfePct: 0.02 });

  // mae "+0.03" (would be favorable) clamps to 0; mfe "-0.01" clamps to 0: neither is a new extreme.
  assert.equal(await ctx.store.recordPositionExcursionRange({ id: "AAPL|t1", maePct: 0.03, mfePct: -0.01 }), false);
  const r = await row(ctx);
  assert.equal(r.mae_pct, -0.05);
  assert.equal(r.mfe_pct, 0.02);
});

test("recordPositionExcursionRange: a CLOSED position's extremes are left alone", async () => {
  const ctx = makeCtx();
  await openLong(ctx.store);
  await ctx.store.recordPositionExcursionRange({ id: "AAPL|t1", maePct: -0.04, mfePct: 0.02 });
  await ctx.store.closePosition({ id: "AAPL|t1", closedAt: "2026-01-06T10:05:00Z", closeReason: "stop_loss", exitPrice: 95 });

  assert.equal(await ctx.store.recordPositionExcursionRange({ id: "AAPL|t1", maePct: -0.5, mfePct: 0.5 }), false);
  const r = await row(ctx);
  assert.equal(r.mae_pct, -0.04);
  assert.equal(r.mfe_pct, 0.02);
});

test("recordPositionExcursionRange: scoped to its own run_id", async () => {
  const ctx = makeCtx({ runId: "run-a" });
  const other = new RunStore(ctx.stateDb, "run-b");
  await openLong(ctx.store);
  await openLong(other);

  await ctx.store.recordPositionExcursionRange({ id: "AAPL|t1", maePct: -0.04, mfePct: 0.02 });

  const rows = await stateRows(ctx.stateDb, "positions");
  assert.equal(rows.find((r) => r.run_id === "run-a").mae_pct, -0.04);
  assert.equal(rows.find((r) => r.run_id === "run-b").mae_pct ?? null, null);
});

test("cursor and excursion writes are independent columns: one never disturbs the other or the position's identity fields", async () => {
  const ctx = makeCtx();
  await openLong(ctx.store);

  await ctx.store.recordPositionExcursionRange({ id: "AAPL|t1", maePct: -0.04, mfePct: 0.02 });
  await ctx.store.advancePositionCheck({ id: "AAPL|t1", lastCheckedAt: "2026-01-06T10:00:00Z" });

  const r = await row(ctx);
  assert.equal(r.mae_pct, -0.04);
  assert.equal(r.mfe_pct, 0.02);
  assert.equal(r.last_checked_at, "2026-01-06T10:00:00Z");
  assert.equal(r.entry_price, 100);
  assert.equal(r.opened_at, "2026-01-05T14:30:00Z");
  assert.equal(r.closed_at ?? null, null);
});
