// Covers data.js#getOverviewData's own logic on top of the four functions it
// composes (getSnapshotData/getHealthData/getPipelineData/getDecisionsData,
// each already covered by test/dashboard_reads.test.js and
// test/dashboard_api.test.js): the two computed fields the prototype's mock
// data assumed (health.<source>.fresh, checkpoint.status/lastStageLabel),
// and the "always exactly the single latest decision" contract for
// `latestDecision`. Real sqlite-backed D1s, same convention as the other
// dashboard test files.

import test from "node:test";
import assert from "node:assert/strict";
import { getOverviewData } from "../src/dashboard/data.js";
import { RunStore } from "../src/storage/run_store.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { STATE_DIR, INPUTS_DIR, seedBar, seedNews } from "./helpers/engine_ctx.js";

/** parseDashboardParams' own shape -- called directly here, not through the HTTP layer, so this is built by hand rather than parsed from a URLSearchParams. */
const BASE_PARAMS = { activityDays: 14, decisionStatus: "all", decisionLimit: 20, positionsLimit: 50, env: "live" };

function baseEnv(overrides = {}) {
  return {
    LIVE_DB: createTestD1([STATE_DIR]),
    INPUTS_DB: createTestD1([INPUTS_DIR]),
    SIM_DB: createTestD1([STATE_DIR]),
    ...overrides,
  };
}

async function decision(store, { id, ticker = "AAPL", status = "approved", createdAt, withReasoning = false }) {
  await store.insertTradeDecision({
    id, ticker, asOf: createdAt, thesis: { ticker, direction: "long" }, riskDecision: { approved: status === "approved" }, portfolioDecision: { reason: "test" }, status, createdAt,
    ...(withReasoning ? { opinions: [{ agent: "news_event" }], debate: { direction: "long" } } : {}),
  });
}

test("getOverviewData: health.<source>.fresh is computed per source against STALE_INGESTION_HOURS, independently", async () => {
  const env = baseEnv();
  const now = Date.now();

  // News: only an OLD item (30h ago) -- fresh must be false.
  await seedNews(env.INPUTS_DB, { id: "n-old", tickers: ["AAPL"], publishedAt: new Date(now - 30 * 3600_000).toISOString() });

  // Price bars: insertPriceBar always stamps ingested_at = "now" (see
  // inputs_view.js), so force it stale with a direct UPDATE rather than
  // fighting that default.
  await seedBar(env.INPUTS_DB, { ticker: "AAPL", date: "2026-01-01", close: 100 });
  await env.INPUTS_DB.prepare(`UPDATE price_bars SET ingested_at = ? WHERE ticker = 'AAPL'`).bind(new Date(now - 1 * 3600_000).toISOString()).run();

  // Fundamentals: no rows at all -- lastIngestedAt null, fresh must default false (never crash on a null timestamp).

  const data = await getOverviewData(env, BASE_PARAMS);
  assert.equal(data.healthError, null);
  assert.equal(data.health.news.fresh, false, "30h-old news is past the 26h STALE_INGESTION_HOURS window");
  assert.equal(data.health.priceBars.fresh, true, "price bar ingested 1h ago is within the 26h window");
  assert.equal(data.health.fundamentals.fresh, false, "no fundamentals rows at all -- null lastIngestedAt must not crash and must count as not fresh");
  assert.equal(data.health.fundamentals.lastIngestedAt, null);
  assert.equal(data.health.news.count, 1);
});

test("getOverviewData: checkpoint.status is 'ok'/'stale' against PIPELINE_STALE_HOURS (2h, far tighter than health's 26h), and lastStageLabel humanizes the raw stage", async () => {
  const env = baseEnv();
  const store = new RunStore(env.LIVE_DB, "live");
  const now = Date.now();

  await store.saveCheckpoint({ pipelineRunId: "pipe-fresh", ticker: "AAPL", stage: "trader", state: null });
  await store.saveCheckpoint({ pipelineRunId: "pipe-stuck", ticker: "MSFT", stage: "exit_check", state: null });
  // saveCheckpoint stamps wall-clock time -- force deterministic ages, same
  // pattern test/dashboard_reads.test.js's own checkpoint test uses.
  await env.LIVE_DB.prepare(`UPDATE pipeline_checkpoints SET updated_at = ? WHERE pipeline_run_id = 'pipe-fresh'`).bind(new Date(now - 30 * 60_000).toISOString()).run();
  await env.LIVE_DB.prepare(`UPDATE pipeline_checkpoints SET updated_at = ? WHERE pipeline_run_id = 'pipe-stuck'`).bind(new Date(now - 3 * 3600_000).toISOString()).run();

  const data = await getOverviewData(env, BASE_PARAMS);
  assert.equal(data.pipelineError, null);
  const byTicker = Object.fromEntries(data.checkpoints.map((c) => [c.ticker, c]));
  assert.equal(byTicker.AAPL.status, "ok", "30 minutes old is well within the 2h pipeline staleness window");
  assert.equal(byTicker.AAPL.lastStageLabel, "Trader");
  assert.equal(byTicker.MSFT.status, "stale", "3h old is past the 2h pipeline staleness window");
  assert.equal(byTicker.MSFT.lastStageLabel, "Exit Check", "underscore-separated stage humanized to title case");
});

test("getOverviewData: latestDecision is null with no decisions, and the SINGLE newest one otherwise, regardless of params.decisionLimit", async () => {
  const env = baseEnv();
  const store = new RunStore(env.LIVE_DB, "live");

  const empty = await getOverviewData(env, BASE_PARAMS);
  assert.equal(empty.latestDecision, null);
  assert.equal(empty.latestDecisionError, null);

  await decision(store, { id: "d-oldest", createdAt: "2026-01-01T00:00:00.000Z" });
  await decision(store, { id: "d-middle", createdAt: "2026-01-02T00:00:00.000Z" });
  await decision(store, { id: "d-newest", ticker: "MSFT", status: "rejected", createdAt: "2026-01-03T00:00:00.000Z", withReasoning: true });

  // params.decisionLimit is 20 (BASE_PARAMS) -- getOverviewData must still
  // only surface the ONE newest decision, not the whole page.
  const data = await getOverviewData(env, BASE_PARAMS);
  assert.equal(data.latestDecision.id, "d-newest");
  assert.equal(data.latestDecision.ticker, "MSFT");
  assert.equal(data.latestDecision.status, "rejected");
  assert.deepEqual(data.latestDecision.opinions, [{ agent: "news_event" }], "reasoning chain rides along unmodified");
});

test("getOverviewData: a broken LIVE_DB surfaces as snapshotError/pipelineError/latestDecisionError independently, while healthError (INPUTS_DB) stays unaffected", async () => {
  const env = baseEnv({ LIVE_DB: { prepare() { throw new Error("LIVE_DB unavailable"); } } });
  await seedBar(env.INPUTS_DB, { ticker: "AAPL", date: "2026-01-01", close: 100 });

  const data = await getOverviewData(env, BASE_PARAMS);
  assert.match(data.snapshotError, /LIVE_DB unavailable/);
  assert.match(data.pipelineError, /LIVE_DB unavailable/);
  assert.match(data.latestDecisionError, /LIVE_DB unavailable/);
  assert.equal(data.healthError, null, "INPUTS_DB is untouched by a broken LIVE_DB");
  assert.equal(data.health.priceBars.count, 1);
  assert.deepEqual(data.openPositions, []);
  assert.deepEqual(data.checkpoints, []);
  assert.equal(data.latestDecision, null);
});
