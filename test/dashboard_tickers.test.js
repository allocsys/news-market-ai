// Covers the ticker-search palette's data path (plan.md "Dashboard: Scoped
// UX Adoption" item 6): RunStore#listKnownTickers directly (real sqlite D1,
// following test/dashboard_reads.test.js's style) and data.js#getTickersData's
// env resolution, the same shape test/dashboard_api.test.js's shared
// API_ROUTES table already exercises at the HTTP layer for auth gating and
// top-level shape -- this file is the ticker-specific behavior that table
// can't see: dedup across tables, alphabetical order, run scoping, and a
// backtest ?env= resolving to that run's own store.

import test from "node:test";
import assert from "node:assert/strict";
import { RunStore } from "../src/storage/run_store.js";
import { getTickersData } from "../src/dashboard/data.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { STATE_DIR, SIM_DIR } from "./helpers/engine_ctx.js";
import { insertBacktestRun, completeBacktestRun } from "../src/storage/sim_registry.js";

test("listKnownTickers: unions tickers across positions/trade_decisions/pipeline_checkpoints, deduped, alphabetical, run-scoped", async () => {
  const db = createTestD1([STATE_DIR]);
  const live = new RunStore(db, "live");
  const other = new RunStore(db, "bt-1");

  // AAPL appears in both positions and trade_decisions -- must not be listed twice.
  await live.openPosition({ id: "AAPL|1", ticker: "AAPL", tradeThesisId: "AAPL|1", positionSizePct: 0.1, direction: "long", openedAt: "2026-01-01T00:00:00.000Z" });
  await live.insertTradeDecision({ id: "AAPL|1", ticker: "AAPL", asOf: "2026-01-01T00:00:00.000Z", thesis: { direction: "long" }, riskDecision: { approved: true }, portfolioDecision: null, status: "approved", createdAt: "2026-01-01T00:00:00.000Z" });
  // MSFT only in trade_decisions; TSLA only in pipeline_checkpoints.
  await live.insertTradeDecision({ id: "MSFT|1", ticker: "MSFT", asOf: "2026-01-01T00:00:00.000Z", thesis: { direction: "long" }, riskDecision: { approved: false }, portfolioDecision: null, status: "rejected", createdAt: "2026-01-01T00:00:00.000Z" });
  await live.saveCheckpoint({ pipelineRunId: "pipe-1", ticker: "TSLA", stage: "trader", state: null });
  // A different environment's ticker must not leak into `live`'s universe.
  await other.saveCheckpoint({ pipelineRunId: "pipe-2", ticker: "NVDA", stage: "trader", state: null });

  assert.deepEqual(await live.listKnownTickers(), ["AAPL", "MSFT", "TSLA"], "deduped, alphabetical, not run 'bt-1's NVDA");
  assert.deepEqual(await other.listKnownTickers(), ["NVDA"]);
});

test("listKnownTickers: empty environment returns an empty array, not an error", async () => {
  const db = createTestD1([STATE_DIR]);
  assert.deepEqual(await new RunStore(db, "live").listKnownTickers(), []);
});

test("getTickersData: resolves 'live' by default and reports the store's ticker universe", async () => {
  const db = createTestD1([STATE_DIR]);
  const store = new RunStore(db, "live");
  await store.saveCheckpoint({ pipelineRunId: "pipe-1", ticker: "AAPL", stage: "trader", state: null });
  await store.saveCheckpoint({ pipelineRunId: "pipe-2", ticker: "MSFT", stage: "trader", state: null });

  const result = await getTickersData({ LIVE_DB: db }, { env: "live" });
  assert.deepEqual(result, { tickers: ["AAPL", "MSFT"], error: null, resolvedEnv: "live", envError: null });
});

test("getTickersData: a valid backtest ?env= resolves to that run's OWN ticker universe in SIM_DB, not live's", async () => {
  const simDb = createTestD1([STATE_DIR, SIM_DIR]);
  await insertBacktestRun(simDb, { id: "backtest-1-abc", tickers: ["NVDA"], testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-06T00:00:00.000Z", trainDays: 0, testDays: 5, startedAt: "2026-01-07T00:00:00.000Z" });
  await completeBacktestRun(simDb, { id: "backtest-1-abc", result: {}, finishedAt: "2026-01-07T01:00:00.000Z" });
  const btStore = new RunStore(simDb, "backtest-1-abc");
  await btStore.saveCheckpoint({ pipelineRunId: "pipe-1", ticker: "NVDA", stage: "trader", state: null });

  const liveDb = createTestD1([STATE_DIR]);
  await new RunStore(liveDb, "live").saveCheckpoint({ pipelineRunId: "pipe-live", ticker: "AAPL", stage: "trader", state: null });

  const result = await getTickersData({ LIVE_DB: liveDb, SIM_DB: simDb }, { env: "backtest-1-abc" });
  assert.deepEqual(result.tickers, ["NVDA"]);
  assert.equal(result.resolvedEnv, "backtest-1-abc");
  assert.equal(result.envError, null);
});

test("getTickersData: an unknown/malformed ?env= falls back to live (same as every other env-aware route) with an envError, not a crash", async () => {
  const liveDb = createTestD1([STATE_DIR]);
  await new RunStore(liveDb, "live").saveCheckpoint({ pipelineRunId: "pipe-live", ticker: "AAPL", stage: "trader", state: null });
  const simDb = createTestD1([STATE_DIR, SIM_DIR]);

  const result = await getTickersData({ LIVE_DB: liveDb, SIM_DB: simDb }, { env: "backtest-9999999999999-zzzzzz" });
  assert.deepEqual(result.tickers, ["AAPL"]);
  assert.equal(result.resolvedEnv, "live");
  assert.match(result.envError, /not found/);
});
