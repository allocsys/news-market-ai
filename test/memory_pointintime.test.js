// memory_pointintime test (plan.md open item, mirrors TradingAgents' test
// naming and backtest.leakcheck.test.js's leak-check style). Covers
// Backtesting Integrity point 4: the reflection/memory loop is the easiest
// place to leak the future into a backtest, since it depends on a REALIZED
// outcome. Exercises storage/d1.js#getDecisionMemoryAsOf's enforced cutoff
// AND agents/utils/memory.js#fetchPriorLessons's use of it, against a
// minimal in-memory fake of D1's prepare/bind/all interface.
//
// HONEST SCOPE: FakeMemoryDb only understands the one SELECT d1.js issues
// against decision_memory -- not a general D1/SQLite emulator, same
// convention as checkpoint_resume.test.js's FakeCheckpointDb. Does not
// exercise recordAndReflect (the write path), since that calls the live
// Gemini cascade via callStructured -- out of scope for a pure leak-check
// test, same reasoning as checkpoint_resume.test.js's boundary.

import test from "node:test";
import assert from "node:assert/strict";
import { getDecisionMemoryAsOf } from "../src/storage/d1.js";
import { fetchPriorLessons } from "../src/agents/utils/memory.js";
import { LookaheadViolationError } from "../src/shared/errors.js";

class FakeMemoryDb {
  constructor(rows) {
    this.rows = rows; // [{ id, decision_id, ticker, realized_return, alpha_return, reflection, resolved_at }]
  }

  prepare(sql) {
    const db = this;
    return {
      bind(...args) {
        return {
          async all() {
            if (!/FROM decision_memory/.test(sql)) {
              throw new Error(`FakeMemoryDb: unsupported query: ${sql}`);
            }
            const [ticker, asOf, limit] = args;
            const results = db.rows
              .filter((r) => r.ticker === ticker && r.resolved_at < asOf) // strictly before -- matches the real SQL's "<", not "<="
              .sort((a, b) => (a.resolved_at < b.resolved_at ? 1 : -1)) // resolved_at DESC, matching the real ORDER BY
              .slice(0, limit);
            return { results };
          },
        };
      },
    };
  }
}

const SAMPLE_ROWS = [
  { id: "d1", decision_id: "dec-1", ticker: "AAPL", realized_return: 0.02, alpha_return: 0.01, reflection: "sized in too early", resolved_at: "2026-01-01T00:00:00Z" },
  { id: "d2", decision_id: "dec-2", ticker: "AAPL", realized_return: -0.01, alpha_return: -0.02, reflection: "ignored bear case, shouldn't have", resolved_at: "2026-01-10T00:00:00Z" },
  { id: "d3", decision_id: "dec-3", ticker: "AAPL", realized_return: 0.05, alpha_return: 0.03, reflection: "FUTURE LEAK -- must never appear before 2026-02-01", resolved_at: "2026-02-01T00:00:00Z" },
  { id: "d4", decision_id: "dec-4", ticker: "MSFT", realized_return: 0.01, alpha_return: 0.0, reflection: "different ticker, must not cross-contaminate", resolved_at: "2026-01-05T00:00:00Z" },
];

test("getDecisionMemoryAsOf throws LookaheadViolationError when asOf is omitted", async () => {
  const db = new FakeMemoryDb(SAMPLE_ROWS);
  await assert.rejects(() => getDecisionMemoryAsOf(db, { ticker: "AAPL" }), LookaheadViolationError);
});

test("getDecisionMemoryAsOf returns only rows strictly before asOf", async () => {
  const db = new FakeMemoryDb(SAMPLE_ROWS);
  const results = await getDecisionMemoryAsOf(db, { ticker: "AAPL", asOf: "2026-01-15T00:00:00Z" });

  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.resolved_at < "2026-01-15T00:00:00Z"));
  assert.ok(!results.some((r) => r.id === "d3")); // the future row must never appear
});

test("getDecisionMemoryAsOf excludes a row resolved EXACTLY at asOf (strictly before, not at-or-before)", async () => {
  const db = new FakeMemoryDb(SAMPLE_ROWS);
  const results = await getDecisionMemoryAsOf(db, { ticker: "AAPL", asOf: "2026-02-01T00:00:00Z" });

  assert.ok(!results.some((r) => r.id === "d3")); // resolved_at === asOf must not count as "already known"
});

test("getDecisionMemoryAsOf orders most-recent-first and respects limit", async () => {
  const db = new FakeMemoryDb(SAMPLE_ROWS);
  const results = await getDecisionMemoryAsOf(db, { ticker: "AAPL", asOf: "2026-01-15T00:00:00Z", limit: 1 });

  assert.equal(results.length, 1);
  assert.equal(results[0].id, "d2"); // most recent of the two eligible AAPL rows (d3 is not yet resolved as of Jan 15)
});

test("getDecisionMemoryAsOf never mixes another ticker's history in", async () => {
  const db = new FakeMemoryDb(SAMPLE_ROWS);
  const results = await getDecisionMemoryAsOf(db, { ticker: "AAPL", asOf: "2026-03-01T00:00:00Z" });

  assert.ok(!results.some((r) => r.ticker === "MSFT"));
});

test("fetchPriorLessons returns '' with no history, never null/undefined", async () => {
  const db = new FakeMemoryDb(SAMPLE_ROWS);
  const lessons = await fetchPriorLessons(db, { ticker: "TSLA", asOf: "2026-01-15T00:00:00Z" }); // no TSLA rows at all
  assert.equal(lessons, "");
});

test("fetchPriorLessons's formatted prompt text never contains a future reflection", async () => {
  const db = new FakeMemoryDb(SAMPLE_ROWS);
  const lessons = await fetchPriorLessons(db, { ticker: "AAPL", asOf: "2026-01-15T00:00:00Z" });

  assert.ok(lessons.includes("sized in too early"));
  assert.ok(lessons.includes("ignored bear case"));
  assert.ok(!lessons.includes("FUTURE LEAK")); // the core leak-check assertion, at the level agents actually consume
});

test("fetchPriorLessons's asOf boundary shifts forward correctly as simulated time advances (walk-forward-style check)", async () => {
  const db = new FakeMemoryDb(SAMPLE_ROWS);

  const early = await fetchPriorLessons(db, { ticker: "AAPL", asOf: "2026-01-05T00:00:00Z" });
  assert.ok(early.includes("sized in too early"));
  assert.ok(!early.includes("ignored bear case")); // d2 (Jan 10) not yet resolved as of Jan 5

  const later = await fetchPriorLessons(db, { ticker: "AAPL", asOf: "2026-01-15T00:00:00Z" });
  assert.ok(later.includes("ignored bear case")); // now resolved and visible
});
