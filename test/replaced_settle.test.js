// M2 additions around replacing a position and settling it (storage/
// run_store.js#getUnsettledReplacedPositions + graph/pipeline.js's use of it),
// and the shared TRADE_DECISION_STATUS constants. All on REAL sqlite state +
// inputs DBs (test/helpers/engine_ctx.js).
//
// WHY THE QUERY EXISTS: commitThesis closes the replaced position and opens
// the new one in ONE atomic batch; settling the replaced position (realized
// return + reflection) is a separate LLM-touching step AFTER it. If the
// process dies in between, the queue retries the ANALYZE message -- and the
// retry sees its own new position as "the existing one" (commitThesis is an
// idempotent no-op), so remembering `existingPosition` in memory would lose the
// settle. Querying "replaced at exactly this asOf, with no decision_memory
// row yet" recovers it.

import test from "node:test";
import assert from "node:assert/strict";
import { runPipelineForTicker } from "../src/graph/pipeline.js";
import { TRADE_DECISION_STATUS } from "../src/shared/constants.js";
import { LookaheadViolationError } from "../src/shared/errors.js";
import { AnalystTeamOpinion, DebateSide, DebateVerdict, TradeThesis } from "../src/schemas/index.js";
import { makeCtx, seedBar, stateRows } from "./helpers/engine_ctx.js";

function thesisArgs({ id, asOf, ticker = "AAPL", positionSizePct = 0.05 }) {
  return {
    id, ticker, tradeThesisId: id, positionSizePct, direction: "long", entryPrice: 100, stopLossPct: 0.03, takeProfitPct: 0.06, exitPrice: 110,
    asOf, thesis: { ticker, asOf, direction: "long" }, riskDecision: { approved: true, positionSizePct }, createdAt: asOf,
  };
}

// --- getUnsettledReplacedPositions ------------------------------------------

test("getUnsettledReplacedPositions returns the position a commit just replaced, with its recorded exitPrice", async () => {
  const { store } = makeCtx();
  await store.commitThesis(thesisArgs({ id: "AAPL|t1", asOf: "2026-01-10T00:00:00Z" }));
  await store.commitThesis({ ...thesisArgs({ id: "AAPL|t2", asOf: "2026-01-15T00:00:00Z" }), exitPrice: 111 });

  const unsettled = await store.getUnsettledReplacedPositions({ ticker: "AAPL", closedAt: "2026-01-15T00:00:00Z" });
  assert.equal(unsettled.length, 1);
  assert.equal(unsettled[0].id, "AAPL|t1");
  assert.equal(unsettled[0].tradeThesisId, "AAPL|t1");
  assert.equal(unsettled[0].closeReason, "replaced");
  assert.equal(unsettled[0].exitPrice, 111);
  assert.equal(unsettled[0].entryPrice, 100);
});

test("getUnsettledReplacedPositions excludes a position once its outcome is settled (decision_memory row exists)", async () => {
  const { store } = makeCtx();
  await store.commitThesis(thesisArgs({ id: "AAPL|t1", asOf: "2026-01-10T00:00:00Z" }));
  await store.commitThesis(thesisArgs({ id: "AAPL|t2", asOf: "2026-01-15T00:00:00Z" }));
  await store.recordDecisionOutcome({
    id: "mem-1", decisionId: "AAPL|t1", ticker: "AAPL", realizedReturn: 0.1, alphaReturn: null, reflection: "r", resolvedAt: "2026-01-15T00:00:00Z",
  });

  assert.deepEqual(await store.getUnsettledReplacedPositions({ ticker: "AAPL", closedAt: "2026-01-15T00:00:00Z" }), []);
});

test("getUnsettledReplacedPositions only matches the exact closedAt, the ticker, and 'replaced' closes", async () => {
  const { store } = makeCtx();
  await store.commitThesis(thesisArgs({ id: "AAPL|t1", asOf: "2026-01-10T00:00:00Z" }));
  await store.commitThesis(thesisArgs({ id: "AAPL|t2", asOf: "2026-01-15T00:00:00Z" }));
  await store.openPosition({ id: "MSFT|t1", ticker: "MSFT", tradeThesisId: "MSFT|t1", positionSizePct: 0.02, openedAt: "2026-01-01T00:00:00Z" });
  await store.closePosition({ id: "MSFT|t1", closedAt: "2026-01-15T00:00:00Z", closeReason: "stop_loss" });

  assert.deepEqual(await store.getUnsettledReplacedPositions({ ticker: "AAPL", closedAt: "2026-01-16T00:00:00Z" }), []);
  assert.deepEqual(await store.getUnsettledReplacedPositions({ ticker: "MSFT", closedAt: "2026-01-15T00:00:00Z" }), []);
});

test("getUnsettledReplacedPositions requires closedAt", async () => {
  const { store } = makeCtx();
  await assert.rejects(() => store.getUnsettledReplacedPositions({ ticker: "AAPL" }), LookaheadViolationError);
});

// --- pipeline: retry after commit-before-settle -----------------------------

function makeModel() {
  return async (prompt, opts) => {
    if (prompt.startsWith("A trade decision for")) {
      return JSON.stringify({ reflection: "settled on retry" });
    }
    if (opts.schema === AnalystTeamOpinion) {
      return JSON.stringify({
        news_event: { eventType: "earnings_beat", entities: [], summary: "beat", justification: "j" },
        sentiment: { sentiment: "positive", summary: "positive", justification: "j" },
        technical: { summary: "flat", justification: "j" },
      });
    }
    if (opts.schema === DebateSide) return JSON.stringify({ argument: "a", justification: "j" });
    if (opts.schema === DebateVerdict) return JSON.stringify({ direction: "long", confidence: 0.8, timeHorizon: "days", justification: "j" });
    if (opts.schema === TradeThesis) return JSON.stringify({ instrument: "equity", rationale: "r" });
    throw new Error("unexpected schema");
  };
}

const baseConfig = (fakeModel) => ({ geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, fakeModel });
const newsItem = (id) => ({ id, title: "AAPL news", body: "body" });

test("a pipeline retry after the replace-commit but before settling still settles the replaced position exactly once", async () => {
  const ctx = makeCtx();
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-09", close: 100 });
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-14", close: 110 });

  // First thesis opens a position at 100.
  await runPipelineForTicker({}, baseConfig(makeModel()), ctx, { pipelineRunId: "news-1", ticker: "AAPL", newsItem: newsItem("news-1"), asOf: "2026-01-10T00:00:00Z" });
  assert.equal((await stateRows(ctx.stateDb, "decision_memory")).length, 0);

  // Second thesis replaces it, but the process "dies" right after the atomic
  // batch: the step that looks up what to settle throws once, uncaught, exactly
  // like a crash between commitThesis and settlePositionOutcome would.
  // (settlePositionOutcome itself logs-and-swallows a failed reflection by
  // design -- that path never rejects -- so the crash is injected before it.)
  const realLookup = ctx.store.getUnsettledReplacedPositions.bind(ctx.store);
  let crashed = false;
  ctx.store.getUnsettledReplacedPositions = async (args) => {
    if (!crashed) {
      crashed = true;
      throw new Error("simulated process death after the commit batch");
    }
    return realLookup(args);
  };
  await assert.rejects(
    runPipelineForTicker({}, baseConfig(makeModel()), ctx, { pipelineRunId: "news-2", ticker: "AAPL", newsItem: newsItem("news-2"), asOf: "2026-01-15T00:00:00Z" }),
    /simulated process death after the commit batch/
  );
  let positions = await stateRows(ctx.stateDb, "positions", "opened_at");
  assert.equal(positions.length, 2);
  assert.equal(positions[0].close_reason, "replaced"); // the atomic batch DID land
  assert.equal(positions[1].closed_at, null);
  assert.equal((await stateRows(ctx.stateDb, "decision_memory")).length, 0); // ...but nothing was settled

  // Queue retry: commitThesis is a no-op now, yet the replaced position is found by query and settled.
  await runPipelineForTicker({}, baseConfig(makeModel()), ctx, { pipelineRunId: "news-2", ticker: "AAPL", newsItem: newsItem("news-2"), asOf: "2026-01-15T00:00:00Z" });
  const memory = await stateRows(ctx.stateDb, "decision_memory");
  assert.equal(memory.length, 1);
  assert.equal(memory[0].decision_id, positions[0].trade_thesis_id);
  assert.equal(memory[0].realized_return, (110 - 100) / 100);
  assert.equal(memory[0].reflection, "settled on retry");

  // Still exactly one open position, no double-open from the retry.
  positions = await stateRows(ctx.stateDb, "positions", "opened_at");
  assert.equal(positions.filter((p) => p.closed_at === null).length, 1);
  assert.equal(positions.length, 2);

  // A further replay settles nothing new.
  await runPipelineForTicker({}, baseConfig(makeModel()), ctx, { pipelineRunId: "news-2", ticker: "AAPL", newsItem: newsItem("news-2"), asOf: "2026-01-15T00:00:00Z" });
  assert.equal((await stateRows(ctx.stateDb, "decision_memory")).length, 1);
});

// --- status constants ---------------------------------------------------------

test("TRADE_DECISION_STATUS holds the agreed names", () => {
  assert.deepEqual({ ...TRADE_DECISION_STATUS }, {
    OPENED: "opened", REJECTED: "rejected", SUPERSEDED: "superseded", SKIPPED_NO_PRICE_DATA: "skipped_no_price_data",
  });
});

test("the pipeline records SKIPPED_NO_PRICE_DATA when a thesis is approved but no price bar exists", async () => {
  const ctx = makeCtx(); // no bars seeded
  await runPipelineForTicker({}, baseConfig(makeModel()), ctx, { pipelineRunId: "news-1", ticker: "AAPL", newsItem: newsItem("news-1"), asOf: "2026-01-10T00:00:00Z" });

  const decisions = await stateRows(ctx.stateDb, "trade_decisions");
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].status, TRADE_DECISION_STATUS.SKIPPED_NO_PRICE_DATA);
  assert.equal((await stateRows(ctx.stateDb, "positions")).length, 0);
});

// The SUPERSEDED / OPENED / REJECTED outcomes produced by commitThesis's SQL
// (interpolated from these same constants) are pinned in test/run_store.test.js
// ("out-of-order asOf is superseded", "opens a fresh position and records
// status 'opened'", the ceiling-breach rejection).
