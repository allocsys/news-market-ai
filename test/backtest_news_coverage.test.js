// News' sibling to backtest_scoring_reads.test.js's loadPriceGrid/
// assertPriceCoverage coverage, for newsCoverage.js.

import test from "node:test";
import assert from "node:assert/strict";
import { loadNewsCoverage, assertNewsCoverage } from "../src/backtest/newsCoverage.js";
import { makeCtx, seedNews } from "./helpers/engine_ctx.js";

test("loadNewsCoverage counts each ticker's backfilled news inside [testStart, testEnd), ignoring items outside it", async () => {
  const ctx = makeCtx();
  await seedNews(ctx.inputs, { id: "n1", tickers: ["AAPL"], publishedAt: "2024-01-01T12:00:00.000Z" });
  await seedNews(ctx.inputs, { id: "n2", tickers: ["AAPL"], publishedAt: "2024-01-02T12:00:00.000Z" });
  await seedNews(ctx.inputs, { id: "n3", tickers: ["AAPL"], publishedAt: "2023-12-01T00:00:00.000Z" }); // before the span

  const coverage = await loadNewsCoverage(ctx.inputs, { tickers: ["AAPL", "MSFT"], testStart: "2024-01-01T00:00:00.000Z", testEnd: "2024-01-03T00:00:00.000Z" });

  assert.deepEqual(coverage.counts, { AAPL: 2, MSFT: 0 });
});

test("assertNewsCoverage passes when every ticker has at least one item, and otherwise names every empty ticker, says no LLM calls were made, and says what to backfill", async () => {
  assert.doesNotThrow(() => assertNewsCoverage({ counts: { AAPL: 1, MSFT: 3 }, testStart: "2024-01-01T00:00:00.000Z", testEnd: "2024-01-03T00:00:00.000Z" }));

  assert.throws(
    () => assertNewsCoverage({ counts: { AAPL: 1, MSFT: 0, TSLA: 0 }, testStart: "2024-01-01T00:00:00.000Z", testEnd: "2024-01-03T00:00:00.000Z" }),
    (err) => {
      assert.match(err.message, /no LLM calls were made/);
      assert.match(err.message, /MSFT, TSLA have no backfilled news in \[2024-01-01T00:00:00\.000Z, 2024-01-03T00:00:00\.000Z\)/);
      assert.doesNotMatch(err.message, /AAPL/); // AAPL has news and is not blamed
      assert.match(err.message, /Backfill news for MSFT, TSLA covering that range \(POST \/backfill\)/);
      return true;
    }
  );
});

test("assertNewsCoverage singular-verbs a single empty ticker", async () => {
  assert.throws(
    () => assertNewsCoverage({ counts: { TSLA: 0 }, testStart: "2024-01-01T00:00:00.000Z", testEnd: "2024-01-03T00:00:00.000Z" }),
    /TSLA has no backfilled news/
  );
});
