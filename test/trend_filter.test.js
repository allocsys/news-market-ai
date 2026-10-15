// agents/risk_mgmt/trend_filter.js: the pure trend filter (knobs trendFilterAgainst / trendFilterMixed, default OFF).

import test from "node:test";
import assert from "node:assert/strict";
import { trendFilterParams, trendFilterActive, evaluateTrendFilter } from "../src/agents/risk_mgmt/trend_filter.js";

test("trendFilterParams / trendFilterActive: missing or non-true keys mean OFF", () => {
  assert.deepEqual(trendFilterParams({}), { against: false, mixed: false });
  assert.deepEqual(trendFilterParams(undefined), { against: false, mixed: false });
  assert.deepEqual(trendFilterParams({ trendFilterAgainst: 1, trendFilterMixed: "true" }), { against: false, mixed: false });
  assert.deepEqual(trendFilterParams({ trendFilterAgainst: true }), { against: true, mixed: false });
  assert.equal(trendFilterActive({}), false);
  assert.equal(trendFilterActive({ trendFilterMixed: true }), true);
});

test("evaluateTrendFilter: 'against' is blocked only when against is selected", () => {
  const on = evaluateTrendFilter({ alignment: "against", blockAgainst: true });
  assert.deepEqual([on.applied, on.blocked], [true, true]);
  assert.match(on.reason, /^trend filter: entry is against the trend$/);
  const off = evaluateTrendFilter({ alignment: "against", blockMixed: true });
  assert.deepEqual([off.applied, off.blocked], [true, false]);
});

test("evaluateTrendFilter: 'mixed' is blocked only when mixed is selected", () => {
  assert.equal(evaluateTrendFilter({ alignment: "mixed", blockMixed: true }).blocked, true);
  assert.equal(evaluateTrendFilter({ alignment: "mixed", blockAgainst: true }).blocked, false);
});

test("evaluateTrendFilter: both selected blocks against and mixed, never 'with'", () => {
  const both = { blockAgainst: true, blockMixed: true };
  assert.equal(evaluateTrendFilter({ alignment: "against", ...both }).blocked, true);
  assert.equal(evaluateTrendFilter({ alignment: "mixed", ...both }).blocked, true);
  const withTrend = evaluateTrendFilter({ alignment: "with", ...both });
  assert.deepEqual([withTrend.applied, withTrend.blocked], [true, false]);
  assert.match(withTrend.reason, /^trend filter passed \(with\)$/);
});

test("evaluateTrendFilter: nothing selected or nothing to judge never blocks and never throws", () => {
  const none = evaluateTrendFilter({ alignment: "against" });
  assert.deepEqual([none.applied, none.blocked], [false, false]);
  for (const alignment of ["unknown", null, undefined, 5, "bogus"]) {
    const out = evaluateTrendFilter({ alignment, blockAgainst: true, blockMixed: true });
    assert.deepEqual([out.applied, out.blocked], [false, false], String(alignment));
  }
  assert.equal(evaluateTrendFilter().blocked, false);
  assert.equal(evaluateTrendFilter({}).blocked, false);
});
