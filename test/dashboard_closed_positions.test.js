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

test("open and closed tables show MAE/MFE as signed percents, and a dash for a position never sampled", () => {
  const sampled = { ...closed, maePct: -0.0213, mfePct: 0.0345 };
  for (const html of [positionsTable([sampled]), positionsTable([sampled], { closed: true })]) {
    assert.match(html, /<th>MAE<\/th><th>MFE<\/th>/);
    assert.match(html, /data-label="MAE"[^>]*>-2\.1%</);
    assert.match(html, /data-label="MFE"[^>]*>\+3\.5%</);
  }
  const unsampled = positionsTable([{ ...closed, maePct: null, mfePct: undefined }]);
  assert.match(unsampled, /data-label="MAE"[^>]*>\u2014</);
  assert.match(unsampled, /data-label="MFE"[^>]*>\u2014</);
  assert.match(positionsTable([{ ...closed, maePct: 0, mfePct: 0 }]), /data-label="MFE"[^>]*>0\.0%</, "a real zero is shown, not treated as missing");
});

test("direction and exit reason render as pills, with underscores removed from the reason", () => {
  const html = positionsTable([closed, { ...closed, direction: "short", closeReason: "time_based" }, { ...closed, closeReason: "stop_loss" }], { closed: true });
  assert.match(html, /data-label="Direction"><span class="status status-approved">long</);
  assert.match(html, /data-label="Direction"><span class="status status-rejected">short</);
  assert.match(html, /data-label="Reason"><span class="status status-approved">take profit</);
  assert.match(html, /data-label="Reason"><span class="status status-rejected">stop loss</);
  assert.match(html, /data-label="Reason"><span class="status status-neutral">time based</);
  assert.match(positionsTable([{ ...closed, direction: null, closeReason: null }], { closed: true }), /data-label="Direction">\u2014</);
});

test("the Positions page no longer claims exit prices are not recorded", () => {
  const html = renderPositionsView({ openPositions: [], openPositionsError: null, closedPositions: [closed], closedPositionsError: null, params: { positionsLimit: 50, env: "live" }, totalExposurePct: 0 });
  assert.doesNotMatch(html, /No exit price is recorded/);
  assert.match(html, /exit price is recorded on close/);
});
