// A real sqlite state DB (migrations/state/) pre-seeded with in-flight
// job_progress rows under run_id 'live', for the dashboard/backend tests that
// need GET /api/jobs/* to have something to find. Replaces the hand-written
// FakeJobDb that answered any job_progress SELECT with one canned row.
//
// Rows are stamped with the CURRENT time: getActiveJob ignores rows idle for
// more than 15 minutes, so a fixed historical timestamp would (correctly) age
// out. `updatedAt` is returned so a test can assert on the exact value.
//
// Lives in test/helpers/ (not *.test.js) so `npm test` doesn't run it.

import { createTestD1 } from "./sqlite_d1.js";
import { STATE_DIR } from "./engine_ctx.js";
import { RunStore } from "../../src/storage/run_store.js";

/**
 * @param {Array<{id: string, type: string, params?: object, phase?: string, percent?: number, done?: number, total?: number, detail?: string}>} jobs
 * @returns {Promise<{db: object, store: RunStore, updatedAt: string}>}
 */
export async function jobStateDb(jobs = []) {
  const db = createTestD1([STATE_DIR]);
  const store = new RunStore(db, "live");
  const updatedAt = new Date().toISOString();
  for (const { id, type, params = null, phase = "saving", percent = 0, done = 0, total = 0, detail = null } of jobs) {
    await store.insertQueuedJob({ id, type, params, now: updatedAt });
    await store.markJobRunning({ id, type, now: updatedAt });
    await store.updateJobProgress({ id, phase, percent, done, total, detail, now: updatedAt });
  }
  return { db, store, updatedAt };
}
