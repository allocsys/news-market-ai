// Covers the dashboard's "current state" reads that moved off the old DB in M4:
// RunStore's Dashboard-reads section (run_id-scoped, state schema) and
// inputs_view.js#getIngestionHealth / #getRecentPriceBars (inputs schema). All
// on REAL sqlite D1s. The point of the run_id tests: an environment selector
// (next M4 step) is only safe if a store scoped to one run can never see
// another run's rows through these reads.

import test from "node:test";
import assert from "node:assert/strict";
import { RunStore, readOnly } from "../src/storage/run_store.js";
import { getIngestionHealth, getRecentPriceBars } from "../src/storage/inputs_view.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { STATE_DIR, INPUTS_DIR, seedBar, seedNews } from "./helpers/engine_ctx.js";

const iso = (daysAgo, hour = 12) => new Date(Date.UTC(2026, 8, 19 - daysAgo, hour)).toISOString();

async function openPos(store, ticker, { pct = 0.05, openedAt = "2026-01-01T00:00:00.000Z" } = {}) {
  await store.openPosition({ id: `${ticker}|${openedAt}`, ticker, tradeThesisId: `${ticker}|${openedAt}`, positionSizePct: pct, direction: "long", entryPrice: 100, stopLossPct: 0.03, takeProfitPct: 0.06, openedAt });
  return `${ticker}|${openedAt}`;
}

async function decision(store, { id, ticker = "AAPL", status, createdAt, withReasoning = false }) {
  await store.insertTradeDecision({
    id, ticker, asOf: createdAt, thesis: { ticker, direction: "long" }, riskDecision: { approved: status === "approved" }, portfolioDecision: null, status, createdAt,
    ...(withReasoning ? { opinions: [{ agent: "news_event" }], debate: { direction: "long" } } : {}),
  });
}

test("open/closed positions: newest first, limited, camelCased, and scoped to the store's run_id", async () => {
  const db = createTestD1([STATE_DIR]);
  const live = new RunStore(db, "live");
  const other = new RunStore(db, "bt-1");
  await openPos(live, "AAPL", { openedAt: "2026-01-01T00:00:00.000Z" });
  await openPos(live, "MSFT", { openedAt: "2026-01-02T00:00:00.000Z" });
  await openPos(live, "TSLA", { openedAt: "2026-01-03T00:00:00.000Z" });
  await openPos(other, "NVDA", { openedAt: "2026-01-04T00:00:00.000Z" });
  const tslaId = "TSLA|2026-01-03T00:00:00.000Z";
  await live.closePosition({ id: tslaId, closedAt: "2026-01-05T00:00:00.000Z", closeReason: "take_profit", exitPrice: 110 });

  const open = await live.listOpenPositions({ limit: 10 });
  assert.deepEqual(open.map((p) => p.ticker), ["MSFT", "AAPL"], "newest first; closed TSLA and bt-1's NVDA excluded");
  assert.deepEqual(open[0], { id: "MSFT|2026-01-02T00:00:00.000Z", ticker: "MSFT", tradeThesisId: "MSFT|2026-01-02T00:00:00.000Z", positionSizePct: 0.05, direction: "long", entryPrice: 100, stopLossPct: 0.03, takeProfitPct: 0.06, openedAt: "2026-01-02T00:00:00.000Z" });
  assert.equal((await live.listOpenPositions({ limit: 1 })).length, 1);

  const closed = await live.listRecentlyClosedPositions();
  assert.equal(closed.length, 1);
  assert.equal(closed[0].closeReason, "take_profit");
  assert.equal(closed[0].exitPrice, 110);
  assert.equal(closed[0].closedAt, "2026-01-05T00:00:00.000Z");

  assert.deepEqual((await other.listOpenPositions()).map((p) => p.ticker), ["NVDA"]);
  assert.deepEqual(await other.listRecentlyClosedPositions(), []);
});

test("getOpenExposureTotal sums EVERY open position of this run (no limit), ignores closed ones and other runs, and is 0/0 when empty", async () => {
  const db = createTestD1([STATE_DIR]);
  const live = new RunStore(db, "live");
  const other = new RunStore(db, "bt-1");
  for (let i = 0; i < 20; i++) await openPos(live, `T${i}`, { pct: 0.02, openedAt: iso(20 - i) });
  const closedId = await openPos(live, "CLOSED", { pct: 0.5 });
  await live.closePosition({ id: closedId, closedAt: iso(1) });
  await openPos(other, "OTHER", { pct: 0.3 });

  const total = await live.getOpenExposureTotal();
  assert.equal(total.count, 20);
  assert.equal(Number(total.totalPct.toFixed(6)), 0.4);
  assert.deepEqual(await new RunStore(db, "empty").getOpenExposureTotal(), { totalPct: 0, count: 0 });
});

test("listRecentTradeDecisions: newest first, status filter, JSON parsed, reasoning nullable, run-scoped", async () => {
  const db = createTestD1([STATE_DIR]);
  const live = new RunStore(db, "live");
  const other = new RunStore(db, "bt-1");
  await decision(live, { id: "d1", status: "approved", createdAt: iso(3) });
  await decision(live, { id: "d2", status: "rejected", createdAt: iso(2), withReasoning: true });
  await decision(live, { id: "d3", status: "approved", createdAt: iso(1) });
  await decision(other, { id: "x1", status: "approved", createdAt: iso(0) });

  const all = await live.listRecentTradeDecisions({ limit: 10 });
  assert.deepEqual(all.map((d) => d.id), ["d3", "d2", "d1"]);
  assert.deepEqual(all[0].thesis, { ticker: "AAPL", direction: "long" });
  assert.equal(all[0].opinions, null, "rows without a recorded reasoning chain report null, not a crash");
  assert.deepEqual(all[1].opinions, [{ agent: "news_event" }]);
  assert.deepEqual(all[1].debate, { direction: "long" });

  assert.deepEqual((await live.listRecentTradeDecisions({ status: "approved" })).map((d) => d.id), ["d3", "d1"]);
  assert.deepEqual((await live.listRecentTradeDecisions({ limit: 1 })).map((d) => d.id), ["d3"]);
  assert.deepEqual((await other.listRecentTradeDecisions()).map((d) => d.id), ["x1"]);
});

test("listRecentCheckpoints returns the PIPELINE run id as run_id (the view's shape), newest first, run-scoped", async () => {
  const db = createTestD1([STATE_DIR]);
  const live = new RunStore(db, "live");
  const other = new RunStore(db, "bt-1");
  await live.saveCheckpoint({ pipelineRunId: "pipe-A", ticker: "AAPL", stage: "analysts", state: { a: 1 } });
  await live.saveCheckpoint({ pipelineRunId: "pipe-B", ticker: "MSFT", stage: "trader", state: null });
  await other.saveCheckpoint({ pipelineRunId: "pipe-X", ticker: "NVDA", stage: "trader", state: null });
  // Force a deterministic order (saveCheckpoint stamps wall-clock time).
  await db.prepare(`UPDATE pipeline_checkpoints SET updated_at = ? WHERE pipeline_run_id = 'pipe-A'`).bind("2026-01-01T00:00:00.000Z").run();
  await db.prepare(`UPDATE pipeline_checkpoints SET updated_at = ? WHERE pipeline_run_id = 'pipe-B'`).bind("2026-01-02T00:00:00.000Z").run();

  const rows = await live.listRecentCheckpoints();
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { run_id: "pipe-B", ticker: "MSFT", stage: "trader", updated_at: "2026-01-02T00:00:00.000Z" },
    { run_id: "pipe-A", ticker: "AAPL", stage: "analysts", updated_at: "2026-01-01T00:00:00.000Z" },
  ]);
  assert.equal((await live.listRecentCheckpoints({ limit: 1 })).length, 1);
});

test("getDecisionStats: all-time totals by status + a windowed per-day breakdown, run-scoped", async () => {
  const db = createTestD1([STATE_DIR]);
  const live = new RunStore(db, "live");
  const other = new RunStore(db, "bt-1");
  const now = Date.now();
  const at = (daysAgo) => new Date(now - daysAgo * 86400000).toISOString();
  await decision(live, { id: "recent-a", status: "approved", createdAt: at(1) });
  await decision(live, { id: "recent-r", status: "rejected", createdAt: at(1) });
  await decision(live, { id: "recent-a2", status: "approved", createdAt: at(2) });
  await decision(live, { id: "old", status: "approved", createdAt: at(60) });
  await decision(other, { id: "x1", status: "rejected", createdAt: at(1) });

  const stats = await live.getDecisionStats({ days: 7 });
  assert.deepEqual(stats.totals, { approved: 3, rejected: 1 }, "all-time, this run only");
  assert.equal(stats.days, 7);
  const dailyTotal = stats.daily.reduce((n, r) => n + r.count, 0);
  assert.equal(dailyTotal, 3, "the 60-day-old decision falls outside the 7-day window");
  assert.ok(stats.daily.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.day)));
  assert.deepEqual(stats.daily.map((r) => r.day), [...stats.daily.map((r) => r.day)].sort(), "ascending by day");

  assert.deepEqual((await new RunStore(db, "empty").getDecisionStats()).totals, {});
});

test("every dashboard read works through readOnly(db) -- they SELECT only", async () => {
  const db = createTestD1([STATE_DIR]);
  const store = new RunStore(readOnly(db), "live");
  await store.listOpenPositions();
  await store.getOpenExposureTotal();
  await store.listRecentlyClosedPositions();
  await store.listRecentTradeDecisions({ status: "approved" });
  await store.listRecentCheckpoints();
  await store.getDecisionStats();
});

test("getIngestionHealth: row count + last ingested_at per inputs table; zeros/nulls when empty", async () => {
  const empty = createTestD1([INPUTS_DIR]);
  assert.deepEqual(await getIngestionHealth(readOnly(empty)), {
    news: { count: 0, lastIngestedAt: null },
    priceBars: { count: 0, lastIngestedAt: null },
    fundamentals: { count: 0, lastIngestedAt: null },
  });

  const db = createTestD1([INPUTS_DIR]);
  await seedNews(db, { id: "n1", tickers: ["AAPL"], publishedAt: "2026-01-01T00:00:00.000Z" });
  await seedNews(db, { id: "n2", tickers: ["AAPL"], publishedAt: "2026-01-02T00:00:00.000Z" });
  await seedBar(db, { ticker: "AAPL", date: "2026-01-01", close: 100 });
  const health = await getIngestionHealth(readOnly(db));
  assert.equal(health.news.count, 2);
  assert.ok(health.news.lastIngestedAt);
  assert.equal(health.priceBars.count, 1);
  assert.equal(health.fundamentals.count, 0);
  assert.equal(health.fundamentals.lastIngestedAt, null);
});

test("getRecentPriceBars: the newest `limit` bars for one ticker, returned oldest-first", async () => {
  const db = createTestD1([INPUTS_DIR]);
  for (let d = 1; d <= 5; d++) await seedBar(db, { ticker: "AAPL", date: `2026-01-0${d}`, close: 100 + d });
  await seedBar(db, { ticker: "MSFT", date: "2026-01-09", close: 999 });

  const bars = await getRecentPriceBars(readOnly(db), { ticker: "AAPL", limit: 3 });
  assert.deepEqual(bars.map((b) => ({ ...b })), [{ date: "2026-01-03", close: 103 }, { date: "2026-01-04", close: 104 }, { date: "2026-01-05", close: 105 }]);
  assert.deepEqual(await getRecentPriceBars(readOnly(db), { ticker: "NOPE" }), []);
});
