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

/**
 * Cancels a RUNNING backtest, atomically (`WHERE status = 'running'` in the
 * same statement as the transition, so a cancel racing the run's own
 * completion/failure can never resurrect or double-transition a terminal
 * row). `error` reuses the same column failBacktestRun writes to -- the
 * registry has no separate "why it stopped" field, and the dashboard's error
 * rendering (helpers.js#backtestRunsList) already knows how to show it.
 * Returns whether THIS call made the change: false means the run had
 * already finished, failed, or was cancelled by an earlier call -- the
 * caller uses that to tell "cancelled just now" from "nothing to cancel"
 * without a second read.
 */
export async function cancelBacktestRun(db, { id, finishedAt, error = "Cancelled by operator" }) {
  const result = await db
    .prepare(`UPDATE backtest_runs SET status = 'cancelled', error = ?, finished_at = ? WHERE id = ? AND status = 'running'`)
    .bind(error, finishedAt, id)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

/**
 * Ids (+ status) of TERMINAL ('complete' | 'failed' | 'cancelled') runs
 * started more than `olderThanDays` ago, oldest first, up to `limit` -- the
 * candidate set for backtest/cleanup.js#cleanupOldRuns's bulk "clean up old
 * runs" sweep. Deliberately never returns a 'running' row: a stuck-looking
 * run needs an explicit, individual cancel (cancelBacktestRun above), not a
 * silent bulk data-delete swept up by age alone.
 */
export async function getStaleTerminalBacktestRuns(db, { olderThanDays, limit = 5 }) {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 3600 * 1000).toISOString();
  const { results } = await db
    .prepare(`SELECT id, status FROM backtest_runs WHERE status IN ('complete', 'failed', 'cancelled') AND started_at < ? ORDER BY started_at ASC LIMIT ?`)
    .bind(cutoff, limit)
    .all();
  return results;
}

/**
 * Ids (+ status) of FAILED or CANCELLED runs, oldest first, up to `limit` --
 * the candidate set for backtest/cleanup.js#purgeFailedAndCancelledRuns. Never
 * returns a 'running' or 'complete' row: a complete run's result is the
 * deliverable, and a running one needs an explicit cancel first.
 */
export async function getFailedOrCancelledBacktestRuns(db, { limit = 20 } = {}) {
  const { results } = await db
    .prepare(`SELECT id, status FROM backtest_runs WHERE status IN ('failed', 'cancelled') ORDER BY started_at ASC, id ASC LIMIT ?`)
    .bind(limit)
    .all();
  return results;
}

/**
 * Deletes one registry row, atomically guarded on status (`failed`/`cancelled`
 * in the same statement as the delete), so a row that somehow became
 * 'running' or 'complete' since it was listed is never removed. Returns
 * whether THIS call deleted it.
 */
export async function deleteFailedOrCancelledBacktestRun(db, id) {
  const result = await db
    .prepare(`DELETE FROM backtest_runs WHERE id = ? AND status IN ('failed', 'cancelled')`)
    .bind(id)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

/**
 * Adds `rows` to a run's running rows_written total (BACKTEST_DAILY_WRITE_BUDGET,
 * plan.md/config.js#backtestDailyWriteBudget) -- called once per part/
 * invocation from backtest-worker.js with that part's observed D1 write-row
 * count (subrequestBudget.js's rowsWritten counter), not once per statement,
 * same batching-cost reasoning as everywhere else in this file. A no-op
 * (`rows <= 0`) is skipped rather than issuing a pointless UPDATE.
 */
export async function addBacktestRunRowsWritten(db, { id, rows }) {
  if (!(rows > 0)) return;
  await db.prepare(`UPDATE backtest_runs SET rows_written = rows_written + ? WHERE id = ?`).bind(rows, id).run();
}

/**
 * Sum of rows_written across every backtest_runs row STARTED on the given
 * UTC calendar day (default: today), regardless of status -- a 'running' run
 * already in flight counts its writes-so-far too, not just terminal runs.
 * This is the whole-day total backtest-worker.js checks against
 * config.backtestDailyWriteBudget before starting/continuing a part; started_at
 * (not finished_at) is the bucket so a run that started today but finishes
 * tomorrow is still charged to today, matching when the writes actually
 * happened.
 */
export async function getBacktestRowsWrittenToday(db, { now = new Date() } = {}) {
  const dayStart = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
  const dayEnd = `${now.toISOString().slice(0, 10)}T23:59:59.999Z`;
  const row = await db
    .prepare(`SELECT COALESCE(SUM(rows_written), 0) AS total FROM backtest_runs WHERE started_at >= ? AND started_at <= ?`)
    .bind(dayStart, dayEnd)
    .first();
  return row?.total ?? 0;
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
