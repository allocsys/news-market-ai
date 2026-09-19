// memory_pointintime test (plan.md open item, mirrors TradingAgents' test
// naming and backtest.leakcheck.test.js's leak-check style). Covers
// Backtesting Integrity point 4: the reflection/memory loop is the easiest
// place to leak the future into a backtest, since it depends on a REALIZED
// outcome. Exercises RunStore#getDecisionMemoryAsOf's enforced cutoff
// AND agents/utils/memory.js#fetchPriorLessons's use of it. M2: runs against
// a REAL sqlite state DB through RunStore (storage/run_store.js#
// getDecisionMemoryAsOf / recordDecisionOutcome), replacing the hand-rolled
// FakeMemoryDb -- every assertion is kept, now proven against the real SQL
// (the strictly-before "<" cutoff, the ORDER BY, ON CONFLICT DO NOTHING).

import test from "node:test";
import assert from "node:assert/strict";
import { fetchPriorLessons, recordAndReflect } from "../src/agents/utils/memory.js";
import { LookaheadViolationError } from "../src/shared/errors.js";
import { makeCtx, stateRows } from "./helpers/engine_ctx.js";

/**
 * A live RunStore over a real sqlite state DB, with `rows` inserted straight
 * into decision_memory (raw SQL, run_id 'live') so each test controls the
 * exact resolved_at values the point-in-time cutoff is checked against.
 */
async function memoryStore(rows) {
  const ctx = makeCtx();
  for (const r of rows) {
    await ctx.stateDb
      .prepare(`INSERT INTO decision_memory (run_id, id, decision_id, ticker, realized_return, alpha_return, reflection, resolved_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind("live", r.id, r.decision_id, r.ticker, r.realized_return, r.alpha_return, r.reflection, r.resolved_at, r.resolved_at)
      .run();
  }
  return ctx;
}

const SAMPLE_ROWS = [
  { id: "d1", decision_id: "dec-1", ticker: "AAPL", realized_return: 0.02, alpha_return: 0.01, reflection: "sized in too early", resolved_at: "2026-01-01T00:00:00Z" },
  { id: "d2", decision_id: "dec-2", ticker: "AAPL", realized_return: -0.01, alpha_return: -0.02, reflection: "ignored bear case, shouldn't have", resolved_at: "2026-01-10T00:00:00Z" },
  { id: "d3", decision_id: "dec-3", ticker: "AAPL", realized_return: 0.05, alpha_return: 0.03, reflection: "FUTURE LEAK -- must never appear before 2026-02-01", resolved_at: "2026-02-01T00:00:00Z" },
  { id: "d4", decision_id: "dec-4", ticker: "MSFT", realized_return: 0.01, alpha_return: 0.0, reflection: "different ticker, must not cross-contaminate", resolved_at: "2026-01-05T00:00:00Z" },
];

test("getDecisionMemoryAsOf throws LookaheadViolationError when asOf is omitted", async () => {
  const { store, stateDb } = await memoryStore(SAMPLE_ROWS);
  await assert.rejects(() => store.getDecisionMemoryAsOf({ ticker: "AAPL" }), LookaheadViolationError);
});

test("getDecisionMemoryAsOf returns only rows strictly before asOf", async () => {
  const { store, stateDb } = await memoryStore(SAMPLE_ROWS);
  const results = await store.getDecisionMemoryAsOf({ ticker: "AAPL", asOf: "2026-01-15T00:00:00Z" });

  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.resolved_at < "2026-01-15T00:00:00Z"));
  assert.ok(!results.some((r) => r.id === "d3")); // the future row must never appear
});

test("getDecisionMemoryAsOf excludes a row resolved EXACTLY at asOf (strictly before, not at-or-before)", async () => {
  const { store, stateDb } = await memoryStore(SAMPLE_ROWS);
  const results = await store.getDecisionMemoryAsOf({ ticker: "AAPL", asOf: "2026-02-01T00:00:00Z" });

  assert.ok(!results.some((r) => r.id === "d3")); // resolved_at === asOf must not count as "already known"
});

test("getDecisionMemoryAsOf orders most-recent-first and respects limit", async () => {
  const { store, stateDb } = await memoryStore(SAMPLE_ROWS);
  const results = await store.getDecisionMemoryAsOf({ ticker: "AAPL", asOf: "2026-01-15T00:00:00Z", limit: 1 });

  assert.equal(results.length, 1);
  assert.equal(results[0].id, "d2"); // most recent of the two eligible AAPL rows (d3 is not yet resolved as of Jan 15)
});

test("getDecisionMemoryAsOf never mixes another ticker's history in", async () => {
  const { store, stateDb } = await memoryStore(SAMPLE_ROWS);
  const results = await store.getDecisionMemoryAsOf({ ticker: "AAPL", asOf: "2026-03-01T00:00:00Z" });

  assert.ok(!results.some((r) => r.ticker === "MSFT"));
});

test("fetchPriorLessons returns '' with no history, never null/undefined", async () => {
  const { store, stateDb } = await memoryStore(SAMPLE_ROWS);
  const lessons = await fetchPriorLessons(store, { ticker: "TSLA", asOf: "2026-01-15T00:00:00Z" }); // no TSLA rows at all
  assert.equal(lessons, "");
});

test("fetchPriorLessons's formatted prompt text never contains a future reflection", async () => {
  const { store, stateDb } = await memoryStore(SAMPLE_ROWS);
  const lessons = await fetchPriorLessons(store, { ticker: "AAPL", asOf: "2026-01-15T00:00:00Z" });

  assert.ok(lessons.includes("sized in too early"));
  assert.ok(lessons.includes("ignored bear case"));
  assert.ok(!lessons.includes("FUTURE LEAK")); // the core leak-check assertion, at the level agents actually consume
});

test("fetchPriorLessons's asOf boundary shifts forward correctly as simulated time advances (walk-forward-style check)", async () => {
  const { store, stateDb } = await memoryStore(SAMPLE_ROWS);

  const early = await fetchPriorLessons(store, { ticker: "AAPL", asOf: "2026-01-05T00:00:00Z" });
  assert.ok(early.includes("sized in too early"));
  assert.ok(!early.includes("ignored bear case")); // d2 (Jan 10) not yet resolved as of Jan 5

  const later = await fetchPriorLessons(store, { ticker: "AAPL", asOf: "2026-01-15T00:00:00Z" });
  assert.ok(later.includes("ignored bear case")); // now resolved and visible
});

// ---------------------------------------------------------------------
// recordAndReflect -- the write path, now exercisable end-to-end via
// config.fakeModel (agents/utils/structured.js's new injection point)
// instead of needing the live Gemini cascade.
// ---------------------------------------------------------------------

test("recordAndReflect calls the real callStructured path (via config.fakeModel), persists the outcome, and returns the reflection text", async () => {
  const { store, stateDb } = await memoryStore([]);
  let capturedPrompt = null;

  const config = {
    geminiQuickModel: "quick-model",
    fakeModel: async (prompt, opts) => {
      capturedPrompt = prompt;
      assert.equal(opts.model, "quick-model"); // recordAndReflect explicitly passes geminiQuickModel
      return JSON.stringify({ reflection: "sized too aggressively given low confidence" });
    },
  };

  const reflection = await recordAndReflect({}, config, store, {
    id: "dec-1|reflection",
    decisionId: "dec-1",
    ticker: "AAPL",
    decisionSummary: { direction: "long", instrument: "equity" },
    realizedReturn: -0.02,
    alphaReturn: -0.03,
    resolvedAt: "2026-03-01T00:00:00Z",
  });

  assert.equal(reflection, "sized too aggressively given low confidence");
  assert.ok(capturedPrompt.includes("AAPL")); // grounded in the real ticker, not a placeholder
  assert.ok(capturedPrompt.includes("-0.02")); // grounded in the real realized return

  // Persisted row is now readable back through the normal asOf-gated read path.
  const rows = await store.getDecisionMemoryAsOf({ ticker: "AAPL", asOf: "2026-03-02T00:00:00Z" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reflection, "sized too aggressively given low confidence");
  assert.equal(rows[0].realized_return, -0.02);
});

test("recordAndReflect is idempotent -- a second call with the same id does not duplicate the row (ON CONFLICT DO NOTHING)", async () => {
  const { store, stateDb } = await memoryStore([]);
  const config = {
    geminiQuickModel: "quick-model",
    fakeModel: async () => JSON.stringify({ reflection: "first reflection" }),
  };

  const args = {
    id: "dec-1|reflection",
    decisionId: "dec-1",
    ticker: "AAPL",
    decisionSummary: { direction: "long" },
    realizedReturn: 0.01,
    alphaReturn: 0.01,
    resolvedAt: "2026-03-01T00:00:00Z",
  };

  await recordAndReflect({}, config, store, args);
  config.fakeModel = async () => JSON.stringify({ reflection: "a different second reflection" });
  await recordAndReflect({}, config, store, args); // same id -- a checkpoint-resumed re-run scenario

  const rows = await store.getDecisionMemoryAsOf({ ticker: "AAPL", asOf: "2026-03-02T00:00:00Z" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reflection, "first reflection"); // the second call's write never landed
});

test("recordAndReflect surfaces a schema-validation error rather than silently persisting a malformed reflection", async () => {
  const { store, stateDb } = await memoryStore([]);
  const config = {
    geminiQuickModel: "quick-model",
    fakeModel: async () => JSON.stringify({ notReflection: "wrong shape" }), // missing required `reflection: string`
  };

  await assert.rejects(() =>
    recordAndReflect({}, config, store, {
      id: "dec-2|reflection",
      decisionId: "dec-2",
      ticker: "AAPL",
      decisionSummary: {},
      realizedReturn: 0,
      alphaReturn: 0,
      resolvedAt: "2026-03-01T00:00:00Z",
    })
  );

  assert.equal((await stateRows(stateDb, "decision_memory")).length, 0); // failed validation, nothing should have been written
});
