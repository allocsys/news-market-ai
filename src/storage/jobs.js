// Live progress for operator-triggered long-running jobs (migrations/
// 0011_job_progress.sql). Used by:
//   - `backend` (src/index.js): records a 'queued' row when POST /backfill or
//     POST /backtest/run enqueues, serves GET /api/jobs/:id, and reports
//     progress while consuming JOBS's `backfill`.
//   - `llm` (src/llm-worker.js): reports progress while consuming LLM_JOBS's
//     `backtest`.
//   - `dashboard` only ever READS this, through backend's /api/jobs/:id.
//
// PROGRESS IS BEST-EFFORT, ON PURPOSE. Every write here goes through
// createJobReporter, which swallows (and console.warns) any D1 failure and is
// a silent no-op when there's no usable db. A failed progress write must
// never fail, retry or double-run the job it describes -- the job's real
// outcome is its own return value/backtest_runs row, this is only the view
// onto it. That also keeps the reporter safe to hand a fake/absent DB in
// tests that aren't about progress.
//
// WRITE VOLUME: each write is a D1 subrequest, and the consumers already do
// a lot of D1 work per invocation (a backfill inserts one row per article),
// so update() is throttled to one write per `minIntervalMs` unless the caller
// passes `force: true` (phase changes, the last step). Never call the storage
// functions below in a per-item loop directly -- go through the reporter.
//
// PERCENT: each job type owns its own mapping onto 0-100 and reports it; the
// dashboard just draws it.
//   backfill: fetching 5-50 (one step per ticker), saving 50-100 (per article)
//   backtest: simulating 0-95 (one step per ticker-day, see onSignalRunner.js),
//             saving 98; 100 is only ever written by complete()

const MAX_ERROR_LENGTH = 500;
const MAX_DETAIL_LENGTH = 200;

const JOB_COLUMNS = "id, type, status, phase, percent, done, total, detail, params, result, error, created_at, started_at, updated_at, finished_at";

function nowIso() {
  return new Date().toISOString();
}

function clampPercent(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function nonNegativeInt(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function truncate(text, max) {
  if (text === undefined || text === null) return null;
  const s = String(text);
  return s.length > max ? `${s.slice(0, max - 1)}\u2026` : s;
}

function toJsonOrNull(value) {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function parseJsonOrNull(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Inserts the 'queued' row when a job is enqueued. No-op if the id already exists. */
export async function insertQueuedJob(db, { id, type, params = null, now = nowIso() }) {
  await db
    .prepare(
      `INSERT INTO job_progress (id, type, status, percent, params, created_at, updated_at)
       VALUES (?, ?, 'queued', 0, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    )
    .bind(id, type, toJsonOrNull(params), now, now)
    .run();
}

/**
 * Marks a job 'running' when its consumer picks it up. An upsert, so it also
 * works when the 'queued' row was never written (best-effort insert failed)
 * and when a crashed message is redelivered (started_at keeps its first value).
 */
export async function markJobRunning(db, { id, type, params = null, now = nowIso() }) {
  await db
    .prepare(
      `INSERT INTO job_progress (id, type, status, percent, params, created_at, started_at, updated_at)
       VALUES (?, ?, 'running', 0, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = 'running', started_at = COALESCE(job_progress.started_at, excluded.started_at), updated_at = excluded.updated_at`
    )
    .bind(id, type, toJsonOrNull(params), now, now, now)
    .run();
}

/** Progress tick. Guarded on status so a late tick can never overwrite a finished job. */
export async function updateJobProgress(db, { id, phase = null, percent = 0, done = 0, total = 0, detail = null, now = nowIso() }) {
  await db
    .prepare(
      `UPDATE job_progress SET status = 'running', phase = ?, percent = ?, done = ?, total = ?, detail = ?, updated_at = ?
       WHERE id = ? AND status IN ('queued', 'running')`
    )
    .bind(phase, clampPercent(percent), nonNegativeInt(done), nonNegativeInt(total), truncate(detail, MAX_DETAIL_LENGTH), now, id)
    .run();
}

export async function completeJob(db, { id, result = null, detail = null, now = nowIso() }) {
  await db
    .prepare(`UPDATE job_progress SET status = 'complete', percent = 100, phase = 'done', result = ?, detail = ?, updated_at = ?, finished_at = ? WHERE id = ?`)
    .bind(toJsonOrNull(result), truncate(detail, MAX_DETAIL_LENGTH), now, now, id)
    .run();
}

/** Keeps the last reported percent/phase, so a failed job shows how far it got. */
export async function failJob(db, { id, error, detail = null, now = nowIso() }) {
  await db
    .prepare(`UPDATE job_progress SET status = 'failed', error = ?, detail = ?, updated_at = ?, finished_at = ? WHERE id = ?`)
    .bind(truncate(error ?? "unknown error", MAX_ERROR_LENGTH), truncate(detail, MAX_DETAIL_LENGTH), now, now, id)
    .run();
}

/** A job_progress row with JSON columns parsed and keys camelCased for the API. */
function rowToJob(row) {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    phase: row.phase ?? null,
    percent: row.percent ?? 0,
    done: row.done ?? 0,
    total: row.total ?? 0,
    detail: row.detail ?? null,
    params: parseJsonOrNull(row.params),
    result: parseJsonOrNull(row.result),
    error: row.error ?? null,
    createdAt: row.created_at,
    startedAt: row.started_at ?? null,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at ?? null,
  };
}

/** One job, with JSON columns parsed and keys camelCased for the API. Null if there's no such id. */
export async function getJob(db, id) {
  const row = await db.prepare(`SELECT ${JOB_COLUMNS} FROM job_progress WHERE id = ?`).bind(id).first();
  return row ? rowToJob(row) : null;
}

/**
 * How long a 'queued'/'running' row may go without an update before it's
 * treated as dead. A consumer killed by an uncatchable isolate kill (e.g.
 * exceededCpu -- see plan.md) never writes 'failed', so its row stays
 * 'running' forever; without this cutoff every such orphan would show a
 * phantom "in progress" bar on the dashboard indefinitely. Live jobs tick far
 * more often than this (progress writes are throttled to ~1.5s, and even a
 * slow LLM step in a backtest finishes well inside it).
 */
export const ACTIVE_JOB_MAX_IDLE_MS = 15 * 60 * 1000;

/**
 * The most recently created job of `type` that is still in flight (status
 * 'queued' or 'running') and has ticked within `maxIdleMs`. Null if none.
 * This is what lets the backfill/backtest pages show a progress bar for a
 * job that was submitted earlier -- the by-id lookup (getJob) only works
 * for whoever still holds the id from the original form submit.
 * `now` is injectable so the idle cutoff is testable without real waiting.
 */
export async function getActiveJob(db, type, { maxIdleMs = ACTIVE_JOB_MAX_IDLE_MS, now = nowIso() } = {}) {
  const cutoff = new Date(Date.parse(now) - maxIdleMs).toISOString();
  const row = await db
    .prepare(
      `SELECT ${JOB_COLUMNS} FROM job_progress
       WHERE type = ? AND status IN ('queued', 'running') AND updated_at >= ?
       ORDER BY created_at DESC LIMIT 1`
    )
    .bind(type, cutoff)
    .first();
  return row ? rowToJob(row) : null;
}

/**
 * The only way callers should write progress. See the header: best-effort,
 * throttled, silent when `db` can't do D1 (missing, or a bare `{}` in tests).
 *
 * `nowMs` is injectable so the throttle is testable without real waiting.
 */
export function createJobReporter(db, { id, type, params = null, minIntervalMs = 1500, nowMs = () => Date.now() } = {}) {
  const enabled = Boolean(id) && typeof db?.prepare === "function";
  let lastWriteAt = -Infinity;

  async function safe(what, fn) {
    if (!enabled) return;
    try {
      await fn();
    } catch (err) {
      console.warn("job progress write failed (non-fatal)", { id, what, message: err?.message });
    }
  }

  return {
    enabled,

    /** 'queued' row, written by the route right before it enqueues. */
    queued() {
      return safe("queued", () => insertQueuedJob(db, { id, type, params }));
    },

    /** Consumer picked the message up. */
    start() {
      lastWriteAt = nowMs();
      return safe("start", () => markJobRunning(db, { id, type, params }));
    },

    /** Progress tick: { phase, percent, done, total, detail, force }. Skipped if inside the throttle window unless force. */
    async update({ force = false, ...progress } = {}) {
      const t = nowMs();
      if (!force && t - lastWriteAt < minIntervalMs) return;
      lastWriteAt = t;
      await safe("update", () => updateJobProgress(db, { id, ...progress }));
    },

    complete(result = null, detail = null) {
      return safe("complete", () => completeJob(db, { id, result, detail }));
    },

    fail(error, detail = null) {
      return safe("fail", () => failJob(db, { id, error, detail }));
    },
  };
}
