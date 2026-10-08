// RunStore#commitThesis's hold/flip rule (P3), on REAL sqlite (see
// test/helpers/sqlite_d1.js): a new thesis for a ticker with an open position
// only replaces it if it points the OTHER way with confidence >=
// flipMinConfidence. Same direction, or a too-weak opposite thesis, is HELD:
// nothing closes, nothing opens, the old position keeps its opened_at (so the
// time-exit clock is not reset), and the decision row is recorded as 'held'.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { RunStore } from "../src/storage/run_store.js";
import { DEFAULT_FLIP_MIN_CONFIDENCE, TRADE_DECISION_STATUS } from "../src/shared/constants.js";

const STATE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations", "state");

function setup() {
  const db = createTestD1([STATE_DIR]);
  return { db, store: new RunStore(db, "live") };
}

function args({ ticker = "AAPL", asOf, direction = "long", confidence = 0.8, positionSizePct = 0.05, ...rest }) {
  const id = `${ticker}|${asOf}`;
  return {
    id, ticker, tradeThesisId: id, positionSizePct, direction, confidence, entryPrice: 100, stopLossPct: 0.03, takeProfitPct: 0.06,
    asOf, thesis: { ticker, asOf, direction }, riskDecision: { approved: true, positionSizePct }, createdAt: asOf, exitPrice: 105, ...rest,
  };
}

const positions = (db) => db.prepare(`SELECT id, direction, opened_at, closed_at, close_reason, exit_price, confidence FROM positions ORDER BY opened_at, id`).all().then((r) => r.results);
const decisionStatus = (db, id) => db.prepare(`SELECT status FROM trade_decisions WHERE id = ?`).bind(id).first().then((r) => r?.status);

test("same direction is HELD: old position untouched, no new position, decision recorded as held", async () => {
  const { db, store } = setup();
  await store.commitThesis(args({ asOf: "t1" }));
  await store.commitThesis(args({ asOf: "t2", confidence: 0.95 })); // even more confident: still held

  assert.deepEqual(await positions(db), [
    { id: "AAPL|t1", direction: "long", opened_at: "t1", closed_at: null, close_reason: null, exit_price: null, confidence: 0.8 },
  ]);
  assert.equal(await decisionStatus(db, "AAPL|t2"), TRADE_DECISION_STATUS.HELD);
  assert.deepEqual(await store.getUnsettledReplacedPositions({ ticker: "AAPL", closedAt: "t2" }), []);
});

test("a too-weak opposite thesis is HELD too", async () => {
  const { db, store } = setup();
  await store.commitThesis(args({ asOf: "t1" }));
  await store.commitThesis(args({ asOf: "t2", direction: "short", confidence: 0.7 })); // < 0.75

  assert.equal((await positions(db)).length, 1);
  assert.equal((await positions(db))[0].closed_at, null);
  assert.equal(await decisionStatus(db, "AAPL|t2"), TRADE_DECISION_STATUS.HELD);
});

test("a confident opposite thesis FLIPS: old closes as 'flipped' with exitPrice, new opens, decision is opened, and it is found for settling", async () => {
  const { db, store } = setup();
  await store.commitThesis(args({ asOf: "t1" }));
  await store.commitThesis(args({ asOf: "t2", direction: "short", confidence: 0.9, exitPrice: 111 }));

  const rows = await positions(db);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { id: "AAPL|t1", direction: "long", opened_at: "t1", closed_at: "t2", close_reason: "flipped", exit_price: 111, confidence: 0.8 });
  assert.deepEqual(rows[1], { id: "AAPL|t2", direction: "short", opened_at: "t2", closed_at: null, close_reason: null, exit_price: null, confidence: 0.9 });
  assert.equal(await decisionStatus(db, "AAPL|t2"), TRADE_DECISION_STATUS.OPENED);

  const unsettled = await store.getUnsettledReplacedPositions({ ticker: "AAPL", closedAt: "t2" });
  assert.equal(unsettled.length, 1);
  assert.equal(unsettled[0].closeReason, "flipped");
});

test("the flip threshold is inclusive: confidence == flipMinConfidence flips", async () => {
  const { db, store } = setup();
  await store.commitThesis(args({ asOf: "t1" }));
  await store.commitThesis(args({ asOf: "t2", direction: "short", confidence: DEFAULT_FLIP_MIN_CONFIDENCE }));
  assert.equal((await positions(db))[0].close_reason, "flipped");
});

test("flipMinConfidence is overridable per call (0 = always flip, high = never)", async () => {
  const a = setup();
  await a.store.commitThesis(args({ asOf: "t1" }));
  await a.store.commitThesis(args({ asOf: "t2", direction: "short", confidence: 0.61, flipMinConfidence: 0 }));
  assert.equal((await positions(a.db))[0].close_reason, "flipped");

  const b = setup();
  await b.store.commitThesis(args({ asOf: "t1" }));
  await b.store.commitThesis(args({ asOf: "t2", direction: "short", confidence: 0.9, flipMinConfidence: 0.95 }));
  assert.equal((await positions(b.db))[0].closed_at, null);
  assert.equal(await decisionStatus(b.db, "AAPL|t2"), TRADE_DECISION_STATUS.HELD);
});

test("a legacy open position with no direction never holds: it is replaced ('replaced', not 'flipped')", async () => {
  const { db, store } = setup();
  await store.openPosition({ id: "AAPL|t1", ticker: "AAPL", tradeThesisId: "AAPL|t1", positionSizePct: 0.05, openedAt: "t1" }); // direction null
  await store.commitThesis(args({ asOf: "t2", direction: "long" }));

  const rows = await positions(db);
  assert.equal(rows[0].close_reason, "replaced");
  assert.equal(rows[1].closed_at, null);
  assert.equal(await decisionStatus(db, "AAPL|t2"), TRADE_DECISION_STATUS.OPENED);
});

test("a flip that would breach the ceiling is rejected and leaves the old position open", async () => {
  const { db, store } = setup();
  await store.commitThesis(args({ asOf: "t1" })); // AAPL 0.05
  // GOOG is outside TICKER_GROUPS, so a 44% lone position does not trip the 10% group cap; only the 50% ceiling is under test.
  await store.commitThesis(args({ ticker: "GOOG", asOf: "t1", positionSizePct: 0.44 })); // other tickers: 0.44
  await store.commitThesis(args({ asOf: "t2", direction: "short", confidence: 0.9, positionSizePct: 0.07 })); // 0.44 + 0.07 > 0.5

  const aapl = (await positions(db)).filter((p) => p.id.startsWith("AAPL"));
  assert.equal(aapl.length, 1);
  assert.equal(aapl[0].closed_at, null);
  assert.equal(await decisionStatus(db, "AAPL|t2"), TRADE_DECISION_STATUS.REJECTED);
});

test("a retried flip is idempotent: still one closed + one open, no extra decision rows", async () => {
  const { db, store } = setup();
  await store.commitThesis(args({ asOf: "t1" }));
  const flip = args({ asOf: "t2", direction: "short", confidence: 0.9 });
  await store.commitThesis(flip);
  await store.commitThesis(flip);

  const rows = await positions(db);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].close_reason, "flipped");
  assert.equal(rows[1].closed_at, null);
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM trade_decisions`).first()).n, 2);
});

test("a different ticker is unaffected by another ticker's open position (no cross-ticker hold)", async () => {
  const { db, store } = setup();
  await store.commitThesis(args({ ticker: "AAPL", asOf: "t1" }));
  await store.commitThesis(args({ ticker: "MSFT", asOf: "t2" })); // same direction, different ticker
  assert.equal((await positions(db)).filter((p) => p.closed_at === null).length, 2);
  assert.equal(await decisionStatus(db, "MSFT|t2"), TRADE_DECISION_STATUS.OPENED);
});

test("a new thesis with no confidence flips an opposite position (legacy comparison is NULL = not held) but still holds the same direction", async () => {
  const a = setup();
  await a.store.commitThesis(args({ asOf: "t1" }));
  await a.store.commitThesis(args({ asOf: "t2", direction: "short", confidence: null }));
  assert.equal((await positions(a.db))[0].close_reason, "flipped");

  const b = setup();
  await b.store.commitThesis(args({ asOf: "t1" }));
  await b.store.commitThesis(args({ asOf: "t2", confidence: null }));
  assert.equal((await positions(b.db))[0].closed_at, null);
});
