// Bar-based exit evaluation (agents/risk_mgmt/exit_bars.js). Pure functions, so
// no DB: bars are built by hand. Levels used throughout (entry 100):
//   long : stop 95 (sl 5%), target 110 (tp 10%)
//   short: stop 105,        target 90
// Level arithmetic is floating point, so prices are compared with a tiny epsilon.

import test from "node:test";
import assert from "node:assert/strict";
import { exitLevels, walkBarsForExit } from "../src/agents/risk_mgmt/exit_bars.js";

const EPS = 1e-9;
const near = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < EPS, msg ?? `${actual} !~ ${expected}`);

const T0 = Date.parse("2026-01-05T14:30:00.000Z");
const FIVE_MIN = 5 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

/** The i-th consecutive 5-minute bar: opens at T0 + i*5min, fully closed (available) 5 minutes later. */
function bar(i, open, high, low, close, extra = {}) {
  const openMs = T0 + i * FIVE_MIN;
  return { kind: "intraday", openMs, availableAt: iso(openMs + FIVE_MIN), open, high, low, close, ...extra };
}

const LONG = { direction: "long", entryPrice: 100, stopLossPct: 0.05, takeProfitPct: 0.1 };
const SHORT = { direction: "short", entryPrice: 100, stopLossPct: 0.05, takeProfitPct: 0.1 };

const EMPTY = { exit: null, maePct: null, mfePct: null, lastBarAvailableAt: null, barsWalked: 0, invalidBars: 0, split: null };

// ---------------------------------------------------------------------------
// exitLevels
// ---------------------------------------------------------------------------

test("exitLevels: long stop below / target above, short the mirror image", () => {
  const long = exitLevels(LONG);
  near(long.stop, 95);
  near(long.target, 110);
  const short = exitLevels(SHORT);
  near(short.stop, 105);
  near(short.target, 90);
});

test("exitLevels: a missing pct nulls that side only; bad direction or entry price gives null", () => {
  const noStop = exitLevels({ ...LONG, stopLossPct: null });
  assert.equal(noStop.stop, null);
  near(noStop.target, 110);
  const noTarget = exitLevels({ ...LONG, takeProfitPct: undefined });
  near(noTarget.stop, 95);
  assert.equal(noTarget.target, null);
  assert.equal(exitLevels({ ...LONG, direction: null }), null);
  assert.equal(exitLevels({ ...LONG, direction: "flat" }), null);
  assert.equal(exitLevels({ ...LONG, entryPrice: 0 }), null);
  assert.equal(exitLevels({ ...LONG, entryPrice: -5 }), null);
  assert.equal(exitLevels({ ...LONG, entryPrice: null }), null);
  assert.equal(exitLevels({ ...LONG, entryPrice: NaN }), null);
});

// ---------------------------------------------------------------------------
// Touches: stop / target, both directions
// ---------------------------------------------------------------------------

test("long: an intrabar LOW through the stop is a stop-loss filled at the stop level, closedAt = that bar's close time", () => {
  const b0 = bar(0, 100, 101, 99, 100.5);
  const b1 = bar(1, 100, 100.5, 94, 96); // low 94 <= 95, close 96 is back above the stop
  const b2 = bar(2, 96, 97, 95.5, 96.5); // must never be reached
  const r = walkBarsForExit(LONG, [b0, b1, b2]);

  assert.equal(r.exit.reason, "stop_loss");
  near(r.exit.exitPrice, 95);
  assert.equal(r.exit.closedAt, b1.availableAt);
  assert.equal(r.exit.gapped, false);
  assert.equal(r.exit.barKind, "intraday");
  assert.equal(r.exit.barOpenMs, b1.openMs);
  assert.equal(r.barsWalked, 2);
  assert.equal(r.lastBarAvailableAt, b1.availableAt);
  near(r.maePct, -0.06); // (94 - 100) / 100, the triggering bar counts
  near(r.mfePct, 0.01); // best high seen was 101
});

test("long: an intrabar HIGH through the target is a take-profit filled at the target level", () => {
  const b0 = bar(0, 100, 111, 99.5, 105);
  const r = walkBarsForExit(LONG, [b0]);

  assert.equal(r.exit.reason, "take_profit");
  near(r.exit.exitPrice, 110);
  assert.equal(r.exit.closedAt, b0.availableAt);
  assert.equal(r.exit.gapped, false);
  near(r.mfePct, 0.11);
  near(r.maePct, -0.005);
});

test("short: an intrabar HIGH through the stop and an intrabar LOW through the target", () => {
  const stopBar = bar(0, 100, 106, 99, 101);
  const stop = walkBarsForExit(SHORT, [stopBar]);
  assert.equal(stop.exit.reason, "stop_loss");
  near(stop.exit.exitPrice, 105);
  near(stop.maePct, -0.06); // adverse for a short = the high: (100 - 106) / 100
  near(stop.mfePct, 0.01); // favorable = the low: (100 - 99) / 100

  const targetBar = bar(0, 100, 101, 89, 95);
  const target = walkBarsForExit(SHORT, [targetBar]);
  assert.equal(target.exit.reason, "take_profit");
  near(target.exit.exitPrice, 90);
  near(target.mfePct, 0.11);
  near(target.maePct, -0.01);
});

test("a bar that touches BOTH levels resolves as the stop (long and short)", () => {
  const long = walkBarsForExit(LONG, [bar(0, 100, 112, 94, 100)]);
  assert.equal(long.exit.reason, "stop_loss");
  near(long.exit.exitPrice, 95);

  const short = walkBarsForExit(SHORT, [bar(0, 100, 106, 88, 100)]);
  assert.equal(short.exit.reason, "stop_loss");
  near(short.exit.exitPrice, 105);
});

test("across bars the EARLIER touch wins, even when the later bar touches the stop", () => {
  const b0 = bar(0, 100, 111, 99, 108); // target first
  const b1 = bar(1, 108, 109, 90, 92); // stop later
  const r = walkBarsForExit(LONG, [b0, b1]);
  assert.equal(r.exit.reason, "take_profit");
  assert.equal(r.exit.closedAt, b0.availableAt);
  assert.equal(r.barsWalked, 1);
  near(r.maePct, -0.01); // b1 never counted

  const reverse = walkBarsForExit(LONG, [bar(0, 100, 101, 94, 96), bar(1, 96, 115, 95, 112)]);
  assert.equal(reverse.exit.reason, "stop_loss"); // stop first, target never reached
});

test("a missing stop or target pct only evaluates the side that exists", () => {
  const crash = bar(0, 100, 101, 50, 60);
  const noStop = walkBarsForExit({ ...LONG, stopLossPct: null }, [crash]);
  assert.equal(noStop.exit, null);
  near(noStop.maePct, -0.5);

  const noTarget = walkBarsForExit({ ...LONG, takeProfitPct: null }, [bar(0, 100, 150, 99, 140)]);
  assert.equal(noTarget.exit, null);
  near(noTarget.mfePct, 0.5);
});

test("no touch: no exit, MAE/MFE over every bar, cursor target = the last bar", () => {
  const bars = [bar(0, 100, 102, 99, 101), bar(1, 101, 104, 98, 100), bar(2, 100, 103, 97, 99)];
  const r = walkBarsForExit(LONG, bars);
  assert.equal(r.exit, null);
  assert.equal(r.barsWalked, 3);
  assert.equal(r.invalidBars, 0);
  assert.equal(r.split, null);
  assert.equal(r.lastBarAvailableAt, bars[2].availableAt);
  near(r.maePct, -0.03); // lowest low 97
  near(r.mfePct, 0.04); // highest high 104
});

// ---------------------------------------------------------------------------
// Gap fills
// ---------------------------------------------------------------------------

test("gap fills: a bar that OPENS beyond a level fills at the open, not the level", () => {
  // Long stop 95, opens at 92 (worse than the stop).
  const longStop = walkBarsForExit(LONG, [bar(0, 92, 93, 90, 91)]);
  assert.equal(longStop.exit.reason, "stop_loss");
  near(longStop.exit.exitPrice, 92);
  assert.equal(longStop.exit.gapped, true);

  // Long target 110, opens at 115 (better than the target).
  const longTarget = walkBarsForExit(LONG, [bar(0, 115, 118, 114, 116)]);
  assert.equal(longTarget.exit.reason, "take_profit");
  near(longTarget.exit.exitPrice, 115);
  assert.equal(longTarget.exit.gapped, true);

  // Short stop 105, opens at 108.
  const shortStop = walkBarsForExit(SHORT, [bar(0, 108, 110, 107, 109)]);
  assert.equal(shortStop.exit.reason, "stop_loss");
  near(shortStop.exit.exitPrice, 108);
  assert.equal(shortStop.exit.gapped, true);

  // Short target 90, opens at 85.
  const shortTarget = walkBarsForExit(SHORT, [bar(0, 85, 86, 84, 85.5)]);
  assert.equal(shortTarget.exit.reason, "take_profit");
  near(shortTarget.exit.exitPrice, 85);
  assert.equal(shortTarget.exit.gapped, true);
});

test("a bar that opens INSIDE the levels and trades through one is not a gap", () => {
  const r = walkBarsForExit(LONG, [bar(0, 96, 97, 93, 94)]); // opens above stop 95, low 93 crosses it
  assert.equal(r.exit.reason, "stop_loss");
  near(r.exit.exitPrice, 95);
  assert.equal(r.exit.gapped, false);
});

// ---------------------------------------------------------------------------
// Daily bars, kinds
// ---------------------------------------------------------------------------

test("daily bars use the same rules and report their kind", () => {
  const daily = { kind: "daily", openMs: Date.parse("2026-01-05T00:00:00Z"), availableAt: "2026-01-06T00:00:00.000Z", open: 100, high: 104, low: 94, close: 97 };
  const r = walkBarsForExit(LONG, [daily]);
  assert.equal(r.exit.reason, "stop_loss");
  near(r.exit.exitPrice, 95);
  assert.equal(r.exit.barKind, "daily");
  assert.equal(r.exit.closedAt, "2026-01-06T00:00:00.000Z");
});

test("daily and intraday bars can be mixed in one sequence, oldest first", () => {
  const daily = { kind: "daily", openMs: Date.parse("2026-01-02T00:00:00Z"), availableAt: "2026-01-03T00:00:00.000Z", open: 100, high: 103, low: 98, close: 101 };
  const intraday = bar(0, 101, 102, 94, 96);
  const r = walkBarsForExit(LONG, [daily, intraday]);
  assert.equal(r.exit.reason, "stop_loss");
  assert.equal(r.exit.barKind, "intraday");
  assert.equal(r.barsWalked, 2);
});

// ---------------------------------------------------------------------------
// Invalid bars
// ---------------------------------------------------------------------------

test("invalid bars are skipped (never fabricated into a price) but still advance the cursor", () => {
  const nan = bar(0, 100, NaN, 99, 100);
  const inverted = bar(1, 100, 98, 102, 100); // high < low
  const ok = bar(2, 100, 101, 99, 100);
  const r = walkBarsForExit(LONG, [nan, inverted, ok]);
  assert.equal(r.exit, null);
  assert.equal(r.invalidBars, 2);
  assert.equal(r.barsWalked, 3);
  assert.equal(r.lastBarAvailableAt, ok.availableAt);
  near(r.maePct, -0.01);
});

test("only invalid bars: no MAE/MFE, no exit, but the cursor target still moves", () => {
  const nan = bar(0, NaN, NaN, NaN, NaN);
  const r = walkBarsForExit(LONG, [nan]);
  assert.equal(r.exit, null);
  assert.equal(r.maePct, null);
  assert.equal(r.mfePct, null);
  assert.equal(r.invalidBars, 1);
  assert.equal(r.barsWalked, 1);
  assert.equal(r.lastBarAvailableAt, nan.availableAt);
});

test("an invalid bar cannot trigger an exit even when its other fields cross a level", () => {
  const r = walkBarsForExit(LONG, [bar(0, 100, NaN, 50, 60)]);
  assert.equal(r.exit, null);
  assert.equal(r.invalidBars, 1);
});

// ---------------------------------------------------------------------------
// Split guard
// ---------------------------------------------------------------------------

test("split guard: the walk stops BEFORE the split bar; clean bars still count, the cursor target stays on the last clean bar", () => {
  const clean = bar(0, 100, 102, 99, 101);
  const split = bar(1, 50, 51, 49, 50); // 100 -> 50: 2-for-1
  const after = bar(2, 50, 51, 49, 50);
  const r = walkBarsForExit(LONG, [clean, split, after], { splitGuardTolerance: 0.05 });

  assert.equal(r.exit, null);
  assert.equal(r.split.kind, "split");
  assert.equal(r.split.factor, 2);
  assert.equal(r.split.barKind, "intraday");
  assert.equal(r.split.barOpenMs, split.openMs);
  assert.equal(r.barsWalked, 1);
  assert.equal(r.lastBarAvailableAt, clean.availableAt);
  near(r.maePct, -0.01); // the split bar's 49 low was NOT counted
  near(r.mfePct, 0.02);
});

test("split guard: a suspicious CLOSE alone (open looks normal) also trips it, and reverse splits are caught", () => {
  const closeOnly = walkBarsForExit(LONG, [bar(0, 100, 101, 49, 50)], { splitGuardTolerance: 0.05 });
  assert.equal(closeOnly.split.kind, "split");
  assert.equal(closeOnly.exit, null);
  assert.equal(closeOnly.barsWalked, 0);
  assert.equal(closeOnly.lastBarAvailableAt, null);

  const reverse = walkBarsForExit({ ...LONG, entryPrice: 50, stopLossPct: 0.05, takeProfitPct: 0.1 }, [bar(0, 100, 101, 99, 100)], {
    splitGuardTolerance: 0.05,
  });
  assert.equal(reverse.split.kind, "reverse_split");
  assert.equal(reverse.split.factor, 2);
  assert.equal(reverse.exit, null);
});

test("split guard: a real stop that happens BEFORE the split bar is still returned", () => {
  const stop = bar(0, 100, 101, 94, 96);
  const split = bar(1, 50, 51, 49, 50);
  const r = walkBarsForExit(LONG, [stop, split], { splitGuardTolerance: 0.05 });
  assert.equal(r.exit.reason, "stop_loss");
  assert.equal(r.split, null);
});

test("split guard disabled (tolerance 0 or absent): the same bar is a plain gap stop at the raw open", () => {
  for (const opts of [{ splitGuardTolerance: 0 }, {}, undefined]) {
    const r = walkBarsForExit(LONG, [bar(0, 50, 51, 49, 50)], opts);
    assert.equal(r.split, null);
    assert.equal(r.exit.reason, "stop_loss");
    near(r.exit.exitPrice, 50);
    assert.equal(r.exit.gapped, true);
  }
});

test("an ordinary -8% gap is not mistaken for a split with the guard on", () => {
  const r = walkBarsForExit(LONG, [bar(0, 92, 93, 90, 91)], { splitGuardTolerance: 0.05 });
  assert.equal(r.split, null);
  assert.equal(r.exit.reason, "stop_loss");
});

// ---------------------------------------------------------------------------
// Degenerate input
// ---------------------------------------------------------------------------

test("no computable levels, no bars, or a non-array yield the empty result", () => {
  assert.deepEqual(walkBarsForExit({ ...LONG, direction: null }, [bar(0, 100, 101, 99, 100)]), EMPTY);
  assert.deepEqual(walkBarsForExit({ ...LONG, entryPrice: 0 }, [bar(0, 100, 101, 99, 100)]), EMPTY);
  assert.deepEqual(walkBarsForExit(LONG, []), EMPTY);
  assert.deepEqual(walkBarsForExit(LONG, null), EMPTY);
  assert.deepEqual(walkBarsForExit(LONG, undefined), EMPTY);
});
