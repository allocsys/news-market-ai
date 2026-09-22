// Cleanup for a FAILED backtest run: delete the run's data, keep its error log.
//
// plan.md's "Cleanup = delete-by-run in `sim`, chunked". A failed run leaves a
// half-walked pile of positions / decisions / checkpoints that nothing will
// ever read (a failed run has no result), so it is deleted. What is KEPT is
// the trail explaining the failure:
//   - the backtest_runs registry row (status 'failed' + the `error` message,
//     which now also says WHERE it died -- see runBacktest.js),
//   - the run's errored llm_calls rows (usually 1-2; the best evidence),
//   - the run's single job_progress row (the dashboard's job view).
// A COMPLETE run is never deleted here -- its result and its data are the
// deliverable. Guards below enforce that rather than trusting the caller.
//
// BEST-EFFORT by design: this runs in the backtest Worker after the run has
// already been recorded as failed. A problem here must never hide that
// failure or turn into a queue retry (a retry would re-run a deterministic
// failure), so every error is caught and logged, never thrown.
//
// BOUNDED: each chunk is 6 D1 statements and D1 deletes count as writes
// against the daily cap, so the loop stops after `maxChunks` chunks. If it is
// cut short, the leftover rows just remain (`complete: false`, logged) -- no
// retry, no self-enqueue (the backtest Worker holds no queue producer; see
// test/ci_env_isolation.test.js).

import { RunStore } from "../storage/run_store.js";
import { getStaleTerminalBacktestRuns } from "../storage/sim_registry.js";

/**
 * @param {object} registryDb SIM_DB (the backtest_runs registry lives there).
 * @param {RunStore} store    RunStore(SIM_DB, id) for the run being cleaned.
 * @param {string} id         The backtest run id; must equal store.runId.
 * @returns {Promise<{deleted: number, complete: boolean, skipped?: string}>}
 */
export async function cleanupFailedRun(registryDb, store, id, { limit = 500, maxChunks = 20 } = {}) {
  let deleted = 0;
  try {
    if (!id || store.runId !== id) return { deleted: 0, complete: false, skipped: "store/run id mismatch" };
    if (id === "live") return { deleted: 0, complete: false, skipped: "refuses the live run" };

    const row = await registryDb.prepare(`SELECT status FROM backtest_runs WHERE id = ?`).bind(id).first();
    if (row?.status !== "failed") return { deleted: 0, complete: false, skipped: `registry status is ${row?.status ?? "missing"}, not failed` };

    for (let chunk = 0; chunk < maxChunks; chunk++) {
      const n = await store.deleteRun({ limit, keepErroredLlmCalls: true, keepJobProgress: true });
      if (n === 0) return { deleted, complete: true };
      deleted += n;
    }
    console.warn("backtest cleanup cut short at maxChunks; leftover rows remain", { id, deleted, maxChunks, limit });
    return { deleted, complete: false };
  } catch (err) {
    console.warn("backtest cleanup failed (best-effort, ignored)", { id, message: err?.message });
    return { deleted, complete: false, skipped: `error: ${err?.message}` };
  }
}

// ---------------------------------------------------------------------------
// Cleanup for a CANCELLED backtest run (operator-terminated via POST
// /backtest/:id/cancel, src/index.js). Same shape as cleanupFailedRun above
// -- guarded on registry status, chunked, best-effort, never throws -- with
// two differences:
//   - checks for 'cancelled' instead of 'failed'.
//   - does NOT keep errored llm_calls: a cancellation isn't a failure worth
//     investigating (there is no bug to diagnose), so nothing is kept back
//     from the delete. job_progress IS still kept (keepJobProgress: true),
//     same reason as cleanupFailedRun -- it's the one row the dashboard's
//     job view reads, and RunStore#cancelJob (run_store.js) has already
//     written 'cancelled' into it by the time this runs.
// ---------------------------------------------------------------------------

/**
 * @param {object} registryDb SIM_DB (the backtest_runs registry lives there).
 * @param {RunStore} store    RunStore(SIM_DB, id) for the run being cleaned.
 * @param {string} id         The backtest run id; must equal store.runId.
 * @returns {Promise<{deleted: number, complete: boolean, skipped?: string}>}
 */
export async function cleanupCancelledRun(registryDb, store, id, { limit = 500, maxChunks = 20 } = {}) {
  let deleted = 0;
  try {
    if (!id || store.runId !== id) return { deleted: 0, complete: false, skipped: "store/run id mismatch" };
    if (id === "live") return { deleted: 0, complete: false, skipped: "refuses the live run" };

    const row = await registryDb.prepare(`SELECT status FROM backtest_runs WHERE id = ?`).bind(id).first();
    if (row?.status !== "cancelled") return { deleted: 0, complete: false, skipped: `registry status is ${row?.status ?? "missing"}, not cancelled` };

    for (let chunk = 0; chunk < maxChunks; chunk++) {
      const n = await store.deleteRun({ limit, keepJobProgress: true });
      if (n === 0) return { deleted, complete: true };
      deleted += n;
    }
    console.warn("backtest cancel-cleanup cut short at maxChunks; leftover rows remain", { id, deleted, maxChunks, limit });
    return { deleted, complete: false };
  } catch (err) {
    console.warn("backtest cancel-cleanup failed (best-effort, ignored)", { id, message: err?.message });
    return { deleted, complete: false, skipped: `error: ${err?.message}` };
  }
}

// ---------------------------------------------------------------------------
// Bulk cleanup for OLD, already-TERMINAL runs -- POST /backtest/cleanup
// (src/index.js), operator-triggered from the dashboard's "Clean up old
// runs" button, never automatic. Deliberately distinct from the
// cleanupFailedRun/cleanupCancelledRun policy documented in plan.md ("A
// COMPLETE run is never deleted here -- its result and its data are the
// deliverable... Complete runs are never auto-deleted"): that guarantee is
// about the SYSTEM never silently deleting a completed run's data on its
// own. This function only ever runs when an operator explicitly asks for it
// (never from a cron/queue path), and only touches runs that are already
// terminal ('complete' | 'failed' | 'cancelled') and older than
// `olderThanDays` -- a still-'running' run is never a candidate (see
// sim_registry.js#getStaleTerminalBacktestRuns).
//
// TRADEOFF, same one cleanupFailedRun already accepts: the backtest_runs
// registry row (and, for a complete run, its `result` JSON summary --
// what the dashboard's "Recent runs" list and its on/off metrics table
// read) is KEPT; only the underlying per-trade state-table rows
// (positions/trade_decisions/decision_memory/pipeline_checkpoints/
// llm_calls) are deleted. That means the summary metrics survive but the
// per-run "View trade timeline" detail page (which reads those state
// tables directly) will show no positions afterward -- freeing D1 storage
// costs the trade-by-trade detail, not the headline result. The dashboard
// copy next to the button says so.
//
// BOUNDED per call, same reasoning as cleanupFailedRun: `maxRuns` caps how
// many runs one invocation touches (a bulk sweep across many old runs could
// otherwise blow past D1's per-invocation write limits), and
// `maxChunksPerRun` caps how much of any single run's data comes out in one
// call. A cut-short run's leftover rows just remain (`complete: false` in
// that run's entry) -- calling this again later finishes it, exactly like
// cleanupFailedRun's own re-call story.
export async function cleanupOldRuns(registryDb, { olderThanDays = 30, maxRuns = 5, limit = 500, maxChunksPerRun = 10 } = {}) {
  const processed = [];
  let totalDeleted = 0;
  try {
    const candidates = await getStaleTerminalBacktestRuns(registryDb, { olderThanDays, limit: maxRuns });
    for (const { id, status } of candidates) {
      try {
        const store = new RunStore(registryDb, id);
        let deleted = 0;
        let complete = true;
        for (let chunk = 0; chunk < maxChunksPerRun; chunk++) {
          const n = await store.deleteRun({ limit, keepJobProgress: true });
          deleted += n;
          if (n === 0) break;
          if (chunk === maxChunksPerRun - 1) complete = false;
        }
        totalDeleted += deleted;
        processed.push({ id, status, deleted, complete });
      } catch (err) {
        console.warn("backtest cleanupOldRuns: one run failed (best-effort, continuing with the rest)", { id, message: err?.message });
        processed.push({ id, status, deleted: 0, complete: false, skipped: `error: ${err?.message}` });
      }
    }
    return { processed, totalDeleted, scanned: candidates.length, olderThanDays };
  } catch (err) {
    console.warn("backtest cleanupOldRuns failed before it could list candidates (best-effort, ignored)", { message: err?.message });
    return { processed, totalDeleted, scanned: 0, olderThanDays, error: err?.message };
  }
}
