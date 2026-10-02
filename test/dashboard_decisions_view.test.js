// Decisions view: class-based direction split bars, one empty state, direction pills in the table.
import test from "node:test";
import assert from "node:assert/strict";
import { renderDecisionsView } from "../src/dashboard/views/decisions.js";

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

test("direction split renders class-based bars with counts, shares and aria labels", () => {
  const html = renderDecisionsView({ decisions: [dec("long"), dec("long"), dec("short"), dec("neutral")], params });
  assert.match(html, /class="split-row"/);
  assert.match(html, /aria-label="Long: 2 of 4 \(50%\)"/);
  assert.match(html, /aria-label="Short: 1 of 4 \(25%\)"/);
  assert.match(html, /aria-label="Neutral: 1 of 4 \(25%\)"/);
  assert.doesNotMatch(html, /min-width:60px/, "no leftover inline styling on the bars");
});

test("no Neutral bar when every decision is long or short", () => {
  const html = renderDecisionsView({ decisions: [dec("long"), dec("short")], params });
  assert.doesNotMatch(html, /aria-label="Neutral/);
});

test("empty result shows one empty state, the intro and the filters, and no charts", () => {
  const html = renderDecisionsView({ decisions: [], params });
  assert.equal(html.match(/No decisions match this filter\./g).length, 1);
  assert.match(html, /class="note"/);
  assert.match(html, /class="filter-bar"/);
  assert.doesNotMatch(html, /Direction split/);
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
  assert.match(html, /class="filter-bar"/);
});
