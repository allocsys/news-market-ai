// D1 access layer. RULE: every read that could feed an agent -- live or
// backtest -- goes through this module, never a raw D1 query written
// inline elsewhere. That is what makes the point-in-time cutoff (plan.md
// "Backtesting Integrity", point 1) true by construction rather than by
// discipline: there is deliberately no "give me everything" read function
// here, every read requires an explicit `asOf`.

import { LookaheadViolationError } from "../shared/errors.js";

export async function insertNewsItem(db, item) {
  await db
    .prepare(
      `INSERT INTO news_items (id, source, url, first_published_at, ingested_at, title, body, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    )
    .bind(item.id, item.source, item.url, item.publishedAt, item.ingestedAt, item.title, item.body, JSON.stringify(item.raw ?? null))
    .run();

  // revision 1 on first insert; re-ingesting the same id with different
  // content is a future concern for the adapter layer to detect and insert
  // as revision 2, not this function's job.
  await db
    .prepare(
      `INSERT INTO news_item_revisions (news_item_id, revision, published_at, ingested_at, title, body, raw)
       VALUES (?, 1, ?, ?, ?, ?, ?)
       ON CONFLICT(news_item_id, revision) DO NOTHING`
    )
    .bind(item.id, item.publishedAt, item.ingestedAt, item.title, item.body, JSON.stringify(item.raw ?? null))
    .run();

  for (const ticker of item.tickers) {
    await db
      .prepare(`INSERT INTO news_item_tickers (news_item_id, ticker) VALUES (?, ?) ON CONFLICT DO NOTHING`)
      .bind(item.id, ticker)
      .run();
  }
}

/**
 * Point-in-time read: news for `ticker` whose LATEST-AS-OF-asOf revision
 * published at or before `asOf`. This is what makes it revision-aware
 * (plan.md Backtesting Integrity, point 2) -- it serves whichever version of
 * the article actually existed at `asOf`, not necessarily the newest one in
 * the table.
 */
export async function getNewsAsOf(db, { ticker, asOf, limit = 50 }) {
  if (!asOf) {
    throw new LookaheadViolationError("getNewsAsOf requires an explicit asOf timestamp");
  }

  const { results } = await db
    .prepare(
      `SELECT r.news_item_id AS id, r.revision, r.published_at AS published_at, r.title, r.body
       FROM news_item_revisions r
       JOIN news_item_tickers t ON t.news_item_id = r.news_item_id
       WHERE t.ticker = ?
         AND r.published_at <= ?
         AND r.revision = (
           SELECT MAX(r2.revision) FROM news_item_revisions r2
           WHERE r2.news_item_id = r.news_item_id AND r2.published_at <= ?
         )
       ORDER BY r.published_at DESC
       LIMIT ?`
    )
    .bind(ticker, asOf, asOf, limit)
    .all();

  return results;
}

/**
 * Write path for the reflection/memory log (plan.md Adopted Pattern #8).
 * Called once a trade decision's outcome is known -- realizedReturn/
 * alphaReturn are only meaningful after `resolvedAt` has actually passed,
 * which is exactly why getDecisionMemoryAsOf requires callers to filter by
 * asOf on read rather than trusting this table to only contain "past" rows.
 */
export async function recordDecisionOutcome(db, { id, decisionId, ticker, realizedReturn, alphaReturn, reflection, resolvedAt }) {
  await db
    .prepare(
      `INSERT INTO decision_memory (id, decision_id, ticker, realized_return, alpha_return, reflection, resolved_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    )
    .bind(id, decisionId, ticker, realizedReturn ?? null, alphaReturn ?? null, reflection ?? null, resolvedAt, new Date().toISOString())
    .run();
}

/**
 * Point-in-time read of the reflection/memory log for `ticker` -- decisions
 * resolved strictly before `asOf`. Deliberately mirrors getNewsAsOf's
 * required-asOf shape: plan.md Backtesting Integrity point 4 calls this out
 * as the easiest place to accidentally leak future information (a
 * reflection depends on a REALIZED outcome), so it gets the exact same
 * enforced cutoff as news reads, not a separate/looser path.
 */
export async function getDecisionMemoryAsOf(db, { ticker, asOf, limit = 10 }) {
  if (!asOf) {
    throw new LookaheadViolationError("getDecisionMemoryAsOf requires an explicit asOf timestamp");
  }

  const { results } = await db
    .prepare(
      `SELECT id, decision_id, realized_return, alpha_return, reflection, resolved_at
       FROM decision_memory
       WHERE ticker = ? AND resolved_at < ?
       ORDER BY resolved_at DESC
       LIMIT ?`
    )
    .bind(ticker, asOf, limit)
    .all();

  return results;
}

/**
 * Checkpoint/resume for multi-agent runs (plan.md Adopted Pattern #12,
 * graph/checkpointer.js). One row per (runId, ticker) -- upsert on every
 * completed stage rather than append-only, since resume only ever cares
 * about the LATEST completed stage for that (run, ticker) pair.
 */
export async function saveCheckpoint(db, { runId, ticker, stage, state }) {
  await db
    .prepare(
      `INSERT INTO pipeline_checkpoints (run_id, ticker, stage, state, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(run_id, ticker) DO UPDATE SET stage = excluded.stage, state = excluded.state, updated_at = excluded.updated_at`
    )
    .bind(runId, ticker, stage, state != null ? JSON.stringify(state) : null, new Date().toISOString())
    .run();
}

/** Returns null if no checkpoint exists yet for this (runId, ticker) -- callers should start from stage 1. */
export async function getCheckpoint(db, { runId, ticker }) {
  const row = await db
    .prepare(`SELECT stage, state, updated_at FROM pipeline_checkpoints WHERE run_id = ? AND ticker = ?`)
    .bind(runId, ticker)
    .first();

  if (!row) return null;
  return { stage: row.stage, state: row.state ? JSON.parse(row.state) : null, updatedAt: row.updated_at };
}
