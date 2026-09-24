// Rolling retention purge for price_bars_intraday -- plan.md finding G, step
// 6: "Retention: rolling 4-6 month window ... A scheduled purge deletes rows
// older than the window -- purge must never run against a day that an
// in-flight backtest run is actively reading (check/lock, or simply purge
// conservatively -- e.g. only rows older than 6 months, checked before any
// backtest run starts, never mid-run)."
//
// GATING: rather than a lock, this checks for any 'queued' or 'running'
// backtest job in SIM_DB (storage/sim_registry.js#getActiveBacktestRunId,
// the same run-id-agnostic "is anything active" lookup the dashboard's
// Backtest page uses) immediately before deleting anything, and skips the
// WHOLE purge (not just the affected rows) if one is found -- a backtest's
// own test window is unknown to this job without parsing its params, so
// "skip entirely while anything is active" is the conservative choice the
// plan text calls for, not "guess which rows are safe." A skipped purge is
// not lost: the next scheduled run tries again, and a rolling 4-6 month
// window has wide slack (a single missed cycle changes nothing about
// whether the retention target is met).
//
// CHUNKED DELETE, same reasoning as every other bulk-write loop in this
// codebase (NEWS_ITEM_INSERT_CHUNK_SIZE etc): one unbounded DELETE could
// touch hundreds of thousands of rows (4-6 months x 5 tickers x ~78-288
// bars/day) in a single D1 statement/subrequest, risking the same kind of
// per-invocation limit this project has hit before on unbatched writes.
// Deleting via a `rowid IN (SELECT rowid ... LIMIT ?)` subquery bounds each
// statement to `chunkSize` rows; the loop stops either when a chunk deletes
// fewer than `chunkSize` rows (nothing left below the cutoff) or after
// `maxChunks` (a hard stop so a first-ever purge against a much older table
// than expected can't run away inside one invocation -- it simply picks up
// again on the next scheduled tick, same "no chunk left behind, just
// deferred" shape as backfillHistoricalNews's own part/continuation limit).

import { getActiveBacktestRunId } from "../storage/sim_registry.js";

// Default retention: 180 days (~6 months), the upper end of plan.md's
// "rolling 4-6 month window" -- generous headroom over the 90-day backtest
// window the plan sizes this against.
const DEFAULT_RETENTION_DAYS = 180;
// Rows removed per DELETE statement (one Worker subrequest each) and the
// hard stop on statements per call -- see header. 5,000 rows/chunk x 20
// chunks = 100,000 rows/call ceiling, well under the 500MB/DB free-tier
// storage cap this table could otherwise accumulate toward unchecked.
const DEFAULT_CHUNK_SIZE = 5000;
const DEFAULT_MAX_CHUNKS = 20;

/**
 * Deletes price_bars_intraday rows older than `retentionDays` (by `ts`),
 * chunked, UNLESS a backtest is currently queued/running in `simDb` (in
 * which case nothing is deleted at all -- see header's Gating note).
 *
 * `inputsDb` is env.INPUTS_DB (where price_bars_intraday lives); `simDb` is
 * env.SIM_DB, read-only here (only getActiveBacktestRunId is called on it,
 * nothing is written).
 *
 * Returns `{ skipped: true, reason }` when an active backtest gated the
 * purge, or `{ skipped: false, deleted, cutoff, chunks }` otherwise.
 * `deleted` is the total row count actually removed across every chunk.
 */
export async function purgeOldIntradayBars(inputsDb, simDb, { retentionDays = DEFAULT_RETENTION_DAYS, chunkSize = DEFAULT_CHUNK_SIZE, maxChunks = DEFAULT_MAX_CHUNKS, now = new Date() } = {}) {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    throw new Error(`purgeOldIntradayBars requires a positive retentionDays, got ${retentionDays}`);
  }

  const activeRunId = await getActiveBacktestRunId(simDb, { now: now.toISOString() });
  if (activeRunId) {
    console.log("intraday purge: skipped, a backtest is active", { activeRunId });
    return { skipped: true, reason: `active backtest run ${activeRunId}`, deleted: 0 };
  }

  const cutoff = new Date(now.getTime() - retentionDays * 24 * 3600 * 1000).toISOString();

  let deleted = 0;
  let chunks = 0;
  for (; chunks < maxChunks; chunks++) {
    const result = await inputsDb
      .prepare(`DELETE FROM price_bars_intraday WHERE rowid IN (SELECT rowid FROM price_bars_intraday WHERE ts < ? LIMIT ?)`)
      .bind(cutoff, chunkSize)
      .run();
    const changes = result.meta?.changes ?? 0;
    deleted += changes;
    if (changes < chunkSize) {
      chunks++; // count the final (partial or empty) chunk before breaking
      break;
    }
  }

  console.log("intraday purge: done", { retentionDays, cutoff, deleted, chunks });
  return { skipped: false, deleted, cutoff, chunks };
}
