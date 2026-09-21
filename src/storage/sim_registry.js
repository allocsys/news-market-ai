// The `sim` registry: the backtest_runs table (migrations/sim/), which lives
// ONLY on SIM_DB and lists every backtest that has been started -- params,
// status, result. Moved here from the legacy storage/d1.js in M3 (that file's
// header always said the backtest_runs functions would move).
//
// Deliberately NOT part of RunStore: RunStore(db, runId) is the run_id-scoped
// path to the STATE tables (identical schema on LIVE_DB and SIM_DB), whereas
// this is the one table that lists many runs at once -- `id` here IS the
// run_id every state row for that backtest is scoped under (see
// migrations/sim/0001_backtest_runs.sql), so there is no separate run_id
// column to filter on and no one run to scope a handle to. Dashboard-only in
// the same sense as before: a registry row is never fed into an agent prompt,
// so no asOf gating applies.
//
// `db` is SIM_DB. The read (getRecentBacktestRuns) is safe to call through
// run_store.js#readOnly(env.SIM_DB), which is what the dashboard does.

import { ACTIVE_JOB_MAX_IDLE_MS } from "./jobs.js";

/**
 * Inserts the 'running' row for a just-started backtest run, before the
 * (slow, LLM-calling) comparison itself runs -- so a run that crashes the
 * Worker invocation outright (not caught by runBacktest.js's own try/catch)
 * still leaves a 'running' row behind rather than no record at all, and a
 * dashboard viewer can at least see a run was attempted.
 *
 * Idempotent on `id` (ON CONFLICT DO NOTHING): Queues deliver at-least-once,
 * so a redelivered `backtest` message (the first attempt's Worker died
 * mid-run) must be able to re-enter runManualBacktest and resume via the
 * pipeline's checkpoints instead of dying on a primary-key conflict every
 * retry until it lands in the DLQ with the job stuck 'running'. The first
 * attempt's row (params, started_at) stands. Ids are generated per request
 * (index.js#newJobId), so this never masks two genuinely different runs.
 */
export async function insertBacktestRun(db, { id, tickers, testStart, testEnd, trainDays, testDays, graceDays = null, startedAt }) {
  await db
    .prepare(
      `INSERT INTO backtest_runs (id, tickers, test_start, test_end, train_days, test_days, grace_days, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)
       ON CONFLICT(id) DO NOTHING`
    )
    .bind(id, JSON.stringify(tickers), testStart, testEnd, trainDays, testDays, graceDays, startedAt)
    .run();
}

/** Marks a run 'complete' with its result once compareSignalOnOffByWindow resolves. */
export async function completeBacktestRun(db, { id, result, finishedAt }) {
  await db
    .prepare(`UPDATE backtest_runs SET status = 'complete', result = ?, finished_at = ? WHERE id = ?`)
    .bind(JSON.stringify(result), finishedAt, id)
    .run();
}

/** Marks a run 'failed' with the error message that killed it, mirroring completeBacktestRun's shape. */
export async function failBacktestRun(db, { id, error, finishedAt }) {
  await db
    .prepare(`UPDATE backtest_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`)
    .bind(error, finishedAt, id)
    .run();
}

function rowToRun(r) {
  return {
    id: r.id,
    tickers: JSON.parse(r.tickers),
    testStart: r.test_start,
    testEnd: r.test_end,
    trainDays: r.train_days,
    testDays: r.test_days,
    graceDays: r.grace_days,
    status: r.status,
    result: r.result ? JSON.parse(r.result) : null,
    error: r.error,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

/**
 * One backtest_runs row by id, or null. Used by the dashboard's environment
 * selector (dashboard/data.js#resolveEnv) to confirm a `?env=` id is a real
 * run before trusting it as a RunStore run_id -- a malformed or unknown id
 * must fall back to 'live', not surface a raw SQL/D1 error to the page.
 */
export async function getBacktestRun(db, id) {
  const row = await db.prepare(`SELECT id, tickers, test_start, test_end, train_days, test_days, grace_days, status, result, error, started_at, finished_at FROM backtest_runs WHERE id = ?`).bind(id).first();
  return row ? rowToRun(row) : null;
}

/** Most recent backtest_runs rows, newest first. */
export async function getRecentBacktestRuns(db, { limit = 10 } = {}) {
  const { results } = await db
    .prepare(
      `SELECT id, tickers, test_start, test_end, train_days, test_days, grace_days, status, result, error, started_at, finished_at
       FROM backtest_runs ORDER BY started_at DESC LIMIT ?`
    )
    .bind(limit)
    .all();

  return results.map(rowToRun);
}

/**
 * Run id of the newest in-flight ('queued' or 'running') backtest job in SIM_DB, or null.
 *
 * A backtest's job_progress row lives under the backtest's OWN run_id (M3), so
 * RunStore#getActiveJob -- which is scoped to ONE run_id -- can never answer "is
 * any backtest running?" without already knowing which one. This is the
 * run-id-agnostic lookup the Backtest page needs after a form submit (the 303
 * lands on /dashboard/backtest with no ?env=). Same idle cutoff as
 * getActiveJob (`maxIdleMs`, default storage/jobs.js#ACTIVE_JOB_MAX_IDLE_MS), so
 * a consumer killed mid-run doesn't leave a phantom bar. Pass a readOnly() handle.
 */
export async function getActiveBacktestRunId(db, { maxIdleMs = ACTIVE_JOB_MAX_IDLE_MS, now = new Date().toISOString() } = {}) {
  const cutoff = new Date(Date.parse(now) - maxIdleMs).toISOString();
  const row = await db
    .prepare(
      `SELECT run_id FROM job_progress
       WHERE type = 'backtest' AND status IN ('queued', 'running') AND updated_at >= ?
       ORDER BY created_at DESC LIMIT 1`
    )
    .bind(cutoff)
    .first();
  return row ? row.run_id : null;
}
