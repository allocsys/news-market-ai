// RunStore(db, runId) is the ONLY code allowed to run SQL against the state
// tables (migrations/state/) -- positions, trade_decisions, decision_memory,
// pipeline_checkpoints, llm_calls, job_progress (the last two moved here in M2b;
// storage/llm_calls.js and storage/jobs.js keep only their pure helpers). See plan.md "Design:
// environments": every method here filters on its own `runId`, and every
// read requires an explicit `asOf` the same way storage/d1.js's readers do
// (LookaheadViolationError on a missing one) -- this class is a run_id-
// scoped rewrite of those functions, not a new access policy.
//
// M2: the old scope-less state functions in storage/d1.js are gone -- this
// class is the only path to the state tables. Input reads (news/prices/
// fundamentals) live in storage/inputs_view.js. M4 moved the dashboard's
// "current state" reads here too (the "Dashboard reads" section below) and
// deleted d1.js; the backtest_runs registry is storage/sim_registry.js.

import { LookaheadViolationError } from "../shared/errors.js";
import { MAX_PORTFOLIO_RISK_PCT, TRADE_DECISION_STATUS } from "../shared/constants.js";
import { DEFAULT_MAX_CHARS, PREVIEW_CHARS, buildLlmCallRow, llmCallSummaryFromRow, llmCallFromRow } from "./llm_calls.js";
import {
  ACTIVE_JOB_MAX_IDLE_MS,
  MAX_DETAIL_LENGTH,
  MAX_ERROR_LENGTH,
  clampPercent,
  jobFromRow,
  nonNegativeInt,
  nowIso,
  toJsonOrNull,
  truncate,
} from "./jobs.js";

const LLM_LIST_COLUMNS = `id, created_at, source, job_id, run_id, ticker, label, requested_model, model_used, key_index, status, error_stage, error,
  duration_ms, prompt_chars, response_chars, truncated,
  substr(prompt, 1, ${PREVIEW_CHARS}) AS prompt_preview, substr(response, 1, ${PREVIEW_CHARS}) AS response_preview`;

const JOB_COLUMNS = "id, type, status, phase, percent, done, total, detail, params, result, error, created_at, started_at, updated_at, finished_at";

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

  /**
   * Backtest-result read, deliberately not asOf-gated -- same carve-out as d1.js#getRealizedReturnsInRange (see that function's header).
   * Returns EVERY realized return resolved in [from, to), oldest first (ties by row id, so the order is
   * deterministic and safe to compound). It used to default to `limit = 500` and truncate silently
   * (plan.md Next steps, step B); a row here is one number, so there is nothing to page.
   */
  async getRealizedReturnsInRange({ ticker, from, to }) {
    if (!from || !to) {
      throw new LookaheadViolationError("getRealizedReturnsInRange requires an explicit {from, to} range");
    }

    const { results } = await this.db
      .prepare(
        `SELECT realized_return
         FROM decision_memory
         WHERE run_id = ? AND ticker = ? AND resolved_at >= ? AND resolved_at < ? AND realized_return IS NOT NULL
         ORDER BY resolved_at ASC, id ASC`
      )
      .bind(this.runId, ticker, from, to)
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
  // Dashboard reads (M4) -- unrestricted "current state" queries for the
  // human-facing dashboard, scoped to THIS environment (run_id). They are
  // deliberately NOT asOf-gated: the required-asOf convention above exists to
  // stop an AGENT seeing future data during a simulated run; these describe
  // what has already happened in this environment and never feed an agent
  // prompt. Do not reuse them for anything that does. Pass a
  // readOnly(db)-wrapped handle (the dashboard never writes).
  // -------------------------------------------------------------------

  /** Positions currently open (closed_at IS NULL), newest first. */
  async listOpenPositions({ limit = 50 } = {}) {
    const { results } = await this.db
      .prepare(
        `SELECT id, ticker, trade_thesis_id, position_size_pct, direction, entry_price, stop_loss_pct, take_profit_pct, opened_at
         FROM positions WHERE run_id = ? AND closed_at IS NULL ORDER BY opened_at DESC LIMIT ?`
      )
      .bind(this.runId, limit)
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

  /**
   * Total exposure across EVERY open position in this environment, not just
   * whatever page listOpenPositions fetched (summing that page client-side
   * quietly understated exposure once open positions exceeded the Rows
   * filter -- plan.md Step 1). A plain aggregate: no LIMIT, no asOf.
   */
  async getOpenExposureTotal() {
    const row = await this.db
      .prepare(`SELECT COALESCE(SUM(position_size_pct), 0) AS total_pct, COUNT(*) AS count FROM positions WHERE run_id = ? AND closed_at IS NULL`)
      .bind(this.runId)
      .first();

    return { totalPct: row?.total_pct ?? 0, count: row?.count ?? 0 };
  }

  /**
   * Most recently closed positions. `exitPrice` is nullable (a time_based
   * exit with no price_bars data, same honest gap as a null entry_price);
   * the realized return is not computed here -- graph/settle.js writes it to
   * decision_memory at close time.
   */
  async listRecentlyClosedPositions({ limit = 20 } = {}) {
    const { results } = await this.db
      .prepare(
        `SELECT id, ticker, trade_thesis_id, position_size_pct, direction, entry_price, exit_price, opened_at, closed_at, close_reason
         FROM positions WHERE run_id = ? AND closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT ?`
      )
      .bind(this.runId, limit)
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

  /** Most recent trade_decisions rows, newest first. `status`, if given, filters to that exact status ("approved"/"rejected"/...). */
  async listRecentTradeDecisions({ limit = 20, status } = {}) {
    const cols = `id, ticker, as_of, debate_id, thesis, risk_decision, portfolio_decision, status, created_at, opinions, debate`;
    const { results } = status
      ? await this.db
          .prepare(`SELECT ${cols} FROM trade_decisions WHERE run_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?`)
          .bind(this.runId, status, limit)
          .all()
      : await this.db
          .prepare(`SELECT ${cols} FROM trade_decisions WHERE run_id = ? ORDER BY created_at DESC LIMIT ?`)
          .bind(this.runId, limit)
          .all();

    return results.map((r) => ({
      id: r.id,
      ticker: r.ticker,
      asOf: r.as_of,
      debateId: r.debate_id,
      thesis: JSON.parse(r.thesis),
      riskDecision: JSON.parse(r.risk_decision),
      portfolioDecision: r.portfolio_decision ? JSON.parse(r.portfolio_decision) : null,
      status: r.status,
      createdAt: r.created_at,
      // Nullable: rows written before the LLM reasoning chain was recorded
      // have neither column; the dashboard renders an honest "not recorded".
      opinions: r.opinions ? JSON.parse(r.opinions) : null,
      debate: r.debate ? JSON.parse(r.debate) : null,
    }));
  }

  /**
   * Most recently updated pipeline_checkpoints rows, across every (pipeline
   * run, ticker) in this environment. A proxy for "recent pipeline
   * activity", not a strict health signal -- a stuck run just stops appearing
   * rather than showing a failure state. `run_id` in the result is the
   * PIPELINE run id (the column is aliased so the dashboard view keeps its
   * shape); the environment is this store's own scope.
   */
  async listRecentCheckpoints({ limit = 30 } = {}) {
    const { results } = await this.db
      .prepare(`SELECT pipeline_run_id AS run_id, ticker, stage, updated_at FROM pipeline_checkpoints WHERE run_id = ? ORDER BY updated_at DESC LIMIT ?`)
      .bind(this.runId, limit)
      .all();

    return results;
  }

  /**
   * Trade-decision counts by status (all-time totals) plus a per-day
   * breakdown for the last `days` days, both by status -- the activity
   * chart's stacked bars. `day` buckets on created_at's first 10 characters
   * (an ISO string's UTC date) via substr, not strftime, so it needs no
   * datetime parsing. The window is relative to the wall clock -- right for
   * a live environment; a finished backtest's decisions are dated in the
   * past, so a window over one is the environment selector's problem.
   */
  /**
   * `anchor` (an ISO timestamp) replaces wall-clock 'now' as the end of the
   * "last N days" window -- required for a finished backtest environment,
   * whose decisions happened at simulated dates that could be arbitrarily far
   * in the past and would otherwise fall outside a `now`-relative window
   * entirely. `live` callers omit it and get the original wall-clock
   * behavior (SQLite's `datetime(NULL ?? 'now', ...)` below resolves to
   * `datetime('now', ...)`).
   */
  async getDecisionStats({ days = 14, anchor = null } = {}) {
    const totalsResult = await this.db
      .prepare(`SELECT status, COUNT(*) AS count FROM trade_decisions WHERE run_id = ? GROUP BY status`)
      .bind(this.runId)
      .all();

    const dailyResult = await this.db
      .prepare(
        `SELECT substr(created_at, 1, 10) AS day, status, COUNT(*) AS count
         FROM trade_decisions
         WHERE run_id = ? AND created_at >= datetime(?, ?)
         GROUP BY day, status
         ORDER BY day ASC`
      )
      .bind(this.runId, anchor ?? "now", `-${days} days`)
      .all();

    const totals = totalsResult.results.reduce((acc, r) => {
      acc[r.status] = r.count;
      return acc;
    }, {});

    return { totals, daily: dailyResult.results, days };
  }

  // -------------------------------------------------------------------
  // LLM call log (M2b) -- the state schema's `llm_calls`. Scoped by
  // `env_run_id` (this.runId); the table's own `run_id` column is the
  // PIPELINE run and is only ever a filter/payload here, never the scope.
  // Best-effort policy lives in storage/llm_calls.js#recordLlmCall (the
  // call-site wrapper) -- these methods throw on D1 failure.
  // -------------------------------------------------------------------

  /** Inserts one row for this environment. `entry` is the camelCase shape recordLlmCall builds; see llm_calls.js#buildLlmCallRow for clipping/redaction. */
  async insertLlmCall(entry, { maxChars = DEFAULT_MAX_CHARS, now = new Date().toISOString() } = {}) {
    const r = buildLlmCallRow(entry, { maxChars, now });
    await this.db
      .prepare(
        `INSERT INTO llm_calls (env_run_id, created_at, source, job_id, run_id, ticker, label, requested_model, model_used, key_index, status, error_stage, error, duration_ms, attempts, prompt, response, prompt_chars, response_chars, truncated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        this.runId, r.created_at, r.source, r.job_id, r.run_id, r.ticker, r.label, r.requested_model, r.model_used, r.key_index,
        r.status, r.error_stage, r.error, r.duration_ms, r.attempts, r.prompt, r.response, r.prompt_chars, r.response_chars, r.truncated
      )
      .run();
  }

  /** Deletes THIS environment's rows older than `days`. Throws on D1 failure. */
  async pruneLlmCalls({ days, now = Date.now() }) {
    const cutoff = new Date(now - days * 24 * 3600 * 1000).toISOString();
    await this.db.prepare(`DELETE FROM llm_calls WHERE env_run_id = ? AND created_at < ?`).bind(this.runId, cutoff).run();
  }

  /**
   * Newest-first page of this environment's calls, with only a short preview
   * of each prompt/response (the full text can be ~60K chars per row -- the
   * list must not load it; see getLlmCall). Filters are all optional and
   * AND-ed; `runId` here filters the PIPELINE run column. Keyset pagination on
   * id: pass the previous page's `nextBeforeId` as `beforeId`. Fetches
   * limit+1 rows to know whether another page exists.
   */
  async getRecentLlmCalls({ limit = 50, source, status, ticker, jobId, runId, beforeId } = {}) {
    const where = ["env_run_id = ?"];
    const args = [this.runId];
    if (source) { where.push("source = ?"); args.push(source); }
    if (status) { where.push("status = ?"); args.push(status); }
    if (ticker) { where.push("ticker = ?"); args.push(ticker); }
    if (jobId) { where.push("job_id = ?"); args.push(jobId); }
    if (runId) { where.push("run_id = ?"); args.push(runId); }
    if (beforeId) { where.push("id < ?"); args.push(beforeId); }

    const { results } = await this.db
      .prepare(`SELECT ${LLM_LIST_COLUMNS} FROM llm_calls WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`)
      .bind(...args, limit + 1)
      .all();

    const hasMore = results.length > limit;
    const page = hasMore ? results.slice(0, limit) : results;
    return { calls: page.map(llmCallSummaryFromRow), nextBeforeId: hasMore ? page[page.length - 1].id : null };
  }

  /** One call in full (complete prompt + response + cascade attempts), or null. Scoped: another environment's id is "not found". */
  async getLlmCall(id) {
    const row = await this.db.prepare(`SELECT * FROM llm_calls WHERE env_run_id = ? AND id = ?`).bind(this.runId, id).first();
    return row ? llmCallFromRow(row) : null;
  }

  // -------------------------------------------------------------------
  // Job progress (M2b) -- the state schema's `job_progress`, PK
  // (run_id, id), run_id = this.runId. Callers go through
  // storage/jobs.js#createJobReporter (best-effort, throttled), never these
  // directly in a per-item loop.
  // -------------------------------------------------------------------

  /** Inserts the 'queued' row when a job is enqueued. No-op if the id already exists. */
  async insertQueuedJob({ id, type, params = null, now = nowIso() }) {
    await this.db
      .prepare(
        `INSERT INTO job_progress (run_id, id, type, status, percent, params, created_at, updated_at)
         VALUES (?, ?, ?, 'queued', 0, ?, ?, ?)
         ON CONFLICT(run_id, id) DO NOTHING`
      )
      .bind(this.runId, id, type, toJsonOrNull(params), now, now)
      .run();
  }

  /**
   * Marks a job 'running' when its consumer picks it up. An upsert, so it also
   * works when the 'queued' row was never written (best-effort insert failed)
   * and when a crashed message is redelivered (started_at keeps its first value).
   */
  async markJobRunning({ id, type, params = null, now = nowIso() }) {
    await this.db
      .prepare(
        `INSERT INTO job_progress (run_id, id, type, status, percent, params, created_at, started_at, updated_at)
         VALUES (?, ?, ?, 'running', 0, ?, ?, ?, ?)
         ON CONFLICT(run_id, id) DO UPDATE SET status = 'running', started_at = COALESCE(job_progress.started_at, excluded.started_at), updated_at = excluded.updated_at`
      )
      .bind(this.runId, id, type, toJsonOrNull(params), now, now, now)
      .run();
  }

  /** Progress tick. Guarded on status so a late tick can never overwrite a finished job. */
  async updateJobProgress({ id, phase = null, percent = 0, done = 0, total = 0, detail = null, now = nowIso() }) {
    await this.db
      .prepare(
        `UPDATE job_progress SET status = 'running', phase = ?, percent = ?, done = ?, total = ?, detail = ?, updated_at = ?
         WHERE run_id = ? AND id = ? AND status IN ('queued', 'running')`
      )
      .bind(phase, clampPercent(percent), nonNegativeInt(done), nonNegativeInt(total), truncate(detail, MAX_DETAIL_LENGTH), now, this.runId, id)
      .run();
  }

  async completeJob({ id, result = null, detail = null, now = nowIso() }) {
    await this.db
      .prepare(`UPDATE job_progress SET status = 'complete', percent = 100, phase = 'done', result = ?, detail = ?, updated_at = ?, finished_at = ? WHERE run_id = ? AND id = ?`)
      .bind(toJsonOrNull(result), truncate(detail, MAX_DETAIL_LENGTH), now, now, this.runId, id)
      .run();
  }

  /** Keeps the last reported percent/phase, so a failed job shows how far it got. */
  async failJob({ id, error, detail = null, now = nowIso() }) {
    await this.db
      .prepare(`UPDATE job_progress SET status = 'failed', error = ?, detail = ?, updated_at = ?, finished_at = ? WHERE run_id = ? AND id = ?`)
      .bind(truncate(error ?? "unknown error", MAX_ERROR_LENGTH), truncate(detail, MAX_DETAIL_LENGTH), now, now, this.runId, id)
      .run();
  }

  /** One job, with JSON columns parsed and keys camelCased for the API. Null if there's no such id in this run. */
  async getJob(id) {
    const row = await this.db.prepare(`SELECT ${JOB_COLUMNS} FROM job_progress WHERE run_id = ? AND id = ?`).bind(this.runId, id).first();
    return row ? jobFromRow(row) : null;
  }

  /**
   * The most recently created job of `type` in this run that is still in
   * flight (status 'queued' or 'running') and has ticked within `maxIdleMs`
   * (a consumer killed by an uncatchable isolate kill never writes 'failed',
   * so without the cutoff every such orphan would show a phantom "in
   * progress" bar forever). Null if none. `now` is injectable so the cutoff
   * is testable without real waiting.
   */
  async getActiveJob(type, { maxIdleMs = ACTIVE_JOB_MAX_IDLE_MS, now = nowIso() } = {}) {
    const cutoff = new Date(Date.parse(now) - maxIdleMs).toISOString();
    const row = await this.db
      .prepare(
        `SELECT ${JOB_COLUMNS} FROM job_progress
         WHERE run_id = ? AND type = ? AND status IN ('queued', 'running') AND updated_at >= ?
         ORDER BY created_at DESC LIMIT 1`
      )
      .bind(this.runId, type, cutoff)
      .first();
    return row ? jobFromRow(row) : null;
  }

  /**
   * The most recently FINISHED job ('complete' or 'failed') of `type` in this
   * run, by finished_at, or null if none has finished. The counterpart to
   * getActiveJob: that one answers "what is running right now" (and ages out
   * orphans), this one answers "how did the last run end" so a page can show a
   * result after the progress bar is gone. In-flight rows are excluded on
   * purpose -- the active-job panel already covers those, and a row orphaned by
   * an isolate kill would otherwise show as a phantom "running" last run forever.
   * Same camelCased, JSON-parsed shape as getJob.
   */
  async getLatestFinishedJob(type) {
    const row = await this.db
      .prepare(
        `SELECT ${JOB_COLUMNS} FROM job_progress
         WHERE run_id = ? AND type = ? AND status IN ('complete', 'failed')
         ORDER BY finished_at DESC, created_at DESC LIMIT 1`
      )
      .bind(this.runId, type)
      .first();
    return row ? jobFromRow(row) : null;
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
   *
   * Two opt-in keeps, both DEFAULT false (so the plain call still removes
   * everything), used to delete a FAILED run's data while retaining its
   * error trail (backtest/cleanup.js):
   *   - keepErroredLlmCalls: leave llm_calls rows whose status is 'error'
   *     (the best debugging evidence for why a run died).
   *   - keepJobProgress: leave job_progress rows alone (the dashboard's
   *     "failed + error" job view reads the one row).
   * A kept row is never matched by the delete, so a caller looping "until
   * 0" still terminates.
   */
  async deleteRun({ limit = 500, keepErroredLlmCalls = false, keepJobProgress = false } = {}) {
    if (this.runId === "live") {
      throw new Error("deleteRun refuses to delete the 'live' run_id");
    }

    const tables = ["positions", "trade_decisions", "decision_memory", "pipeline_checkpoints"];
    if (!keepJobProgress) tables.push("job_progress");
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
      .prepare(
        `DELETE FROM llm_calls WHERE rowid IN (SELECT rowid FROM llm_calls WHERE env_run_id = ?${keepErroredLlmCalls ? " AND status <> 'error'" : ""} LIMIT ?)`
      )
      .bind(this.runId, limit)
      .run();
    totalChanges += llmResult.meta?.changes ?? 0;

    return totalChanges;
  }
}
