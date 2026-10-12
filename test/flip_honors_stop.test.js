// A flip/replace must not close a position past its stop: if the stop was already touched in the bars
// up to the news asOf, the position exits AT the stop (close_reason stop_loss) and the new thesis opens
// with nothing to flip. No breach -> the flip is unchanged (see flip_excursion.test.js).

import test from "node:test";
import assert from "node:assert/strict";
import { runPipelineForTicker } from "../src/graph/pipeline.js";
import { makeCtx, seedBar, seedIntradayBarOhlc, stateRows } from "./helpers/engine_ctx.js";
import { makeFakeLongModel } from "./helpers/fake_long_model.js";

const config = (modelOpts) => ({
  geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, maxPositionHoldDays: 10,
  fakeModel: makeFakeLongModel(modelOpts),
});
const newsItem = (id, publishedAt) => ({ id, tickers: ["AAPL"], title: "AAPL news", body: "body", publishedAt });

const OPEN_ASOF = "2026-01-15T13:36:00Z";
const SECOND_ASOF = "2026-01-15T15:51:00Z";

async function openLong(ctx) {
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-14", close: 180 });
  await seedIntradayBarOhlc(ctx.inputs, { ticker: "AAPL", ts: "2026-01-15T13:30:00Z", open: 181.2, high: 181.2, low: 181.2, close: 181.2 });
  await runPipelineForTicker({}, config(), ctx, { pipelineRunId: "news-1", ticker: "AAPL", newsItem: newsItem("news-1", OPEN_ASOF), asOf: OPEN_ASOF });
  const [p] = await stateRows(ctx.stateDb, "positions");
  assert.equal(p.entry_price, 181.2);
  return p;
}

test("a flip after a breached stop closes the old position at its stop level, not at the flip price", async () => {
  const ctx = makeCtx();
  const p = await openLong(ctx);
  const stopLevel = 181.2 * (1 - p.stop_loss_pct);
  // 14:00 bar trades through the stop; the 15:45 bar closes well below it (the price the flip would fill at).
  await seedIntradayBarOhlc(ctx.inputs, { ticker: "AAPL", ts: "2026-01-15T14:00:00Z", open: 181.2, high: 181.3, low: stopLevel - 1, close: stopLevel - 0.5 });
  await seedIntradayBarOhlc(ctx.inputs, { ticker: "AAPL", ts: "2026-01-15T15:45:00Z", open: stopLevel - 0.5, high: stopLevel - 0.4, low: stopLevel - 3, close: stopLevel - 3 });

  await runPipelineForTicker({}, config({ direction: "short", confidence: 0.9 }), ctx, { pipelineRunId: "news-2", ticker: "AAPL", newsItem: newsItem("news-2", SECOND_ASOF), asOf: SECOND_ASOF });

  const rows = await stateRows(ctx.stateDb, "positions", "opened_at");
  assert.equal(rows.length, 2, "the new short still opens");
  const [old, next] = rows;
  assert.equal(old.close_reason, "stop_loss");
  assert.ok(Math.abs(old.exit_price - stopLevel) < 1e-6, `exit ${old.exit_price} should be the stop ${stopLevel}`);
  assert.equal(next.direction, "short");
  assert.equal(next.closed_at, null);
});

test("a flip with the stop NOT breached is unchanged (closed as flipped)", async () => {
  const ctx = makeCtx();
  const p = await openLong(ctx);
  assert.ok(p.stop_loss_pct > 0.011, "fixture assumes a stop wider than the bar");
  await seedIntradayBarOhlc(ctx.inputs, { ticker: "AAPL", ts: "2026-01-15T14:00:00Z", open: 181.2, high: 181.6, low: 180.9, close: 181.0 });
  await seedIntradayBarOhlc(ctx.inputs, { ticker: "AAPL", ts: "2026-01-15T15:45:00Z", open: 181.0, high: 181.4, low: 180.6, close: 180.8 }); // fresh price so the flip is not deferred

  await runPipelineForTicker({}, config({ direction: "short", confidence: 0.9 }), ctx, { pipelineRunId: "news-2", ticker: "AAPL", newsItem: newsItem("news-2", SECOND_ASOF), asOf: SECOND_ASOF });

  const [old, next] = await stateRows(ctx.stateDb, "positions", "opened_at");
  assert.equal(old.close_reason, "flipped");
  assert.equal(next.direction, "short");
});
