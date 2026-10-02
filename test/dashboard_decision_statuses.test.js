// The dashboard used to key its approved/rejected logic on status 'approved', but
// RunStore#commitThesis has written 'opened' since M2 -- so Approved counts and the
// approval rate read 0, and the Status filter's 'approved' option matched nothing.
// The older dashboard tests seed the retired 'approved' string directly, which is
// how that went unnoticed. These tests render with the store's REAL vocabulary
// (shared/constants.js#TRADE_DECISION_STATUS and the position close reasons).

import test from "node:test";
import assert from "node:assert/strict";
import {
  DECISION_STATUS_OPTIONS, DECISION_APPROVED_STATUS, decisionBadge, renderSummaryCards, renderBookCharts, decisionsActivityChart,
} from "../src/dashboard/helpers.js";
import { renderSnapshotView } from "../src/dashboard/views/snapshot.js";
import { renderPositionsView } from "../src/dashboard/views/positions.js";
import { TRADE_DECISION_STATUS } from "../src/shared/constants.js";

const TOTALS = { opened: 2, rejected: 1, held: 2, superseded: 1 };
const PARAMS = { activityDays: 14, decisionStatus: "all", decisionLimit: 20, positionsLimit: 50, env: "live" };

test("'approved' in the dashboard means the store's 'opened' status", () => {
  assert.equal(DECISION_APPROVED_STATUS, TRADE_DECISION_STATUS.OPENED);
  assert.equal(DECISION_APPROVED_STATUS, "opened");
});

test("Status filter options come from TRADE_DECISION_STATUS: every real status is filterable, the retired 'approved' is not", () => {
  assert.equal(DECISION_STATUS_OPTIONS[0], "all");
  for (const status of Object.values(TRADE_DECISION_STATUS)) {
    assert.ok(DECISION_STATUS_OPTIONS.includes(status), `${status} must be a filter option`);
  }
  assert.ok(!DECISION_STATUS_OPTIONS.includes("approved"));
});

test("decisionBadge: opened is green, rejected is red, held/superseded/skipped are neutral", () => {
  assert.match(decisionBadge("opened"), /status-approved/);
  assert.match(decisionBadge("rejected"), /status-rejected/);
  for (const status of ["held", "superseded", "skipped_no_price_data", "pending_entry", "skipped_no_fill"]) {
    assert.match(decisionBadge(status), /status-neutral/, `${status} is neutral`);
  }
  assert.match(decisionBadge("held"), />\s*held</);
  assert.match(decisionBadge("skipped_no_price_data"), /skipped \(no price\)/);
  assert.match(decisionBadge("pending_entry"), /pending entry/);
  assert.match(decisionBadge("skipped_no_fill"), /skipped \(no fill\)/);
});

test("renderSummaryCards counts 'opened' as approved: approval rate = opened / (opened + rejected), held/superseded are 'other'", () => {
  const html = renderSummaryCards({
    openPositions: [], closedPositions: [], decisionStats: { totals: TOTALS, daily: [] }, totalExposurePct: 0,
  });
  assert.match(html, /2 approved \/ 1 rejected \/ 3 other/);
  assert.match(html, /67%/);
});

test("renderSummaryCards with only non-approved statuses shows a dash, not a bogus 0% rate", () => {
  const html = renderSummaryCards({
    openPositions: [], closedPositions: [], decisionStats: { totals: { held: 4 }, daily: [] }, totalExposurePct: 0,
  });
  assert.match(html, /0 approved \/ 0 rejected \/ 4 other/);
  assert.match(html, /\u2014/, "approval-rate card shows an em dash when nothing was decided");
});

test("Book panel's decision bar reads the 'opened' total, with every share out of all decisions", () => {
  const html = renderBookCharts({
    openPositions: [], decisionStats: { totals: TOTALS, daily: [] }, totalExposurePct: 0,
  });
  assert.match(html, /ov-book/);
  assert.doesNotMatch(html, /chart-row-3/);
  // TOTALS = opened 2, rejected 1, held 2 + superseded 1 (other 3): 6 decisions in all.
  assert.match(html, /Approved <b>2<\/b> <span class="stack-pct">33%/);
  assert.match(html, /Rejected <b>1<\/b> <span class="stack-pct">17%/);
  assert.match(html, /Other <b>3<\/b> <span class="stack-pct">50%/);
});

test("Snapshot view shows the recently-closed table and no longer duplicates Overview's cards and charts", () => {
  const html = renderSnapshotView({
    openPositions: [], closedPositions: [], decisionStats: { totals: TOTALS, daily: [] }, totalExposurePct: 0, error: null,
  });
  assert.match(html, /Recently closed/);
  assert.doesNotMatch(html, /stat-grid/);
  assert.doesNotMatch(html, /chart-row-3/);
});

test("decisionsActivityChart stacks 'opened' as the approved (green) segment and gives 'held' its own color", () => {
  const today = new Date().toISOString().slice(0, 10);
  const html = decisionsActivityChart(
    [
      { day: today, status: "opened", count: 2 },
      { day: today, status: "held", count: 1 },
    ],
    7
  );
  assert.match(html, /: 2 opened</);
  assert.match(html, /: 1 held</);
  assert.match(html, /fill="var\(--color-success-text\)"/);
  assert.match(html, /fill="var\(--color-info-text\)"/);
});

test("Positions exit donut labels flipped / replaced / time_based closes instead of lumping them into Other", () => {
  const closed = [
    { closeReason: "take_profit" },
    { closeReason: "stop_loss" },
    { closeReason: "flipped" },
    { closeReason: "replaced" },
    { closeReason: "time_based" },
  ].map((p, i) => ({ id: `p${i}`, ticker: "AAPL", direction: "long", positionSizePct: 0.05, entryPrice: 100, exitPrice: 101, openedAt: "2026-01-01T00:00:00.000Z", closedAt: "2026-01-02T00:00:00.000Z", ...p }));
  const html = renderPositionsView({
    openPositions: [], openPositionsError: null, closedPositions: closed, closedPositionsError: null, params: PARAMS, totalExposurePct: 0,
  });
  for (const label of ["Take profit", "Stop loss", "Flipped", "Replaced", "Time exit"]) {
    assert.match(html, new RegExp(label), `${label} slice`);
  }
});

test("break-even / trailing stop closes get their own donut slices and a summary-card count, not Other / stop-loss", () => {
  const closed = ["stop_loss", "breakeven_stop", "trailing_stop", "trailing_stop"].map((closeReason, i) => ({
    id: `r${i}`, ticker: "AAPL", direction: "long", positionSizePct: 0.05, entryPrice: 100, exitPrice: 101,
    openedAt: "2026-01-01T00:00:00.000Z", closedAt: "2026-01-02T00:00:00.000Z", closeReason,
  }));
  const view = renderPositionsView({
    openPositions: [], openPositionsError: null, closedPositions: closed, closedPositionsError: null, params: PARAMS, totalExposurePct: 0,
  });
  assert.match(view, /Break-even stop/);
  assert.match(view, /Trailing stop/);
  assert.doesNotMatch(view, />Other</, "ratcheted stops are not lumped into Other");
  const cards = renderSummaryCards({ openPositions: [], closedPositions: closed, decisionStats: { totals: TOTALS, daily: [] }, totalExposurePct: 0 });
  assert.match(cards, /1 stop-loss \/ 0 take-profit \/ 3 trailing/);
  const none = renderSummaryCards({ openPositions: [], closedPositions: [], decisionStats: { totals: TOTALS, daily: [] }, totalExposurePct: 0 });
  assert.doesNotMatch(none, /trailing/, "no ratcheted closes: summary text unchanged");
});
