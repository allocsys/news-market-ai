// exit_logic test (plan.md positions known-gap: "closePosition has no
// caller yet"). Covers three things: agents/risk_mgmt/exit.js#evaluateExit's
// pure stop-loss/take-profit/time-based rules, storage/d1.js's
// openPosition/closePosition/getOpenPositionsAsOf against the new exit
// fields (migrations/0006), and graph/exit_check.js#checkOpenPositionExits'
// orchestration against a minimal in-memory fake of BOTH the `positions`
// and `price_bars` tables -- same honest, narrow-fake convention as
// positions_pointintime.test.js and price_bars_pointintime.test.js.

import test from "node:test";
import assert from "node:assert/strict";
import { evaluateExit, CLOSE_REASON } from "../src/agents/risk_mgmt/exit.js";
import { openPosition, closePosition, getOpenPositionsAsOf } from "../src/storage/d1.js";
import { checkOpenPositionExits } from "../src/graph/exit_check.js";
import { LookaheadViolationError } from "../src/shared/errors.js";

// Deterministic, offline stand-in for the reflection LLM call --
// checkOpenPositionExits now calls settlePositionOutcome -> closeTheLoop ->
// recordAndReflect under the hood after every close (see graph/settle.js).
// Same config.fakeModel injection point memory_pointintime.test.js and
// checkpoint_resume.test.js already use.
const FAKE_REFLECTION_MODEL = async () => JSON.stringify({ reflection: "test reflection" });

// ---------------------------------------------------------------------
// evaluateExit -- pure function, no DB
// ---------------------------------------------------------------------

const BASE_LONG = {
  direction: "long",
  entryPrice: 100,
  stopLossPct: 0.03,
  takeProfitPct: 0.06,
  openedAt: "2026-01-01T00:00:00Z",
};

test("evaluateExit: long position with no threshold crossed and within hold window stays open", () => {
  const result = evaluateExit(BASE_LONG, { currentPrice: 101, asOf: "2026-01-02T00:00:00Z", maxHoldDays: 10 });
  assert.equal(result, null);
});

test("evaluateExit: long position triggers stop_loss when price drops past stopLossPct", () => {
  const result = evaluateExit(BASE_LONG, { currentPrice: 96.9, asOf: "2026-01-02T00:00:00Z", maxHoldDays: 10 }); // -3.1%
  assert.deepEqual(result, { reason: CLOSE_REASON.STOP_LOSS });
});

test("evaluateExit: long position triggers take_profit when price rises past takeProfitPct", () => {
  const result = evaluateExit(BASE_LONG, { currentPrice: 107, asOf: "2026-01-02T00:00:00Z", maxHoldDays: 10 }); // +7%
  assert.deepEqual(result, { reason: CLOSE_REASON.TAKE_PROFIT });
});

test("evaluateExit: short position triggers stop_loss when price RISES past stopLossPct (inverted)", () => {
  const short = { ...BASE_LONG, direction: "short" };
  const result = evaluateExit(short, { currentPrice: 103.5, asOf: "2026-01-02T00:00:00Z", maxHoldDays: 10 }); // price up 3.5% hurts a short
  assert.deepEqual(result, { reason: CLOSE_REASON.STOP_LOSS });
});

test("evaluateExit: short position triggers take_profit when price FALLS past takeProfitPct (inverted)", () => {
  const short = { ...BASE_LONG, direction: "short" };
  const result = evaluateExit(short, { currentPrice: 93, asOf: "2026-01-02T00:00:00Z", maxHoldDays: 10 }); // price down 7% is a win for a short
  assert.deepEqual(result, { reason: CLOSE_REASON.TAKE_PROFIT });
});

test("evaluateExit: stop_loss takes priority over take_profit when both are crossed at once", () => {
  // A price gap could, in principle, jump straight past both thresholds in
  // one bar -- stop_loss must win (protect capital first).
  const result = evaluateExit(BASE_LONG, { currentPrice: 50, asOf: "2026-01-02T00:00:00Z", maxHoldDays: 10 });
  assert.deepEqual(result, { reason: CLOSE_REASON.STOP_LOSS });
});

test("evaluateExit: time_based fires once maxHoldDays has elapsed with no price threshold crossed", () => {
  const result = evaluateExit(BASE_LONG, { currentPrice: 101, asOf: "2026-01-11T00:00:00Z", maxHoldDays: 10 });
  assert.deepEqual(result, { reason: CLOSE_REASON.TIME_BASED });
});

test("evaluateExit: time_based does not fire before maxHoldDays has elapsed", () => {
  const result = evaluateExit(BASE_LONG, { currentPrice: 101, asOf: "2026-01-09T00:00:00Z", maxHoldDays: 10 });
  assert.equal(result, null);
});

test("evaluateExit: a price threshold win still beats time_based even right at the hold-day boundary", () => {
  const result = evaluateExit(BASE_LONG, { currentPrice: 107, asOf: "2026-01-11T00:00:00Z", maxHoldDays: 10 });
  assert.deepEqual(result, { reason: CLOSE_REASON.TAKE_PROFIT });
});

test("evaluateExit: null entryPrice skips price-based exits entirely but time_based still works", () => {
  const noPrice = { ...BASE_LONG, entryPrice: null };
  const stillOpen = evaluateExit(noPrice, { currentPrice: 50, asOf: "2026-01-02T00:00:00Z", maxHoldDays: 10 });
  assert.equal(stillOpen, null); // would have been stop_loss if entryPrice were set -- must NOT fabricate one

  const timeBased = evaluateExit(noPrice, { currentPrice: 50, asOf: "2026-01-11T00:00:00Z", maxHoldDays: 10 });
  assert.deepEqual(timeBased, { reason: CLOSE_REASON.TIME_BASED });
});

test("evaluateExit: null currentPrice (no price_bars data) also skips price-based exits", () => {
  const result = evaluateExit(BASE_LONG, { currentPrice: null, asOf: "2026-01-02T00:00:00Z", maxHoldDays: 10 });
  assert.equal(result, null);
});

test("evaluateExit: direction 'flat' never triggers a price-based exit", () => {
  const flat = { ...BASE_LONG, direction: "flat" };
  const result = evaluateExit(flat, { currentPrice: 50, asOf: "2026-01-02T00:00:00Z", maxHoldDays: 10 });
  assert.equal(result, null);
});

// ---------------------------------------------------------------------
// storage/d1.js -- fake positions + price_bars tables
// ---------------------------------------------------------------------

class FakeDb {
  constructor() {
    this.positions = new Map();
    this.priceBars = new Map(); // `${ticker}|${date}` -> bar
    this.decisionMemory = []; // rows written by recordDecisionOutcome (via settlePositionOutcome -> closeTheLoop)
  }

  prepare(sql) {
    const db = this;
    return {
      bind(...args) {
        return {
          async run() {
            if (/INSERT INTO positions/.test(sql)) {
              const [id, ticker, tradeThesisId, positionSizePct, direction, entryPrice, stopLossPct, takeProfitPct, openedAt] = args;
              if (db.positions.has(id)) return; // ON CONFLICT DO NOTHING
              db.positions.set(id, {
                id, ticker, trade_thesis_id: tradeThesisId, position_size_pct: positionSizePct,
                direction, entry_price: entryPrice, stop_loss_pct: stopLossPct, take_profit_pct: takeProfitPct,
                opened_at: openedAt, closed_at: null, close_reason: null, exit_price: null,
              });
              return;
            }
            if (/UPDATE positions SET closed_at/.test(sql)) {
              const [closedAt, closeReason, exitPrice, id] = args;
              const row = db.positions.get(id);
              if (row && row.closed_at === null) {
                row.closed_at = closedAt;
                row.close_reason = closeReason;
                row.exit_price = exitPrice;
              }
              return;
            }
            if (/INSERT INTO price_bars/.test(sql)) {
              const [ticker, date, open, high, low, close, volume, source] = args;
              db.priceBars.set(`${ticker}|${date}`, { ticker, date, open, high, low, close, volume, source });
              return;
            }
            if (/INSERT INTO decision_memory/.test(sql)) {
              const [id, decisionId, ticker, realizedReturn, alphaReturn, reflection, resolvedAt] = args;
              if (db.decisionMemory.some((r) => r.id === id)) return; // ON CONFLICT(id) DO NOTHING
              db.decisionMemory.push({ id, decision_id: decisionId, ticker, realized_return: realizedReturn, alpha_return: alphaReturn, reflection, resolved_at: resolvedAt });
              return;
            }
            throw new Error(`FakeDb: unsupported run() query: ${sql}`);
          },
          async all() {
            if (/SELECT id, ticker, trade_thesis_id, position_size_pct, direction, entry_price, stop_loss_pct, take_profit_pct, opened_at\s+FROM positions/.test(sql)) {
              const [asOf1, asOf2] = args;
              const results = [...db.positions.values()]
                .filter((r) => r.opened_at <= asOf1 && (r.closed_at === null || r.closed_at > asOf2))
                .map((r) => ({
                  id: r.id, ticker: r.ticker, trade_thesis_id: r.trade_thesis_id, position_size_pct: r.position_size_pct,
                  direction: r.direction, entry_price: r.entry_price, stop_loss_pct: r.stop_loss_pct,
                  take_profit_pct: r.take_profit_pct, opened_at: r.opened_at,
                }));
              return { results };
            }
            if (/SELECT ticker, date, open, high, low, close, volume, source\s+FROM price_bars/.test(sql)) {
              const [ticker, asOf, limit] = args;
              const results = [...db.priceBars.values()]
                .filter((b) => b.ticker === ticker && b.date <= asOf)
                .sort((a, b) => (a.date < b.date ? 1 : -1))
                .slice(0, limit);
              return { results };
            }
            throw new Error(`FakeDb: unsupported all() query: ${sql}`);
          },
        };
      },
    };
  }
}

async function seedBar(db, { ticker, date, close }) {
  await db
    .prepare(`INSERT INTO price_bars (ticker, date, open, high, low, close, volume, source, ingested_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(ticker, date, close, close, close, close, 1000, "test", new Date().toISOString())
    .run();
}

test("getOpenPositionsAsOf throws LookaheadViolationError when asOf is omitted", async () => {
  const db = new FakeDb();
  await assert.rejects(() => getOpenPositionsAsOf(db, {}), LookaheadViolationError);
});

test("openPosition stores direction/entryPrice/stopLossPct/takeProfitPct, and getOpenPositionsAsOf returns them", async () => {
  const db = new FakeDb();
  await openPosition(db, {
    id: "AAPL|t1", ticker: "AAPL", tradeThesisId: "AAPL|t1", positionSizePct: 0.03,
    direction: "long", entryPrice: 150, stopLossPct: 0.03, takeProfitPct: 0.06,
    openedAt: "2026-01-01T00:00:00Z",
  });

  const [position] = await getOpenPositionsAsOf(db, { asOf: "2026-01-05T00:00:00Z" });
  assert.deepEqual(position, {
    id: "AAPL|t1", ticker: "AAPL", tradeThesisId: "AAPL|t1", positionSizePct: 0.03,
    direction: "long", entryPrice: 150, stopLossPct: 0.03, takeProfitPct: 0.06,
    openedAt: "2026-01-01T00:00:00Z",
  });
});

test("openPosition defaults direction/entryPrice/stopLossPct/takeProfitPct to null when omitted", async () => {
  const db = new FakeDb();
  await openPosition(db, { id: "AAPL|t1", ticker: "AAPL", tradeThesisId: "AAPL|t1", positionSizePct: 0.03, openedAt: "2026-01-01T00:00:00Z" });

  const [position] = await getOpenPositionsAsOf(db, { asOf: "2026-01-05T00:00:00Z" });
  assert.equal(position.direction, null);
  assert.equal(position.entryPrice, null);
});

test("closePosition records closeReason and a subsequent getOpenPositionsAsOf no longer returns it", async () => {
  const db = new FakeDb();
  await openPosition(db, { id: "AAPL|t1", ticker: "AAPL", tradeThesisId: "AAPL|t1", positionSizePct: 0.03, direction: "long", openedAt: "2026-01-01T00:00:00Z" });
  await closePosition(db, { id: "AAPL|t1", closedAt: "2026-01-05T00:00:00Z", closeReason: "stop_loss" });

  const stillOpenAsOfBefore = await getOpenPositionsAsOf(db, { asOf: "2026-01-03T00:00:00Z" });
  assert.equal(stillOpenAsOfBefore.length, 1); // still open before the close

  const openAsOfAfter = await getOpenPositionsAsOf(db, { asOf: "2026-01-10T00:00:00Z" });
  assert.equal(openAsOfAfter.length, 0); // closed by then

  assert.equal(db.positions.get("AAPL|t1").close_reason, "stop_loss");
});

// ---------------------------------------------------------------------
// checkOpenPositionExits -- orchestration
// ---------------------------------------------------------------------

test("checkOpenPositionExits closes a position whose stop_loss triggers against price_bars, leaves others open", async () => {
  const db = new FakeDb();
  const config = { maxPositionHoldDays: 10, geminiQuickModel: "quick", fakeModel: FAKE_REFLECTION_MODEL };

  await openPosition(db, {
    id: "AAPL|t1", ticker: "AAPL", tradeThesisId: "AAPL|t1", positionSizePct: 0.03,
    direction: "long", entryPrice: 100, stopLossPct: 0.03, takeProfitPct: 0.06,
    openedAt: "2026-01-01T00:00:00Z",
  });
  await openPosition(db, {
    id: "MSFT|t1", ticker: "MSFT", tradeThesisId: "MSFT|t1", positionSizePct: 0.02,
    direction: "long", entryPrice: 200, stopLossPct: 0.03, takeProfitPct: 0.06,
    openedAt: "2026-01-01T00:00:00Z",
  });
  await seedBar(db, { ticker: "AAPL", date: "2026-01-02", close: 95 }); // -5%, past stop_loss
  await seedBar(db, { ticker: "MSFT", date: "2026-01-02", close: 201 }); // unchanged, stays open

  const closed = await checkOpenPositionExits({}, config, db, { asOf: "2026-01-02T12:00:00Z" });

  assert.deepEqual(closed, [{ id: "AAPL|t1", ticker: "AAPL", reason: "stop_loss" }]);
  const stillOpen = await getOpenPositionsAsOf(db, { asOf: "2026-01-03T00:00:00Z" });
  assert.deepEqual(stillOpen.map((p) => p.id), ["MSFT|t1"]);

  // exitPrice recorded (the same bar that triggered the exit), and a
  // realized return computed + recorded via settlePositionOutcome.
  assert.equal(db.positions.get("AAPL|t1").exit_price, 95);
  assert.equal(db.decisionMemory.length, 1);
  assert.equal(db.decisionMemory[0].decision_id, "AAPL|t1");
  assert.equal(db.decisionMemory[0].realized_return, (95 - 100) / 100); // -0.05, direction 'long'
  assert.equal(db.decisionMemory[0].alpha_return, null); // HONEST SCOPE -- no benchmark ingestion yet
  assert.equal(db.decisionMemory[0].reflection, "test reflection");
});

test("checkOpenPositionExits closes a position on a time-based exit even with no price_bars data at all, and records no reflection since the realized return isn't computable", async () => {
  const db = new FakeDb();
  const config = { maxPositionHoldDays: 5, geminiQuickModel: "quick", fakeModel: FAKE_REFLECTION_MODEL };

  await openPosition(db, {
    id: "TSLA|t1", ticker: "TSLA", tradeThesisId: "TSLA|t1", positionSizePct: 0.03,
    direction: "long", entryPrice: null, stopLossPct: 0.03, takeProfitPct: 0.06,
    openedAt: "2026-01-01T00:00:00Z",
  });
  // No price bars seeded for TSLA at all -- this is the "yfinance not wired
  // in yet" case documented in exit_check.js's header.

  const closed = await checkOpenPositionExits({}, config, db, { asOf: "2026-01-08T00:00:00Z" }); // 7 days later
  assert.deepEqual(closed, [{ id: "TSLA": "TSLA", id: "TSLA|t1", ticker: "TSLA", reason: "time_based" }]);

  // No entryPrice AND no exitPrice -- settlePositionOutcome must skip
  // reflection entirely rather than fabricate a realized return.
  assert.equal(db.positions.get("TSLA|t1").exit_price, null);
  assert.equal(db.decisionMemory.length, 0);
});

test("checkOpenPositionExits closes nothing and returns an empty array when no position triggers", async () => {
  const db = new FakeDb();
  const config = { maxPositionHoldDays: 10 };

  await openPosition(db, {
    id: "AAPL|t1", ticker: "AAPL", tradeThesisId: "AAPL|t1", positionSizePct: 0.03,
    direction: "long", entryPrice: 100, stopLossPct: 0.03, takeProfitPct: 0.06,
    openedAt: "2026-01-01T00:00:00Z",
  });
  await seedBar(db, { ticker: "AAPL", date: "2026-01-02", close: 101 });

  const closed = await checkOpenPositionExits(db, config, { asOf: "2026-01-02T12:00:00Z" });
  assert.deepEqual(closed, []);
});

test("checkOpenPositionExits is safe to re-run: an already-closed position is not returned/closed again", async () => {
  const db = new FakeDb();
  const config = { maxPositionHoldDays: 10 };

  await openPosition(db, {
    id: "AAPL|t1", ticker: "AAPL", tradeThesisId: "AAPL|t1", positionSizePct: 0.03,
    direction: "long", entryPrice: 100, stopLossPct: 0.03, takeProfitPct: 0.06,
    openedAt: "2026-01-01T00:00:00Z",
  });
  await seedBar(db, { ticker: "AAPL", date: "2026-01-02", close: 95 });

  const firstRun = await checkOpenPositionExits(db, config, { asOf: "2026-01-02T12:00:00Z" });
  assert.equal(firstRun.length, 1);

  const secondRun = await checkOpenPositionExits(db, config, { asOf: "2026-01-03T12:00:00Z" });
  assert.deepEqual(secondRun, []);
});
