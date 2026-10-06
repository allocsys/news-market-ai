import test from "node:test";
import assert from "node:assert/strict";
import { decisionCards } from "../src/dashboard/decision_cards.js";
import { renderSignalsView } from "../src/dashboard/views/signals.js";

const mockDecision = {
  ticker: "AAPL",
  status: "opened",
  createdAt: "2026-09-15T10:00:00Z",
  thesis: { direction: "long" },
  riskDecision: { positionSizePct: 0.05, reason: "Risk approved." },
  portfolioDecision: { reason: "Portfolio looks solid." }
};

const longReason = "A very long rationale to trigger truncation over 140 characters. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam.";

test("decisionCards renders all fields, applies null fallbacks and renders view expander", () => {
  const html = decisionCards([mockDecision]);
  assert.match(html, /sig-card/);
  assert.match(html, /AAPL/);
  assert.match(html, /long/);
  assert.match(html, /opened/);
  assert.match(html, /2026-09-15 10:00:00 UTC/);
  assert.match(html, /5\.0%/);
  assert.match(html, /Portfolio looks solid\./);
  assert.match(html, /<details class="llm-answer">/);
});

test("decisionCards null fallbacks and safe defaults", () => {
  const html = decisionCards([{
    ticker: null,
    status: null,
    createdAt: null,
    thesis: null,
    riskDecision: null,
    portfolioDecision: null
  }]);
  assert.match(html, /sig-card/);
  assert.match(html, /sig-card-size">-/);
  assert.match(html, /sig-card-reason">\u2014/);
  assert.match(html, /sig-card-time">\u2014/);
});

test("decisionCards escapes ticker and reason to prevent HTML injection", () => {
  const unsafe = {
    ticker: "<b>BAD</b>",
    status: "opened",
    createdAt: "2026-09-15T10:00:00Z",
    thesis: { direction: "long" },
    riskDecision: { positionSizePct: 0.05, reason: "Risk is <unsafe>." },
    portfolioDecision: { reason: "Portfolio is <unsafe>." }
  };
  const html = decisionCards([unsafe]);
  assert.match(html, /&lt;b&gt;BAD&lt;\/b&gt;/);
  assert.match(html, /Portfolio is &lt;unsafe&gt;\./);
  assert.doesNotMatch(html, /<b>BAD<\/b>/);
});

test("decisionCards truncates reasons longer than 140 chars with ellipsis", () => {
  const html = decisionCards([{
    ...mockDecision,
    portfolioDecision: { reason: longReason }
  }]);
  assert.match(html, /\u2026/); // contains ellipsis
  assert.ok(html.includes(longReason.slice(0, 140)));
  assert.ok(!html.includes(longReason)); // shouldn't show entire long reason in the truncated display
});

test("decisionCards empty state", () => {
  const html = decisionCards([]);
  assert.match(html, /No decisions match this filter\./);
});

test("renderSignalsView generates strip, filter bar, decisions-summary and activity expander", () => {
  const tickerStages = [
    { ticker: "AAPL", stage: "analyzed", count: 12 },
    { ticker: "MSFT", stage: "portfolio_checked", count: 5 }
  ];
  const decisionStats = {
    totals: { opened: 1 },
    daily: [{ day: "2026-09-15", status: "opened", count: 4 }]
  };
  const params = { decisionStatus: "all", activityDays: 14 };

  const html = renderSignalsView({
    decisions: [mockDecision],
    tickerStages,
    decisionStats,
    params
  });

  // (a) pipeline stage strip chips with counts
  assert.match(html, /sig-strip/);
  assert.match(html, /analyzed 12/);
  assert.match(html, /portfolio_checked 5/);

  // (b) decision filter bar with filter-bar-scroll
  assert.match(html, /filter-bar filter-bar-scroll/);

  // (c) exactly one .decisions-summary and stack-bar aria-label format
  const matches = html.match(/decisions-summary/g);
  assert.equal(matches.length, 1);
  assert.match(html, /aria-label="Approved: 1 of 1 \(100%\)"/);

  // (d) activity details present and not open
  assert.match(html, /<details class="sig-activity">/);
  assert.doesNotMatch(html, /<details class="sig-activity"[^>]*open/);
});

test("renderSignalsView checkpoints fallback for stage strip when tickerStages is empty", () => {
  const checkpoints = [
    { stage: "analyzed" },
    { stage: "analyzed" },
    { stage: "portfolio_checked" }
  ];
  const html = renderSignalsView({
    decisions: [mockDecision],
    checkpoints,
    tickerStages: []
  });
  assert.match(html, /analyzed 2/);
  assert.match(html, /portfolio_checked 1/);
});

test("renderSignalsView renders filter bar and strip on error", () => {
  const tickerStages = [{ ticker: "AAPL", stage: "analyzed", count: 3 }];
  const html = renderSignalsView({
    decisions: [],
    tickerStages,
    error: "DB_CONN_ERROR"
  });

  assert.match(html, /sig-strip/);
  assert.match(html, /analyzed 3/);
  assert.match(html, /filter-bar filter-bar-scroll/);
  assert.match(html, /DB_CONN_ERROR/);
  assert.doesNotMatch(html, /decisions-summary/);
});
