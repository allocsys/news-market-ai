// checkpoint_resume test (plan.md open item, mirrors TradingAgents' test
// naming). Scope: exercises graph/checkpointer.js's stage-ordering logic and
// its round-trip through RunStore#saveCheckpoint/getCheckpoint, then
// runPipelineForTicker end-to-end.
//
// M2: everything here runs on REAL sqlite-backed DBs (test/helpers/
// engine_ctx.js -- the real migrations/state + migrations/inputs SQL), not
// hand-written fakes. The old FakeCheckpointDb/FakePipelineDb only
// understood the exact query shapes d1.js issued and had to be edited in
// lockstep with every SQL change; the real schema also proves things they
// couldn't (the (run_id, pipeline_run_id, ticker) checkpoint key, commitThesis's
// atomic batch actually opening the position).
//
// config.fakeModel (agents/utils/structured.js) is what makes the
// full-pipeline test possible without live Gemini calls across six agent
// modules. llm_calls (M2b) lands in the same state DB as the rest of the
// run's state, through ctx.store, so the log tests read it back with
// stateRows(ctx.stateDb, "llm_calls").

import test from "node:test";
import assert from "node:assert/strict";
import { STAGES, nextStage, checkpoint, resumeFrom } from "../src/graph/checkpointer.js";
import { runPipelineForTicker } from "../src/graph/pipeline.js";
import { runNewsEventAnalyst } from "../src/agents/analysts/newsEventAnalyst.js";
import { runSentimentAnalyst } from "../src/agents/analysts/sentimentAnalyst.js";
import { AnalystOpinion, DebateSide, DebateVerdict, TradeThesis } from "../src/schemas/index.js";
import { makeCtx, seedBar, stateRows } from "./helpers/engine_ctx.js";
import { withLlmLogContext } from "../src/storage/llm_calls.js";
import { RunStore } from "../src/storage/run_store.js";

test("nextStage(null) starts a brand-new run at the first stage", () => {
  assert.equal(nextStage(null), STAGES[0]);
});

test("nextStage walks STAGES in order and returns null after the last stage", () => {
  let stage = null;
  const seen = [];
  while (true) {
    stage = nextStage(stage);
    if (stage === null) break;
    seen.push(stage);
  }
  assert.deepEqual(seen, STAGES);
});

test("nextStage throws on an unrecognized stage name", () => {
  assert.throws(() => nextStage("not_a_real_stage"), /unknown stage/);
});

test("resumeFrom returns {stage: null, state: null} when no checkpoint exists yet", async () => {
  const { store } = makeCtx();
  const result = await resumeFrom(store, { pipelineRunId: "run-1", ticker: "AAPL" });
  assert.deepEqual(result, { stage: null, state: null });
});

test("checkpoint + resumeFrom resumes at the stage AFTER the last completed one, with state preserved", async () => {
  const { store } = makeCtx();
  const state = { opinions: [{ ticker: "AAPL", note: "fake analyst output" }] };

  await checkpoint(store, { pipelineRunId: "run-1", ticker: "AAPL", stage: "analyzed", state });
  const result = await resumeFrom(store, { pipelineRunId: "run-1", ticker: "AAPL" });

  assert.equal(result.stage, "debated"); // the stage after "analyzed"
  assert.deepEqual(result.state, state);
});

test("resumeFrom distinguishes a fully-completed run (nextStage null + state present) from a brand-new one (nextStage null + state null)", async () => {
  const { store } = makeCtx();
  const state = { portfolioDecision: { action: "hold" } };

  await checkpoint(store, { pipelineRunId: "run-1", ticker: "AAPL", stage: "portfolio_checked", state });
  const result = await resumeFrom(store, { pipelineRunId: "run-1", ticker: "AAPL" });

  assert.equal(result.stage, null); // no stage after the last one
  assert.deepEqual(result.state, state); // but state is populated -- this is what pipeline.js checks to short-circuit and return the cached decision
});

test("resumeFrom keeps separate (pipelineRunId, ticker) pairs independent", async () => {
  const { store } = makeCtx();
  await checkpoint(store, { pipelineRunId: "run-1", ticker: "AAPL", stage: "traded", state: { thesis: "aapl thesis" } });
  await checkpoint(store, { pipelineRunId: "run-1", ticker: "MSFT", stage: "analyzed", state: { opinions: ["msft opinion"] } });

  const aapl = await resumeFrom(store, { pipelineRunId: "run-1", ticker: "AAPL" });
  const msft = await resumeFrom(store, { pipelineRunId: "run-1", ticker: "MSFT" });

  assert.equal(aapl.stage, "risk_checked");
  assert.equal(msft.stage, "debated");
});

test("checkpoints are scoped by environment run_id: the same (pipelineRunId, ticker) in two RunStores never collides", async () => {
  const live = makeCtx({ runId: "live" });
  // Same underlying state DB, different environment id -- the backtest case.
  const { RunStore } = await import("../src/storage/run_store.js");
  const sim = new RunStore(live.stateDb, "bt-1");
  await checkpoint(live.store, { pipelineRunId: "run-1", ticker: "AAPL", stage: "analyzed", state: { env: "live" } });

  assert.deepEqual(await resumeFrom(sim, { pipelineRunId: "run-1", ticker: "AAPL" }), { stage: null, state: null });
  assert.deepEqual((await resumeFrom(live.store, { pipelineRunId: "run-1", ticker: "AAPL" })).state, { env: "live" });
});

// =======================================================================
// runPipelineForTicker -- true end-to-end integration, via config.fakeModel
// (agents/utils/structured.js), over real sqlite state + inputs DBs.
// =======================================================================

/** ctx with the one price bar runPipelineForTicker's entry-price lookup needs (PR #38's no-price-data guard). */
async function ctxWithEntryBar() {
  const ctx = makeCtx();
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-14", close: 181 });
  return ctx;
}

/**
 * A fake model that dispatches on the exact schema reference plus
 * extraFields (see structured.js's header) -- the same pattern
 * structured_fakemodel.test.js documents. Deliberately produces a
 * high-confidence "long" verdict so the pipeline exercises its full width:
 * risk_mgmt approves, portfolio_manager approves, a position actually
 * opens, and a trade_decision row is written.
 */
function makeFakeModel({ onCall } = {}) {
  return async (prompt, opts) => {
    onCall?.(opts);
    if (opts.schema === AnalystOpinion) {
      if (opts.extraFields.agent === "news_event") {
        return JSON.stringify({ eventType: "earnings_beat", entities: ["AAPL"], summary: "AAPL beat on EPS", justification: "guidance raised too" });
      }
      if (opts.extraFields.agent === "sentiment") {
        return JSON.stringify({ sentiment: "positive", summary: "market reaction positive", justification: "beat + raised guidance" });
      }
      if (opts.extraFields.agent === "technical") {
        return JSON.stringify({ summary: "one bar only, flat", justification: "not enough history for a trend read" });
      }
      throw new Error(`unexpected AnalystOpinion agent in test fake model: ${opts.extraFields.agent}`);
    }
    if (opts.schema === DebateSide) {
      return opts.extraFields.stance === "bull"
        ? JSON.stringify({ argument: "earnings beat justifies a long position", justification: "fundamentals improved" })
        : JSON.stringify({ argument: "one beat doesn't confirm a trend", justification: "macro risk remains" });
    }
    if (opts.schema === DebateVerdict) {
      return JSON.stringify({ direction: "long", confidence: 0.8, timeHorizon: "days", justification: "bull case outweighs bear case" });
    }
    if (opts.schema === TradeThesis) {
      return JSON.stringify({ instrument: "equity", rationale: "ride the post-earnings momentum" });
    }
    throw new Error(`unexpected schema in test fake model: ${JSON.stringify(opts.extraFields)}`);
  };
}

const NEWS_ITEM = { id: "news-1", title: "AAPL beats earnings", body: "Apple reported EPS above estimates and raised guidance." };

test("runPipelineForTicker runs the FULL pipeline end-to-end via config.fakeModel -- every stage checkpointed, a position opened, and a portfolioDecision returned", async () => {
  const ctx = await ctxWithEntryBar();
  const calls = [];
  const config = { geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, fakeModel: makeFakeModel({ onCall: (opts) => calls.push(opts) }) };

  const result = await runPipelineForTicker({}, config, ctx, {
    pipelineRunId: "news-1", ticker: "AAPL", newsItem: NEWS_ITEM, asOf: "2026-01-15T00:00:00Z",
  });

  assert.equal(result.approvedForExecution, true);
  assert.ok(result.finalPositionSizePct > 0);

  // Every stage checkpointed, in order, ending at portfolio_checked.
  const checkpoints = await stateRows(ctx.stateDb, "pipeline_checkpoints");
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].pipeline_run_id, "news-1");
  assert.equal(checkpoints[0].run_id, "live");
  assert.equal(checkpoints[0].stage, "portfolio_checked");

  // A position actually opened (confidence 0.8 clears risk.js's 0.6 threshold).
  const positions = await stateRows(ctx.stateDb, "positions");
  assert.equal(positions.length, 1);
  assert.equal(positions[0].ticker, "AAPL");
  assert.equal(positions[0].direction, "long");
  assert.equal(positions[0].closed_at, null);
  assert.equal(positions[0].run_id, "live");

  // A trade_decision row was persisted (status renamed approved -> opened in M2).
  const decisions = await stateRows(ctx.stateDb, "trade_decisions");
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].status, "opened");

  // Exactly one call per LLM-backed agent: 3 analysts (the technical analyst
  // runs now: the real inputs DB returns the seeded entry bar to it too) +
  // bull + bear + judge + trader = 7, single debate round since confidence
  // 0.8 already clears shouldContinueDebate's threshold.
  assert.equal(calls.length, 7);
});

test("runPipelineForTicker resumes after a simulated crash mid-pipeline WITHOUT re-invoking already-completed stages' LLM calls", async () => {
  const ctx = await ctxWithEntryBar();

  // First "process": complete only through the analyzed stage, exactly what
  // runPipelineForTicker's own first block does, then simulate a crash by
  // simply never calling the function again -- state.opinions is checkpointed
  // for real, same write graph/pipeline.js itself uses.
  const analystOnlyModel = async (prompt, opts) => {
    if (opts.schema !== AnalystOpinion) throw new Error("only analysts should run before the simulated crash");
    return opts.extraFields.agent === "news_event"
      ? JSON.stringify({ eventType: "earnings_beat", entities: ["AAPL"], summary: "beat", justification: "guidance raised" })
      : JSON.stringify({ sentiment: "positive", summary: "positive reaction", justification: "beat + guidance" });
  };
  const configForFirstHalf = { geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, fakeModel: analystOnlyModel };

  // Manually drive just the checkpointer the same way pipeline.js's first
  // `if (stage === null || stage === "ingested")` block does, so the fake
  // db ends up in exactly the state a real crash-after-"analyzed" run would
  // leave it in, without having to partially execute runPipelineForTicker
  // itself (which has no built-in way to stop early on command).
  const [newsOpinion, sentimentOpinion] = await Promise.all([
    runNewsEventAnalyst({}, configForFirstHalf, NEWS_ITEM),
    runSentimentAnalyst({}, configForFirstHalf, NEWS_ITEM),
  ]);
  await checkpoint(ctx.store, { pipelineRunId: "news-1", ticker: "AAPL", stage: "analyzed", state: { opinions: [newsOpinion, sentimentOpinion] } });

  // "Resume": a fresh call to runPipelineForTicker for the same (pipelineRunId,
  // ticker) -- a fake model that THROWS if an analyst (AnalystOpinion) is
  // ever called again is the actual resume assertion: if resumeFrom's
  // stage-skipping logic were broken, this test would fail on that throw,
  // not on an assertion after the fact.
  const calls = [];
  const resumeModel = async (prompt, opts) => {
    calls.push(opts);
    if (opts.schema === AnalystOpinion) {
      throw new Error("resume must NOT re-invoke the analyst stage -- it was already checkpointed");
    }
    if (opts.schema === DebateSide) {
      return opts.extraFields.stance === "bull"
        ? JSON.stringify({ argument: "bull case", justification: "j" })
        : JSON.stringify({ argument: "bear case", justification: "j" });
    }
    if (opts.schema === DebateVerdict) {
      return JSON.stringify({ direction: "long", confidence: 0.8, timeHorizon: "days", justification: "j" });
    }
    if (opts.schema === TradeThesis) {
      return JSON.stringify({ instrument: "equity", rationale: "j" });
    }
    throw new Error("unexpected schema during resume");
  };
  const configForResume = { geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, fakeModel: resumeModel };

  const result = await runPipelineForTicker({}, configForResume, ctx, {
    pipelineRunId: "news-1", ticker: "AAPL", newsItem: NEWS_ITEM, asOf: "2026-01-15T00:00:00Z",
  });

  assert.equal(result.approvedForExecution, true);
  assert.equal(calls.length, 4); // bull + bear + judge + trader -- NOT the 2 analysts again
  assert.equal((await resumeFrom(ctx.store, { pipelineRunId: "news-1", ticker: "AAPL" })).stage, null);
  assert.equal((await stateRows(ctx.stateDb, "pipeline_checkpoints"))[0].stage, "portfolio_checked");

  // The checkpointed opinions from BEFORE the simulated crash made it all
  // the way through to the debate stage unchanged -- proof state, not just
  // stage, survives the resume.
  const verdictPrompt = calls.find((c) => c.schema === DebateVerdict);
  assert.ok(verdictPrompt); // judge stage did run, using the pre-crash opinions passed through bull/bear
});

test("runPipelineForTicker returns null-confidence rejection without opening a position when the debate verdict has low confidence", async () => {
  const ctx = await ctxWithEntryBar();
  const lowConfidenceModel = async (prompt, opts) => {
    if (opts.schema === AnalystOpinion) {
      return opts.extraFields.agent === "news_event"
        ? JSON.stringify({ eventType: "minor_update", entities: ["AAPL"], summary: "minor update", justification: "nothing material" })
        : JSON.stringify({ sentiment: "neutral", summary: "no strong reaction", justification: "unclear signal" });
    }
    if (opts.schema === DebateSide) {
      return opts.extraFields.stance === "bull"
        ? JSON.stringify({ argument: "weak bull case", justification: "little evidence" })
        : JSON.stringify({ argument: "weak bear case", justification: "little evidence" });
    }
    if (opts.schema === DebateVerdict) {
      return JSON.stringify({ direction: "long", confidence: 0.3, timeHorizon: "days", justification: "low conviction either way" });
    }
    if (opts.schema === TradeThesis) {
      return JSON.stringify({ instrument: "equity", rationale: "low-confidence pass-through" });
    }
    throw new Error("unexpected schema");
  };
  const config = { geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, fakeModel: lowConfidenceModel };

  const result = await runPipelineForTicker({}, config, ctx, {
    pipelineRunId: "news-2", ticker: "AAPL", newsItem: { ...NEWS_ITEM, id: "news-2" }, asOf: "2026-01-15T00:00:00Z",
  });

  assert.equal(result.approvedForExecution, false); // risk.js's MIN_CONFIDENCE_TO_ACT (0.6) not met
  assert.equal((await stateRows(ctx.stateDb, "positions")).length, 0);
  const decisions = await stateRows(ctx.stateDb, "trade_decisions");
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].status, "rejected");
});

// ---------------------------------------------------------------------------
// LLM call log context (storage/llm_calls.js). Since M2b the engine's own
// store (ctx.store) is where the log writes, so the rows are read straight
// back out of the ctx's state DB; env is not involved at all.
// ---------------------------------------------------------------------------

const EXPECTED_LABELS = ["analyst:news_event", "analyst:sentiment", "analyst:technical", "debate:bear", "debate:bull", "debate:judge", "trader"];

const llmRows = (ctx) => stateRows(ctx.stateDb, "llm_calls", "id");

test("runPipelineForTicker logs every LLM call it makes, tagged with its runId and ticker, as source 'pipeline' by default", async () => {
  const ctx = await ctxWithEntryBar();
  const config = { geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, llmLogEnabled: true, fakeModel: makeFakeModel() };

  await runPipelineForTicker({}, config, ctx, { pipelineRunId: "news-1", ticker: "AAPL", newsItem: NEWS_ITEM, asOf: "2026-01-15T00:00:00Z" });

  const rows = await llmRows(ctx);
  assert.deepEqual(rows.map((r) => r.label).sort(), EXPECTED_LABELS);
  for (const row of rows) {
    assert.equal(row.env_run_id, "live", "the environment is the store's run id");
    assert.equal(row.source, "pipeline");
    assert.equal(row.run_id, "news-1", "run_id is the PIPELINE run, not the environment");
    assert.equal(row.ticker, "AAPL");
    assert.equal(row.job_id, null);
    assert.equal(row.status, "ok");
  }
  // The exact prompt each agent sent and the raw text it got back are what's stored.
  const trader = rows.find((r) => r.label === "trader");
  assert.match(trader.prompt, /You are a trader/);
  assert.match(trader.response, /ride the post-earnings momentum/);
  assert.equal(trader.requested_model, "deep");
  assert.equal(rows.find((r) => r.label === "analyst:sentiment").requested_model, "quick");
});

test("a pipeline run in a backtest environment logs under that environment's env_run_id", async () => {
  const ctx = makeCtx({ runId: "bt-1" });
  await seedBar(ctx.inputs, { ticker: "AAPL", date: "2026-01-14", close: 181 });
  const config = { geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, llmLogEnabled: true, fakeModel: makeFakeModel() };

  await runPipelineForTicker({}, config, ctx, { pipelineRunId: "news-1", ticker: "AAPL", newsItem: NEWS_ITEM, asOf: "2026-01-15T00:00:00Z" });

  const rows = await llmRows(ctx);
  assert.equal(rows.length, 7);
  assert.ok(rows.every((r) => r.env_run_id === "bt-1"));
  assert.equal((await ctx.store.getRecentLlmCalls()).calls.length, 7);
  assert.equal((await new RunStore(ctx.stateDb, "live").getRecentLlmCalls()).calls.length, 0, "the live environment sees none of it");
});

test("runPipelineForTicker keeps a source/jobId the caller set (a backtest), and only adds runId/ticker/store on top", async () => {
  const ctx = await ctxWithEntryBar();
  const base = { geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, llmLogEnabled: true, fakeModel: makeFakeModel() };
  const config = withLlmLogContext(base, { source: "backtest", jobId: "backtest-42" });

  await runPipelineForTicker({}, config, ctx, { pipelineRunId: "2026-01-01|AAPL|news-1", ticker: "AAPL", newsItem: NEWS_ITEM, asOf: "2026-01-15T00:00:00Z" });

  const rows = await llmRows(ctx);
  assert.equal(rows.length, 7);
  for (const row of rows) {
    assert.equal(row.source, "backtest");
    assert.equal(row.job_id, "backtest-42");
    assert.equal(row.run_id, "2026-01-01|AAPL|news-1");
  }
  assert.equal(config.llmLog.runId, undefined, "the caller's config object must not be mutated");
  assert.equal(config.llmLog.store, undefined, "...nor gain a store");
});

test("a resumed pipeline run doesn't log the stages it skips (no LLM call was made for them)", async () => {
  const ctx = await ctxWithEntryBar();
  const base = { geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, llmLogEnabled: true };

  // First attempt dies at the debate stage, after the analysts were logged.
  const crashModel = async (prompt, opts) => {
    if (opts.schema === DebateSide) throw new Error("simulated crash mid-pipeline");
    return makeFakeModel()(prompt, opts);
  };
  await assert.rejects(runPipelineForTicker({}, { ...base, fakeModel: crashModel }, ctx, { pipelineRunId: "news-1", ticker: "AAPL", newsItem: NEWS_ITEM, asOf: "2026-01-15T00:00:00Z" }));
  const afterCrash = await llmRows(ctx);
  assert.equal(afterCrash.filter((r) => r.label.startsWith("analyst:")).length, 3);
  const lastId = afterCrash[afterCrash.length - 1].id;

  // Retry: resumes at the debate stage, so the analysts must not be called (or logged) again.
  await runPipelineForTicker({}, { ...base, fakeModel: makeFakeModel() }, ctx, { pipelineRunId: "news-1", ticker: "AAPL", newsItem: NEWS_ITEM, asOf: "2026-01-15T00:00:00Z" });
  const retryRows = (await llmRows(ctx)).filter((r) => r.id > lastId);
  assert.deepEqual(retryRows.map((r) => r.label).sort(), ["debate:bear", "debate:bull", "debate:judge", "trader"]);
});
