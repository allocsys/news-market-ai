// RunStore(db, runId) is the ONLY code allowed to run SQL against the state
// tables (migrations/state/) -- positions, trade_decisions, decision_memory,
// pipeline_checkpoints (llm_calls and job_progress follow in M2b). See plan.md "Design:
// environments": every method here filters on its own `runId`, and every
// read requires an explicit `asOf` the same way storage/d1.js's readers do
// (LookaheadViolationError on a missing one) -- this class is a run_id-
// scoped rewrite of those functions, not a new access policy.
//
// M2: the old scope-less state functions in storage/d1.js are gone -- this
// class is the only path to the state tables. Input reads (news/prices/
// fundamentals) live in storage/inputs_view.js. The remaining d1.js functions
// are the dashboard's old-DB reads and the backtest_runs registry, which move
// in M4/M3.

import { LookaheadViolationError } from "../shared/errors.js";
import { MAX_PORTFOLIO_RISK_PCT, TRADE_DECISION_STATUS } from "../shared/constants.js";

function requireAsOf(fnName, asOf) {
  if (!asOf) {
    throw new LookaheadViolationError(`${fnName} requires an explicit asOf timestamp`);
  }
}

/**
 * Wraps a D1 database so only SELECT (or PRAGMA/WITH-as-select) statements
 * can run through it -- config (wrangler bindings) can't express "read-only"
 * for a D1 binding, so this is the code-level half of plan.md's "backend:
 * read-only handles to all three [DBs] for the dashboard API" and "llm
 * (live only): ... inputs read-only" requirements. Throws synchronously,
 * before ever touching the underlying db, on anything else -- including
 * INSERT/UPDATE/DELETE and D1's own .exec()/.batch() (batch could smuggle a
 * write in as one of its statements, so it's blocked outright rather than
 * inspected element-by-element).
 */
export function readOnly(db) {
  const isSelectish = (sql) => /^\s*(select|pragma|with)\b/i.test(sql);
  return {
    prepare(sql) {
      if (!isSelectish(sql)) {
        throw new Error(`readOnly(db): refusing non-SELECT statement: ${sql}`);
      }
      return db.prepare(sql);
    },
    batch() {
      throw new Error("readOnly(db): batch() is not permitted through a read-only handle");
    },
    exec() {
      throw new Error("readOnly(db): exec() is not permitted through a read-only handle");
    },
  };
}

export class RunStore {
  constructor(db, runId) {
    if (!runId) {
      throw new Error("RunStore requires a runId (the environment: 'live' or a backtest id)");
    }
    this.db = db;
    this.runId = runId;
  }

  // -------------------------------------------------------------------
  // Positions
  // -------------------------------------------------------------------

  /**
   * Direct open, no risk/replace logic -- same low-level shape as
   * d1.js#openPosition, just run_id-scoped. commitThesis (below) is the
   * atomic check-and-open path graph/pipeline.js should actually call once
   * wired in M2; this stays exposed for tests and for any caller that has
   * already done its own risk check.
   */
  async openPosition({ id, ticker, tradeThesisId, positionSizePct, direction = null, entryPrice = null, stopLossPct = null, takeProfitPct = null, openedAt }) {
    await this.db
      .prepare(
        `INSERT INTO positions (run_id, id, ticker, trade_thesis_id, position_size_pct, direction, entry_price, stop_loss_pct, take_profit_pct, opened_at, closed_at, close_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
         ON CONFLICT(run_id, id) DO NOTHING`
      )
      .bind(this.runId, id, ticker, tradeThesisId, positionSizePct, direction, entryPrice, stopLossPct, takeProfitPct, openedAt)
      .run();
  }

  async closePosition({ id, closedAt, closeReason = null, exitPrice = null }) {
    await this.db
      .prepare(`UPDATE positions SET closed_at = ?, close_reason = ?, exit_price = ? WHERE run_id = ? AND id = ? AND closed_at IS NULL`)
      .bind(closedAt, closeReason, exitPrice, this.runId, id)
      .run();
  }

  async getOpenPositionsAsOf({ asOf }) {
    requireAsOf("getOpenPositionsAsOf", asOf);

    const { results } = await this.db
      .prepare(
        `SELECT id, ticker, trade_thesis_id, position_size_pct, direction, entry_price, stop_loss_pct, take_profit_pct, opened_at
         FROM positions
         WHERE run_id = ? AND opened_at <= ? AND (closed_at IS NULL OR closed_at > ?)`
      )
      .bind(this.runId, asOf, asOf)
      .all();

    return results.map((r) => ({
      id: r.id,
      ticker: r.ticker,
      tradeThesisId: r.trade_thesis_id,
      positionSizePct: r.position_size_pct,
      direction: r.direction,
      entryPrice: r.entry_price,
      stopLossPct: r.stop_loss_pct,
      takeProfitPct: r.take_profit_pct,
      openedAt: r.opened_at,
    }));
  }

  async getOpenPositionsRiskPctAsOf({ asOf, excludeTicker } = {}) {
    requireAsOf("getOpenPositionsRiskPctAsOf", asOf);

    const sql = excludeTicker
      ? `SELECT position_size_pct FROM positions WHERE run_id = ? AND opened_at <= ? AND (closed_at IS NULL OR closed_at > ?) AND ticker != ?`
      : `SELECT position_size_pct FROM positions WHERE run_id = ? AND opened_at <= ? AND (closed_at IS NULL OR closed_at > ?)`;
    const binds = excludeTicker ? [this.runId, asOf, asOf, excludeTicker] : [this.runId, asOf, asOf];

    const { results } = await this.db.prepare(sql).bind(...binds).all();
    return results.reduce((sum, r) => sum + r.position_size_pct, 0);
  }

  async getOpenPositionForTickerAsOf({ ticker, asOf }) {
    requireAsOf("getOpenPositionForTickerAsOf", asOf);

    const row = await this.db
      .prepare(
        `SELECT id, ticker, trade_thesis_id, position_size_pct, direction, entry_price, stop_loss_pct, take_profit_pct, opened_at
         FROM positions
         WHERE run_id = ? AND ticker = ? AND opened_at <= ? AND (closed_at IS NULL OR closed_at > ?)
         ORDER BY opened_at DESC
         LIMIT 1`
      )
      .bind(this.runId, ticker, asOf, asOf)
      .first();

    if (!row) return null;
    return {
      id: row.id,
      ticker: row.ticker,
      tradeThesisId: row.trade_thesis_id,
      positionSizePct: row.position_size_pct,
      direction: row.direction,
      entryPrice: row.entry_price,
      stopLossPct: row.stop_loss_pct,
      takeProfitPct: row.take_profit_pct,
      openedAt: row.opened_at,
    };
  }

  /**
   * Positions that ticker's commitThesis batch closed as 'replaced' at exactly
   * `closedAt` and that have no decision_memory row yet -- i.e. replaced
   * positions still waiting for graph/settle.js to record their realized
   * outcome. This is how the pipeline finds what to settle AFTER the commit:
   * it can't rely on "the position I read before committing" because a
   * queue-retried re-run (crash after the batch, before settle/checkpoint)
   * would then see its own new position as the existing one and never settle
   * the old one. Returns each position with `exitPrice`/`closedAt`/
   * `closeReason`, the shape settlePositionOutcome needs. A position whose
   * realized return can't be computed (no entry price) stays "unsettled"
   * here and is simply skipped again on a re-run -- harmless.
   */
  async getUnsettledReplacedPositions({ ticker, closedAt }) {
    if (!closedAt) {
      throw new LookaheadViolationError("getUnsettledReplacedPositions requires an explicit closedAt timestamp");
    }

    const { results } = await this.db
      .prepare(
        `SELECT p.id, p.ticker, p.trade_thesis_id, p.position_size_pct, p.direction, p.entry_price, p.exit_price, p.opened_at, p.closed_at, p.close_reason
         FROM positions p
         WHERE p.run_id = ? AND p.ticker = ? AND p.closed_at = ? AND p.close_reason = 'replaced'
           AND NOT EXISTS (
             SELECT 1 FROM decision_memory m WHERE m.run_id = p.run_id AND m.decision_id = p.trade_thesis_id
           )`
      )
      .bind(this.runId, ticker, closedAt)
      .all();

    return results.map((r) => ({
      id: r.id,
      ticker: r.ticker,
      tradeThesisId: r.trade_thesis_id,
      positionSizePct: r.position_size_pct,
      direction: r.direction,
      entryPrice: r.entry_price,
      exitPrice: r.exit_price,
      openedAt: r.opened_at,
      closedAt: r.closed_at,
      closeReason: r.close_reason,
    }));
  }

  // -------------------------------------------------------------------
  // Atomic portfolio commit -- plan.md "Atomic portfolio commit"
  // -------------------------------------------------------------------

  /**
   * The one write path graph/pipeline.js's risk_checked/portfolio_checked
   * stages should call once wired in M2, replacing the old
   * getOpenPositionForTickerAsOf-then-closePosition-then-openPosition
   * sequence (three separate round trips, hence "Overlapping open
   * positions" -- see plan.md's incident writeup) with ONE db.batch of
   * exactly 3 statements, so the whole check-and-write is atomic:
   *
   *   1. UPDATE: close this ticker's older open position(s) as 'replaced'.
   *   2. INSERT OR IGNORE: open the new position.
   *   3. INSERT: the trade_decision row, always -- with status/outcome
   *      derived from the SAME predicate as (1)/(2), computed in SQL
   *      rather than read back from their results (D1 batch has no
   *      mid-batch read).
   *
   * Both (1) and (2) are guarded by the identical predicate P:
   *   P1 (out-of-order guard): no OTHER open position for this ticker with
   *      a LATER opened_at already exists. This is what makes "latest asOf
   *      wins" true even when a late-finishing older article's pipeline
   *      run reaches this stage after a newer one already did.
   *   P2 (risk ceiling): (open risk of every OTHER ticker) + this
   *      position's positionSizePct <= MAX_PORTFOLIO_RISK_PCT. Checked
   *      against OTHER tickers only -- **decided 2026-09-19** (plan.md):
   *      a ticker's new position replacing its own old one is not double-
   *      counted against the ceiling.
   * (1) never closes the row it is about to (re)insert (`id != ?`): a
   * checkpoint-resumed or queue-retried re-run of the portfolio stage (crash
   * between this batch and the checkpoint write) must be a no-op, not close
   * its own just-opened position as 'replaced'. `exitPrice` is recorded on
   * whatever (1) closes, so the caller can settle the replaced position.
   * (1) excludes this ticker's own soon-to-be-closed row from P2's SUM by
   * construction (`ticker != ?`), so evaluating the identical expression
   * again in (2) and (3) is safe -- (1) never changes what (2)/(3) see.
   *
   * `outcome` (trade_decisions.status) is one of:
   *   'superseded' -- P1 failed: a newer position for this ticker already exists.
   *   'rejected'   -- P1 held but P2 failed: would breach the risk ceiling.
   *   'opened'     -- both held: the position was actually opened.
   * `id`/`tradeThesisId` should both be `${ticker}|${asOf}` (risk.js's own
   * convention) -- ON CONFLICT DO NOTHING on both inserts makes a
   * checkpoint-resumed re-run of this stage idempotent, same as the old
   * openPosition/insertTradeDecision.
   *
   * Returns the raw D1 batch result array (3 entries) -- callers that need
   * to know which outcome fired should re-read via
   * getOpenPositionForTickerAsOf or getRecentTradeDecisions rather than
   * parse `meta.changes` here, since `changes: 0` is ambiguous between "P
   * failed" and "ON CONFLICT DO NOTHING short-circuited" for (2).
   */
  async commitThesis({
    id,
    ticker,
    tradeThesisId,
    positionSizePct,
    direction = null,
    entryPrice = null,
    stopLossPct = null,
    takeProfitPct = null,
    asOf,
    exitPrice = null,
    debateId = null,
    thesis,
    riskDecision,
    portfolioDecision = null,
    opinions = null,
    debate = null,
    createdAt,
  }) {
    if (!asOf) {
      throw new LookaheadViolationError("commitThesis requires an explicit asOf timestamp");
    }

    const closeOld = this.db
      .prepare(
        `UPDATE positions
         SET closed_at = ?, close_reason = 'replaced', exit_price = ?
         WHERE run_id = ? AND ticker = ? AND id != ? AND closed_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM positions p2
             WHERE p2.run_id = ? AND p2.ticker = ? AND p2.closed_at IS NULL AND p2.opened_at > ?
           )
           AND (
             SELECT COALESCE(SUM(position_size_pct), 0) FROM positions p3
             WHERE p3.run_id = ? AND p3.ticker != ? AND p3.closed_at IS NULL
           ) + ? <= ?`
      )
      .bind(asOf, exitPrice, this.runId, ticker, id, this.runId, ticker, asOf, this.runId, ticker, positionSizePct, MAX_PORTFOLIO_RISK_PCT);

    const openNew = this.db
      .prepare(
        `INSERT OR IGNORE INTO positions (run_id, id, ticker, trade_thesis_id, position_size_pct, direction, entry_price, stop_loss_pct, take_profit_pct, opened_at, closed_at, close_reason)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL
         WHERE NOT EXISTS (
           SELECT 1 FROM positions p2
           WHERE p2.run_id = ? AND p2.ticker = ? AND p2.closed_at IS NULL AND p2.opened_at > ?
         )
         AND (
           SELECT COALESCE(SUM(position_size_pct), 0) FROM positions p3
           WHERE p3.run_id = ? AND p3.ticker != ? AND p3.closed_at IS NULL
         ) + ? <= ?`
      )
      .bind(
        this.runId, id, ticker, tradeThesisId, positionSizePct, direction, entryPrice, stopLossPct, takeProfitPct, asOf,
        this.runId, ticker, asOf,
        this.runId, ticker, positionSizePct, MAX_PORTFOLIO_RISK_PCT
      );

    const insertDecision = this.db
      .prepare(
        `INSERT INTO trade_decisions (run_id, id, ticker, as_of, debate_id, thesis, risk_decision, portfolio_decision, status, opinions, debate, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?,
           (CASE
             WHEN EXISTS (
               SELECT 1 FROM positions p2
               WHERE p2.run_id = ? AND p2.ticker = ? AND p2.closed_at IS NULL AND p2.opened_at > ?
             ) THEN '${TRADE_DECISION_STATUS.SUPERSEDED}'
             WHEN (
               SELECT COALESCE(SUM(position_size_pct), 0) FROM positions p3
               WHERE p3.run_id = ? AND p3.ticker != ? AND p3.closed_at IS NULL
             ) + ? > ? THEN '${TRADE_DECISION_STATUS.REJECTED}'
             ELSE '${TRADE_DECISION_STATUS.OPENED}'
           END),
           ?, ?, ?)
         ON CONFLICT(run_id, id) DO NOTHING`
      )
      .bind(
        this.runId, id, ticker, asOf, debateId,
        JSON.stringify(thesis), JSON.stringify(riskDecision), portfolioDecision != null ? JSON.stringify(portfolioDecision) : null,
        this.runId, ticker, asOf,
        this.runId, ticker, positionSizePct, MAX_PORTFOLIO_RISK_PCT,
        opinions != null ? JSON.stringify(opinions) : null,
        debate != null ? JSON.stringify(debate) : null,
        createdAt
      );

    return this.db.batch([closeOld, openNew, insertDecision]);
  }

  // -------------------------------------------------------------------
  // Trade decisions / decision memory
  // -------------------------------------------------------------------

  /** Direct insert, no risk/replace logic -- same shape as d1.js#insertTradeDecision, run_id-scoped. Prefer commitThesis for the live write path once wired in M2. */
  async insertTradeDecision({ id, ticker, asOf, debateId = null, thesis, riskDecision, portfolioDecision, status, createdAt, opinions = null, debate = null }) {
    await this.db
      .prepare(
        `INSERT INTO trade_decisions (run_id, id, ticker, as_of, debate_id, thesis, risk_decision, portfolio_decision, status, created_at, opinions, debate)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, id) DO NOTHING`
      )
      .bind(
        this.runId, id, ticker, asOf, debateId,
        JSON.stringify(thesis), JSON.stringify(riskDecision), portfolioDecision != null ? JSON.stringify(portfolioDecision) : null,
        status, createdAt,
        opinions != null ? JSON.stringify(opinions) : null,
        debate != null ? JSON.stringify(debate) : null
      )
      .run();
  }

  async recordDecisionOutcome({ id, decisionId, ticker, realizedReturn, alphaReturn, reflection, resolvedAt }) {
    await this.db
      .prepare(
        `INSERT INTO decision_memory (run_id, id, decision_id, ticker, realized_return, alpha_return, reflection, resolved_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, id) DO NOTHING`
      )
      .bind(this.runId, id, decisionId, ticker, realizedReturn ?? null, alphaReturn ?? null, reflection ?? null, resolvedAt, new Date().toISOString())
      .run();
  }

  async getDecisionMemoryAsOf({ ticker, asOf, limit = 10 }) {
    requireAsOf("getDecisionMemoryAsOf", asOf);

    const { results } = await this.db
      .prepare(
        `SELECT id, decision_id, realized_return, alpha_return, reflection, resolved_at
         FROM decision_memory
         WHERE run_id = ? AND ticker = ? AND resolved_at < ?
         ORDER BY resolved_at DESC
         LIMIT ?`
      )
      .bind(this.runId, ticker, asOf, limit)
      .all();

    return results;
  }

  /** Backtest-result read, deliberately not asOf-gated -- same carve-out as d1.js#getRealizedReturnsInRange (see that function's header). */
  async getRealizedReturnsInRange({ ticker, from, to, limit = 500 }) {
    if (!from || !to) {
      throw new LookaheadViolationError("getRealizedReturnsInRange requires an explicit {from, to} range");
    }

    const { results } = await this.db
      .prepare(
        `SELECT realized_return
         FROM decision_memory
         WHERE run_id = ? AND ticker = ? AND resolved_at >= ? AND resolved_at < ? AND realized_return IS NOT NULL
         ORDER BY resolved_at ASC
         LIMIT ?`
      )
      .bind(this.runId, ticker, from, to, limit)
      .all();

    return results.map((r) => r.realized_return);
  }

  // -------------------------------------------------------------------
  // Pipeline checkpoints -- `pipelineRunId` here is the OLD `runId`
  // concept (one per-ticker pipeline execution), renamed to avoid
  // colliding with this class's own `runId` (the environment). See
  // migrations/state/0001_init.sql's header.
  // -------------------------------------------------------------------

  async saveCheckpoint({ pipelineRunId, ticker, stage, state }) {
    await this.db
      .prepare(
        `INSERT INTO pipeline_checkpoints (run_id, pipeline_run_id, ticker, stage, state, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, pipeline_run_id, ticker) DO UPDATE SET stage = excluded.stage, state = excluded.state, updated_at = excluded.updated_at`
      )
      .bind(this.runId, pipelineRunId, ticker, stage, state != null ? JSON.stringify(state) : null, new Date().toISOString())
      .run();
  }

  async getCheckpoint({ pipelineRunId, ticker }) {
    const row = await this.db
      .prepare(`SELECT stage, state, updated_at FROM pipeline_checkpoints WHERE run_id = ? AND pipeline_run_id = ? AND ticker = ?`)
      .bind(this.runId, pipelineRunId, ticker)
      .first();

    if (!row) return null;
    return { stage: row.stage, state: row.state ? JSON.parse(row.state) : null, updatedAt: row.updated_at };
  }

  // -------------------------------------------------------------------
  // Cleanup -- plan.md "Cleanup = delete-by-run in `sim`, chunked, run by
  // the `backtest` Worker." `deleteRun` refuses 'live' unconditionally --
  // this class has no other guard against accidentally wiping the live
  // environment's state, so the refusal lives directly on the one method
  // that could do it.
  // -------------------------------------------------------------------

  /**
   * Deletes every row for this.runId across every state table, `limit`
   * rows per table per call -- chunked so a large backtest's cleanup can't
   * blow past D1's per-invocation limits in one call. Returns the total
   * rows deleted this call; a caller (the `backtest` Worker, in M3) should
   * keep calling until the total comes back 0.
   */
  async deleteRun({ limit = 500 } = {}) {
    if (this.runId === "live") {
      throw new Error("deleteRun refuses to delete the 'live' run_id");
    }

    const tables = ["positions", "trade_decisions", "decision_memory", "pipeline_checkpoints", "job_progress"];
    let totalChanges = 0;
    for (const table of tables) {
      const result = await this.db
        .prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE run_id = ? LIMIT ?)`)
        .bind(this.runId, limit)
        .run();
      totalChanges += result.meta?.changes ?? 0;
    }
    // llm_calls uses env_run_id, not run_id -- see migrations/state/0001_init.sql's header.
    const llmResult = await this.db
      .prepare(`DELETE FROM llm_calls WHERE rowid IN (SELECT rowid FROM llm_calls WHERE env_run_id = ? LIMIT ?)`)
      .bind(this.runId, limit)
      .run();
    totalChanges += llmResult.meta?.changes ?? 0;

    return totalChanges;
  }
}
