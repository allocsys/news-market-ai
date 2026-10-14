// POST /backtest/run with the temporary tuning param `seedFromRunId` (src/index.js, src/backtest/seedCheckpoints.js):
// checked up front (a 400 before any job row exists), forwarded on the queue message and in job_progress params when valid,
// absent from both when not given.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { STATE_DIR, SIM_DIR } from "./helpers/engine_ctx.js";
import { RunStore } from "../src/storage/run_store.js";
import { insertBacktestRun, completeBacktestRun } from "../src/storage/sim_registry.js";

const SOURCE = "backtest-1000-source";

class FakeBacktestQueue {
  constructor() {
    this.sent = [];
  }
  async send(body) {
    this.sent.push(body);
  }
}

function baseEnv() {
  return { SIM_DB: createTestD1([STATE_DIR, SIM_DIR]), BACKTEST: new FakeBacktestQueue(), WATCHLIST_TICKERS: "AAPL,MSFT" };
}

async function addSource(db, { id = SOURCE, testStart = "2024-01-01T00:00:00.000Z", tickers = ["AAPL", "MSFT"], complete = true } = {}) {
  await insertBacktestRun(db, { id, tickers, testStart, testEnd: "2024-01-31T00:00:00.000Z", trainDays: 0, testDays: 30, graceDays: 5, startedAt: "2024-02-01T00:00:00.000Z" });
  if (complete) await completeBacktestRun(db, { id, result: { knobs: {} }, finishedAt: "2024-02-01T01:00:00.000Z" });
}

function post(env, query) {
  return worker.fetch(new Request(`https://worker.example/backtest/run?testStart=2024-01-01&testEnd=2024-01-31&tickers=AAPL&${query}`, { method: "POST" }), env);
}

test("seedFromRunId: a valid source is forwarded on the queue message, the ack and the job_progress params", async () => {
  const env = baseEnv();
  await addSource(env.SIM_DB);

  const response = await post(env, `seedFromRunId=${SOURCE}`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.seedFromRunId, SOURCE);
  assert.equal(env.BACKTEST.sent.length, 1);
  assert.equal(env.BACKTEST.sent[0].seedFromRunId, SOURCE);
  const job = await new RunStore(env.SIM_DB, body.id).getJob(body.id);
  assert.equal(job.params.seedFromRunId, SOURCE);
});

test("seedFromRunId: absent -> no key on the message or in the ack (the default path is unchanged)", async () => {
  const env = baseEnv();
  const body = await (await post(env, "")).json();
  assert.equal("seedFromRunId" in env.BACKTEST.sent[0], false);
  assert.equal("seedFromRunId" in body, false);
});

test("seedFromRunId: a malformed id, a missing/unfinished source, another window or a ticker the source lacks is a 400 with nothing created or enqueued", async () => {
  const env = baseEnv();
  await addSource(env.SIM_DB, { id: "backtest-1001-running", complete: false });
  await addSource(env.SIM_DB, { id: "backtest-1002-otherwindow", testStart: "2024-02-01T00:00:00.000Z" });
  await addSource(env.SIM_DB, { id: "backtest-1003-msftonly", tickers: ["MSFT"] });

  for (const [seed, pattern] of [
    ["not-a-run-id", /malformed/],
    ["backtest-9-missing", /not found/],
    ["backtest-1001-running", /not complete/],
    ["backtest-1002-otherwindow", /testStart/],
    ["backtest-1003-msftonly", /did not cover AAPL/],
  ]) {
    const response = await post(env, `seedFromRunId=${seed}`);
    assert.equal(response.status, 400, seed);
    assert.match((await response.json()).error, pattern, seed);
  }
  assert.equal(env.BACKTEST.sent.length, 0);
  assert.equal((await env.SIM_DB.prepare("SELECT COUNT(*) AS n FROM job_progress").first()).n, 0, "no job row for a rejected request");
});
