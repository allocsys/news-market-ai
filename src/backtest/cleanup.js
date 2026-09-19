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
