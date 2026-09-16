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
// exercise runPipelineForTicker itself, since that requires live Gemini
// calls across six agent modules -- a true integration test of the full
// resume path belongs in a separate, mocked-LLM-layer test once
// agents/utils/structured.js exposes a way to inject a fake model response.

import test from "node:test";
import assert from "node:assert/strict";
import { STAGES, nextStage, checkpoint, resumeFrom } from "../src/graph/checkpointer.js";

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
