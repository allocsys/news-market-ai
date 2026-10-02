// Same-direction group concentration cap (MAX_GROUP_EXPOSURE_PCT, TICKER_GROUPS) enforced INSIDE
// RunStore#commitThesis's SQL, so two runs that both passed portfolio_manager.js's pre-check on a stale
// view cannot both open. Every test here calls commitThesis directly (no JS pre-check at all), which is
// exactly the racing case: the SQL alone must reject. Real sqlite-backed D1.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { RunStore } from "../src/storage/run_store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, "..", "migrations", "state");

function newStore() {
  return new RunStore(createTestD1([STATE_DIR]), "live");
}

function thesisArgs({ ticker, asOf, direction = "long", confidence = 0.8, positionSizePct = 0.05 }) {
  const id = `${ticker}|${asOf}`;
  return {
    id,
    ticker,
    tradeThesisId: id,
    positionSizePct,
    direction,
    confidence,
    entryPrice: 100,
    stopLossPct: 0.03,
    takeProfitPct: 0.06,
    asOf,
    thesis: { ticker, asOf, direction },
    riskDecision: { approved: true, positionSizePct },
    createdAt: asOf,
  };
}

async function statusOf(store, id) {
  const row = await store.db.prepare(`SELECT status FROM trade_decisions WHERE run_id = ? AND id = ?`).bind("live", id).first();
  return row?.status ?? null;
}

async function commit(store, args) {
  await store.commitThesis(args);
  return statusOf(store, args.id);
}

test("a third same-direction position in one group is rejected in SQL, with no position opened", async () => {
  const store = newStore();
  assert.equal(await commit(store, thesisArgs({ ticker: "AAPL", asOf: "2026-01-05T00:00:00Z" })), "opened");
  assert.equal(await commit(store, thesisArgs({ ticker: "MSFT", asOf: "2026-01-05T01:00:00Z" })), "opened");
  // Total exposure 15% is under the 20% ceiling and loss-at-stop is tiny, so only the group cap can reject this.
  assert.equal(await commit(store, thesisArgs({ ticker: "TSLA", asOf: "2026-01-05T02:00:00Z" })), "rejected");
  assert.equal(await store.getOpenPositionForTickerAsOf({ ticker: "TSLA", asOf: "2026-01-06T00:00:00Z" }), null);
});

test("an opposite-direction position in the same group offsets and is not counted", async () => {
  const store = newStore();
  await commit(store, thesisArgs({ ticker: "AAPL", asOf: "2026-01-05T00:00:00Z" }));
  await commit(store, thesisArgs({ ticker: "MSFT", asOf: "2026-01-05T01:00:00Z" }));
  assert.equal(await commit(store, thesisArgs({ ticker: "TSLA", asOf: "2026-01-05T02:00:00Z", direction: "short" })), "opened");
});

test("a different group is never capped against the full equity group", async () => {
  const store = newStore();
  await commit(store, thesisArgs({ ticker: "AAPL", asOf: "2026-01-05T00:00:00Z" }));
  await commit(store, thesisArgs({ ticker: "MSFT", asOf: "2026-01-05T01:00:00Z" }));
  assert.equal(await commit(store, thesisArgs({ ticker: "USO", asOf: "2026-01-05T02:00:00Z" })), "opened");
});

test("a ticker re-evaluated against its own open position is held, not rejected by its own group size", async () => {
  const store = newStore();
  await commit(store, thesisArgs({ ticker: "AAPL", asOf: "2026-01-05T00:00:00Z" }));
  await commit(store, thesisArgs({ ticker: "MSFT", asOf: "2026-01-05T01:00:00Z" }));
  // AAPL already holds 5% and MSFT 5%: this ticker is excluded from the group sum, so the answer is the
  // pre-existing hold rule ('held'), not a concentration rejection.
  assert.equal(await commit(store, thesisArgs({ ticker: "AAPL", asOf: "2026-01-06T00:00:00Z" })), "held");
});

test("the group sum is point-in-time: a peer that opens after asOf does not count", async () => {
  const store = newStore();
  await commit(store, thesisArgs({ ticker: "AAPL", asOf: "2026-01-10T00:00:00Z" }));
  await commit(store, thesisArgs({ ticker: "MSFT", asOf: "2026-01-05T00:00:00Z" }));
  // At 2026-01-06 only MSFT is open (AAPL opens on 01-10), so 5% + 5% = 10% fits the cap exactly.
  assert.equal(await commit(store, thesisArgs({ ticker: "TSLA", asOf: "2026-01-06T00:00:00Z" })), "opened");
});

test("a ticker outside TICKER_GROUPS is its own group and is never capped", async () => {
  const store = newStore();
  for (const [i, t] of ["NVDA", "AMD", "INTC"].entries()) {
    assert.equal(await commit(store, thesisArgs({ ticker: t, asOf: `2026-01-05T0${i}:00:00Z` })), "opened");
  }
});
