// positions_pointintime test (plan.md open item: real positions store).
// Exercises RunStore#openPosition/closePosition/getOpenPositionsRiskPctAsOf/
// getOpenPositionForTickerAsOf (storage/run_store.js) against a REAL
// sqlite-backed state DB (test/helpers/engine_ctx.js) -- M2 replaced the
// hand-rolled FakePositionsDb, keeping every assertion below unchanged, so
// the same point-in-time guarantees are now proven against the real SQL.
//
// Focus: getOpenPositionsRiskPctAsOf must reflect exposure exactly AS OF a
// given timestamp -- a position opened after `asOf`, or already closed
// before `asOf`, must never count toward the sum (Backtesting Integrity,
// same principle as points 1/2/4 applied to portfolio exposure).

import test from "node:test";
import assert from "node:assert/strict";
import { LookaheadViolationError } from "../src/shared/errors.js";
import { RunStore } from "../src/storage/run_store.js";
import { makeCtx } from "./helpers/engine_ctx.js";

test("getOpenPositionsRiskPctAsOf throws LookaheadViolationError when asOf is omitted", async () => {
  const { store } = makeCtx();
  await assert.rejects(() => store.getOpenPositionsRiskPctAsOf({}), LookaheadViolationError);
});

test("getOpenPositionsRiskPctAsOf is 0 with no positions open", async () => {
  const { store } = makeCtx();
  const pct = await store.getOpenPositionsRiskPctAsOf({ asOf: "2026-01-15T00:00:00Z" });
  assert.equal(pct, 0);
});

test("getOpenPositionsRiskPctAsOf sums every position open as of the given timestamp", async () => {
  const { store } = makeCtx();
  await store.openPosition({ id: "AAPL|t1", ticker: "AAPL", tradeThesisId: "AAPL|t1", positionSizePct: 0.03, openedAt: "2026-01-01T00:00:00Z" });
  await store.openPosition({ id: "MSFT|t1", ticker: "MSFT", tradeThesisId: "MSFT|t1", positionSizePct: 0.02, openedAt: "2026-01-05T00:00:00Z" });

  const pct = await store.getOpenPositionsRiskPctAsOf({ asOf: "2026-01-10T00:00:00Z" });
  assert.equal(pct, 0.05);
});

test("a position opened AFTER asOf does not count (no lookahead)", async () => {
  const { store } = makeCtx();
  await store.openPosition({ id: "AAPL|t1", ticker: "AAPL", tradeThesisId: "AAPL|t1", positionSizePct: 0.03, openedAt: "2026-02-01T00:00:00Z" });

  const pct = await store.getOpenPositionsRiskPctAsOf({ asOf: "2026-01-15T00:00:00Z" });
  assert.equal(pct, 0); // not yet opened as of Jan 15
});

test("a position closed strictly BEFORE asOf no longer counts", async () => {
  const { store } = makeCtx();
  await store.openPosition({ id: "AAPL|t1", ticker: "AAPL", tradeThesisId: "AAPL|t1", positionSizePct: 0.03, openedAt: "2026-01-01T00:00:00Z" });
  await store.closePosition({ id: "AAPL|t1", closedAt: "2026-01-10T00:00:00Z" });

  const pct = await store.getOpenPositionsRiskPctAsOf({ asOf: "2026-01-20T00:00:00Z" });
  assert.equal(pct, 0);
});

test("a position closed AFTER asOf still counts as open at that earlier asOf", async () => {
  const { store } = makeCtx();
  await store.openPosition({ id: "AAPL|t1", ticker: "AAPL", tradeThesisId: "AAPL|t1", positionSizePct: 0.03, openedAt: "2026-01-01T00:00:00Z" });
  await store.closePosition({ id: "AAPL|t1", closedAt: "2026-01-20T00:00:00Z" });

  const pct = await store.getOpenPositionsRiskPctAsOf({ asOf: "2026-01-10T00:00:00Z" });
  assert.equal(pct, 0.03); // still open as of Jan 10, closes later on Jan 20
});

test("openPosition is idempotent on the same id -- a checkpoint-resumed re-run can't double-open", async () => {
  const { store } = makeCtx();
  await store.openPosition({ id: "AAPL|t1", ticker: "AAPL", tradeThesisId: "AAPL|t1", positionSizePct: 0.03, openedAt: "2026-01-01T00:00:00Z" });
  await store.openPosition({ id: "AAPL|t1", ticker: "AAPL", tradeThesisId: "AAPL|t1", positionSizePct: 0.03, openedAt: "2026-01-01T00:00:00Z" });

  const pct = await store.getOpenPositionsRiskPctAsOf({ asOf: "2026-01-15T00:00:00Z" });
  assert.equal(pct, 0.03); // not 0.06 -- the second call was a no-op
});

// --- Netting: excludeTicker + getOpenPositionForTickerAsOf ---------------
// Covers the previously-documented KNOWN LIMITATION (re-evaluating a
// ticker that already has an open position double-counted its own
// exposure) now that both halves of the fix exist: excludeTicker on the
// summed read, and getOpenPositionForTickerAsOf for finding what to
// replace.

test("getOpenPositionsRiskPctAsOf with excludeTicker nets that ticker's own exposure out of the sum", async () => {
  const { store } = makeCtx();
  await store.openPosition({ id: "AAPL|t1", ticker: "AAPL", tradeThesisId: "AAPL|t1", positionSizePct: 0.03, openedAt: "2026-01-01T00:00:00Z" });
  await store.openPosition({ id: "MSFT|t1", ticker: "MSFT", tradeThesisId: "MSFT|t1", positionSizePct: 0.02, openedAt: "2026-01-05T00:00:00Z" });

  const pct = await store.getOpenPositionsRiskPctAsOf({ asOf: "2026-01-10T00:00:00Z", excludeTicker: "AAPL" });
  assert.equal(pct, 0.02); // AAPL's own 0.03 excluded, only MSFT's 0.02 remains
});

test("getOpenPositionsRiskPctAsOf without excludeTicker is unaffected -- pre-existing behavior preserved", async () => {
  const { store } = makeCtx();
  await store.openPosition({ id: "AAPL|t1", ticker: "AAPL", tradeThesisId: "AAPL|t1", positionSizePct: 0.03, openedAt: "2026-01-01T00:00:00Z" });
  await store.openPosition({ id: "MSFT|t1", ticker: "MSFT", tradeThesisId: "MSFT|t1", positionSizePct: 0.02, openedAt: "2026-01-05T00:00:00Z" });

  const pct = await store.getOpenPositionsRiskPctAsOf({ asOf: "2026-01-10T00:00:00Z" });
  assert.equal(pct, 0.05); // no excludeTicker -- sums everything, same as before this session
});

test("getOpenPositionForTickerAsOf throws LookaheadViolationError when asOf is omitted", async () => {
  const { store } = makeCtx();
  await assert.rejects(() => store.getOpenPositionForTickerAsOf({ ticker: "AAPL" }), LookaheadViolationError);
});

test("getOpenPositionForTickerAsOf returns null when the ticker has no open position", async () => {
  const { store } = makeCtx();
  const pos = await store.getOpenPositionForTickerAsOf({ ticker: "AAPL", asOf: "2026-01-10T00:00:00Z" });
  assert.equal(pos, null);
});

test("getOpenPositionForTickerAsOf finds the ticker's open position as of asOf", async () => {
  const { store } = makeCtx();
  await store.openPosition({ id: "AAPL|t1", ticker: "AAPL", tradeThesisId: "AAPL|t1", positionSizePct: 0.03, openedAt: "2026-01-01T00:00:00Z" });

  const pos = await store.getOpenPositionForTickerAsOf({ ticker: "AAPL", asOf: "2026-01-10T00:00:00Z" });
  assert.equal(pos.id, "AAPL|t1");
  assert.equal(pos.ticker, "AAPL");
  assert.equal(pos.positionSizePct, 0.03);
});

test("getOpenPositionForTickerAsOf returns null for a position not yet opened as of asOf (no lookahead)", async () => {
  const { store } = makeCtx();
  await store.openPosition({ id: "AAPL|t1", ticker: "AAPL", tradeThesisId: "AAPL|t1", positionSizePct: 0.03, openedAt: "2026-02-01T00:00:00Z" });

  const pos = await store.getOpenPositionForTickerAsOf({ ticker: "AAPL", asOf: "2026-01-15T00:00:00Z" });
  assert.equal(pos, null);
});

test("getOpenPositionForTickerAsOf returns null once the position has closed strictly before asOf", async () => {
  const { store } = makeCtx();
  await store.openPosition({ id: "AAPL|t1", ticker: "AAPL", tradeThesisId: "AAPL|t1", positionSizePct: 0.03, openedAt: "2026-01-01T00:00:00Z" });
  await store.closePosition({ id: "AAPL|t1", closedAt: "2026-01-10T00:00:00Z", closeReason: "replaced" });

  const pos = await store.getOpenPositionForTickerAsOf({ ticker: "AAPL", asOf: "2026-01-20T00:00:00Z" });
  assert.equal(pos, null);
});

test("getOpenPositionForTickerAsOf is per-ticker -- does not return a different ticker's position", async () => {
  const { store } = makeCtx();
  await store.openPosition({ id: "MSFT|t1", ticker: "MSFT", tradeThesisId: "MSFT|t1", positionSizePct: 0.02, openedAt: "2026-01-01T00:00:00Z" });

  const pos = await store.getOpenPositionForTickerAsOf({ ticker: "AAPL", asOf: "2026-01-10T00:00:00Z" });
  assert.equal(pos, null);
});

// --- Environment isolation (new in M2: every row is run_id-scoped) --------

test("positions are isolated by run_id: a second RunStore on the same DB never sees or nets the first's positions", async () => {
  const { store, stateDb } = makeCtx({ runId: "live" });
  const sim = new RunStore(stateDb, "bt-1");
  await store.openPosition({ id: "AAPL|t1", ticker: "AAPL", tradeThesisId: "AAPL|t1", positionSizePct: 0.03, openedAt: "2026-01-01T00:00:00Z" });

  assert.equal(await sim.getOpenPositionsRiskPctAsOf({ asOf: "2026-01-10T00:00:00Z" }), 0);
  assert.equal(await sim.getOpenPositionForTickerAsOf({ ticker: "AAPL", asOf: "2026-01-10T00:00:00Z" }), null);
  assert.equal(await store.getOpenPositionsRiskPctAsOf({ asOf: "2026-01-10T00:00:00Z" }), 0.03);
});
