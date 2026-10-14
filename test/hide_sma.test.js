// TEMPORARY backtest knob hideSma: the analyst-team prompt's technical snapshot drops the 5-day SMA fields.
import test from "node:test";
import assert from "node:assert/strict";
import { parseKnobOverrides, applyKnobOverrides, effectiveKnobs } from "../src/backtest/knobOverrides.js";
import { seedKnobMismatches, SEED_MATCH_KNOBS } from "../src/backtest/seedCheckpoints.js";
import { omitSmaFields } from "../src/agents/analysts/analystTeam.js";
import { computeTechnicalSnapshot } from "../src/agents/analysts/technicalIndicators.js";

test("hideSma: 0/1 override -> boolean knob, default OFF, bad values rejected", () => {
  const { overrides } = parseKnobOverrides((n) => ({ hideSma: "1" })[n]);
  assert.deepEqual(overrides, { hideSma: 1 });
  assert.equal(effectiveKnobs(applyKnobOverrides({}, overrides)).hideSma, true);
  assert.equal(effectiveKnobs({}).hideSma, false);
  assert.ok(parseKnobOverrides((n) => ({ hideSma: "2" })[n]).error);
});

test("hideSma: is a seed-match knob (a seeded run would otherwise reuse prompts that still showed the SMA)", () => {
  assert.ok(SEED_MATCH_KNOBS.includes("hideSma"));
  assert.deepEqual(seedKnobMismatches({}, { hideSma: true }), ["hideSma"]);
  assert.deepEqual(seedKnobMismatches({ hideSma: false }, { hideSma: false }), []);
  assert.deepEqual(seedKnobMismatches({ hideSma: true }, { hideSma: true }), []);
});

test("omitSmaFields: drops sma / smaWindow / smaBasis and keeps the other fields", () => {
  const bars = Array.from({ length: 8 }, (_, i) => ({ date: `2026-10-0${8 - i}`, close: 100 + i, volume: 10 }));
  const snapshot = computeTechnicalSnapshot(bars);
  assert.ok("sma" in snapshot && "smaWindow" in snapshot);
  const trimmed = omitSmaFields(snapshot);
  assert.ok(!("sma" in trimmed) && !("smaWindow" in trimmed) && !("smaBasis" in trimmed));
  assert.equal(trimmed.latestClose, snapshot.latestClose);
  assert.equal(trimmed.priceChangePct, snapshot.priceChangePct);
  assert.equal(trimmed.volumeRatio, snapshot.volumeRatio);
  assert.ok("sma" in snapshot, "the input is not mutated");
});
