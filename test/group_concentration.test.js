// Same-direction per-group concentration cap (MAX_GROUP_EXPOSURE_PCT, TICKER_GROUPS):
// evaluatePortfolio sums open same-direction positions in the ticker's group and rejects a thesis
// that would push the group over the cap. The open positions come from the same query as the other
// two ceilings (RunStore#getOpenPositionsRiskAsOf). Real sqlite-backed D1 for the store part.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { RunStore } from "../src/storage/run_store.js";
import { evaluatePortfolio } from "../src/agents/managers/portfolio_manager.js";
import { MAX_GROUP_EXPOSURE_PCT, TICKER_GROUPS, groupOfTicker } from "../src/shared/constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, "..", "migrations", "state");

function risk({ positionSizePct = 0.05, stopLossPct = 0.03 } = {}) {
  return { tradeThesisId: "X|t", approved: true, positionSizePct, stopLossPct, takeProfitPct: stopLossPct * 2, reason: "test" };
}

const pos = (ticker, direction, positionSizePct = 0.05) => ({ ticker, direction, positionSizePct });

test("group map: equities share a group, USO and XAUUSD are their own, unknown tickers are their own", () => {
  assert.equal(groupOfTicker("AAPL"), groupOfTicker("MSFT"));
  assert.equal(groupOfTicker("MSFT"), groupOfTicker("TSLA"));
  assert.notEqual(groupOfTicker("USO"), groupOfTicker("XAUUSD"));
  assert.notEqual(groupOfTicker("USO"), groupOfTicker("AAPL"));
  assert.equal(groupOfTicker("NVDA"), "NVDA");
  assert.equal(TICKER_GROUPS.XAUUSD, "gold");
});

test("two full 5% same-direction positions in one group fit the 10% cap; the third is rejected", () => {
  assert.equal(MAX_GROUP_EXPOSURE_PCT, 0.1);
  const second = evaluatePortfolio(risk(), { ticker: "MSFT", direction: "long", openPositions: [pos("AAPL", "long")] });
  assert.equal(second.approvedForExecution, true, "0.05 + 0.05 == the cap, not over it");

  const third = evaluatePortfolio(risk(), { ticker: "TSLA", direction: "long", openPositions: [pos("AAPL", "long"), pos("MSFT", "long")] });
  assert.equal(third.approvedForExecution, false);
  assert.equal(third.finalPositionSizePct, 0);
  assert.match(third.reason, /concentration/);
  assert.match(third.reason, /equity/);
});

test("an opposite-direction position in the group offsets and is not counted", () => {
  const d = evaluatePortfolio(risk(), { ticker: "TSLA", direction: "long", openPositions: [pos("AAPL", "long"), pos("MSFT", "short")] });
  assert.equal(d.approvedForExecution, true);
});

test("positions in another group are not counted", () => {
  const d = evaluatePortfolio(risk(), { ticker: "AAPL", direction: "long", openPositions: [pos("USO", "long"), pos("XAUUSD", "long")] });
  assert.equal(d.approvedForExecution, true);
});

test("a position with no stored direction is counted (it cannot be netted)", () => {
  const d = evaluatePortfolio(risk(), { ticker: "TSLA", direction: "long", openPositions: [pos("AAPL", "long"), pos("MSFT", null)] });
  assert.equal(d.approvedForExecution, false);
  assert.match(d.reason, /concentration/);
});

test("a ticker's own position is never counted against itself", () => {
  const d = evaluatePortfolio(risk(), { ticker: "AAPL", direction: "long", openPositions: [pos("AAPL", "long", 0.05), pos("MSFT", "long")] });
  assert.equal(d.approvedForExecution, true);
});

test("the check is skipped when ticker, direction or openPositions is missing, or the direction is flat", () => {
  const open = [pos("AAPL", "long"), pos("MSFT", "long")];
  assert.equal(evaluatePortfolio(risk(), { direction: "long", openPositions: open }).approvedForExecution, true);
  assert.equal(evaluatePortfolio(risk(), { ticker: "TSLA", openPositions: open }).approvedForExecution, true);
  assert.equal(evaluatePortfolio(risk(), { ticker: "TSLA", direction: "long" }).approvedForExecution, true);
  assert.equal(evaluatePortfolio(risk(), { ticker: "TSLA", direction: "flat", openPositions: open }).approvedForExecution, true);
});

test("a smaller thesis still fits when the group has headroom", () => {
  const d = evaluatePortfolio(risk({ positionSizePct: 0.02 }), { ticker: "TSLA", direction: "long", openPositions: [pos("AAPL", "long", 0.05), pos("MSFT", "long", 0.03)] });
  assert.equal(d.approvedForExecution, true, "0.05 + 0.03 + 0.02 = 0.10");
  const over = evaluatePortfolio(risk({ positionSizePct: 0.03 }), { ticker: "TSLA", direction: "long", openPositions: [pos("AAPL", "long", 0.05), pos("MSFT", "long", 0.03)] });
  assert.equal(over.approvedForExecution, false);
});

test("the existing ceilings still reject first and keep their own reason", () => {
  const d = evaluatePortfolio(risk(), { openPositionsRiskPct: 0.17, ticker: "TSLA", direction: "long", openPositions: [pos("AAPL", "long"), pos("MSFT", "long")] });
  assert.equal(d.approvedForExecution, false);
  assert.match(d.reason, /combined portfolio risk/);
});

test("getOpenPositionsRiskAsOf returns the open positions (ticker, direction, size) from the same read, honoring excludeTicker", async () => {
  const store = new RunStore(createTestD1([STATE_DIR]), "live");
  await store.openPosition({ id: "AAPL|t1", ticker: "AAPL", tradeThesisId: "AAPL|t1", positionSizePct: 0.04, direction: "long", stopLossPct: 0.05, openedAt: "2026-01-01T00:00:00Z" });
  await store.openPosition({ id: "MSFT|t1", ticker: "MSFT", tradeThesisId: "MSFT|t1", positionSizePct: 0.02, openedAt: "2026-01-02T00:00:00Z" });

  const all = await store.getOpenPositionsRiskAsOf({ asOf: "2026-01-10T00:00:00Z" });
  assert.equal(all.positions.length, 2);
  const aapl = all.positions.find((p) => p.ticker === "AAPL");
  assert.equal(aapl.direction, "long");
  assert.equal(aapl.positionSizePct, 0.04);
  const msft = all.positions.find((p) => p.ticker === "MSFT");
  assert.equal(msft.direction, null, "a row with no stored direction comes back as null");

  const net = await store.getOpenPositionsRiskAsOf({ asOf: "2026-01-10T00:00:00Z", excludeTicker: "AAPL" });
  assert.deepEqual(net.positions.map((p) => p.ticker), ["MSFT"]);
});
