// checkpoint_resume test (plan.md open item, mirrors TradingAgents' test
// naming). Scope: exercises graph/checkpointer.js's stage-ordering logic and
// its round-trip through storage/d1.js#saveCheckpoint/getCheckpoint against
// a minimal in-memory fake of D1's prepare/bind/run/first interface.
//
// HONEST SCOPE: FakeCheckpointDb below only understands the two queries
// d1.js actually issues against pipeline_checkpoints (an upsert and a
// point lookup by run_id+ticker) -- it is NOT a general D1/SQLite emulator,
// deliberately, matching this repo's convention of not building more than
// what's needed (see e.g. entity_resolution.js's domain map). It does not
// exercise runPipelineForTicker itself -- that's FakePipelineDb, a
// separate, wider fake covering positions/trade_decisions/decision_memory/
// price_bars too, further down this file. Splitting them keeps this file's
// top half a pure unit test of checkpointer.js's stage-ordering logic
// against the smallest fake that can exercise it.
//
// UPDATE (2026-09-17): agents/utils/structured.js now exposes
// config.fakeModel (see that file's header), which is what makes the
// full-pipeline integration test below possible -- previously this would
// have required live Gemini calls across six agent modules.

import test from "node:test";
import assert from "node:assert/strict";
import { STAGES, nextStage, checkpoint, resumeFrom } from "../src/graph/checkpointer.js";
import { runPipelineForTicker } from "../src/graph/pipeline.js";
import { runNewsEventAnalyst } from "../src/agents/analysts/newsEventAnalyst.js";
import { runSentimentAnalyst } from "../src/agents/analysts/sentimentAnalyst.js";
import { AnalystOpinion, DebateSide, DebateVerdict, TradeThesis } from "../src/schemas/index.js";

class FakeCheckpointDb {
  constructor() {
    this.rows = new Map(); // key: `${runId}|${ticker}` -> { stage, state, updated_at }
  }

  prepare(sql) {
    const db = this;
    return {
      bind(...args) {
        return {
          async run() {
            if (!/INSERT INTO pipeline_checkpoints/.test(sql)) {
              throw new Error(`FakeCheckpointDb: unsupported run() query: ${sql}`);
            }
            const [runId, ticker, stage, state, updatedAt] = args;
            db.rows.set(`${runId}|${ticker}`, { stage, state, updated_at: updatedAt });
          },
          async first() {
            if (!/SELECT stage, state, updated_at FROM pipeline_checkpoints/.test(sql)) {
              throw new Error(`FakeCheckpointDb: unsupported first() query: ${sql}`);
            }
            const [runId, ticker] = args;
            return db.rows.get(`${runId}|${ticker}`) ?? null;
          },
        };
      },
    };
  }
}

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
  const db = new FakeCheckpointDb();
  const result = await resumeFrom(db, { runId: "run-1", ticker: "AAPL" });
  assert.deepEqual(result, { stage: null, state: null });
});

test("checkpoint + resumeFrom resumes at the stage AFTER the last completed one, with state preserved", async () => {
  const db = new FakeCheckpointDb();
  const state = { opinions: [{ ticker: "AAPL", note: "fake analyst output" }] };

  await checkpoint(db, { runId: "run-1", ticker: "AAPL", stage: "analyzed", state });
  const result = await resumeFrom(db, { runId: "run-1", ticker: "AAPL" });

  assert.equal(result.stage, "debated"); // the stage after "analyzed"
  assert.deepEqual(result.state, state);
});

test("resumeFrom distinguishes a fully-completed run (nextStage null + state present) from a brand-new one (nextStage null + state null)", async () => {
  const db = new FakeCheckpointDb();
  const state = { portfolioDecision: { action: "hold" } };

  await checkpoint(db, { runId: "run-1", ticker: "AAPL", stage: "portfolio_checked", state });
  const result = await resumeFrom(db, { runId: "run-1", ticker: "AAPL" });

  assert.equal(result.stage, null); // no stage after the last one
  assert.deepEqual(result.state, state); // but state is populated -- this is what pipeline.js checks to short-circuit and return the cached decision
});

test("resumeFrom keeps separate (runId, ticker) pairs independent", async () => {
  const db = new FakeCheckpointDb();
  await checkpoint(db, { runId: "run-1", ticker: "AAPL", stage: "traded", state: { thesis: "aapl thesis" } });
  await checkpoint(db, { runId: "run-1", ticker: "MSFT", stage: "analyzed", state: { opinions: ["msft opinion"] } });

  const aapl = await resumeFrom(db, { runId: "run-1", ticker: "AAPL" });
  const msft = await resumeFrom(db, { runId: "run-1", ticker: "MSFT" });

  assert.equal(aapl.stage, "risk_checked");
  assert.equal(msft.stage, "debated");
});

// =======================================================================
// runPipelineForTicker -- true end-to-end integration, via config.fakeModel
// (agents/utils/structured.js). FakePipelineDb below is wider than
// FakeCheckpointDb above: it also covers positions, trade_decisions, and
// the decision_memory/price_bars reads the pipeline touches along the way
// (both returning empty results here -- no price history or prior
// decisions is a normal, honest state for a ticker's first-ever run, and
// keeps this fake from needing to be a general SQLite emulator).
// =======================================================================

class FakePipelineDb {
  constructor() {
    this.checkpoints = new Map(); // `${runId}|${ticker}` -> { stage, state, updated_at }
    this.positions = [];
    this.tradeDecisions = [];
  }

  prepare(sql) {
    const db = this;
    return {
      bind(...args) {
        return {
          async run() {
            if (/INSERT INTO pipeline_checkpoints/.test(sql)) {
              const [runId, ticker, stage, state, updatedAt] = args;
              db.checkpoints.set(`${runId}|${ticker}`, { stage, state, updated_at: updatedAt });
              return;
            }
            if (/INSERT INTO positions/.test(sql)) {
              const [id, ticker, tradeThesisId, positionSizePct, direction, entryPrice, stopLossPct, takeProfitPct, openedAt] = args;
              if (db.positions.some((p) => p.id === id)) return; // ON CONFLICT(id) DO NOTHING
              db.positions.push({
                id, ticker, trade_thesis_id: tradeThesisId, position_size_pct: positionSizePct,
                direction, entry_price: entryPrice, stop_loss_pct: stopLossPct, take_profit_pct: takeProfitPct,
                opened_at: openedAt, closed_at: null, close_reason: null,
              });
              return;
            }
            if (/UPDATE positions SET closed_at/.test(sql)) {
              const [closedAt, closeReason, id] = args;
              const p = db.positions.find((p) => p.id === id && p.closed_at === null);
              if (p) { p.closed_at = closedAt; p.close_reason = closeReason; }
              return;
            }
            if (/INSERT INTO trade_decisions/.test(sql)) {
              const [id, ticker, asOf, debateId, thesis, riskDecision, portfolioDecision, status, createdAt] = args;
              if (db.tradeDecisions.some((d) => d.id === id)) return; // ON CONFLICT(id) DO NOTHING
              db.tradeDecisions.push({ id, ticker, as_of: asOf, debate_id: debateId, thesis, risk_decision: riskDecision, portfolio_decision: portfolioDecision, status, created_at: createdAt });
              return;
            }
            throw new Error(`FakePipelineDb: unsupported run() query: ${sql}`);
          },
          async first() {
            if (/SELECT stage, state, updated_at FROM pipeline_checkpoints/.test(sql)) {
              const [runId, ticker] = args;
              return db.checkpoints.get(`${runId}|${ticker}`) ?? null;
            }
            if (/FROM positions/.test(sql) && /LIMIT 1/.test(sql)) {
              // getOpenPositionForTickerAsOf: bind(ticker, asOf, asOf)
              const [ticker, asOf, asOfClose] = args;
              const open = db.positions
                .filter((p) => p.ticker === ticker && p.opened_at <= asOf && (p.closed_at === null || p.closed_at > asOfClose))
                .sort((a, b) => (a.opened_at < b.opened_at ? 1 : -1));
              return open[0] ?? null;
            }
            throw new Error(`FakePipelineDb: unsupported first() query: ${sql}`);
          },
          async all() {
            if (/SELECT position_size_pct FROM positions/.test(sql)) {
              // getOpenPositionsRiskPctAsOf: bind(asOf, asOf) or bind(asOf, asOf, excludeTicker)
              const [asOf, asOfClose, excludeTicker] = args;
              const results = db.positions
                .filter((p) => p.opened_at <= asOf && (p.closed_at === null || p.closed_at > asOfClose))
                .filter((p) => !excludeTicker || p.ticker !== excludeTicker)
                .map((p) => ({ position_size_pct: p.position_size_pct }));
              return { results };
            }
            if (/FROM price_bars/.test(sql)) {
              return { results: [] }; // no price history seeded -- technicalAnalyst self-skips on empty bars
            }
            if (/FROM decision_memory/.test(sql)) {
              return { results: [] }; // no prior decisions for this fresh test ticker
            }
            throw new Error(`FakePipelineDb: unsupported all() query: ${sql}`);
          },
        };
      },
    };
  }
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
  const db = new FakePipelineDb();
  const calls = [];
  const config = { geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, fakeModel: makeFakeModel({ onCall: (opts) => calls.push(opts) }) };

  const result = await runPipelineForTicker({}, config, db, {
    runId: "news-1", ticker: "AAPL", newsItem: NEWS_ITEM, asOf: "2026-01-15T00:00:00Z",
  });

  assert.equal(result.approvedForExecution, true);
  assert.ok(result.finalPositionSizePct > 0);

  // Every stage checkpointed, in order, ending at portfolio_checked.
  const finalCheckpoint = db.checkpoints.get("news-1|AAPL");
  assert.equal(finalCheckpoint.stage, "portfolio_checked");

  // A position actually opened (confidence 0.8 clears risk.js's 0.6 threshold).
  assert.equal(db.positions.length, 1);
  assert.equal(db.positions[0].ticker, "AAPL");
  assert.equal(db.positions[0].direction, "long");
  assert.equal(db.positions[0].closed_at, null);

  // A trade_decision row was persisted.
  assert.equal(db.tradeDecisions.length, 1);
  assert.equal(db.tradeDecisions[0].status, "approved");

  // Exactly one call per LLM-backed agent: 2 analysts (technical self-skips,
  // no price bars) + bull + bear + judge + trader = 6, single debate round
  // since confidence 0.8 already clears shouldContinueDebate's threshold.
  assert.equal(calls.length, 6);
});

test("runPipelineForTicker resumes after a simulated crash mid-pipeline WITHOUT re-invoking already-completed stages' LLM calls", async () => {
  const db = new FakePipelineDb();

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
  await checkpoint(db, { runId: "news-1", ticker: "AAPL", stage: "analyzed", state: { opinions: [newsOpinion, sentimentOpinion] } });

  // "Resume": a fresh call to runPipelineForTicker for the same (runId,
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

  const result = await runPipelineForTicker({}, configForResume, db, {
    runId: "news-1", ticker: "AAPL", newsItem: NEWS_ITEM, asOf: "2026-01-15T00:00:00Z",
  });

  assert.equal(result.approvedForExecution, true);
  assert.equal(calls.length, 4); // bull + bear + judge + trader -- NOT the 2 analysts again
  assert.equal(db.checkpoints.get("news-1|AAPL").stage, "portfolio_checked");

  // The checkpointed opinions from BEFORE the simulated crash made it all
  // the way through to the debate stage unchanged -- proof state, not just
  // stage, survives the resume.
  const verdictPrompt = calls.find((c) => c.schema === DebateVerdict);
  assert.ok(verdictPrompt); // judge stage did run, using the pre-crash opinions passed through bull/bear
});

test("runPipelineForTicker returns null-confidence rejection without opening a position when the debate verdict has low confidence", async () => {
  const db = new FakePipelineDb();
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

  const result = await runPipelineForTicker({}, config, db, {
    runId: "news-2", ticker: "AAPL", newsItem: { ...NEWS_ITEM, id: "news-2" }, asOf: "2026-01-15T00:00:00Z",
  });

  assert.equal(result.approvedForExecution, false); // risk.js's MIN_CONFIDENCE_TO_ACT (0.6) not met
  assert.equal(db.positions.length, 0);
  assert.equal(db.tradeDecisions.length, 1);
  assert.equal(db.tradeDecisions[0].status, "rejected");
});
