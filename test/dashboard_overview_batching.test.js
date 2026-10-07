// Integration: getOverviewData through autoBatch, on REAL sqlite D1s (same
// convention as dashboard_overview.test.js). Proves the wiring, not just the
// wrapper (test/auto_batch.test.js): the Overview's reads reach D1 as fewer
// round trips, the page data is identical to the unbatched path, and a failing
// panel still fails alone.

import test from "node:test";
import assert from "node:assert/strict";
import { getOverviewData } from "../src/dashboard/data.js";
import { RunStore } from "../src/storage/run_store.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { STATE_DIR, INPUTS_DIR, seedBar, seedNews } from "./helpers/engine_ctx.js";

const BASE_PARAMS = { activityDays: 14, decisionStatus: "all", decisionLimit: 20, positionsLimit: 50, env: "live" };

/**
 * Counts how a db is reached. `withBatch: false` hides batch(), which makes autoBatch() return the handle unchanged,
 * i.e. the pre-batching behaviour: that is the baseline the batched run is compared against.
 * Statements keep `_execute` so the sqlite double's own batch() can run them.
 */
function counting(db, { withBatch = true } = {}) {
  const stats = { batches: 0, direct: 0, sizes: [] };
  const wrap = (s) => ({
    bind: (...a) => wrap(s.bind(...a)),
    all: () => (stats.direct++, s.all()),
    first: (c) => (stats.direct++, s.first(c)),
    run: () => (stats.direct++, s.run()),
    _execute: () => s._execute(),
  });
  const out = { stats, prepare: (sql) => wrap(db.prepare(sql)) };
  if (withBatch) {
    out.batch = async (stmts) => {
      stats.batches++;
      stats.sizes.push(stmts.length);
      return db.batch(stmts);
    };
  }
  return out;
}

const roundTrips = (s) => s.batches + s.direct;

async function seedRaw() {
  const raw = { LIVE_DB: createTestD1([STATE_DIR]), INPUTS_DB: createTestD1([INPUTS_DIR]), SIM_DB: createTestD1([STATE_DIR]) };
  const live = new RunStore(raw.LIVE_DB, "live");
  const now = new Date().toISOString();
  await live.openPosition({ id: "AAPL|open", ticker: "AAPL", tradeThesisId: "AAPL|open", positionSizePct: 0.05, direction: "long", entryPrice: 100, stopLossPct: 0.03, takeProfitPct: 0.06, openedAt: "2026-01-01T00:00:00.000Z" });
  await live.openPosition({ id: "MSFT|closed", ticker: "MSFT", tradeThesisId: "MSFT|closed", positionSizePct: 0.04, direction: "long", entryPrice: 100, stopLossPct: 0.03, takeProfitPct: 0.06, openedAt: "2026-01-02T00:00:00.000Z" });
  await live.closePosition({ id: "MSFT|closed", closedAt: "2026-01-03T00:00:00.000Z", closeReason: "take_profit", exitPrice: 110 });
  await live.insertTradeDecision({
    id: "d1", ticker: "AAPL", asOf: now, thesis: { ticker: "AAPL", direction: "long" }, riskDecision: { approved: true }, portfolioDecision: { reason: "test" }, status: "approved", createdAt: now,
    opinions: [{ agent: "news_event" }], debate: { direction: "long" },
  });
  await live.saveCheckpoint({ pipelineRunId: "pipe-1", ticker: "AAPL", stage: "trader", state: null });
  await seedNews(raw.INPUTS_DB, { id: "n1", tickers: ["AAPL"], publishedAt: now });
  await seedBar(raw.INPUTS_DB, { ticker: "AAPL", date: "2026-01-01", close: 100 });
  return raw;
}

const instrument = (raw, opts) => {
  const env = {};
  const stats = {};
  for (const name of Object.keys(raw)) {
    const c = counting(raw[name], opts);
    env[name] = c;
    stats[name] = c.stats;
  }
  return { env, stats };
};

// A panel whose query throws is logged (console.error in safe(), console.warn in autoBatch's fallback); keep test output clean.
async function quietly(fn) {
  const { error, warn } = console;
  console.error = () => {};
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.error = error;
    console.warn = warn;
  }
}

test("getOverviewData: reads reach D1 as fewer round trips, with identical page data", async (t) => {
  const raw = await seedRaw();
  const plain = instrument(raw, { withBatch: false });
  const batched = instrument(raw, { withBatch: true });

  const expected = await getOverviewData(plain.env, BASE_PARAMS);
  const actual = await getOverviewData(batched.env, BASE_PARAMS);

  assert.deepEqual(actual, expected, "batching must not change a single field of the Overview payload");
  assert.equal(actual.openPositions.length, 1, "sanity: the seed is actually being read");
  assert.equal(actual.latestDecision?.id, "d1");

  for (const name of Object.keys(raw)) {
    t.diagnostic(`${name}: plain=${roundTrips(plain.stats[name])} round trips, batched=${roundTrips(batched.stats[name])} (batches ${JSON.stringify(batched.stats[name].sizes)}, direct ${batched.stats[name].direct})`);
  }

  assert.equal(plain.stats.LIVE_DB.batches, 0, "baseline never batches");
  assert.ok(plain.stats.LIVE_DB.direct >= 6, `baseline should issue several separate LIVE_DB reads (got ${plain.stats.LIVE_DB.direct})`);

  // With no sequential awaits left in the composed reads, every read starts in the same tick and leaves as ONE batch per
  // database. LIVE_DB: open positions, closed positions, decision totals + daily, exposure, checkpoints + stage counts,
  // latest decision, realized P&L = 9. INPUTS_DB: news, price bars, fundamentals, macro health = 4. SIM_DB: untouched
  // for env=live. Exact sizes on purpose: a new `await` between two reads shows up here as an extra round trip.
  assert.deepEqual(batched.stats.LIVE_DB.sizes, [9], `LIVE_DB should be a single batch of 9 (sizes: ${JSON.stringify(batched.stats.LIVE_DB.sizes)})`);
  assert.equal(batched.stats.LIVE_DB.direct, 0, "no LIVE_DB read bypasses the batch");
  assert.deepEqual(batched.stats.INPUTS_DB.sizes, [4], `INPUTS_DB should be a single batch of 4 (sizes: ${JSON.stringify(batched.stats.INPUTS_DB.sizes)})`);
  assert.equal(batched.stats.INPUTS_DB.direct, 0, "no INPUTS_DB read bypasses the batch");
  assert.equal(roundTrips(batched.stats.SIM_DB), 0, "env=live never touches SIM_DB");
  assert.equal(roundTrips(batched.stats.LIVE_DB), 1);
  assert.equal(roundTrips(batched.stats.INPUTS_DB), 1);
  assert.ok(
    roundTrips(batched.stats.LIVE_DB) < roundTrips(plain.stats.LIVE_DB),
    `LIVE_DB round trips should drop (plain ${roundTrips(plain.stats.LIVE_DB)}, batched ${roundTrips(batched.stats.LIVE_DB)})`
  );

  const total = (x) => Object.values(x.stats).reduce((n, s) => n + roundTrips(s), 0);
  assert.ok(total(batched) < total(plain), `total round trips should drop (plain ${total(plain)}, batched ${total(batched)})`);
});

test("getOverviewData: a failing panel's query fails that panel only, same as without batching", async () => {
  const raw = await seedRaw();
  // The decisions table disappears: every read of it (decision stats, latest decision) throws, the rest still work.
  raw.LIVE_DB.exec("DROP TABLE trade_decisions");
  const plain = instrument(raw, { withBatch: false });
  const batched = instrument(raw, { withBatch: true });

  const expected = await quietly(() => getOverviewData(plain.env, BASE_PARAMS));
  const actual = await quietly(() => getOverviewData(batched.env, BASE_PARAMS));

  assert.deepEqual(actual, expected, "a failed batch is retried per statement, so every panel ends up exactly as it would unbatched");
  assert.ok(actual.latestDecisionError, "the decisions panel reports its own error");
  assert.ok(actual.snapshotError, "the stat grid reports the decision-stats failure");
  assert.equal(actual.pipelineError, null, "checkpoints panel unaffected");
  assert.equal(actual.healthError, null, "ingestion health panel unaffected");
  assert.equal(actual.openPositions.length, 1, "open positions still load next to the failed statement");
  assert.ok(batched.stats.LIVE_DB.batches >= 1, "the failure case really did go through a batch first");
});
