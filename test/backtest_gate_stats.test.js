// Per-trade rollout-gate stats (backtest/gateStats.js): pure, no D1.

import test from "node:test";
import assert from "node:assert/strict";
import { computeGateStats, GATE_Z_ONE_SIDED_95 } from "../src/backtest/gateStats.js";

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

const T = (direction, entryPrice, exitPrice, closedAt = "2026-09-10T00:00:00Z") => ({ direction, entryPrice, exitPrice, closedAt });

test("computeGateStats: n, mean, sample SD, SE and the one-sided lower bound", () => {
  const g = computeGateStats([T("long", 100, 110), T("long", 100, 90), T("long", 100, 105)]);
  assert.equal(g.n, 3);
  close(g.mean, 0.05 / 3);
  close(g.sd, Math.sqrt(0.0216666666667 / 2), 1e-6);
  close(g.se, g.sd / Math.sqrt(3));
  close(g.lowerBound, g.mean - GATE_Z_ONE_SIDED_95 * g.se);
  close(g.winRate, 2 / 3);
  assert.equal(g.openAtEnd, 0);
  assert.equal(g.unreplayable, 0);
});

test("computeGateStats: shorts are direction-aware and costs are netted (one entry + one exit)", () => {
  const g = computeGateStats([T("short", 100, 90)], { costBps: 10 });
  assert.equal(g.n, 1);
  close(g.mean, 0.1 - 0.002); // gross +10% minus 2 * 10bps
  assert.equal(g.se, null); // n < 2: undefined, not 0
  assert.equal(g.lowerBound, null);
});

test("computeGateStats: open trades are counted as openAtEnd, not in n; unpriced closes are unreplayable", () => {
  const g = computeGateStats([T("long", 100, 110), { direction: "long", entryPrice: 100, exitPrice: null, closedAt: null }, T("long", 100, null)]);
  assert.equal(g.n, 1);
  assert.equal(g.openAtEnd, 1);
  assert.equal(g.unreplayable, 1);
});

test("computeGateStats: no trades gives null stats (a thin sample can never read as a pass)", () => {
  const g = computeGateStats([]);
  assert.equal(g.n, 0);
  assert.equal(g.mean, null);
  assert.equal(g.lowerBound, null);
  assert.equal(g.winRate, null);
  assert.equal(computeGateStats(undefined).n, 0);
});
