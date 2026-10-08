// Loss-at-stop ceiling (MAX_PORTFOLIO_STOP_RISK_PCT): sum of size * stop over open
// positions, checked in portfolio_manager.js (JS) and in RunStore#commitThesis (SQL),
// alongside the existing gross-exposure ceiling. Real sqlite-backed D1, same as run_store.test.js.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { RunStore } from "../src/storage/run_store.js";
import { evaluatePortfolio } from "../src/agents/managers/portfolio_manager.js";
import { FALLBACK_STOP_LOSS_PCT, MAX_PORTFOLIO_STOP_RISK_PCT, MAX_PORTFOLIO_RISK_PCT } from "../src/shared/constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, "..", "migrations", "state");

function newStore() {
  return new RunStore(createTestD1([STATE_DIR]), "live");
}

function risk({ positionSizePct = 0.05, stopLossPct } = {}) {
  return { tradeThesisId: "X|t", approved: true, positionSizePct, stopLossPct, takeProfitPct: stopLossPct ? stopLossPct * 2 : undefined, reason: "test" };
}

function thesisArgs({ id, ticker, asOf, positionSizePct = 0.05, stopLossPct = 0.03 }) {
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

test("evaluatePortfolio rejects when loss-at-stop would exceed the ceiling even though exposure is fine", () => {
  // 10% at a 22% stop = 2.2% of the book; another 0.01% already open -> 2.21% > 2.0% (MAX_PORTFOLIO_STOP_RISK_PCT). Exposure 0.10 <= MAX_PORTFOLIO_RISK_PCT.
  const d = evaluatePortfolio(risk({ positionSizePct: 0.10, stopLossPct: 0.22 }), { openPositionsRiskPct: 0.10, openPositionsStopRiskPct: 0.0001 });
  assert.equal(d.approvedForExecution, false);
  assert.equal(d.finalPositionSizePct, 0);
  assert.match(d.reason, /loss-at-stop/);
});

test("evaluatePortfolio approves when loss-at-stop is under the ceiling", () => {
  const d = evaluatePortfolio(risk({ positionSizePct: 0.05, stopLossPct: 0.03 }), { openPositionsRiskPct: 0.05, openPositionsStopRiskPct: 0.0015 });
  assert.equal(d.approvedForExecution, true);
  assert.equal(d.finalPositionSizePct, 0.05);
});

test("evaluatePortfolio charges the fallback stop when the risk decision has none", () => {
  const d = evaluatePortfolio(risk({ positionSizePct: 0.05 }), { openPositionsStopRiskPct: MAX_PORTFOLIO_STOP_RISK_PCT - 0.05 * FALLBACK_STOP_LOSS_PCT - 0.0001 });
  assert.equal(d.approvedForExecution, true);
  const over = evaluatePortfolio(risk({ positionSizePct: 0.05 }), { openPositionsStopRiskPct: MAX_PORTFOLIO_STOP_RISK_PCT - 0.05 * FALLBACK_STOP_LOSS_PCT + 0.0001 });
  assert.equal(over.approvedForExecution, false);
});

test("evaluatePortfolio without openPositionsStopRiskPct keeps the exposure-only behavior", () => {
  const d = evaluatePortfolio(risk({ positionSizePct: 0.05, stopLossPct: 0.03 }), { openPositionsRiskPct: MAX_PORTFOLIO_RISK_PCT - 0.05 });
  assert.equal(d.approvedForExecution, true);
  const over = evaluatePortfolio(risk({ positionSizePct: 0.05, stopLossPct: 0.03 }), { openPositionsRiskPct: MAX_PORTFOLIO_RISK_PCT + 0.01 });
  assert.equal(over.approvedForExecution, false);
  assert.match(over.reason, /combined portfolio risk/);
});

test("getOpenPositionsRiskAsOf returns exposure and loss-at-stop from one read, charging the fallback to a stop-less row", async () => {
  const store = newStore();
  await store.openPosition({ id: "AAPL|t1", ticker: "AAPL", tradeThesisId: "AAPL|t1", positionSizePct: 0.04, stopLossPct: 0.05, openedAt: "2026-01-01T00:00:00Z" });
  await store.openPosition({ id: "MSFT|t1", ticker: "MSFT", tradeThesisId: "MSFT|t1", positionSizePct: 0.02, openedAt: "2026-01-02T00:00:00Z" });

  const { exposurePct, stopRiskPct } = await store.getOpenPositionsRiskAsOf({ asOf: "2026-01-10T00:00:00Z" });
  assert.ok(Math.abs(exposurePct - 0.06) < 1e-12);
  assert.ok(Math.abs(stopRiskPct - (0.04 * 0.05 + 0.02 * FALLBACK_STOP_LOSS_PCT)) < 1e-12);

  const net = await store.getOpenPositionsRiskAsOf({ asOf: "2026-01-10T00:00:00Z", excludeTicker: "AAPL" });
  assert.ok(Math.abs(net.exposurePct - 0.02) < 1e-12);
  assert.ok(Math.abs(net.stopRiskPct - 0.02 * FALLBACK_STOP_LOSS_PCT) < 1e-12);

  assert.equal(await store.getOpenPositionsRiskPctAsOf({ asOf: "2026-01-10T00:00:00Z" }), exposurePct);
});

test("commitThesis rejects in SQL when loss-at-stop would breach the ceiling (exposure alone would pass)", async () => {
  const store = newStore();
  await store.commitThesis(thesisArgs({ id: "AAPL|t1", ticker: "AAPL", asOf: "2026-01-05T00:00:00Z", positionSizePct: 0.20, stopLossPct: 0.09 }));
  assert.equal(await statusOf(store, "AAPL|t1"), "opened");

  await store.commitThesis(thesisArgs({ id: "MSFT|t1", ticker: "MSFT", asOf: "2026-01-06T00:00:00Z", positionSizePct: 0.10, stopLossPct: 0.12 }));
  assert.equal(await statusOf(store, "MSFT|t1"), "rejected");
  assert.equal(await store.getOpenPositionForTickerAsOf({ ticker: "MSFT", asOf: "2026-01-07T00:00:00Z" }), null);
});

test("commitThesis opens when the second position's stop keeps loss-at-stop under the ceiling", async () => {
  const store = newStore();
  await store.commitThesis(thesisArgs({ id: "AAPL|t1", ticker: "AAPL", asOf: "2026-01-05T00:00:00Z", stopLossPct: 0.08 }));
  await store.commitThesis(thesisArgs({ id: "MSFT|t1", ticker: "MSFT", asOf: "2026-01-06T00:00:00Z", stopLossPct: 0.03 }));
  assert.equal(await statusOf(store, "MSFT|t1"), "opened");
});

test("a ticker replacing its own position is not double-counted by the loss-at-stop ceiling", async () => {
  const store = newStore();
  await store.commitThesis(thesisArgs({ id: "AAPL|t1", ticker: "AAPL", asOf: "2026-01-05T00:00:00Z", stopLossPct: 0.08 }));
  // Opposite direction with confidence >= flip threshold would flip; same-direction is held. Either way the
  // ceiling sum excludes AAPL itself, so a lone ticker never trips it against its own old position.
  await store.commitThesis({ ...thesisArgs({ id: "AAPL|t2", ticker: "AAPL", asOf: "2026-01-06T00:00:00Z", stopLossPct: 0.08 }), direction: "short", confidence: 0.9 });
  assert.equal(await statusOf(store, "AAPL|t2"), "opened");
});
