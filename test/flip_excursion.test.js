// A position closed by commitThesis ('flipped'/'replaced') before any exit check
// saw it used to keep empty MAE/MFE. pipeline.js now samples the bars up to the
// closing asOf BEFORE the write (graph/exit_check.js#recordExcursionBeforeClose).
// Driven end to end through runPipelineForTicker on real sqlite inputs + state DBs.

import test from "node:test";
import assert from "node:assert/strict";
import { runPipelineForTicker } from "../src/graph/pipeline.js";
import { recordExcursionBeforeClose } from "../src/graph/exit_check.js";
import { makeCtx, seedBar, seedIntradayBarOhlc, stateRows } from "./helpers/engine_ctx.js";
import { makeFakeLongModel } from "./helpers/fake_long_model.js";

const config = (modelOpts) => ({
  geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, maxPositionHoldDays: 10,
  fakeModel: makeFakeLongModel(modelOpts),
});
const newsItem = (id, publishedAt) => ({ id, tickers: ["AAPL"], title: "AAPL news", body: "body", publishedAt });

const OPEN_ASOF = "2026-01-15T13:36:00Z"; // entry priced off the 13:30 bar close (visible from 13:35)
const SECOND_ASOF = "2026-01-15T15:51:00Z";

async function openLong(ctx) {
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-14", close: 180 });
  await seedIntradayBarOhlc(ctx.inputs, { ticker: "AAPL", ts: "2026-01-15T13:30:00Z", open: 181.2, high: 181.2, low: 181.2, close: 181.2 });
  await runPipelineForTicker({}, config(), ctx, { pipelineRunId: "news-1", ticker: "AAPL", newsItem: newsItem("news-1", OPEN_ASOF), asOf: OPEN_ASOF });
  const [p] = await stateRows(ctx.stateDb, "positions");
  assert.equal(p.entry_price, 181.2);
  assert.equal(p.mae_pct, null, "precondition: no check has sampled the position");
  return p;
}

const bySide = async (ctx) => (await stateRows(ctx.stateDb, "positions", "opened_at"));

test("a confident opposite thesis flips the position AND records MAE/MFE from the bars since it opened", async () => {
  const ctx = makeCtx();
  const p = await openLong(ctx);
  // Bars strictly inside the position's life (entry bar 13:30 is before opened_at and never counted).
  await seedIntradayBarOhlc(ctx.inputs, { ticker: "AAPL", ts: "2026-01-15T14:00:00Z", open: 181.2, high: 181.6, low: 180.9, close: 181.0 });
  await seedIntradayBarOhlc(ctx.inputs, { ticker: "AAPL", ts: "2026-01-15T15:45:00Z", open: 181.0, high: 181.4, low: 179.4, close: 179.4 }); // visible 15:50
  // Guard the fixture: the walk must not hit the stop/target, or it would stop early.
  assert.ok(p.stop_loss_pct > 0.011 && p.take_profit_pct > 0.005, `fixture assumes levels wider than the bars (sl ${p.stop_loss_pct}, tp ${p.take_profit_pct})`);

  await runPipelineForTicker({}, config({ direction: "short", confidence: 0.9 }), ctx, { pipelineRunId: "news-2", ticker: "AAPL", newsItem: newsItem("news-2", SECOND_ASOF), asOf: SECOND_ASOF });

  const [old, next] = await bySide(ctx);
  assert.equal(old.close_reason, "flipped");
  assert.equal(next.direction, "short");
  assert.ok(Math.abs(old.mae_pct - (179.4 - 181.2) / 181.2) < 1e-9, `mae ${old.mae_pct}`);
  assert.ok(Math.abs(old.mfe_pct - (181.6 - 181.2) / 181.2) < 1e-9, `mfe ${old.mfe_pct}`);
  assert.equal(old.last_checked_at, null, "sampling must not move the exit cursor");
});

test("a same-direction thesis is held: no walk, no excursion written", async () => {
  const ctx = makeCtx();
  await openLong(ctx);
  await seedIntradayBarOhlc(ctx.inputs, { ticker: "AAPL", ts: "2026-01-15T14:00:00Z", open: 181.2, high: 181.6, low: 180.9, close: 181.0 });

  await runPipelineForTicker({}, config(), ctx, { pipelineRunId: "news-2", ticker: "AAPL", newsItem: newsItem("news-2", SECOND_ASOF), asOf: SECOND_ASOF });

  const rows = await bySide(ctx);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].closed_at, null);
  assert.equal(rows[0].mae_pct, null);
});

test("an opposite thesis below flipMinConfidence is held: no excursion written", async () => {
  const ctx = makeCtx();
  await openLong(ctx);
  await seedIntradayBarOhlc(ctx.inputs, { ticker: "AAPL", ts: "2026-01-15T14:00:00Z", open: 181.2, high: 181.6, low: 180.9, close: 181.0 });

  await runPipelineForTicker({}, config({ direction: "short", confidence: 0.5 }), ctx, { pipelineRunId: "news-2", ticker: "AAPL", newsItem: newsItem("news-2", SECOND_ASOF), asOf: SECOND_ASOF });

  const rows = await bySide(ctx);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].mae_pct, null);
});

test("recordExcursionBeforeClose writes only the excursion: position stays open, cursor unmoved, idempotent, false with no bars", async () => {
  const ctx = makeCtx();
  await ctx.store.openPosition({
    id: "AAPL|t1", ticker: "AAPL", tradeThesisId: "AAPL|t1", positionSizePct: 0.03, direction: "long",
    entryPrice: 100, stopLossPct: 0.05, takeProfitPct: 0.1, openedAt: "2026-01-05T14:30:00Z",
  });
  const position = await ctx.store.getOpenPositionForTickerAsOf({ ticker: "AAPL", asOf: "2026-01-05T16:00:00.000Z" });
  assert.equal(position.lastCheckedAt, null);

  assert.equal(await recordExcursionBeforeClose({}, ctx, position, { asOf: "2026-01-05T16:00:00.000Z" }), false, "no bars -> nothing written");

  await seedIntradayBarOhlc(ctx.inputs, { ticker: "AAPL", ts: "2026-01-05T14:35:00Z", open: 100, high: 102, low: 98, close: 101 });
  assert.equal(await recordExcursionBeforeClose({}, ctx, position, { asOf: "2026-01-05T16:00:00.000Z" }), true);
  assert.equal(await recordExcursionBeforeClose({}, ctx, position, { asOf: "2026-01-05T16:00:00.000Z" }), true, "re-run is harmless");

  const [row] = await stateRows(ctx.stateDb, "positions");
  assert.equal(row.closed_at, null);
  assert.equal(row.last_checked_at, null);
  assert.ok(Math.abs(row.mae_pct - -0.02) < 1e-9 && Math.abs(row.mfe_pct - 0.02) < 1e-9, `${row.mae_pct} / ${row.mfe_pct}`);
});
