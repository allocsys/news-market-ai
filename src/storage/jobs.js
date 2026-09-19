// Live progress for operator-triggered long-running jobs (the `job_progress`
// table in migrations/state/). Used by:
//   - `backend` (src/index.js): records a 'queued' row when POST /backfill
//     enqueues, serves GET /api/jobs/:id, and reports progress while
//     consuming JOBS's `backfill`.
//   - `llm` (src/llm-worker.js): marks a rejected `backtest` message failed
//     (backtests move to the backtest Worker in M3).
//   - `dashboard` only ever READS this, through backend's /api/jobs/:id.
//
// M2b: this module holds NO SQL. job_progress lives in the state schema, so
// every statement is a RunStore method (storage/run_store.js: insertQueuedJob /
// markJobRunning / updateJobProgress / completeJob / failJob / getJob /
// getActiveJob), scoped by the store's run_id. Backfill jobs live under the
// 'live' run; a backtest's jobs will live in the SIM_DB under its own run id
// (M3). What stays here is the pure part -- value normalizers, the row ->
// API-object mapper, the idle cutoff -- which RunStore imports, plus the
// best-effort reporter that wraps a store.
//
// PROGRESS IS BEST-EFFORT, ON PURPOSE. Every write here goes through
// createJobReporter, which swallows (and console.warns) any D1 failure and is
// a silent no-op when there's no usable store. A failed progress write must
// never fail, retry or double-run the job it describes -- the job's real
// outcome is its own return value/backtest_runs row, this is only the view
// onto it. That also keeps the reporter safe to hand a fake/absent store in
// tests that aren't about progress.
//
// WRITE VOLUME: each write is a D1 subrequest, and the consumers already do
// a lot of D1 work per invocation (a backfill inserts one row per article),
// so update() is throttled to one write per `minIntervalMs` unless the caller
// passes `force: true` (phase changes, the last step). Never call the RunStore
// job methods in a per-item loop directly -- go through the reporter.
//
// PERCENT: each job type owns its own mapping onto 0-100 and reports it; the
// dashboard just draws it.
//   backfill: fetching 5-50 (one step per ticker), saving 50-100 (per article)
//   backtest: simulating 0-95 (one step per ticker-day, see onSignalRunner.js),
//             saving 98; 100 is only ever written by complete()

export const MAX_ERROR_LENGTH = 500;
export const MAX_DETAIL_LENGTH = 200;

export function nowIso() {
  return new Date().toISOString();
}

export function clampPercent(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

export function nonNegativeInt(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function truncate(text, max) {
  if (text === undefined || text === null) return null;
  const s = String(text);
  return s.length > max ? `${s.slice(0, max - 1)}\u2026` : s;
}

export function toJsonOrNull(value) {
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

/** A job_progress row with JSON columns parsed and keys camelCased for the API. */
export function jobFromRow(row) {
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
 * The only way callers should write progress. See the header: best-effort,
 * throttled, silent when `store` can't do job writes (missing, or a bare `{}`
 * in tests). `store` is a RunStore; the job's run_id is whatever that store
 * was built with.
 *
 * `nowMs` is injectable so the throttle is testable without real waiting.
 */
export function createJobReporter(store, { id, type, params = null, minIntervalMs = 1500, nowMs = () => Date.now() } = {}) {
  const enabled = Boolean(id) && typeof store?.insertQueuedJob === "function";
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
      return safe("queued", () => store.insertQueuedJob({ id, type, params }));
    },

    /** Consumer picked the message up. */
    start() {
      lastWriteAt = nowMs();
      return safe("start", () => store.markJobRunning({ id, type, params }));
    },

    /** Progress tick: { phase, percent, done, total, detail, force }. Skipped if inside the throttle window unless force. */
    async update({ force = false, ...progress } = {}) {
      const t = nowMs();
      if (!force && t - lastWriteAt < minIntervalMs) return;
      lastWriteAt = t;
      await safe("update", () => store.updateJobProgress({ id, ...progress }));
    },

    complete(result = null, detail = null) {
      return safe("complete", () => store.completeJob({ id, result, detail }));
    },

    fail(error, detail = null) {
      return safe("fail", () => store.failJob({ id, error, detail }));
    },
  };
}
