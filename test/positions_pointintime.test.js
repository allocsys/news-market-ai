// positions_pointintime test (plan.md open item: real positions store).
// Exercises storage/d1.js#openPosition/closePosition/getOpenPositionsRiskPctAsOf
// against a minimal in-memory fake of the `positions` table, same honest,
// narrow-fake convention as checkpoint_resume.test.js and
// memory_pointintime.test.js.
//
// Focus: getOpenPositionsRiskPctAsOf must reflect exposure exactly AS OF a
// given timestamp -- a position opened after `asOf`, or already closed
// before `asOf`, must never count toward the sum (Backtesting Integrity,
// same principle as points 1/2/4 applied to portfolio exposure).

import test from "node:test";
import assert from "node:assert/strict";
import { openPosition, closePosition, getOpenPositionsRiskPctAsOf, getOpenPositionForTickerAsOf } from "../src/storage/d1.js";
import { LookaheadViolationError } from "../src/shared/errors.js";

class FakePositionsDb {
  constructor() {
    this.rows = new Map(); // id -> { id, ticker, trade_thesis_id, position_size_pct, opened_at, closed_at }
  }

  prepare(sql) {
    const db = this;
    return {
      bind(...args) {
        return {
          async run() {
            if (/INSERT INTO positions/.test(sql)) {
              // Bind order now includes the exit-logic fields added by
              // migrations/0006 (direction/entryPrice/stopLossPct/
              // takeProfitPct) -- see test/exit_logic.test.js for coverage
              // of those fields specifically. This fake only cares about
              // the columns getOpenPositionsRiskPctAsOf below reads.
              const [id, ticker, tradeThesisId, positionSizePct, , , , , openedAt] = args;
              if (db.rows.has(id)) return; // ON CONFLICT DO NOTHING
              db.rows.set(id, { id, ticker, trade_thesis_id: tradeThesisId, position_size_pct: positionSizePct, opened_at: openedAt, closed_at: null });
              return;
            }
            if (/UPDATE positions SET closed_at/.test(sql)) {
              const [closedAt, , id] = args; // closeReason (2nd bind) not modeled by this narrow fake
              const row = db.rows.get(id);
              if (row && row.closed_at === null) row.closed_at = closedAt;
              return;
            }
            throw new Error(`FakePositionsDb: unsupported run() query: ${sql}`);
          },
          async all() {
            if (!/SELECT position_size_pct FROM positions/.test(sql)) {
              throw new Error(`FakePositionsDb: unsupported all() query: ${sql}`);
            }
            // excludeTicker (netting) adds a third bind param + "AND ticker != ?"
            // to the same SQL shape -- distinguish by arg count, not by a
            // stricter regex, so this fake stays agnostic to exact SQL text.
            const [asOf1, asOf2, excludeTicker] = args;
            const results = [...db.rows.values()]
              .filter((r) => r.opened_at <= asOf1 && (r.closed_at === null || r.closed_at > asOf2))
              .filter((r) => excludeTicker === undefined || r.ticker !== excludeTicker)
              .map((r) => ({ position_size_pct: r.position_size_pct }));
            return { results };
          },
          async first() {
            if (!/SELECT id, ticker, trade_thesis_id.*FROM positions\s+WHERE ticker = \?/s.test(sql)) {
              throw new Error(`FakePositionsDb: unsupported first() query: ${sql}`);
            }
            const [ticker, asOf1, asOf2] = args;
            const matches = [...db.rows.values()]
              .filter((r) => r.ticker === ticker && r.opened_at <= asOf1 && (r.closed_at === null || r.closed_at > asOf2))
              .sort((a, b) => (a.opened_at < b.opened_at ? 1 : -1)); // ORDER BY opened_at DESC
            const row = matches[0];
            if (!row) return null;
            return {
              id: row.id,
              ticker: row.ticker,
              trade_thesis_id: row.trade_thesis_id,
              position_size_pct: row.position_size_pct,
              direction: row.direction ?? null,
              entry_price: row.entry_price ?? null,
              stop_loss_pct: row.stop_loss_pct ?? null,
              take_profit_pct: row.take_profit_pct ?? null,
              opened_at: row.opened_at,
            };
          },
        };
      },
    };
  }
}

test("getOpenPositionsRiskPctAsOf throws LookaheadViolationError when asOf is omitted", async () => {
  const db = new FakePositionsDb();
  await assert.rejects(() => getOpenPositionsRiskPctAsOf(db, {}), LookaheadViolationError);
});

test("getOpenPositionsRiskPctAsOf is 0 with no positions open", async () => {
  const db = new FakePositionsDb();
  const pct = await getOpenPositionsRiskPctAsOf(db, { asOf: "2026-01-15T00:00:00Z" });
  assert.equal(pct, 0);
});

test("getOpenPositionsRiskPctAsOf sums every position open as of the given timestamp", async () => {
  const db = new FakePositionsDb();
  await openPosition(db, { id: "AAPL|t1", ticker: "AAPL", tradeThesisId: "AAPL|t1", positionSizePct: 0.03, openedAt: "2026-01-01T00:00:00Z" });
  await openPosition(db, { id: "MSFT|t1", ticker: "MSFT", tradeThesisId: "MSFT|t1", positionSizePct: 0.02, openedAt: "2026-01-05T00:00:00Z" });

  const pct = await getOpenPositionsRiskPctAsOf(db, { asOf: "2026-01-10T00:00:00Z" });
  assert.equal(pct, 0.05);
});

test("a position opened AFTER asOf does not count (no lookahead)", async () => {
  const db = new FakePositionsDb();
  await openPosition(db, { id: "AAPL|t1", ticker: "AAPL", tradeThesisId: "AAPL|t1", positionSizePct: 0.03, openedAt: "2026-02-01T00:00:00Z" });

  const pct = await getOpenPositionsRiskPctAsOf(db, { asOf: "2026-01-15T00:00:00Z" });
  assert.equal(pct, 0); // not yet opened as of Jan 15
});

test("a position closed strictly BEFORE asOf no longer counts", async () => {
  const db = new FakePositionsDb();
  await openPosition(db, { id: "AAPL|t1", ticker: "AAPL", tradeThesisId: "AAPL|t1", positionSizePct: 0.03, openedAt: "2026-01-01T00:00:00Z" });
  await closePosition(db, { id: "AAPL|t1", closedAt: "2026-01-10T00:00:00Z" });

  const pct = await getOpenPositionsRiskPctAsOf(db, { asOf: "2026-01-20T00:00:00Z" });
  assert.equal(pct, 0);
});

test("a position closed AFTER asOf still counts as open at that earlier asOf", async () => {
  const db = new FakePositionsDb();
  await openPosition(db, { id: "AAPL|t1", ticker: "AAPL", tradeThesisId: "AAPL|t1", positionSizePct: 0.03, openedAt: "2026-01-01T00:00:00Z" });
  await closePosition(db, { id: "AAPL|t1", closedAt: "2026-01-20T00:00:00Z" });

  const pct = await getOpenPositionsRiskPctAsOf(db, { asOf: "2026-01-10T00:00:00Z" });
  assert.equal(pct, 0.03); // still open as of Jan 10, closes later on Jan 20
});

test("openPosition is idempotent on the same id -- a checkpoint-resumed re-run can't double-open", async () => {
  const db = new FakePositionsDb();
  await openPosition(db, { id: "AAPL|t1", ticker: "AAPL", tradeThesisId: "AAPL|t1", positionSizePct: 0.03, openedAt: "2026-01-01T00:00:00Z" });
  await openPosition(db, { id: "AAPL|t1", ticker: "AAPL", tradeThesisId: "AAPL|t1", positionSizePct: 0.03, openedAt: "2026-01-01T00:00:00Z" });

  const pct = await getOpenPositionsRiskPctAsOf(db, { asOf: "2026-01-15T00:00:00Z" });
  assert.equal(pct, 0.03); // not 0.06 -- the second call was a no-op
});

// --- Netting: excludeTicker + getOpenPositionForTickerAsOf ---------------
// Covers the previously-documented KNOWN LIMITATION (re-evaluating a
// ticker that already has an open position double-counted its own
// exposure) now that both halves of the fix exist: excludeTicker on the
// summed read, and getOpenPositionForTickerAsOf for finding what to
// replace.

test("getOpenPositionsRiskPctAsOf with excludeTicker nets that ticker's own exposure out of the sum", async () => {
  const db = new FakePositionsDb();
  await openPosition(db, { id: "AAPL|t1", ticker: "AAPL", tradeThesisId: "AAPL|t1", positionSizePct: 0.03, openedAt: "2026-01-01T00:00:00Z" });
  await openPosition(db, { id: "MSFT|t1", ticker: "MSFT", tradeThesisId: "MSFT|t1", positionSizePct: 0.02, openedAt: "2026-01-05T00:00:00Z" });

  const pct = await getOpenPositionsRiskPctAsOf(db, { asOf: "2026-01-10T00:00:00Z", excludeTicker: "AAPL" });
  assert.equal(pct, 0.02); // AAPL's own 0.03 excluded, only MSFT's 0.02 remains
});

test("getOpenPositionsRiskPctAsOf without excludeTicker is unaffected -- pre-existing behavior preserved", async () => {
  const db = new FakePositionsDb();
  await openPosition(db, { id: "AAPL|t1", ticker: "AAPL", tradeThesisId: "AAPL|t1", positionSizePct: 0.03, openedAt: "2026-01-01T00:00:00Z" });
  await openPosition(db, { id: "MSFT|t1", ticker: "MSFT", tradeThesisId: "MSFT|t1", positionSizePct: 0.02, openedAt: "2026-01-05T00:00:00Z" });

  const pct = await getOpenPositionsRiskPctAsOf(db, { asOf: "2026-01-10T00:00:00Z" });
  assert.equal(pct, 0.05); // no excludeTicker -- sums everything, same as before this session
});

test("getOpenPositionForTickerAsOf throws LookaheadViolationError when asOf is omitted", async () => {
  const db = new FakePositionsDb();
  await assert.rejects(() => getOpenPositionForTickerAsOf(db, { ticker: "AAPL" }), LookaheadViolationError);
});

test("getOpenPositionForTickerAsOf returns null when the ticker has no open position", async () => {
  const db = new FakePositionsDb();
  const pos = await getOpenPositionForTickerAsOf(db, { ticker: "AAPL", asOf: "2026-01-10T00:00:00Z" });
  assert.equal(pos, null);
});

test("getOpenPositionForTickerAsOf finds the ticker's open position as of asOf", async () => {
  const db = new FakePositionsDb();
  await openPosition(db, { id: "AAPL|t1", ticker: "AAPL", tradeThesisId: "AAPL|t1", positionSizePct: 0.03, openedAt: "2026-01-01T00:00:00Z" });

  const pos = await getOpenPositionForTickerAsOf(db, { ticker: "AAPL", asOf: "2026-01-10T00:00:00Z" });
  assert.equal(pos.id, "AAPL|t1");
  assert.equal(pos.ticker, "AAPL");
  assert.equal(pos.positionSizePct, 0.03);
});

test("getOpenPositionForTickerAsOf returns null for a position not yet opened as of asOf (no lookahead)", async () => {
  const db = new FakePositionsDb();
  await openPosition(db, { id: "AAPL|t1", ticker: "AAPL", tradeThesisId: "AAPL|t1", positionSizePct: 0.03, openedAt: "2026-02-01T00:00:00Z" });

  const pos = await getOpenPositionForTickerAsOf(db, { ticker: "AAPL", asOf: "2026-01-15T00:00:00Z" });
  assert.equal(pos, null);
});

test("getOpenPositionForTickerAsOf returns null once the position has closed strictly before asOf", async () => {
  const db = new FakePositionsDb();
  await openPosition(db, { id: "AAPL|t1", ticker: "AAPL", tradeThesisId: "AAPL|t1", positionSizePct: 0.03, openedAt: "2026-01-01T00:00:00Z" });
  await closePosition(db, { id: "AAPL|t1", closedAt: "2026-01-10T00:00:00Z", closeReason: "replaced" });

  const pos = await getOpenPositionForTickerAsOf(db, { ticker: "AAPL", asOf: "2026-01-20T00:00:00Z" });
  assert.equal(pos, null);
});

test("getOpenPositionForTickerAsOf is per-ticker -- does not return a different ticker's position", async () => {
  const db = new FakePositionsDb();
  await openPosition(db, { id: "MSFT|t1", ticker: "MSFT", tradeThesisId: "MSFT|t1", positionSizePct: 0.02, openedAt: "2026-01-01T00:00:00Z" });

  const pos = await getOpenPositionForTickerAsOf(db, { ticker: "AAPL", asOf: "2026-01-10T00:00:00Z" });
  assert.equal(pos, null);
});
