// Break-even / trailing stop (migration 0010, agents/risk_mgmt/trailing.js, exit_bars.js, run_store.js).
// Pure functions for the level and the walk; real sqlite-backed D1 for the peak persistence.
// Levels used throughout: entry 100, R = stopLossPct = 0.05 (so 1R = 5 price points), target +10%.

import test from "node:test";
import assert from "node:assert/strict";
import { resolveTrailingConfig, ratchetedStop, betterPeak } from "../src/agents/risk_mgmt/trailing.js";
import { walkBarsForExit } from "../src/agents/risk_mgmt/exit_bars.js";
import { CLOSE_REASON } from "../src/agents/risk_mgmt/exit.js";
import { makeCtx } from "./helpers/engine_ctx.js";

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, msg ?? `${a} !~ ${b}`);

const T0 = Date.parse("2026-01-05T14:30:00.000Z");
const FIVE_MIN = 5 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
function bar(i, open, high, low, close) {
  const openMs = T0 + i * FIVE_MIN;
  return { kind: "intraday", openMs, availableAt: iso(openMs + FIVE_MIN), open, high, low, close };
}

const LONG = { direction: "long", entryPrice: 100, stopLossPct: 0.05, takeProfitPct: 0.1 };
const SHORT = { direction: "short", entryPrice: 100, stopLossPct: 0.05, takeProfitPct: 0.1 };

// ---------------------------------------------------------------------------
// resolveTrailingConfig
// ---------------------------------------------------------------------------

test("resolveTrailingConfig: all knobs 0 / missing config / garbage = off (null)", () => {
  assert.equal(resolveTrailingConfig(null), null);
  assert.equal(resolveTrailingConfig({}), null);
  assert.equal(resolveTrailingConfig({ breakEvenTriggerR: 0, trailActivationR: 0, trailDistanceR: 0 }), null);
  assert.equal(resolveTrailingConfig({ breakEvenTriggerR: -1, trailActivationR: Number.NaN, trailDistanceR: "x" }), null);
});

test("resolveTrailingConfig: trailing needs BOTH activation and distance; break-even stands alone", () => {
  assert.equal(resolveTrailingConfig({ trailActivationR: 2 }), null);
  assert.equal(resolveTrailingConfig({ trailDistanceR: 1 }), null);
  const be = resolveTrailingConfig({ breakEvenTriggerR: 1, trailActivationR: 2 });
  assert.equal(be.breakEvenTriggerR, 1);
  assert.equal(be.trailActivationR, 0, "an activation without a distance is not a trail");
  assert.equal(be.trailDistanceR, 0);
  const both = resolveTrailingConfig({ trailActivationR: 2, trailDistanceR: 1, trailRemovesTarget: 1 });
  assert.equal(both.trailActivationR, 2);
  assert.equal(both.trailDistanceR, 1);
  assert.equal(both.trailRemovesTarget, true);
  assert.equal(resolveTrailingConfig({ breakEvenTriggerR: 1, trailRemovesTarget: 1 }).trailRemovesTarget, false, "no trail, nothing to remove the target for");
});

// ---------------------------------------------------------------------------
// ratchetedStop
// ---------------------------------------------------------------------------

test("ratchetedStop: off / uncomputable inputs return null (caller keeps the static stop)", () => {
  assert.equal(ratchetedStop({ ...LONG, peakPrice: 110 }, null), null);
  const t = resolveTrailingConfig({ breakEvenTriggerR: 1 });
  assert.equal(ratchetedStop({ ...LONG, direction: null }, t), null);
  assert.equal(ratchetedStop({ ...LONG, entryPrice: 0 }, t), null);
  assert.equal(ratchetedStop({ ...LONG, stopLossPct: 0 }, t), null);
});

test("ratchetedStop long: initial stop until the trigger, then break-even (net of costs), then the trail", () => {
  const t = resolveTrailingConfig({ breakEvenTriggerR: 1, trailActivationR: 2, trailDistanceR: 1, tradeCostBps: 10 });
  const c = t.costFraction;

  let r = ratchetedStop({ ...LONG, peakPrice: null }, t);
  near(r.level, 95);
  assert.equal(r.reason, CLOSE_REASON.STOP_LOSS);

  r = ratchetedStop({ ...LONG, peakPrice: 104.9 }, t); // just under 1R
  near(r.level, 95);
  assert.equal(r.reason, CLOSE_REASON.STOP_LOSS);

  r = ratchetedStop({ ...LONG, peakPrice: 106 }, t); // 1R reached, trail (2R) not yet active
  near(r.level, 100 * (1 + c));
  assert.equal(r.reason, CLOSE_REASON.BREAKEVEN_STOP);

  r = ratchetedStop({ ...LONG, peakPrice: 112 }, t); // 2.4R: trail = 112 * (1 - 0.05) = 106.4 beats break-even
  near(r.level, 106.4);
  assert.equal(r.reason, CLOSE_REASON.TRAILING_STOP);
});

test("ratchetedStop short mirrors long", () => {
  const t = resolveTrailingConfig({ breakEvenTriggerR: 1, trailActivationR: 2, trailDistanceR: 1, tradeCostBps: 10 });
  const c = t.costFraction;

  let r = ratchetedStop({ ...SHORT, peakPrice: null }, t);
  near(r.level, 105);
  assert.equal(r.reason, CLOSE_REASON.STOP_LOSS);

  r = ratchetedStop({ ...SHORT, peakPrice: 94 }, t);
  near(r.level, 100 * (1 - c));
  assert.equal(r.reason, CLOSE_REASON.BREAKEVEN_STOP);

  r = ratchetedStop({ ...SHORT, peakPrice: 88 }, t); // trail = 88 * 1.05 = 92.4
  near(r.level, 92.4);
  assert.equal(r.reason, CLOSE_REASON.TRAILING_STOP);
});

test("ratchetedStop never loosens the initial stop (a peak worse than entry is ignored)", () => {
  const t = resolveTrailingConfig({ breakEvenTriggerR: 1, trailActivationR: 2, trailDistanceR: 1 });
  near(ratchetedStop({ ...LONG, peakPrice: 90 }, t).level, 95);
  near(ratchetedStop({ ...SHORT, peakPrice: 110 }, t).level, 105);
});

test("betterPeak: direction-aware, null side loses", () => {
  assert.equal(betterPeak("long", 105, 110), 110);
  assert.equal(betterPeak("short", 95, 90), 90);
  assert.equal(betterPeak("long", null, 110), 110);
  assert.equal(betterPeak("long", 105, null), 105);
  assert.equal(betterPeak("long", null, null), null);
});

// ---------------------------------------------------------------------------
// walkBarsForExit with trailing
// ---------------------------------------------------------------------------

test("trailing off: walk is the static walk and the result has no peakPrice key", () => {
  const r = walkBarsForExit(LONG, [bar(0, 100, 106, 99, 105), bar(1, 105, 105, 99.5, 100)]);
  assert.equal(r.exit, null, "static 95 stop is never touched");
  assert.equal("peakPrice" in r, false);
});

test("NO LOOKAHEAD: a bar that spikes to a new high and falls back is judged by the level from before the bar", () => {
  const t = resolveTrailingConfig({ breakEvenTriggerR: 1 });
  // Bar spikes to 109 (1.8R, under the 110 target) and closes back at 100 with a low of 99. Break-even (~100)
  // would catch the low IF the spike's own peak counted; it must not, the bar is judged against the 95 stop.
  const r = walkBarsForExit(LONG, [bar(0, 100, 109, 99, 100)], { trailing: t });
  assert.equal(r.exit, null);
  assert.equal(r.peakPrice, 109, "the bar's own high is folded in only afterwards, for the next bar");
});

test("the NEXT bar is stopped at the break-even level the previous bar created", () => {
  const t = resolveTrailingConfig({ breakEvenTriggerR: 1, tradeCostBps: 10 });
  const c = t.costFraction;
  const r = walkBarsForExit(LONG, [bar(0, 100, 106, 99, 105), bar(1, 105, 105.5, 99.9, 100.2)], { trailing: t });
  assert.equal(r.exit.reason, CLOSE_REASON.BREAKEVEN_STOP);
  near(r.exit.exitPrice, 100 * (1 + c));
  assert.equal(r.exit.gapped, false);
});

test("a bar that opens beyond the ratcheted stop fills at the open (gap), peak carried in from the position", () => {
  const t = resolveTrailingConfig({ breakEvenTriggerR: 1 });
  const r = walkBarsForExit({ ...LONG, peakPrice: 106 }, [bar(0, 98, 99, 97, 98.5)], { trailing: t });
  assert.equal(r.exit.reason, CLOSE_REASON.BREAKEVEN_STOP);
  assert.equal(r.exit.exitPrice, 98);
  assert.equal(r.exit.gapped, true);
});

test("short: break-even stop from a persisted peak", () => {
  const t = resolveTrailingConfig({ breakEvenTriggerR: 1 });
  const r = walkBarsForExit({ ...SHORT, peakPrice: 94 }, [bar(0, 96, 100.5, 95, 99)], { trailing: t });
  assert.equal(r.exit.reason, CLOSE_REASON.BREAKEVEN_STOP);
  near(r.exit.exitPrice, 100); // level = entry * (1 - 0), cost 0 when tradeCostBps is absent
});

test("trailing stop exits with TRAILING_STOP at peak - distance", () => {
  const t = resolveTrailingConfig({ trailActivationR: 2, trailDistanceR: 1 });
  const r = walkBarsForExit({ ...LONG, takeProfitPct: 0.5, peakPrice: 112 }, [bar(0, 108, 109, 106, 107)], { trailing: t });
  assert.equal(r.exit.reason, CLOSE_REASON.TRAILING_STOP);
  near(r.exit.exitPrice, 106.4);
});

test("trailRemovesTarget: the take-profit is ignored once the trail binds; otherwise it still fires", () => {
  const bars = [bar(0, 104, 115, 103, 114)];
  const pos = { ...LONG, peakPrice: 108 }; // 1.6R: trail (1R activation) binds at 108 * 0.95 = 102.6
  const keep = walkBarsForExit(pos, bars, { trailing: resolveTrailingConfig({ trailActivationR: 1, trailDistanceR: 1 }) });
  assert.equal(keep.exit.reason, CLOSE_REASON.TAKE_PROFIT);
  near(keep.exit.exitPrice, 110);

  const run = walkBarsForExit(pos, bars, { trailing: resolveTrailingConfig({ trailActivationR: 1, trailDistanceR: 1, trailRemovesTarget: 1 }) });
  assert.equal(run.exit, null, "winner runs");
  assert.equal(run.peakPrice, 115);
});

test("peakPrice never worse than entry and not set on an exit", () => {
  const t = resolveTrailingConfig({ breakEvenTriggerR: 1 });
  const down = walkBarsForExit(LONG, [bar(0, 99, 99.5, 97, 98)], { trailing: t });
  assert.equal(down.peakPrice, 100, "baseline is entry, never a bar high below it");
  const stopped = walkBarsForExit(LONG, [bar(0, 100, 101, 94, 95)], { trailing: t });
  assert.equal(stopped.exit.reason, CLOSE_REASON.STOP_LOSS);
  assert.equal("peakPrice" in stopped, false);
});

// ---------------------------------------------------------------------------
// advancePositionCheck persists a monotone peak (real sqlite D1)
// ---------------------------------------------------------------------------

async function seed(store, direction) {
  const id = `${direction}|t1`;
  await store.openPosition({ id, ticker: "AAA", tradeThesisId: id, positionSizePct: 0.05, direction, entryPrice: 100, stopLossPct: 0.05, takeProfitPct: 0.1, openedAt: "2026-01-20T00:00:00.000Z" });
  return id;
}
const peakOf = async (store, id) => (await store.db.prepare(`SELECT peak_price FROM positions WHERE run_id = ? AND id = ?`).bind(store.runId, id).first()).peak_price;

test("advancePositionCheck: peak only improves (long = MAX, short = MIN); null leaves it alone", async () => {
  const { store } = makeCtx();
  const l = await seed(store, "long");
  assert.equal(await peakOf(store, l), null);
  await store.advancePositionCheck({ id: l, lastCheckedAt: "2026-01-21T00:00:00.000Z", lastPrice: 105, peakPrice: 108 });
  assert.equal(await peakOf(store, l), 108);
  await store.advancePositionCheck({ id: l, lastCheckedAt: "2026-01-22T00:00:00.000Z", lastPrice: 104, peakPrice: 103 });
  assert.equal(await peakOf(store, l), 108, "a lower peak can never loosen the ratchet");
  await store.advancePositionCheck({ id: l, lastCheckedAt: "2026-01-23T00:00:00.000Z", lastPrice: 104, peakPrice: null });
  assert.equal(await peakOf(store, l), 108, "null (trailing off) leaves the column alone");

  const s = await seed(store, "short");
  await store.advancePositionCheck({ id: s, lastCheckedAt: "2026-01-21T00:00:00.000Z", lastPrice: 96, peakPrice: 94 });
  await store.advancePositionCheck({ id: s, lastCheckedAt: "2026-01-22T00:00:00.000Z", lastPrice: 97, peakPrice: 99 });
  assert.equal(await peakOf(store, s), 94);
  await store.advancePositionCheck({ id: s, lastCheckedAt: "2026-01-23T00:00:00.000Z", lastPrice: 92, peakPrice: 90 });
  assert.equal(await peakOf(store, s), 90);
});

test("getOpenPositionsAsOf returns peakPrice (null until recorded)", async () => {
  const { store } = makeCtx();
  const id = await seed(store, "long");
  const asOf = "2026-02-01T00:00:00.000Z";
  assert.equal((await store.getOpenPositionsAsOf({ asOf }))[0].peakPrice, null);
  await store.advancePositionCheck({ id, lastCheckedAt: "2026-01-21T00:00:00.000Z", lastPrice: 105, peakPrice: 108 });
  assert.equal((await store.getOpenPositionsAsOf({ asOf }))[0].peakPrice, 108);
});
