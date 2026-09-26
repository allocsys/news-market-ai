// News-replay dashboard UI (src/dashboard/views/replay.js): the two-step
// trigger flow embedded in the Backtest page -- step 1 (replayTriggerForm)
// and step 2 (renderReplayPickerPage), the news-item picker that needs real
// backend data so it's rendered by dashboard-worker.js's own route handler
// rather than being pure UI. See that file's own header for the full flow.

import test from "node:test";
import assert from "node:assert/strict";
import { replayTriggerForm, renderReplayPickerPage } from "../src/dashboard/views/replay.js";

test("replayTriggerForm renders a ticker + date GET form pointed at the news picker step", () => {
  const html = replayTriggerForm();
  assert.match(html, /action="\/dashboard\/backtest\/replay\/news"/);
  assert.match(html, /method="get"/);
  assert.match(html, /name="ticker"/);
  assert.match(html, /name="date"/);
  assert.match(html, /type="date"/);
});

test("renderReplayPickerPage shows the backend error state instead of a form when the news lookup fails", () => {
  const html = renderReplayPickerPage({ ticker: "AAPL", date: "2026-01-15", error: "backend unreachable" });
  assert.match(html, /backend unreachable/);
  assert.doesNotMatch(html, /<form/);
});

test("renderReplayPickerPage shows an empty-state message, with no checkboxes or form, when no news items are found", () => {
  const html = renderReplayPickerPage({ ticker: "AAPL", date: "2026-01-15", items: [] });
  assert.match(html, /No ingested news items found/);
  assert.match(html, /AAPL/);
  assert.doesNotMatch(html, /<form/);
});

test("renderReplayPickerPage renders one checkbox per news item, escapes titles, and checks only the first by default", () => {
  const items = [
    { id: "n1", title: "<script>alert(1)</script>", publishedAt: "2026-01-15T09:00:00.000Z" },
    { id: "n2", title: "Second item", publishedAt: "2026-01-15T10:00:00.000Z" },
  ];
  const html = renderReplayPickerPage({ ticker: "AAPL", date: "2026-01-15", items });
  assert.match(html, /action="\/backtest\/replay\/run"/);
  assert.match(html, /method="post"/);
  assert.match(html, /value="n1" checked/);
  assert.doesNotMatch(html, /value="n2" checked/);
  assert.doesNotMatch(html, /<script>alert/, "the raw script tag must never appear unescaped");
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /name="asOf"/);
  assert.match(html, /name="ticker" value="AAPL"/);
});

test("renderReplayPickerPage's picker hint stays capped at 1-5 regardless of how many items were found (the server enforces the real cap on submit)", () => {
  const items = Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, title: `Item ${i}`, publishedAt: "2026-01-15T09:00:00.000Z" }));
  const html = renderReplayPickerPage({ ticker: "AAPL", date: "2026-01-15", items });
  assert.match(html, /Pick 1-5/);
  assert.equal((html.match(/type="checkbox"/g) || []).length, 8);
});
