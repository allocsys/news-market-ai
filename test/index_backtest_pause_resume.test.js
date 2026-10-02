// Covers backend's (src/index.js) POST /backtest/:id/pause and /resume routes. Real sqlite SIM_DB
// (state + sim schema) and LIVE_DB (for the Backtests/LLM pause switches); BACKTEST is a fake queue.
// Same harness shape as test/index_backtest_enqueue.test.js.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { STATE_DIR, SIM_DIR } from "./helpers/engine_ctx.js";
import { insertBacktestRun, pauseBacktestRun, completeBacktestRun } from "../src/storage/sim_registry.js";
import { setPauseFlags } from "../src/storage/pause_flags.js";

const ID = "backtest-1760000000000-abc123";

const ENVELOPE = {
  part: 4,
  cursor: { clockNow: "2026-01-04T00:00:00.000Z", phase: "walk" },
  job: { id: ID, tickers: ["AAPL", "MSFT"], testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-09T00:00:00.000Z", graceDays: 1, knobOverrides: { TRAIL_ACTIVATION_R: 1 } },
};

class FakeQueue {
  constructor() {
    this.sent = [];
  }
  async send(body) {
    this.sent.push(body);
  }
}

class ThrowingQueue {
  async send() {
    throw new Error("simulated queue send failure");
  }
}

function env(overrides = {}) {
  return { SIM_DB: createTestD1([STATE_DIR, SIM_DIR]), LIVE_DB: createTestD1([STATE_DIR]), BACKTEST: new FakeQueue(), ...overrides };
}

const post = (e, path) => worker.fetch(new Request(`https://worker.example${path}`, { method: "POST" }), e);
const row = (e, id = ID) => e.SIM_DB.prepare("SELECT status, cursor, paused_reason, paused_at, resume_after FROM backtest_runs WHERE id = ?").bind(id).first();

async function seedRun(e, id = ID) {
  await insertBacktestRun(e.SIM_DB, { id, tickers: ["AAPL", "MSFT"], testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-09T00:00:00.000Z", trainDays: 0, testDays: 8, graceDays: 1, startedAt: "2026-05-10T00:00:00.000Z" });
}

const quiet = (t) => { t.mock.method(console, "log", () => {}); t.mock.method(console, "error", () => {}); };

// ---------------------------------------------------------------------------
// POST /backtest/:id/pause
// ---------------------------------------------------------------------------

test("POST /backtest/:id/pause parks a running run as an operator pause (no cursor yet) and answers {paused:true}", async (t) => {
  quiet(t);
  const e = env();
  await seedRun(e);
  const res = await post(e, `/backtest/${ID}/pause`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { paused: true, id: ID });
  const r = await row(e);
  assert.equal(r.status, "paused");
  assert.equal(r.paused_reason, "operator");
  assert.ok(r.paused_at);
  assert.equal(r.cursor, null, "the in-flight continuation saves the cursor later");
  assert.equal(e.BACKTEST.sent.length, 0, "pausing enqueues nothing");
});

test("POST /backtest/:id/pause is idempotent on an already-paused run", async (t) => {
  quiet(t);
  const e = env();
  await seedRun(e);
  await post(e, `/backtest/${ID}/pause`);
  const first = await row(e);
  const again = await post(e, `/backtest/${ID}/pause`);
  assert.equal(again.status, 200);
  assert.equal((await row(e)).paused_at, first.paused_at, "original pause stamp kept");
});

test("POST /backtest/:id/pause: 404 for an unknown run, 409 naming the status for a finished one, 400 for a malformed id", async (t) => {
  quiet(t);
  const e = env();
  const missing = await post(e, `/backtest/${ID}/pause`);
  assert.equal(missing.status, 404);

  await seedRun(e);
  await completeBacktestRun(e.SIM_DB, { id: ID, result: { ok: true }, finishedAt: "2026-05-10T01:00:00.000Z" });
  const done = await post(e, `/backtest/${ID}/pause`);
  assert.equal(done.status, 409);
  assert.match((await done.json()).error, /already complete/);
  assert.equal((await row(e)).status, "complete", "a terminal run is never resurrected");

  const bad = await post(e, "/backtest/not%20an%20id!/pause");
  assert.equal(bad.status, 400);
});

// ---------------------------------------------------------------------------
// POST /backtest/:id/resume
// ---------------------------------------------------------------------------

test("POST /backtest/:id/resume re-enqueues the parked envelope (job + next part + cursor), flips the run to running and reports the previous reason", async (t) => {
  quiet(t);
  const e = env();
  await seedRun(e);
  await pauseBacktestRun(e.SIM_DB, { id: ID, reason: "d1_write_budget", cursor: ENVELOPE, pausedAt: "2026-05-10T10:00:00.000Z", resumeAfter: "2026-05-11T00:00:00.000Z" });

  const res = await post(e, `/backtest/${ID}/resume`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { resumed: true, id: ID, part: 4, previousReason: "d1_write_budget" });

  assert.deepEqual(e.BACKTEST.sent, [{ type: "backtest", ...ENVELOPE.job, part: 4, cursor: ENVELOPE.cursor }], "knobOverrides ride along inside the job");
  const r = await row(e);
  assert.equal(r.status, "running");
  assert.equal(r.cursor, null);
  assert.equal(r.paused_reason, null);
});

test("POST /backtest/:id/resume: 404 unknown, 409 not paused, 409 'still pausing' while no cursor is saved yet (nothing is enqueued in any of them)", async (t) => {
  quiet(t);
  const e = env();
  assert.equal((await post(e, `/backtest/${ID}/resume`)).status, 404);

  await seedRun(e);
  const running = await post(e, `/backtest/${ID}/resume`);
  assert.equal(running.status, 409);
  assert.match((await running.json()).error, /not paused/);

  await pauseBacktestRun(e.SIM_DB, { id: ID, reason: "operator", pausedAt: "2026-05-10T10:00:00.000Z" }); // no cursor
  const pausing = await post(e, `/backtest/${ID}/resume`);
  assert.equal(pausing.status, 409);
  assert.match((await pausing.json()).error, /still pausing/);
  assert.equal((await row(e)).status, "paused", "left paused so the operator can retry");

  assert.equal(e.BACKTEST.sent.length, 0);
});

test("POST /backtest/:id/resume returns 400 for a malformed id", async (t) => {
  quiet(t);
  const e = env();
  assert.equal((await post(e, "/backtest/bad%20id/resume")).status, 400);
});

test("POST /backtest/:id/resume honours the Backtests and LLM pause switches (409, run stays paused, nothing enqueued)", async (t) => {
  quiet(t);
  for (const key of ["backtests", "llm"]) {
    const e = env();
    await seedRun(e);
    await pauseBacktestRun(e.SIM_DB, { id: ID, reason: "operator", cursor: ENVELOPE, pausedAt: "2026-05-10T10:00:00.000Z" });
    await setPauseFlags(e.LIVE_DB, [key], true, { by: "test" });

    const res = await post(e, `/backtest/${ID}/resume`);
    assert.equal(res.status, 409, key);
    assert.match((await res.json()).error, /paused/);
    assert.equal((await row(e)).status, "paused", key);
    assert.equal(e.BACKTEST.sent.length, 0, key);
  }
});

test("POST /backtest/:id/resume re-parks the run with the SAME envelope when the enqueue fails, so the operator can simply retry", async (t) => {
  quiet(t);
  const e = env({ BACKTEST: new ThrowingQueue() });
  await seedRun(e);
  await pauseBacktestRun(e.SIM_DB, { id: ID, reason: "quota_threshold", cursor: ENVELOPE, pausedAt: "2026-05-10T10:00:00.000Z", resumeAfter: "2026-05-11T00:00:00.000Z" });

  const res = await post(e, `/backtest/${ID}/resume`);
  assert.equal(res.status, 500);
  assert.match((await res.json()).message, /simulated queue send failure/);

  const r = await row(e);
  assert.equal(r.status, "paused");
  assert.equal(r.paused_reason, "quota_threshold", "the original reason is restored");
  assert.equal(r.resume_after, "2026-05-11T00:00:00.000Z");
  assert.deepEqual(JSON.parse(r.cursor), ENVELOPE);

  // ...and the retry works once the queue is back.
  e.BACKTEST = new FakeQueue();
  const retry = await post(e, `/backtest/${ID}/resume`);
  assert.equal(retry.status, 200);
  assert.equal(e.BACKTEST.sent.length, 1);
});

test("POST /backtest/:id/resume refuses to guess when the stored cursor is not a resume envelope: 500, and the run is re-parked untouched", async (t) => {
  quiet(t);
  const e = env();
  await seedRun(e);
  const notAnEnvelope = { clockNow: "2026-01-04T00:00:00.000Z", phase: "walk" }; // a bare runManualBacktest cursor
  await pauseBacktestRun(e.SIM_DB, { id: ID, reason: "operator", cursor: notAnEnvelope, pausedAt: "2026-05-10T10:00:00.000Z" });

  const res = await post(e, `/backtest/${ID}/resume`);
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /no valid resume envelope/);
  assert.equal(e.BACKTEST.sent.length, 0);
  const r = await row(e);
  assert.equal(r.status, "paused");
  assert.deepEqual(JSON.parse(r.cursor), notAnEnvelope);
});
