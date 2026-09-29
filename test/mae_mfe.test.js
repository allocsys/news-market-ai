// MAE/MFE test: RunStore#recordPositionExcursion (positions.mae_pct /
// mfe_pct, migrations/state/0005) and graph/exit_check.js sampling them on
// each exit check. Real sqlite state + inputs DBs (test/helpers/engine_ctx.js).

import test from "node:test";
import assert from "node:assert/strict";
import { checkOpenPositionExits } from "../src/graph/exit_check.js";
import { makeCtx, seedBar, stateRows } from "./helpers/engine_ctx.js";

const FAKE_REFLECTION_MODEL = async () => JSON.stringify({ reflection: "test reflection" });
const CONFIG = { maxPositionHoldDays: 10, geminiQuickModel: "quick", fakeModel: FAKE_REFLECTION_MODEL, splitGuardTolerance: 0.05 };

const openArgs = (ticker, entryPrice, direction = "long") => ({
  id: `${ticker}|t1`, ticker, tradeThesisId: `${ticker}|t1`, positionSizePct: 0.03,
  direction, entryPrice, stopLossPct: 0.03, takeProfitPct: 0.06,
  openedAt: "2026-01-01T00:00:00Z",
});

const positionRow = async (ctx, id) => (await stateRows(ctx.stateDb, "positions")).find((r) => r.id === id);

// ---------------------------------------------------------------------
// RunStore#recordPositionExcursion
// ---------------------------------------------------------------------

test("recordPositionExcursion: a new position has NULL mae/mfe; the first sample sets both against a 0 baseline", async () => {
  const ctx = makeCtx();
  await ctx.store.openPosition(openArgs("AAPL", 100));
  let row = await positionRow(ctx, "AAPL|t1");
  assert.equal(row.mae_pct, null);
  assert.equal(row.mfe_pct, null);

  assert.equal(await ctx.store.recordPositionExcursion({ id: "AAPL|t1", returnPct: 0.02 }), true);
  row = await positionRow(ctx, "AAPL|t1");
  assert.equal(row.mae_pct, 0); // only ever went up: no adverse excursion
  assert.equal(row.mfe_pct, 0.02);
});

test("recordPositionExcursion keeps the running min/max across samples", async () => {
  const ctx = makeCtx();
  await ctx.store.openPosition(openArgs("AAPL", 100));
  for (const r of [-0.01, 0.03, -0.02, 0.01]) await ctx.store.recordPositionExcursion({ id: "AAPL|t1", returnPct: r });
  const row = await positionRow(ctx, "AAPL|t1");
  assert.equal(row.mae_pct, -0.02);
  assert.equal(row.mfe_pct, 0.03);
});

test("recordPositionExcursion only writes when a sample extends an extreme (no-op samples return false)", async () => {
  const ctx = makeCtx();
  await ctx.store.openPosition(openArgs("AAPL", 100));
  assert.equal(await ctx.store.recordPositionExcursion({ id: "AAPL|t1", returnPct: -0.02 }), true); // first sample: mae=-0.02, mfe=0
  assert.equal(await ctx.store.recordPositionExcursion({ id: "AAPL|t1", returnPct: 0.03 }), true); // new mfe
  assert.equal(await ctx.store.recordPositionExcursion({ id: "AAPL|t1", returnPct: -0.01 }), false); // inside [-0.02, 0.03]
  assert.equal(await ctx.store.recordPositionExcursion({ id: "AAPL|t1", returnPct: 0.03 }), false); // equal to mfe, not an extension
  assert.equal(await ctx.store.recordPositionExcursion({ id: "AAPL|t1", returnPct: -0.02 }), false); // equal to mae
  assert.equal(await ctx.store.recordPositionExcursion({ id: "AAPL|t1", returnPct: -0.05 }), true); // new mae
  const row = await positionRow(ctx, "AAPL|t1");
  assert.equal(row.mae_pct, -0.05);
  assert.equal(row.mfe_pct, 0.03);
});

test("recordPositionExcursion: a first sample of exactly 0 still records the 0/0 baseline (sampled, not NULL)", async () => {
  const ctx = makeCtx();
  await ctx.store.openPosition(openArgs("AAPL", 100));
  assert.equal(await ctx.store.recordPositionExcursion({ id: "AAPL|t1", returnPct: 0 }), true);
  const row = await positionRow(ctx, "AAPL|t1");
  assert.equal(row.mae_pct, 0);
  assert.equal(row.mfe_pct, 0);
  assert.equal(await ctx.store.recordPositionExcursion({ id: "AAPL|t1", returnPct: 0 }), false); // now a no-op
});

test("recordPositionExcursion ignores non-finite samples and never overwrites real extremes", async () => {
  const ctx = makeCtx();
  await ctx.store.openPosition(openArgs("AAPL", 100));
  await ctx.store.recordPositionExcursion({ id: "AAPL|t1", returnPct: -0.02 });
  for (const bad of [null, undefined, NaN, Infinity]) {
    assert.equal(await ctx.store.recordPositionExcursion({ id: "AAPL|t1", returnPct: bad }), false);
  }
  const row = await positionRow(ctx, "AAPL|t1");
  assert.equal(row.mae_pct, -0.02);
  assert.equal(row.mfe_pct, 0);
});

test("recordPositionExcursion does not touch a closed position", async () => {
  const ctx = makeCtx();
  await ctx.store.openPosition(openArgs("AAPL", 100));
  await ctx.store.recordPositionExcursion({ id: "AAPL|t1", returnPct: -0.01 });
  await ctx.store.closePosition({ id: "AAPL|t1", closedAt: "2026-01-05T00:00:00Z", closeReason: "time_based", exitPrice: 99 });

  assert.equal(await ctx.store.recordPositionExcursion({ id: "AAPL|t1", returnPct: -0.5 }), false);
  const row = await positionRow(ctx, "AAPL|t1");
  assert.equal(row.mae_pct, -0.01);
});

test("recordPositionExcursion is run_id scoped", async () => {
  const live = makeCtx({ runId: "live" });
  const { RunStore } = await import("../src/storage/run_store.js");
  const other = new RunStore(live.stateDb, "bt-1");
  await other.openPosition(openArgs("AAPL", 100));

  assert.equal(await live.store.recordPositionExcursion({ id: "AAPL|t1", returnPct: -0.02 }), false); // belongs to bt-1
  const row = (await stateRows(live.stateDb, "positions")).find((r) => r.run_id === "bt-1");
  assert.equal(row.mae_pct, null);
});

// ---------------------------------------------------------------------
// checkOpenPositionExits sampling
// ---------------------------------------------------------------------

test("checkOpenPositionExits accumulates MAE/MFE across checks while the position stays open", async () => {
  const ctx = makeCtx();
  await ctx.store.openPosition(openArgs("AAPL", 100));
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-02", close: 98 }); // -2%
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-05", close: 103 }); // +3%

  assert.deepEqual(await checkOpenPositionExits({}, CONFIG, ctx, { asOf: "2026-01-03T00:00:00Z" }), []);
  let row = await positionRow(ctx, "AAPL|t1");
  assert.equal(row.mae_pct, (98 - 100) / 100);
  assert.equal(row.mfe_pct, 0);

  assert.deepEqual(await checkOpenPositionExits({}, CONFIG, ctx, { asOf: "2026-01-06T00:00:00Z" }), []);
  row = await positionRow(ctx, "AAPL|t1");
  assert.equal(row.mae_pct, (98 - 100) / 100); // earlier adverse extreme is kept
  assert.equal(row.mfe_pct, (103 - 100) / 100);
  assert.equal(row.closed_at, null);
});

test("checkOpenPositionExits counts the bar that triggers the exit (stop_loss bar becomes the MAE)", async () => {
  const ctx = makeCtx();
  await ctx.store.openPosition(openArgs("AAPL", 100));
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-02", close: 95 }); // -5%, past the 3% stop

  const closed = await checkOpenPositionExits({}, CONFIG, ctx, { asOf: "2026-01-03T00:00:00Z" });
  assert.deepEqual(closed, [{ id: "AAPL|t1", ticker: "AAPL", reason: "stop_loss" }]);
  const row = await positionRow(ctx, "AAPL|t1");
  assert.equal(row.mae_pct, (95 - 100) / 100);
  assert.equal(row.mfe_pct, 0);
  assert.equal(row.exit_price, 95);
});

test("checkOpenPositionExits is direction-aware: a short's adverse move is the price RISING", async () => {
  const ctx = makeCtx();
  await ctx.store.openPosition(openArgs("AAPL", 100, "short"));
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-02", close: 102 }); // -2% for a short
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-05", close: 97 }); // +3% for a short

  await checkOpenPositionExits({}, CONFIG, ctx, { asOf: "2026-01-03T00:00:00Z" });
  await checkOpenPositionExits({}, CONFIG, ctx, { asOf: "2026-01-06T00:00:00Z" });
  const row = await positionRow(ctx, "AAPL|t1");
  assert.equal(row.mae_pct, (100 - 102) / 100);
  assert.equal(row.mfe_pct, (100 - 97) / 100);
});

test("checkOpenPositionExits leaves MAE/MFE NULL when there is no price or no entry price to sample", async () => {
  const ctx = makeCtx();
  await ctx.store.openPosition(openArgs("TSLA", 100)); // no bars seeded for TSLA
  await ctx.store.openPosition(openArgs("NVDA", null)); // no entry price
  await seedBar(ctx.inputs, { ticker: "NVDA", date: "2026-01-02", close: 90 });

  await checkOpenPositionExits({}, CONFIG, ctx, { asOf: "2026-01-03T00:00:00Z" });
  for (const id of ["TSLA|t1", "NVDA|t1"]) {
    const row = await positionRow(ctx, id);
    assert.equal(row.mae_pct, null, `${id} mae_pct`);
    assert.equal(row.mfe_pct, null, `${id} mfe_pct`);
  }
});

test("checkOpenPositionExits does not sample a split-suspected price (a 2:1 split is not a -50% MAE)", async () => {
  const ctx = makeCtx();
  await ctx.store.openPosition(openArgs("AAPL", 100));
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-02", close: 50 }); // exactly a 2:1 split ratio

  const closed = await checkOpenPositionExits({}, CONFIG, ctx, { asOf: "2026-01-03T00:00:00Z" });
  assert.deepEqual(closed, []); // price exits suppressed, still open
  const row = await positionRow(ctx, "AAPL|t1");
  assert.equal(row.mae_pct, null);
  assert.equal(row.mfe_pct, null);
});
