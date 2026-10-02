// Snapshot view: one heading with count, one note, a single empty state, heading kept on error.
import test from "node:test";
import assert from "node:assert/strict";
import { renderSnapshotView } from "../src/dashboard/views/snapshot.js";

const closed = { ticker: "AAPL", direction: "long", positionSizePct: 0.05, entryPrice: 100, exitPrice: 110.5, openedAt: "2026-09-15T10:00:00Z", closedAt: "2026-09-16T10:00:00Z", closeReason: "take_profit" };

test("snapshot shows a single heading with the count, one note and the closed table", () => {
  const html = renderSnapshotView({ closedPositions: [closed, { ...closed, ticker: "MSFT" }], error: null });
  assert.equal(html.match(/<h2>/g).length, 1);
  assert.match(html, /Recently closed <span class="h2-count">2<\/span>/);
  assert.equal(html.match(/class="note"/g).length, 1);
  assert.match(html, /<th>Exit<\/th>/);
});

test("snapshot with no closed positions shows one empty state and no table", () => {
  const html = renderSnapshotView({ closedPositions: [], error: null });
  assert.equal(html.match(/No closed positions yet\./g).length, 1);
  assert.doesNotMatch(html, /<table/);
});

test("snapshot error keeps the heading and note", () => {
  const html = renderSnapshotView({ closedPositions: [], error: "boom" });
  assert.match(html, /Recently closed/);
  assert.match(html, /class="note"/);
  assert.doesNotMatch(html, /<table/);
});
