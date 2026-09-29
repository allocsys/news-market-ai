// closePosition must report whether THIS call closed the row, so
// graph/exit_check.js can skip settling a position commitThesis already
// replaced between its read and its write (double-settle race).

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { RunStore } from "../src/storage/run_store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, "..", "migrations", "state");

async function storeWithOpenPosition() {
  const store = new RunStore(createTestD1([STATE_DIR]), "live");
  await store.openPosition({
    id: "AAPL|2026-09-01T00:00:00Z",
    ticker: "AAPL",
    tradeThesisId: "AAPL|2026-09-01T00:00:00Z",
    positionSizePct: 0.05,
    direction: "long",
    entryPrice: 100,
    openedAt: "2026-09-01T00:00:00Z",
  });
  return store;
}

test("closePosition returns true when it closes an open position", async () => {
  const store = await storeWithOpenPosition();
  const closed = await store.closePosition({ id: "AAPL|2026-09-01T00:00:00Z", closedAt: "2026-09-05T00:00:00Z", closeReason: "stop_loss", exitPrice: 96 });
  assert.equal(closed, true);
});

test("closePosition returns false and changes nothing if already closed", async () => {
  const store = await storeWithOpenPosition();
  const id = "AAPL|2026-09-01T00:00:00Z";
  await store.closePosition({ id, closedAt: "2026-09-03T00:00:00Z", closeReason: "replaced", exitPrice: 101 });

  const again = await store.closePosition({ id, closedAt: "2026-09-05T00:00:00Z", closeReason: "stop_loss", exitPrice: 96 });
  assert.equal(again, false);

  const [row] = await store.getPositionsInRange({ from: "2026-09-01T00:00:00Z", to: "2026-09-30T00:00:00Z" });
  assert.equal(row.closeReason, "replaced");
  assert.equal(row.exitPrice, 101);
});
