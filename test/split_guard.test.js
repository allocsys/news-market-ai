// Stock-split guard (plan item 5). Stored bars are RAW/unadjusted, so a split
// looks like a crash: shared/split_guard.js detects a current/entry price ratio
// near a common split ratio, graph/exit_check.js then suppresses stop-loss /
// take-profit (and refuses to settle a fake return), and config.js wires the
// tolerance. Ratios are worked out by hand in the comments.

import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { detectSplitJump, SPLIT_FACTORS } from "../src/shared/split_guard.js";
import { evaluateExit } from "../src/agents/risk_mgmt/exit.js";
import { checkOpenPositionExits } from "../src/graph/exit_check.js";
import { loadConfig } from "../src/config.js";
import { DEFAULT_SPLIT_GUARD_TOLERANCE } from "../src/shared/constants.js";
import { makeCtx, seedBar, stateRows } from "./helpers/engine_ctx.js";

const TOL = 0.05;

// ---------------------------------------------------------------------------
// shared/split_guard.js
// ---------------------------------------------------------------------------

test("detectSplitJump: forward splits (price falls to 1/n) are matched, with the factor and ratio", () => {
  assert.deepEqual(detectSplitJump(100, 50, TOL), { kind: "split", factor: 2, ratio: 0.5 });
  assert.equal(detectSplitJump(150, 50, TOL).factor, 3); // 50/150 = 1/3
  assert.equal(detectSplitJump(100, 25, TOL).factor, 4);
  assert.equal(detectSplitJump(100, 20, TOL).factor, 5);
  assert.equal(detectSplitJump(100, 10, TOL).factor, 10);
});

test("detectSplitJump: reverse splits (price rises to n times) are matched", () => {
  assert.deepEqual(detectSplitJump(50, 100, TOL), { kind: "reverse_split", factor: 2, ratio: 2 });
  assert.equal(detectSplitJump(10, 100, TOL).kind, "reverse_split");
  assert.equal(detectSplitJump(10, 100, TOL).factor, 10);
  assert.deepEqual(SPLIT_FACTORS, [2, 3, 4, 5, 10]);
});

test("detectSplitJump: the window is a RELATIVE tolerance around each ratio", () => {
  // 2:1 -> ratio 0.5; |ratio * 2 - 1| <= 0.05 <=> ratio in [0.475, 0.525].
  assert.ok(detectSplitJump(100, 52, TOL)); // 0.52 * 2 = 1.04, inside
  assert.ok(detectSplitJump(100, 48, TOL)); // 0.48 * 2 = 0.96, inside
  assert.equal(detectSplitJump(100, 56, TOL), null); // 0.56 * 2 = 1.12, outside
  assert.equal(detectSplitJump(100, 44, TOL), null); // 0.44 * 2 = 0.88, outside (and not 1/3 or 1/4 either)
});

test("detectSplitJump: ordinary moves and the unmatched 3-for-2 ratio are not flagged", () => {
  assert.equal(detectSplitJump(100, 95, TOL), null); // -5%
  assert.equal(detectSplitJump(100, 106, TOL), null); // +6%
  assert.equal(detectSplitJump(100, 100, TOL), null);
  assert.equal(detectSplitJump(150, 100, TOL), null); // 3-for-2 (0.667) is deliberately not matched
});

test("detectSplitJump: missing or non-positive prices and a disabled tolerance return null", () => {
  assert.equal(detectSplitJump(null, 50, TOL), null);
  assert.equal(detectSplitJump(100, null, TOL), null);
  assert.equal(detectSplitJump(undefined, undefined, TOL), null);
  assert.equal(detectSplitJump(0, 50, TOL), null);
  assert.equal(detectSplitJump(100, -50, TOL), null);
  assert.equal(detectSplitJump(100, NaN, TOL), null);
  assert.equal(detectSplitJump(100, 50, 0), null); // 0 disables
  assert.equal(detectSplitJump(100, 50, undefined), null); // config without the key runs unguarded
});

// ---------------------------------------------------------------------------
// agents/risk_mgmt/exit.js
// ---------------------------------------------------------------------------

const LONG = { direction: "long", entryPrice: 100, stopLossPct: 0.03, takeProfitPct: 0.06, openedAt: "2026-01-01T00:00:00Z" };

test("evaluateExit: skipPriceExits suppresses stop-loss and take-profit but not the time exit", () => {
  const args = { asOf: "2026-01-02T00:00:00Z", maxHoldDays: 10 };
  assert.deepEqual(evaluateExit(LONG, { ...args, currentPrice: 50 }), { reason: "stop_loss" });
  assert.equal(evaluateExit(LONG, { ...args, currentPrice: 50, skipPriceExits: true }), null);
  assert.deepEqual(evaluateExit(LONG, { ...args, currentPrice: 200 }), { reason: "take_profit" });
  assert.equal(evaluateExit(LONG, { ...args, currentPrice: 200, skipPriceExits: true }), null);
  // Thu 2026-01-01 -> Mon 2026-01-05 is 2 trading days.
  assert.deepEqual(
    evaluateExit(LONG, { asOf: "2026-01-05T00:00:00Z", maxHoldDays: 2, currentPrice: 50, skipPriceExits: true }),
    { reason: "time_based" },
  );
});

// ---------------------------------------------------------------------------
// graph/exit_check.js (real sqlite state + inputs DBs)
// ---------------------------------------------------------------------------

const FAKE_REFLECTION_MODEL = async () => JSON.stringify({ reflection: "test reflection" });
const baseConfig = (extra) => ({ maxPositionHoldDays: 10, geminiQuickModel: "quick", fakeModel: FAKE_REFLECTION_MODEL, ...extra });

async function openLong(ctx) {
  await ctx.store.openPosition({
    id: "AAPL|t1", ticker: "AAPL", tradeThesisId: "AAPL|t1", positionSizePct: 0.03,
    direction: "long", entryPrice: 100, stopLossPct: 0.03, takeProfitPct: 0.06, openedAt: "2026-01-01T00:00:00Z",
  });
}

test("checkOpenPositionExits: a 2-for-1 price step does NOT stop the position out, and is logged loudly", async () => {
  const errors = mock.method(console, "error", () => {});
  try {
    const ctx = makeCtx();
    await openLong(ctx);
    await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-02", close: 50 }); // 100 -> 50: -50% "loss"

    const closed = await checkOpenPositionExits({}, baseConfig({ splitGuardTolerance: TOL }), ctx, { asOf: "2026-01-03T00:00:00Z" });

    assert.deepEqual(closed, []);
    assert.equal((await ctx.store.getOpenPositionsAsOf({ asOf: "2026-01-03T00:00:00Z" })).length, 1); // still open
    assert.equal((await stateRows(ctx.stateDb, "decision_memory")).length, 0); // no fake -50% lesson
    const logged = errors.mock.calls.find((c) => String(c.arguments[0]).includes("possible stock split"));
    assert.ok(logged, "expected a loud split warning");
    assert.equal(logged.arguments[1].ticker, "AAPL");
    assert.equal(logged.arguments[1].suspected, "split");
    assert.equal(logged.arguments[1].factor, 2);
  } finally {
    errors.mock.restore();
  }
});

test("checkOpenPositionExits: with the guard off (tolerance 0 or absent) the same bar is a stop-loss at the raw price", async () => {
  for (const extra of [{ splitGuardTolerance: 0 }, {}]) {
    const ctx = makeCtx();
    await openLong(ctx);
    await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-02", close: 50 });

    const closed = await checkOpenPositionExits({}, baseConfig(extra), ctx, { asOf: "2026-01-03T00:00:00Z" });

    assert.deepEqual(closed.map((c) => c.reason), ["stop_loss"]);
    const [memory] = await stateRows(ctx.stateDb, "decision_memory");
    assert.ok(Math.abs(memory.realized_return - -0.5) < 1e-9);
  }
});

test("checkOpenPositionExits: an ordinary -5% move still stops out with the guard on", async () => {
  const ctx = makeCtx();
  await openLong(ctx);
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-02", close: 95 });

  const closed = await checkOpenPositionExits({}, baseConfig({ splitGuardTolerance: TOL }), ctx, { asOf: "2026-01-03T00:00:00Z" });

  assert.deepEqual(closed.map((c) => c.reason), ["stop_loss"]);
  const [memory] = await stateRows(ctx.stateDb, "decision_memory");
  assert.ok(Math.abs(memory.realized_return - -0.05) < 1e-9);
});

test("checkOpenPositionExits: a time exit under a suspected split closes with no exit price and records no reflection", async () => {
  const errors = mock.method(console, "error", () => {});
  try {
    const ctx = makeCtx();
    await openLong(ctx);
    await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-02", close: 50 });

    // Thu 2026-01-01 -> Mon 2026-01-05: 2 trading days >= maxPositionHoldDays 2.
    const closed = await checkOpenPositionExits(
      {},
      baseConfig({ splitGuardTolerance: TOL, maxPositionHoldDays: 2 }),
      ctx,
      { asOf: "2026-01-05T00:00:00Z" },
    );

    assert.deepEqual(closed.map((c) => c.reason), ["time_based"]);
    const row = (await stateRows(ctx.stateDb, "positions")).find((r) => r.id === "AAPL|t1");
    assert.equal(row.close_reason, "time_based");
    assert.equal(row.exit_price ?? null, null); // the split-distorted 50 is never recorded as an exit price
    assert.equal((await stateRows(ctx.stateDb, "decision_memory")).length, 0); // settle: return not computable
  } finally {
    errors.mock.restore();
  }
});

// ---------------------------------------------------------------------------
// config.js
// ---------------------------------------------------------------------------

test("loadConfig: SPLIT_GUARD_TOLERANCE defaults to the placeholder, honors 0 and decimals, and falls back on garbage or negatives", () => {
  assert.equal(loadConfig({}).splitGuardTolerance, DEFAULT_SPLIT_GUARD_TOLERANCE);
  assert.equal(loadConfig({ SPLIT_GUARD_TOLERANCE: "" }).splitGuardTolerance, DEFAULT_SPLIT_GUARD_TOLERANCE);
  assert.equal(loadConfig({ SPLIT_GUARD_TOLERANCE: "0" }).splitGuardTolerance, 0); // 0 = guard off, not "unset"
  assert.equal(loadConfig({ SPLIT_GUARD_TOLERANCE: "0.1" }).splitGuardTolerance, 0.1);
  assert.equal(loadConfig({ SPLIT_GUARD_TOLERANCE: "abc" }).splitGuardTolerance, DEFAULT_SPLIT_GUARD_TOLERANCE);
  assert.equal(loadConfig({ SPLIT_GUARD_TOLERANCE: "-1" }).splitGuardTolerance, DEFAULT_SPLIT_GUARD_TOLERANCE);
});
