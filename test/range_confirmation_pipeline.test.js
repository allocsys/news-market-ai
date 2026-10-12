// The two decision switches wired through graph/pipeline.js and graph/entry_fill.js, on real sqlite state + inputs DBs:
//   rangeLocationFilter -- a long near the N-day high / a short near the N-day low is REJECTED (no position) unless breakout.
//   entryConfirmation   -- an approved fresh-price entry waits as 'pending_entry' and opens at the open of the bar after a confirming close,
//                          or expires as 'skipped_no_fill'; the outcome lands in decision.debate.evidence.entryConfirmation.
// Both default OFF: with them off the pipeline behaves exactly as before (covered by the rest of the suite).

import test from "node:test";
import assert from "node:assert/strict";
import { runPipelineForTicker } from "../src/graph/pipeline.js";
import { fillPendingEntries } from "../src/graph/entry_fill.js";
import { TRADE_DECISION_STATUS } from "../src/shared/constants.js";
import { makeCtx, seedBar, seedBarOhlc, seedIntradayBar, stateRows } from "./helpers/engine_ctx.js";
import { makeFakeLongModel } from "./helpers/fake_long_model.js";

const ASOF = "2026-01-15T13:36:00Z";
const newsItem = { id: "news-1", tickers: ["AAPL"], title: "AAPL news", body: "body", publishedAt: ASOF };

const config = (extra = {}, modelOpts) => ({
  geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, maxPositionHoldDays: 10,
  fakeModel: makeFakeLongModel(modelOpts), ...extra,
});

/** 10 daily bars ending the day before ASOF: overall high 200 / low 100 (the range the filter measures). */
async function seedRangeBars(ctx, { n = 10 } = {}) {
  for (let i = 0; i < n; i++) {
    const date = new Date(Date.parse("2026-01-14T00:00:00Z") - i * 86400000).toISOString().slice(0, 10);
    await seedBarOhlc(ctx.inputs, { ticker: "AAPL", date, open: 150, high: i === 3 ? 200 : 160, low: i === 6 ? 100 : 120, close: 150 });
  }
}

/** Runs the pipeline with a FRESH intraday bar at `price` (closed 1 minute before ASOF) so the entry price is not stale. */
async function run(ctx, cfg, { price }) {
  await seedIntradayBar(ctx.inputs, { ticker: "AAPL", ts: "2026-01-15T13:30:00Z", close: price });
  const originalError = console.error;
  console.error = () => {};
  try {
    return await runPipelineForTicker({}, cfg, ctx, { pipelineRunId: "news-1", ticker: "AAPL", newsItem, asOf: ASOF });
  } finally {
    console.error = originalError;
  }
}

const decisionRow = async (ctx) => {
  const [row] = await stateRows(ctx.stateDb, "trade_decisions");
  return { row, debate: row?.debate ? JSON.parse(row.debate) : null };
};

// ---------------------------------------------------------------------------
// rangeLocationFilter
// ---------------------------------------------------------------------------

test("range filter ON: a long near the 10-day high is REJECTED -- no position, reason and evidence recorded", async () => {
  const ctx = makeCtx();
  await seedRangeBars(ctx);
  const decision = await run(ctx, config({ rangeLocationFilter: true }), { price: 190 });

  assert.equal(decision.approvedForExecution, false);
  assert.equal(decision.finalPositionSizePct, 0);
  assert.match(decision.reason, /^range filter: long at 90% of the 10-day range/);
  assert.equal((await stateRows(ctx.stateDb, "positions")).length, 0);
  const { row, debate } = await decisionRow(ctx);
  assert.equal(row.status, TRADE_DECISION_STATUS.REJECTED);
  assert.equal(debate.evidence.rangeFilter.applied, true);
  assert.equal(debate.evidence.rangeFilter.blocked, true);
  assert.equal(debate.evidence.rangeFilter.rangePositionPct, 0.9);
  assert.equal(debate.evidence.rangeFilter.high, 200);
  assert.equal(debate.evidence.rangeFilter.low, 100);
});

test("range filter ON: the same long in the lower part of the range opens, and the pass is recorded", async () => {
  const ctx = makeCtx();
  await seedRangeBars(ctx);
  const decision = await run(ctx, config({ rangeLocationFilter: true }), { price: 120 });

  assert.equal(decision.approvedForExecution, true);
  const positions = await stateRows(ctx.stateDb, "positions");
  assert.equal(positions.length, 1);
  assert.equal(positions[0].entry_price, 120);
  const { row, debate } = await decisionRow(ctx);
  assert.equal(row.status, TRADE_DECISION_STATUS.OPENED);
  assert.equal(debate.evidence.rangeFilter.blocked, false);
  assert.equal(debate.evidence.rangeFilter.rangePositionPct, 0.2);
});

test("range filter ON: a long that is already above the prior 10-day high (breakout) is allowed", async () => {
  const ctx = makeCtx();
  await seedRangeBars(ctx);
  const decision = await run(ctx, config({ rangeLocationFilter: true }), { price: 210 });

  assert.equal(decision.approvedForExecution, true);
  assert.equal((await stateRows(ctx.stateDb, "positions")).length, 1);
  const { debate } = await decisionRow(ctx);
  assert.equal(debate.evidence.rangeFilter.breakout, true);
  assert.equal(debate.evidence.rangeFilter.blocked, false);
});

test("range filter ON: a short near the 10-day low is REJECTED", async () => {
  const ctx = makeCtx();
  await seedRangeBars(ctx);
  const decision = await run(ctx, config({ rangeLocationFilter: true }, { direction: "short" }), { price: 110 });

  assert.equal(decision.approvedForExecution, false);
  assert.match(decision.reason, /^range filter: short at 10% of the 10-day range/);
  assert.equal((await stateRows(ctx.stateDb, "positions")).length, 0);
  assert.equal((await decisionRow(ctx)).row.status, TRADE_DECISION_STATUS.REJECTED);
});

test("range filter ON with too little history: not applied, the entry opens as usual", async () => {
  const ctx = makeCtx();
  await seedRangeBars(ctx, { n: 4 });
  const decision = await run(ctx, config({ rangeLocationFilter: true }), { price: 190 });

  assert.equal(decision.approvedForExecution, true);
  assert.equal((await stateRows(ctx.stateDb, "positions")).length, 1);
  const { debate } = await decisionRow(ctx);
  assert.equal(debate.evidence.rangeFilter.applied, false);
  assert.equal(debate.evidence.rangeFilter.blocked, false);
});

test("range filter ON: per-run days / edge are honored (a 5% edge lets a 90% long through)", async () => {
  const ctx = makeCtx();
  await seedRangeBars(ctx);
  const decision = await run(ctx, config({ rangeLocationFilter: true, rangeFilterEdgePct: 0.05 }), { price: 190 });
  assert.equal(decision.approvedForExecution, true);
  assert.equal((await stateRows(ctx.stateDb, "positions")).length, 1);
});

test("range filter OFF (default): the near-high long opens and no rangeFilter evidence is written", async () => {
  const ctx = makeCtx();
  await seedRangeBars(ctx);
  const decision = await run(ctx, config(), { price: 190 });

  assert.equal(decision.approvedForExecution, true);
  assert.equal((await stateRows(ctx.stateDb, "positions")).length, 1);
  const { row, debate } = await decisionRow(ctx);
  assert.equal(row.status, TRADE_DECISION_STATUS.OPENED);
  assert.equal(debate.evidence.rangeFilter, undefined);
});

// ---------------------------------------------------------------------------
// entryConfirmation
// ---------------------------------------------------------------------------

async function confirmationCtx(modelOpts, { price = 180 } = {}) {
  const ctx = makeCtx();
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-14", close: price });
  await run(ctx, config({ entryConfirmation: true }, modelOpts), { price });
  return ctx;
}

/** Flat 5-minute intraday bars after the decision: [open time, close]. */
const seedBars = (ctx, bars) => Promise.all(bars.map(([hhmm, close]) => seedIntradayBar(ctx.inputs, { ticker: "AAPL", ts: `2026-01-15T${hhmm}:00Z`, close })));

test("confirmation ON: a fresh-price entry is stored as pending_entry with its reference price and a 6h deadline -- no position", async () => {
  const ctx = await confirmationCtx();

  assert.equal((await stateRows(ctx.stateDb, "positions")).length, 0);
  const { row, debate } = await decisionRow(ctx);
  assert.equal(row.status, TRADE_DECISION_STATUS.PENDING_ENTRY);
  assert.equal(row.fill_expires_at, "2026-01-15T19:36:00.000Z");
  assert.deepEqual(debate.evidence.entryConfirmation, { status: "pending", refPrice: 180, movePct: 0.005, hours: 6 });
});

test("confirmation ON: per-run move / hours are used for the spec and the deadline", async () => {
  const ctx = makeCtx();
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-14", close: 180 });
  await run(ctx, config({ entryConfirmation: true, entryConfirmMovePct: 0.02, entryConfirmHours: 2 }), { price: 180 });

  const { row, debate } = await decisionRow(ctx);
  assert.equal(row.fill_expires_at, "2026-01-15T15:36:00.000Z");
  assert.equal(debate.evidence.entryConfirmation.movePct, 0.02);
  assert.equal(debate.evidence.entryConfirmation.hours, 2);
});

test("confirmation: a bar closing the required move confirms; the entry opens at the NEXT bar's open and the outcome is recorded", async () => {
  const ctx = await confirmationCtx();
  await seedBars(ctx, [["13:40", 180], ["13:45", 183], ["13:50", 184]]); // 183 closes +1.67% at 13:50; the 13:50 bar opens at 184

  const { filled, expired, waiting } = await fillPendingEntries({}, config({ entryConfirmation: true }), ctx, { asOf: "2026-01-15T14:30:00Z" });
  assert.deepEqual([filled.length, expired.length, waiting], [1, 0, 0]);
  assert.equal(filled[0].openedAt, "2026-01-15T13:50:00.000Z");

  const [position] = await stateRows(ctx.stateDb, "positions");
  assert.equal(position.entry_price, 184, "the open of the bar after the confirming bar, not the confirming close and not the signal-time price");
  assert.equal(position.opened_at, "2026-01-15T13:50:00.000Z");
  assert.equal(position.entry_price_source, "intraday");
  assert.equal(position.direction, "long");

  const { row, debate } = await decisionRow(ctx);
  assert.equal(row.status, TRADE_DECISION_STATUS.OPENED);
  const outcome = debate.evidence.entryConfirmation;
  assert.equal(outcome.status, "confirmed");
  assert.equal(outcome.refPrice, 180);
  assert.equal(outcome.confirmedAt, "2026-01-15T13:50:00.000Z");
  assert.equal(outcome.fillPrice, 184);
  assert.equal(outcome.waitedMinutes, 14);
  assert.ok(Math.abs(outcome.confirmMovePct - 3 / 180) < 1e-9);
  assert.ok(Math.abs(outcome.fillVsRefPct - 4 / 180) < 1e-9, "how much of the move was gone at the fill, direction-signed");
});

test("confirmation: a short is confirmed by a drop and opens short at the next bar's open", async () => {
  const ctx = await confirmationCtx({ direction: "short" });
  await seedBars(ctx, [["13:40", 176], ["13:45", 175]]); // 176 closes -2.2% at 13:45 (+2.2% for a short); the 13:45 bar opens at 175

  const { filled } = await fillPendingEntries({}, config({ entryConfirmation: true }, { direction: "short" }), ctx, { asOf: "2026-01-15T14:30:00Z" });
  assert.equal(filled.length, 1);
  const [position] = await stateRows(ctx.stateDb, "positions");
  assert.equal(position.direction, "short");
  assert.equal(position.entry_price, 175);
  assert.equal(position.opened_at, "2026-01-15T13:45:00.000Z");
  const { debate } = await decisionRow(ctx);
  assert.equal(debate.evidence.entryConfirmation.status, "confirmed");
  assert.ok(debate.evidence.entryConfirmation.fillVsRefPct > 0);
});

test("confirmation: a move AGAINST the trade keeps waiting before the deadline (nothing opens, still pending)", async () => {
  const ctx = await confirmationCtx();
  await seedBars(ctx, [["13:40", 176], ["13:45", 175], ["13:50", 174]]);

  const res = await fillPendingEntries({}, config({ entryConfirmation: true }), ctx, { asOf: "2026-01-15T14:30:00Z" });
  assert.deepEqual(res, { filled: [], expired: [], waiting: 1 });
  assert.equal((await stateRows(ctx.stateDb, "positions")).length, 0);
  const { row, debate } = await decisionRow(ctx);
  assert.equal(row.status, TRADE_DECISION_STATUS.PENDING_ENTRY);
  assert.equal(debate.evidence.entryConfirmation.status, "pending");
});

test("confirmation: never confirmed by the deadline -> skipped_no_fill, outcome 'expired' recorded; a confirming bar that closes too late does not count", async () => {
  const ctx = await confirmationCtx();
  // The only qualifying close (+5.6%) arrives in a bar that closes at 19:40, after the 19:36 deadline.
  await seedBars(ctx, [["13:40", 179], ["15:00", 179], ["19:35", 190]]);

  const res = await fillPendingEntries({}, config({ entryConfirmation: true }), ctx, { asOf: "2026-01-15T20:00:00Z" });
  assert.deepEqual([res.filled.length, res.expired.length, res.waiting], [0, 1, 0]);
  assert.equal((await stateRows(ctx.stateDb, "positions")).length, 0);
  const { row, debate } = await decisionRow(ctx);
  assert.equal(row.status, TRADE_DECISION_STATUS.SKIPPED_NO_FILL);
  assert.equal(debate.evidence.entryConfirmation.status, "expired");
  assert.equal(debate.evidence.entryConfirmation.refPrice, 180);
});

test("confirmation: re-running the fill after it filled opens nothing more (idempotent)", async () => {
  const ctx = await confirmationCtx();
  await seedBars(ctx, [["13:40", 183], ["13:45", 184]]);

  const first = await fillPendingEntries({}, config({ entryConfirmation: true }), ctx, { asOf: "2026-01-15T14:30:00Z" });
  assert.equal(first.filled.length, 1);
  const second = await fillPendingEntries({}, config({ entryConfirmation: true }), ctx, { asOf: "2026-01-15T14:30:00Z" });
  assert.deepEqual(second, { filled: [], expired: [], waiting: 0 });
  assert.equal((await stateRows(ctx.stateDb, "positions")).length, 1);
  assert.equal((await decisionRow(ctx)).debate.evidence.entryConfirmation.status, "confirmed", "the late re-run does not overwrite the outcome");
});

test("confirmation: a crash after the outcome was written but before the commit re-runs the SAME confirming fill (spec found by its numbers)", async () => {
  const ctx = await confirmationCtx();
  await seedBars(ctx, [["13:40", 183], ["13:45", 184]]);
  // Simulate the crash window: the 'confirmed' outcome is already on the still-pending row.
  await ctx.store.recordEntryConfirmation({ id: "AAPL|" + ASOF, outcome: { status: "confirmed", refPrice: 180, movePct: 0.005, hours: 6 } });
  assert.equal((await decisionRow(ctx)).row.status, TRADE_DECISION_STATUS.PENDING_ENTRY);

  const { filled } = await fillPendingEntries({}, config({ entryConfirmation: true }), ctx, { asOf: "2026-01-15T14:30:00Z" });
  assert.equal(filled.length, 1);
  const [position] = await stateRows(ctx.stateDb, "positions");
  assert.equal(position.entry_price, 184, "filled at the confirming fill, not at the first bar after the decision");
  assert.equal(position.opened_at, "2026-01-15T13:45:00.000Z");
});

test("recordEntryConfirmation only touches a decision that is still pending_entry", async () => {
  const ctx = await confirmationCtx();
  await seedBars(ctx, [["13:40", 183], ["13:45", 184]]);
  await fillPendingEntries({}, config({ entryConfirmation: true }), ctx, { asOf: "2026-01-15T14:30:00Z" });

  const changed = await ctx.store.recordEntryConfirmation({ id: "AAPL|" + ASOF, outcome: { status: "expired", refPrice: 1, movePct: 1 } });
  assert.equal(changed, false);
  assert.equal((await decisionRow(ctx)).debate.evidence.entryConfirmation.status, "confirmed");
  assert.equal(await ctx.store.recordEntryConfirmation({ id: "nope", outcome: { status: "expired" } }), false);
});

test("confirmation OFF (default): the same fresh-price entry opens immediately at that price", async () => {
  const ctx = makeCtx();
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-14", close: 180 });
  await run(ctx, config(), { price: 180 });

  const [position] = await stateRows(ctx.stateDb, "positions");
  assert.equal(position.entry_price, 180);
  const { row, debate } = await decisionRow(ctx);
  assert.equal(row.status, TRADE_DECISION_STATUS.OPENED);
  assert.equal(debate.evidence.entryConfirmation, undefined);
});

test("both ON: a range-blocked entry is rejected outright (never reaches the confirmation wait)", async () => {
  const ctx = makeCtx();
  await seedRangeBars(ctx);
  const decision = await run(ctx, config({ rangeLocationFilter: true, entryConfirmation: true }), { price: 190 });

  assert.equal(decision.approvedForExecution, false);
  const { row, debate } = await decisionRow(ctx);
  assert.equal(row.status, TRADE_DECISION_STATUS.REJECTED);
  assert.equal(debate.evidence.entryConfirmation, undefined);
  assert.equal(debate.evidence.rangeFilter.blocked, true);
});

test("both ON: an allowed entry waits for confirmation, and the record carries the range filter pass too", async () => {
  const ctx = makeCtx();
  await seedRangeBars(ctx);
  await run(ctx, config({ rangeLocationFilter: true, entryConfirmation: true }), { price: 120 });

  const { row, debate } = await decisionRow(ctx);
  assert.equal(row.status, TRADE_DECISION_STATUS.PENDING_ENTRY);
  assert.equal(debate.evidence.rangeFilter.blocked, false);
  assert.equal(debate.evidence.entryConfirmation.refPrice, 120);
});
