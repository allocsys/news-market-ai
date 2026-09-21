// Closed-position tables show the recorded exit price (it used to be loaded but
// never displayed, under a note claiming none was recorded).
import test from "node:test";
import assert from "node:assert/strict";
import { positionsTable } from "../src/dashboard/helpers.js";
import { renderPositionsView } from "../src/dashboard/views/positions.js";

const closed = { ticker: "AAPL", direction: "long", positionSizePct: 0.05, entryPrice: 100, exitPrice: 110.5, openedAt: "2026-09-15T10:00:00Z", closedAt: "2026-09-16T10:00:00Z", closeReason: "take_profit" };

test("closed positions show the exit price, a dash when there is none, and open tables have no Exit column", () => {
  const html = positionsTable([closed, { ...closed, ticker: "MSFT", exitPrice: null }], { closed: true });
  assert.match(html, /<th>Exit<\/th>/);
  assert.match(html, /data-label="Exit">\$110\.50</);
  assert.match(html, /data-label="Exit">\u2014</);
  assert.doesNotMatch(positionsTable([closed]), /Exit/);
});

test("the Positions page no longer claims exit prices are not recorded", () => {
  const html = renderPositionsView({ openPositions: [], openPositionsError: null, closedPositions: [closed], closedPositionsError: null, params: { positionsLimit: 50, env: "live" }, totalExposurePct: 0 });
  assert.doesNotMatch(html, /No exit price is recorded/);
  assert.match(html, /exit price is recorded on close/);
});
