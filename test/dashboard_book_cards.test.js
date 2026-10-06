// Covers the phone-first Book page cards (src/dashboard/position_cards.js) and the
// exposure row / expander wiring in views/positions.js.
import test from "node:test";
import assert from "node:assert/strict";
import { openPositionCards, closedPositionCards } from "../src/dashboard/position_cards.js";
import { renderPositionsView } from "../src/dashboard/views/positions.js";

const open = { ticker: "AAPL", direction: "long", positionSizePct: 0.05, entryPrice: 100, maePct: -0.0213, mfePct: 0.0345, openedAt: "2026-09-15T10:00:00Z" };
const closed = { ticker: "MSFT", direction: "short", positionSizePct: 0.03, entryPrice: 200, exitPrice: 190.5, realizedReturn: 0.0412, openedAt: "2026-09-15T10:00:00Z", closedAt: "2026-09-16T10:00:00Z", closeReason: "take_profit" };
const PARAMS = { positionsLimit: 50, env: "live" };

test("open cards show ticker, direction pill, size, entry and signed MAE/MFE, and no table markup", () => {
  const html = openPositionCards([open]);
  assert.match(html, /pos-card-ticker">AAPL</);
  assert.match(html, /<span class="status status-approved">long</);
  assert.match(html, /title="Position size">5\.0%</);
  assert.match(html, /<dt>Entry<\/dt><dd class="">\$100\.00</);
  assert.match(html, /<dd class="pos-neg">-2\.1%</);
  assert.match(html, /<dd class="pos-pos">\+3\.5%</);
  assert.doesNotMatch(html, /<table/);
});

test("open cards show a dash for an unsampled MAE/MFE and for a missing size, never NaN", () => {
  const html = openPositionCards([{ ...open, maePct: null, mfePct: undefined, positionSizePct: null }]);
  assert.match(html, /title="Position size">\u2014</);
  assert.match(html, /<dd class="pos-flat">\u2014</);
  assert.doesNotMatch(html, /NaN/);
});

test("closed cards lead with net P&L (toned), show entry/exit/size, the reason pill, and a dash for a missing exit", () => {
  const html = closedPositionCards([closed, { ...closed, ticker: "NVDA", exitPrice: null, realizedReturn: -0.02, closeReason: "stop_loss" }]);
  assert.match(html, /pos-card-main pos-pos" title="Return net of round-trip trading costs">\+4\.1%</);
  assert.match(html, /pos-card-main pos-neg"[^>]*>-2\.0%</);
  assert.match(html, /<dt>Exit<\/dt><dd class="">\$190\.50</);
  assert.match(html, /<dt>Exit<\/dt><dd class="">\u2014</);
  assert.match(html, /<span class="status status-approved">take profit</);
  assert.match(html, /<span class="status status-rejected">stop loss</);
});

test("closed cards flag gross (pre-cost-model) returns in the P&L tooltip", () => {
  assert.match(closedPositionCards([{ ...closed, returnIsNet: false }]), /title="Gross return \(this run predates the cost model\)"/);
});

test("empty lists render the plain 'None.' note", () => {
  assert.match(openPositionCards([]), /None\./);
  assert.match(closedPositionCards([]), /None\./);
});

test("Book page: exposure row with tone, cards for both lists, charts behind an expander", () => {
  const html = renderPositionsView({ openPositions: [open], openPositionsError: null, closedPositions: [closed], closedPositionsError: null, params: PARAMS, totalExposurePct: 62.5 });
  assert.match(html, /book-exposure-value">62\.5%</);
  assert.match(html, /book-bar-fill--warn/);
  assert.match(html, /1 open &middot; 1 long \/ 0 short/);
  assert.match(html, /pos-card-ticker">AAPL</);
  assert.match(html, /pos-card-ticker">MSFT</);
  assert.match(html, /<details class="llm-answer book-more"><summary>Charts and exit stats<\/summary>/);
  assert.doesNotMatch(html, /<table/);
});

test("Book page: a failed open-positions load shows the error, not misleading counts, and keeps the closed list", () => {
  const html = renderPositionsView({ openPositions: [], openPositionsError: "LIVE_DB unavailable", closedPositions: [closed], closedPositionsError: null, params: PARAMS, totalExposurePct: 0 });
  assert.match(html, /LIVE_DB unavailable/);
  assert.doesNotMatch(html, /0 open &middot;/);
  assert.match(html, /pos-card-ticker">MSFT</);
});
