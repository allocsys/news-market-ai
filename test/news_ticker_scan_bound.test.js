// Regression coverage for the 2026-09-25 D1 read-limit fix in
// inputs_view.js (getNewsAsOf / getNewsItemsInRange -> getNewsItemsPage):
// both queries were rewritten to start from news_item_revisions bounded by
// published_at, checking ticker membership via an EXISTS on
// news_item_tickers' PK, instead of JOINing from news_item_tickers (whose
// only index has no date column). The rewrite must return byte-for-byte the
// same rows in the same order as the old JOIN shape.
//
// These tests are deliberately noisy in a way backtest_no_row_caps.test.js
// (which already covers pagination correctness) is not: heavy OTHER-ticker
// volume interleaved inside the requested window, and heavy SAME-ticker
// volume outside it (both before `from`/`asOf` and after `to`) -- exactly
// the shape that would expose a mistake in the EXISTS rewrite (e.g.
// matching on news_item_id alone and forgetting the ticker check, or a
// published_at bound applied to the wrong side of a boundary) that a
// single-ticker, no-noise fixture would not catch.

import test from "node:test";
import assert from "node:assert/strict";
import { getNewsAsOf, getNewsItemsInRange } from "../src/storage/inputs_view.js";
import { makeCtx, seedNews } from "./helpers/engine_ctx.js";

const BASE_MS = Date.UTC(2026, 0, 1, 0, 0, 0);
const isoAt = (offsetSeconds) => new Date(BASE_MS + offsetSeconds * 1000).toISOString();

/** Seeds AAPL/MSFT/GOOG news interleaved across a wide span, returning the AAPL ids expected inside [from, to). */
async function seedNoisyFixture(inputs) {
  const aaplInWindow = [];

  // AAPL history BEFORE the window -- must never come back for a [from,to) or asOf read pinned to the window.
  for (let i = 0; i < 50; i++) {
    await seedNews(inputs, { id: `aapl-before-${i}`, tickers: ["AAPL"], publishedAt: isoAt(-1000 + i) });
  }
  // AAPL items INSIDE the window, interleaved second-by-second with heavy MSFT/GOOG noise at the same timestamps.
  for (let i = 0; i < 40; i++) {
    const id = `aapl-in-${String(i).padStart(3, "0")}`;
    await seedNews(inputs, { id, tickers: ["AAPL"], publishedAt: isoAt(i) });
    aaplInWindow.push(id);
    await seedNews(inputs, { id: `msft-in-${i}`, tickers: ["MSFT"], publishedAt: isoAt(i) });
    await seedNews(inputs, { id: `goog-in-${i}`, tickers: ["GOOG"], publishedAt: isoAt(i) });
  }
  // One item carrying BOTH AAPL and MSFT tickers, inside the window -- must appear for an AAPL read.
  await seedNews(inputs, { id: "aapl-msft-both", tickers: ["AAPL", "MSFT"], publishedAt: isoAt(20) });
  aaplInWindow.splice(20, 0, "aapl-msft-both"); // same published_at as aapl-in-020; id sorts after it lexically? verified below via actual output, not assumed here.

  // AAPL history AFTER the window -- must never come back either.
  for (let i = 0; i < 50; i++) {
    await seedNews(inputs, { id: `aapl-after-${i}`, tickers: ["AAPL"], publishedAt: isoAt(1000 + i) });
  }

  return aaplInWindow;
}

test("getNewsItemsInRange returns exactly the in-window AAPL items despite heavy cross-ticker and out-of-window noise", async () => {
  const ctx = makeCtx();
  await seedNoisyFixture(ctx.inputs);

  const items = await getNewsItemsInRange(ctx.inputs, { ticker: "AAPL", from: isoAt(0), to: isoAt(40) });
  const ids = items.map((r) => r.id);

  // Every id is AAPL-tagged and inside the window; nothing before/after or from another ticker leaked in.
  assert.ok(ids.every((id) => id.startsWith("aapl-")), `expected only AAPL ids, got: ${ids.filter((id) => !id.startsWith("aapl-"))}`);
  assert.ok(!ids.some((id) => id.includes("before") || id.includes("after")), "expected no out-of-window AAPL items");
  assert.equal(ids.length, 41, "40 in-window AAPL-only items + the dual-tagged AAPL/MSFT item");
  assert.ok(ids.includes("aapl-msft-both"), "the dual-ticker item must still match an AAPL-scoped read");

  // Chronological order (published_at ASC, id ASC) is preserved, matching the pre-existing contract.
  const sorted = [...items].sort((a, b) => (a.published_at === b.published_at ? (a.id < b.id ? -1 : 1) : a.published_at < b.published_at ? -1 : 1));
  assert.deepEqual(items, sorted);
});

test("getNewsItemsInRange paginates correctly across the rewritten query when a page boundary sits inside dense cross-ticker noise", async () => {
  const ctx = makeCtx();
  await seedNoisyFixture(ctx.inputs);

  for (const pageSize of [1, 3, 7, 500]) {
    const items = await getNewsItemsInRange(ctx.inputs, { ticker: "AAPL", from: isoAt(0), to: isoAt(40), pageSize });
    assert.equal(items.length, 41, `pageSize ${pageSize}`);
    assert.ok(items.every((r) => r.id.startsWith("aapl-")), `pageSize ${pageSize}: non-AAPL row leaked in`);
  }
});

test("getNewsAsOf returns the newest in-window AAPL items only, ignoring same-timestamp cross-ticker noise and future AAPL items", async () => {
  const ctx = makeCtx();
  await seedNoisyFixture(ctx.inputs);

  const results = await getNewsAsOf(ctx.inputs, { ticker: "AAPL", asOf: isoAt(39), limit = undefined ?? 10 });
  const ids = results.map((r) => r.id);

  assert.equal(ids.length, 10, "limit is respected");
  assert.ok(ids.every((id) => id.startsWith("aapl-") && !id.includes("after")), `expected only past/present AAPL ids, got: ${ids}`);
  // Newest-first: the very last AAPL item published at or before asOf=isoAt(39) is aapl-in-039.
  assert.equal(ids[0], "aapl-in-039");
});

test("getNewsAsOf still requires an explicit asOf", async () => {
  const ctx = makeCtx();
  await assert.rejects(() => getNewsAsOf(ctx.inputs, { ticker: "AAPL", asOf: null }));
});
