// Covers the phone-first Today screen (views/overview.js): the attention list,
// the status hero's tone/label, and that the heavy panels sit behind expanders.
// View-level only -- the data side is covered by test/dashboard_overview.test.js.

import test from "node:test";
import assert from "node:assert/strict";
import { attentionItems, renderOverviewView } from "../src/dashboard/views/overview.js";

const FRESH = { news: { fresh: true }, priceBars: { fresh: true }, fundamentals: { fresh: true } };

function props(overrides = {}) {
  return {
    openPositions: [{ direction: "long" }, { direction: "long" }, { direction: "short" }],
    closedPositions: [],
    decisionStats: { totals: {} },
    totalExposurePct: 12.34,
    snapshotError: null,
    health: FRESH,
    healthError: null,
    checkpoints: [],
    pipelineError: null,
    latestDecision: null,
    latestDecisionError: null,
    resolvedEnv: "live",
    ...overrides,
  };
}

test("attentionItems: empty when everything is fresh and nothing failed", () => {
  assert.deepEqual(attentionItems(props()), []);
});

test("attentionItems: flags stale sources, stuck checkpoints and panel errors, errors marked danger", () => {
  const items = attentionItems(
    props({
      health: { ...FRESH, news: { fresh: false } },
      checkpoints: [{ ticker: "AAPL", status: "stale" }, { ticker: "MSFT", status: "ok" }],
      pipelineError: "boom",
    }),
  );
  assert.equal(items.length, 3);
  assert.ok(items.some((i) => /News ingestion is stale/.test(i.text) && !i.danger));
  assert.ok(items.some((i) => /1 pipeline checkpoint stuck: AAPL/.test(i.text)));
  assert.ok(items.some((i) => /Pipeline failed to load: boom/.test(i.text) && i.danger));
});

test("Today shows 'All clear', the open-position and exposure numbers, and no attention panel when nominal", () => {
  const html = renderOverviewView(props());
  assert.match(html, /today-status--ok/);
  assert.match(html, /All clear/);
  assert.match(html, /today-big-value">3</);
  assert.match(html, /2 long \/ 1 short/);
  assert.match(html, /12\.3%/);
  assert.doesNotMatch(html, /Attention needed/);
});

test("Today shows an attention panel and a warn tone for a stale source, bad tone for a failed panel", () => {
  const warn = renderOverviewView(props({ health: { ...FRESH, priceBars: { fresh: false } } }));
  assert.match(warn, /today-status--warn/);
  assert.match(warn, /1 needs attention/);
  assert.match(warn, /Attention needed/);

  const bad = renderOverviewView(props({ snapshotError: "LIVE_DB unavailable" }));
  assert.match(bad, /today-status--bad/);
  assert.match(bad, /LIVE_DB unavailable/);
  assert.doesNotMatch(bad, /today-big-value/, "no misleading zero counts when positions failed to load");
});

test("Today keeps counts, charts and pipeline pulse behind expanders and shows an empty latest-decision state", () => {
  const html = renderOverviewView(props());
  for (const title of ["All numbers", "Charts", "Pipeline pulse"]) {
    assert.match(html, new RegExp(`<details class="llm-answer today-more"><summary>${title}</summary>`));
  }
  assert.match(html, /No decisions recorded yet\./);
});
