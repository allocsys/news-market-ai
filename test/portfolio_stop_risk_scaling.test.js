// Loss-at-stop SCALING (portfolio_manager.js): a thesis whose full size would breach MAX_PORTFOLIO_STOP_RISK_PCT is shrunk
// to fit the remaining budget instead of rejected (BTCUSD: 30% size, a stop past ~6.7% used to be thrown away). The scaled
// size is what evaluatePortfolio returns as finalPositionSizePct and what RunStore#commitThesis re-checks in SQL with no
// tolerance, so these tests drive both sides with the same numbers. Real sqlite-backed D1, same as portfolio_stop_risk.test.js.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { RunStore } from "../src/storage/run_store.js";
import { evaluatePortfolio } from "../src/agents/managers/portfolio_manager.js";
import { MAX_PORTFOLIO_STOP_RISK_PCT, MIN_SCALED_POSITION_PCT } from "../src/shared/constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, "..", "migrations", "state");

function newStore() {
  return new RunStore(createTestD1([STATE_DIR]), "live");
}

function risk({ positionSizePct = 0.05, stopLossPct } = {}) {
  return { tradeThesisId: "X|t", approved: true, positionSizePct, stopLossPct, takeProfitPct: stopLossPct ? stopLossPct * 2 : undefined, reason: "test" };
}

function thesisArgs({ id, ticker, asOf, positionSizePct, stopLossPct }) {
  return {
    id,
    ticker,
    tradeThesisId: id,
    positionSizePct,
    direction: "long",
    confidence: 0.8,
    entryPrice: 100,
    stopLossPct,
    takeProfitPct: stopLossPct * 2,
    asOf,
    thesis: { ticker, asOf, direction: "long" },
    riskDecision: { approved: true, positionSizePct },
    createdAt: asOf,
  };
}

async function statusOf(store, id) {
  const row = await store.db.prepare(`SELECT status FROM trade_decisions WHERE run_id = ? AND id = ?`).bind("live", id).first();
  return row?.status ?? null;
}

const BTC = { ticker: "BTCUSD", direction: "long", openPositions: [] };

test("a wide-stop BTC thesis is scaled down to the 2% loss-at-stop budget instead of rejected", () => {
  // 30% at a 10% stop = 3% of the book > 2%: scaled to the size whose stop loss is just under 2% (0.1999 * 0.1).
  const d = evaluatePortfolio(risk({ positionSizePct: 0.3, stopLossPct: 0.1 }), { ...BTC });
  assert.equal(d.approvedForExecution, true);
  assert.equal(d.finalPositionSizePct, 0.1999);
  assert.ok(d.finalPositionSizePct * 0.1 <= MAX_PORTFOLIO_STOP_RISK_PCT);
  assert.match(d.reason, /scaled down from 0\.3 to 0\.1999/);
});

test("a stop that already fits is not touched", () => {
  // 30% at a 6% stop = 1.8% <= 2%.
  const d = evaluatePortfolio(risk({ positionSizePct: 0.3, stopLossPct: 0.06 }), { ...BTC });
  assert.equal(d.approvedForExecution, true);
  assert.equal(d.finalPositionSizePct, 0.3);
  assert.doesNotMatch(d.reason, /scaled/);
});

test("other tickers' open loss-at-stop shrinks the scaled size", () => {
  // 1% of the budget is already used by other positions, so only 1% is left: 0.01 / 0.1 -> 0.0999.
  const d = evaluatePortfolio(risk({ positionSizePct: 0.3, stopLossPct: 0.1 }), { ...BTC, openPositionsRiskPct: 0.1, openPositionsStopRiskPct: 0.01 });
  assert.equal(d.approvedForExecution, true);
  assert.equal(d.finalPositionSizePct, 0.0999);
});

test("a scaled size under the minimum is still rejected (no dust positions)", () => {
  // 0.5% of budget left at a 10% stop -> ~5% of the book fits (0.0499), above the minimum.
  const fits = evaluatePortfolio(risk({ positionSizePct: 0.3, stopLossPct: 0.1 }), { ...BTC, openPositionsStopRiskPct: 0.015 });
  assert.equal(fits.approvedForExecution, true);
  assert.equal(fits.finalPositionSizePct, 0.0499);
  assert.ok(fits.finalPositionSizePct >= MIN_SCALED_POSITION_PCT);

  // 0.05% left -> ~0.5% of the book, under MIN_SCALED_POSITION_PCT (1%): rejected.
  const dust = evaluatePortfolio(risk({ positionSizePct: 0.3, stopLossPct: 0.1 }), { ...BTC, openPositionsStopRiskPct: 0.0195 });
  assert.equal(dust.approvedForExecution, false);
  assert.equal(dust.finalPositionSizePct, 0);
  assert.match(dust.reason, /loss-at-stop/);

  // Nothing left at all: rejected.
  const exhausted = evaluatePortfolio(risk({ positionSizePct: 0.3, stopLossPct: 0.1 }), { ...BTC, openPositionsStopRiskPct: MAX_PORTFOLIO_STOP_RISK_PCT });
  assert.equal(exhausted.approvedForExecution, false);
});

test("scaling does not bypass the gross-exposure ceiling", () => {
  // Other tickers already hold 49%, so even the scaled 19.99% pushes past the 50% ceiling.
  const exposure = evaluatePortfolio(risk({ positionSizePct: 0.3, stopLossPct: 0.1 }), { ...BTC, openPositionsRiskPct: 0.49 });
  assert.equal(exposure.approvedForExecution, false);
  assert.match(exposure.reason, /combined portfolio risk/);
});

test("the scaled size passes commitThesis's SQL loss-at-stop check; the full size is rejected there", async () => {
  const asOf = "2026-01-06T00:00:00Z";
  const scaled = evaluatePortfolio(risk({ positionSizePct: 0.3, stopLossPct: 0.1 }), { ...BTC });

  const okStore = newStore();
  await okStore.commitThesis(thesisArgs({ id: "BTCUSD|t1", ticker: "BTCUSD", asOf, positionSizePct: scaled.finalPositionSizePct, stopLossPct: 0.1 }));
  assert.equal(await statusOf(okStore, "BTCUSD|t1"), "opened");

  const fullStore = newStore();
  await fullStore.commitThesis(thesisArgs({ id: "BTCUSD|t1", ticker: "BTCUSD", asOf, positionSizePct: 0.3, stopLossPct: 0.1 }));
  assert.equal(await statusOf(fullStore, "BTCUSD|t1"), "rejected");
});

test("with another open position, the JS-scaled size still passes the SQL check (no float edge)", async () => {
  const store = newStore();
  await store.commitThesis(thesisArgs({ id: "AAPL|t1", ticker: "AAPL", asOf: "2026-01-05T00:00:00Z", positionSizePct: 0.05, stopLossPct: 0.08 })); // 0.004 loss-at-stop
  assert.equal(await statusOf(store, "AAPL|t1"), "opened");

  const asOf = "2026-01-06T00:00:00Z";
  const { exposurePct, stopRiskPct, positions } = await store.getOpenPositionsRiskAsOf({ asOf, excludeTicker: "BTCUSD" });
  const d = evaluatePortfolio(risk({ positionSizePct: 0.3, stopLossPct: 0.1 }), {
    openPositionsRiskPct: exposurePct,
    openPositionsStopRiskPct: stopRiskPct,
    ticker: "BTCUSD",
    direction: "long",
    openPositions: positions,
  });
  assert.equal(d.approvedForExecution, true);
  assert.equal(d.finalPositionSizePct, 0.1599);

  await store.commitThesis(thesisArgs({ id: "BTCUSD|t1", ticker: "BTCUSD", asOf, positionSizePct: d.finalPositionSizePct, stopLossPct: 0.1 }));
  assert.equal(await statusOf(store, "BTCUSD|t1"), "opened");
});
