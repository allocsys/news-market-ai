// Per-run backtest knob overrides (backtest/knobOverrides.js): request-param
// parsing (allowlist, blank = default, invalid = error), applying onto a config
// without mutating it, and the effective-knob record stored in a run's result.

import test from "node:test";
import assert from "node:assert/strict";
import {
  KNOB_OVERRIDES,
  parseKnobOverrides,
  applyKnobOverrides,
  effectiveKnobs,
} from "../src/backtest/knobOverrides.js";
import { DEFAULT_FLIP_MIN_CONFIDENCE } from "../src/shared/constants.js";

const from = (obj) => (name) => (Object.prototype.hasOwnProperty.call(obj, name) ? obj[name] : null);

// ---------------------------------------------------------------------------
// parseKnobOverrides
// ---------------------------------------------------------------------------

test("parse: nothing given -> empty overrides", () => {
  assert.deepEqual(parseKnobOverrides(from({})), { overrides: {} });
});

test("parse: valid values become numbers", () => {
  const r = parseKnobOverrides(from({
    tradeCostBps: "7.5",
    drawdownBreakerPct: "0.03",
    drawdownBreakerWindowDays: "21",
    splitGuardTolerance: "0.1",
    flipMinConfidence: "0.8",
  }));
  assert.deepEqual(r, {
    overrides: { tradeCostBps: 7.5, drawdownBreakerPct: 0.03, drawdownBreakerWindowDays: 21, splitGuardTolerance: 0.1, flipMinConfidence: 0.8 },
  });
});

test("parse: blank, whitespace, null and undefined are ignored (use the default)", () => {
  const get = (name) => ({ tradeCostBps: "", drawdownBreakerPct: "   ", splitGuardTolerance: null, flipMinConfidence: undefined }[name]);
  assert.deepEqual(parseKnobOverrides(get), { overrides: {} });
});

test("parse: 0 is a real value, not blank (disables a breaker / guard)", () => {
  const r = parseKnobOverrides(from({ drawdownBreakerPct: "0", splitGuardTolerance: "0", flipMinConfidence: "0" }));
  assert.deepEqual(r, { overrides: { drawdownBreakerPct: 0, splitGuardTolerance: 0, flipMinConfidence: 0 } });
});

test("parse: non-numeric is an error naming the param", () => {
  const r = parseKnobOverrides(from({ tradeCostBps: "abc" }));
  assert.ok(r.error?.includes("tradeCostBps"), r.error);
  assert.equal(r.overrides, undefined);
});

test("parse: Infinity / NaN are rejected", () => {
  assert.ok(parseKnobOverrides(from({ tradeCostBps: "Infinity" })).error);
  assert.ok(parseKnobOverrides(from({ tradeCostBps: "NaN" })).error);
});

test("parse: out-of-range is an error (both ends, inclusive bounds accepted)", () => {
  assert.ok(parseKnobOverrides(from({ drawdownBreakerPct: "-0.01" })).error);
  assert.ok(parseKnobOverrides(from({ drawdownBreakerPct: "1.01" })).error);
  assert.ok(parseKnobOverrides(from({ tradeCostBps: "1000.5" })).error);
  assert.deepEqual(parseKnobOverrides(from({ drawdownBreakerPct: "1" })), { overrides: { drawdownBreakerPct: 1 } });
  assert.deepEqual(parseKnobOverrides(from({ tradeCostBps: "1000" })), { overrides: { tradeCostBps: 1000 } });
});

test("parse: window days must be a whole number within 1..365", () => {
  assert.ok(parseKnobOverrides(from({ drawdownBreakerWindowDays: "14.5" })).error);
  assert.ok(parseKnobOverrides(from({ drawdownBreakerWindowDays: "0" })).error);
  assert.ok(parseKnobOverrides(from({ drawdownBreakerWindowDays: "366" })).error);
  assert.deepEqual(parseKnobOverrides(from({ drawdownBreakerWindowDays: "365" })), { overrides: { drawdownBreakerWindowDays: 365 } });
});

test("parse: one bad value fails the whole request even if others are valid", () => {
  const r = parseKnobOverrides(from({ tradeCostBps: "5", flipMinConfidence: "2" }));
  assert.ok(r.error?.includes("flipMinConfidence"), r.error);
});

test("parse: only allowlisted names are read (other config keys cannot be set)", () => {
  const seen = [];
  parseKnobOverrides((name) => { seen.push(name); return null; });
  assert.deepEqual(seen.sort(), Object.keys(KNOB_OVERRIDES).sort());
  assert.deepEqual(parseKnobOverrides(from({ geminiApiKey: "x", maxPositionHoldDays: "3" })), { overrides: {} });
});

// ---------------------------------------------------------------------------
// applyKnobOverrides
// ---------------------------------------------------------------------------

test("apply: nothing to apply returns the very same config object", () => {
  const config = { tradeCostBps: 5 };
  assert.equal(applyKnobOverrides(config, undefined), config);
  assert.equal(applyKnobOverrides(config, null), config);
  assert.equal(applyKnobOverrides(config, {}), config);
});

test("apply: returns a NEW config with overrides layered on, leaving the input untouched", () => {
  const config = { tradeCostBps: 5, drawdownBreakerPct: 0.02, other: "keep" };
  const out = applyKnobOverrides(config, { tradeCostBps: 12 });
  assert.notEqual(out, config);
  assert.deepEqual(out, { tradeCostBps: 12, drawdownBreakerPct: 0.02, other: "keep" });
  assert.deepEqual(config, { tradeCostBps: 5, drawdownBreakerPct: 0.02, other: "keep" });
});

test("apply: unknown keys and non-finite values in the queue message are ignored", () => {
  const config = { tradeCostBps: 5, geminiApiKey: "secret" };
  assert.equal(applyKnobOverrides(config, { geminiApiKey: "hijack", tradeCostBps: Number.NaN }), config);
  const out = applyKnobOverrides(config, { geminiApiKey: "hijack", tradeCostBps: 9 });
  assert.deepEqual(out, { tradeCostBps: 9, geminiApiKey: "secret" });
});

test("apply: an override of 0 is applied, not treated as unset", () => {
  const out = applyKnobOverrides({ drawdownBreakerPct: 0.02 }, { drawdownBreakerPct: 0 });
  assert.equal(out.drawdownBreakerPct, 0);
});

// ---------------------------------------------------------------------------
// effectiveKnobs
// ---------------------------------------------------------------------------

test("effective: reports every knob from the config", () => {
  const knobs = effectiveKnobs({
    tradeCostBps: 5,
    drawdownBreakerPct: 0.02,
    drawdownBreakerWindowDays: 14,
    splitGuardTolerance: 0.05,
    flipMinConfidence: 0.7,
  });
  assert.deepEqual(knobs, {
    tradeCostBps: 5,
    drawdownBreakerPct: 0.02,
    drawdownBreakerWindowDays: 14,
    splitGuardTolerance: 0.05,
    flipMinConfidence: 0.7,
  });
});

test("effective: unset flipMinConfidence resolves to the constants.js default", () => {
  assert.equal(effectiveKnobs({}).flipMinConfidence, DEFAULT_FLIP_MIN_CONFIDENCE);
  assert.equal(effectiveKnobs({ flipMinConfidence: undefined }).flipMinConfidence, DEFAULT_FLIP_MIN_CONFIDENCE);
});

test("effective: flipMinConfidence 0 is kept (always flip), not replaced by the default", () => {
  assert.equal(effectiveKnobs({ flipMinConfidence: 0 }).flipMinConfidence, 0);
});

test("effective: a key a hand-built config lacks is null", () => {
  const knobs = effectiveKnobs({});
  assert.equal(knobs.tradeCostBps, null);
  assert.equal(knobs.drawdownBreakerPct, null);
  assert.equal(knobs.drawdownBreakerWindowDays, null);
  assert.equal(knobs.splitGuardTolerance, null);
});

test("effective: reflects overrides applied to a config", () => {
  const config = { tradeCostBps: 5, drawdownBreakerPct: 0.02, drawdownBreakerWindowDays: 14, splitGuardTolerance: 0.05 };
  const knobs = effectiveKnobs(applyKnobOverrides(config, { drawdownBreakerPct: 0.04 }));
  assert.equal(knobs.drawdownBreakerPct, 0.04);
  assert.equal(knobs.tradeCostBps, 5);
});
