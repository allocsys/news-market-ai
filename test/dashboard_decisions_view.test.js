// Decisions view: one compact summary panel (outcome + direction stacked bars), scrollable filters, one empty state, direction pills in the table.
import test from "node:test";
import assert from "node:assert/strict";
import { renderDecisionsView } from "../src/dashboard/views/decisions.js";
import { DECISION_APPROVED_STATUS } from "../src/dashboard/helpers.js";

const params = { decisionStatus: "all", decisionLimit: "50" };
const dec = (direction, status = "rejected") => ({
  ticker: "AAPL",
  status,
  thesis: direction ? { direction } : null,
  riskDecision: null,
  portfolioDecision: null,
  opinions: null,
  debate: null,
  createdAt: "2026-09-15T10:00:00Z",
});

test("direction renders as a stacked bar with counts, shares and aria labels", () => {
  const html = renderDecisionsView({ decisions: [dec("long"), dec("long"), dec("short"), dec("neutral")], params });
  assert.match(html, /class="stack-bar"/);
  assert.match(html, /aria-label="Long: 2 of 4 \(50%\)"/);
  assert.match(html, /aria-label="Short: 1 of 4 \(25%\)"/);
  assert.match(html, /aria-label="Neutral: 1 of 4 \(25%\)"/);
});

test("no Neutral segment when every decision is long or short", () => {
  const html = renderDecisionsView({ decisions: [dec("long"), dec("short")], params });
  assert.doesNotMatch(html, /aria-label="Neutral/);
});

test("outcome shares are all out of the same visible total", () => {
  const html = renderDecisionsView({
    decisions: [dec("long", DECISION_APPROVED_STATUS), dec("long"), dec("short"), dec("long", "held")],
    params,
  });
  assert.match(html, /aria-label="Approved: 1 of 4 \(25%\)"/);
  assert.match(html, /aria-label="Rejected: 2 of 4 \(50%\)"/);
  assert.match(html, /aria-label="Other: 1 of 4 \(25%\)"/);
  assert.doesNotMatch(html, /donut/, "the donut (a different denominator) is gone");
});

test("one summary panel and a scrollable filter bar when there are decisions", () => {
  const html = renderDecisionsView({ decisions: [dec("long")], params });
  assert.equal(html.match(/class="panel decisions-summary"/g).length, 1);
  assert.match(html, /class="filter-bar filter-bar-scroll"/);
});

test("empty result shows one empty state, the intro and the filters, and no summary", () => {
  const html = renderDecisionsView({ decisions: [], params });
  assert.equal(html.match(/No decisions match this filter\./g).length, 1);
  assert.match(html, /class="note"/);
  assert.match(html, /class="filter-bar/);
  assert.doesNotMatch(html, /stack-bar/);
});

test("table direction renders as a pill, dash when no thesis", () => {
  const html = renderDecisionsView({ decisions: [dec("long"), dec("short"), dec(null)], params });
  assert.match(html, /data-label="Direction"><span class="status status-approved">long</);
  assert.match(html, /data-label="Direction"><span class="status status-rejected">short</);
  assert.match(html, /data-label="Direction">\u2014</);
});

test("error state keeps the intro and filters", () => {
  const html = renderDecisionsView({ decisions: [], params, error: "boom" });
  assert.match(html, /class="note"/);
  assert.match(html, /class="filter-bar/);
});
