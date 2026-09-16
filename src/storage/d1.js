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

/**
 * Positions ledger (plan.md open item: real portfolio/positions store so
 * agents/managers/portfolio_manager.js's openPositionsRiskPct placeholder
 * becomes a real read instead of a hardcoded 0). `id` should be the trade
 * thesis id (ticker|asOf, see risk_mgmt/risk.js) so a checkpoint-resumed
 * run re-executing the portfolio_checked stage can't double-open the same
 * position -- ON CONFLICT DO NOTHING makes this idempotent the same way
 * insertNewsItem is.
 *
 * HONEST SCOPE: this is a signal-generation pipeline, not a broker
 * integration -- there is no fill confirmation, so `openedAt` is the
 * timestamp portfolio_manager approved the trade, not a real fill time.
 *
 * `direction`/`stopLossPct`/`takeProfitPct` are copied straight from the
 * TradeThesis/RiskDecision that authorized this position, and `entryPrice`
 * (nullable -- see migrations/0006's header for why) lets
 * agents/risk_mgmt/exit.js#evaluateExit later judge a stop-loss/take-profit
 * without reaching back through trade_thesis_id to another table.
 */
export async function openPosition(db, { id, ticker, tradeThesisId, positionSizePct, direction = null, entryPrice = null, stopLossPct = null, takeProfitPct = null, openedAt }) {
  await db
    .prepare(
      `INSERT INTO positions (id, ticker, trade_thesis_id, position_size_pct, direction, entry_price, stop_loss_pct, take_profit_pct, opened_at, closed_at, close_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
       ON CONFLICT(id) DO NOTHING`
    )
    .bind(id, ticker, tradeThesisId, positionSizePct, direction, entryPrice, stopLossPct, takeProfitPct, openedAt)
    .run();
}

/**
 * Write path for exiting a position (stop-loss/take-profit/time-based
 * exit). Now has a caller: src/graph/exit_check.js#checkOpenPositionExits,
 * driven by agents/risk_mgmt/exit.js#evaluateExit's deterministic rules --
 * closing the plan.md gap this function's old comment flagged ("exists now
 * so getOpenPositionsRiskPctAsOf has a real closed_at to filter on once
 * exit logic lands"). `closeReason` records which rule fired
 * ('stop_loss' | 'take_profit' | 'time_based'), same "reason documents
 * which rule fired" convention as RiskDecision.reason.
 */
export async function closePosition(db, { id, closedAt, closeReason = null }) {
  await db
    .prepare(`UPDATE positions SET closed_at = ?, close_reason = ? WHERE id = ? AND closed_at IS NULL`)
    .bind(closedAt, closeReason, id)
    .run();
}

/**
 * Point-in-time read of full position rows (not just the summed pct like
 * getOpenPositionsRiskPctAsOf below) -- what
 * graph/exit_check.js#checkOpenPositionExits iterates to evaluate each open
 * position's own stop-loss/take-profit/time-based exit. Same required-asOf,
 * still-open-as-of-asOf convention as getOpenPositionsRiskPctAsOf.
 */
export async function getOpenPositionsAsOf(db, { asOf }) {
  if (!asOf) {
    throw new LookaheadViolationError("getOpenPositionsAsOf requires an explicit asOf timestamp");
  }

  const { results } = await db
    .prepare(
      `SELECT id, ticker, trade_thesis_id, position_size_pct, direction, entry_price, stop_loss_pct, take_profit_pct, opened_at
       FROM positions
       WHERE opened_at <= ? AND (closed_at IS NULL OR closed_at > ?)`
    )
    .bind(asOf, asOf)
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
 * Point-in-time sum of position_size_pct across every position open AS OF
 * `asOf` (opened_at <= asOf AND (closed_at IS NULL OR closed_at > asOf)) --
 * same required-asOf, no-"give me everything" convention as getNewsAsOf and
 * getDecisionMemoryAsOf, for the same Backtesting Integrity reason.
 *
 * KNOWN LIMITATION: does not exclude/net out an already-open position on
 * the SAME ticker being re-evaluated for a new thesis -- portfolio_manager
 * would see that ticker's existing exposure twice-counted toward the
 * portfolio ceiling in that edge case. Flagged rather than silently wrong;
 * fixing it needs a real "is this thesis replacing an existing position"
 * concept that doesn't exist yet.
 */
export async function getOpenPositionsRiskPctAsOf(db, { asOf }) {
  if (!asOf) {
    throw new LookaheadViolationError("getOpenPositionsRiskPctAsOf requires an explicit asOf timestamp");
  }

  const { results } = await db
    .prepare(`SELECT position_size_pct FROM positions WHERE opened_at <= ? AND (closed_at IS NULL OR closed_at > ?)`)
    .bind(asOf, asOf)
    .all();

  return results.reduce((sum, r) => sum + r.position_size_pct, 0);
}

/**
 * Write path for daily OHLCV bars (ingestion/sources/yfinance.js). Upsert on
 * (ticker, date) since re-ingesting the same trading day should overwrite
 * rather than duplicate -- unlike news, a price bar has no meaningful
 * "revision" concept to preserve.
 */
export async function insertPriceBar(db, bar) {
  await db
    .prepare(
      `INSERT INTO price_bars (ticker, date, open, high, low, close, volume, source, ingested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ticker, date) DO UPDATE SET
         open = excluded.open, high = excluded.high, low = excluded.low,
         close = excluded.close, volume = excluded.volume,
         source = excluded.source, ingested_at = excluded.ingested_at`
    )
    .bind(bar.ticker, bar.date, bar.open, bar.high, bar.low, bar.close, bar.volume, bar.source, new Date().toISOString())
    .run();
}

/**
 * Point-in-time read: bars for `ticker` dated at or before `asOf`. Same
 * required-asOf, no-"give me everything" convention as getNewsAsOf and
 * getDecisionMemoryAsOf (Backtesting Integrity, point 1) -- a technical
 * analyst reading price history must not be able to see a bar from after
 * the simulated "now" any more than a news analyst can.
 */
export async function getPriceBarsAsOf(db, { ticker, asOf, limit = 200 }) {
  if (!asOf) {
    throw new LookaheadViolationError("getPriceBarsAsOf requires an explicit asOf timestamp");
  }

  const { results } = await db
    .prepare(
      `SELECT ticker, date, open, high, low, close, volume, source
       FROM price_bars
       WHERE ticker = ? AND date <= ?
       ORDER BY date DESC
       LIMIT ?`
    )
    .bind(ticker, asOf, limit)
    .all();

  return results;
}

/**
 * One row per (ticker, tag, fiscalYear, fiscalPeriod, form) -- a restated
 * figure (10-K/A) for a period already covered by an earlier filing is a
 * NEW row, not an overwrite. See migrations/0005_fundamental_facts.sql's
 * header for why: this is what lets getFundamentalFactsAsOf reconstruct the
 * value that was actually known at a given point in time, restatements
 * included, instead of only ever storing today's (possibly since-corrected)
 * figure.
 */
export async function insertFundamentalFact(db, fact) {
  await db
    .prepare(
      `INSERT INTO fundamental_facts (ticker, cik, tag, val, unit, fiscal_year, fiscal_period, form, filed_at, source, ingested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ticker, tag, fiscal_year, fiscal_period, form) DO UPDATE SET
         val = excluded.val, unit = excluded.unit, filed_at = excluded.filed_at,
         source = excluded.source, ingested_at = excluded.ingested_at`
    )
    .bind(
      fact.ticker, fact.cik, fact.tag, fact.val, fact.unit,
      fact.fiscalYear, fact.fiscalPeriod, fact.form, fact.filedAt, fact.source, new Date().toISOString()
    )
    .run();
}

/**
 * Point-in-time read (plan.md Backtesting Integrity, point 3): for
 * `ticker`/`tag`, the latest-filed-as-of-`asOf` fact PER FISCAL PERIOD --
 * i.e. whatever value an analyst reading at `asOf` would actually have
 * seen, restatements included up to that point but never a later one. Same
 * required-asOf, no-"give me everything" convention as
 * getPriceBarsAsOf/getNewsAsOf. Ordered most-recent-fiscal-period first.
 *
 * HONEST LIMITATION (see plan.md + edgar_fundamentals.js): this reflects
 * whatever this table has actually been populated with. EDGAR only covers
 * US-listed XBRL filers, and this project's ticker->CIK map is currently a
 * small hand-maintained list (same convention as
 * ingestion/entity_resolution.js's domain map) -- a ticker with no rows
 * here is NOT evidence the company has no fundamentals, only that we
 * haven't ingested them.
 */
export async function getFundamentalFactsAsOf(db, { ticker, tag, asOf, limit = 20 }) {
  if (!asOf) {
    throw new LookaheadViolationError("getFundamentalFactsAsOf requires an explicit asOf timestamp");
  }

  const { results } = await db
    .prepare(
      `SELECT ticker, cik, tag, val, unit, fiscal_year, fiscal_period, form, filed_at, source
       FROM (
         SELECT *, ROW_NUMBER() OVER (
           PARTITION BY fiscal_year, fiscal_period ORDER BY filed_at DESC
         ) AS rn
         FROM fundamental_facts
         WHERE ticker = ? AND tag = ? AND filed_at <= ?
       )
       WHERE rn = 1
       ORDER BY fiscal_year DESC, fiscal_period DESC
       LIMIT ?`
    )
    .bind(ticker, tag, asOf, limit)
    .all();

  return results;
}

/**
 * Persists a completed pipeline run's full decision chain --
 * TradeThesis + RiskDecision + PortfolioDecision -- as one row in
 * trade_decisions (migrations/0001_init.sql, extended by
 * migrations/0007_trade_decisions_portfolio.sql for the portfolio_decision
 * column). Previously nothing wrote to this table at all: the only
 * persisted record of a decision was graph/checkpointer.js's opaque JSON
 * blob in pipeline_checkpoints, keyed by (run_id, ticker), not queryable by
 * ticker/time the way this table is (see idx_decisions_ticker_as_of).
 *
 * `id` should be the trade thesis id (ticker|asOf, same value used as
 * positions.id in openPosition) so this is idempotent across a
 * checkpoint-resumed re-run of the final stage -- ON CONFLICT DO NOTHING,
 * same convention as insertNewsItem/openPosition.
 *
 * `debateId` is nullable and, as of this function's own introduction,
 * ALWAYS null in practice -- the `debates` table (migrations/0001_init.sql)
 * has no write path either, same previously-undiscovered gap as this
 * table had. Not fixed here (out of scope for wiring up decisions
 * specifically); flagged in plan.md.
 */
export async function insertTradeDecision(db, { id, ticker, asOf, debateId = null, thesis, riskDecision, portfolioDecision, status, createdAt }) {
  await db
    .prepare(
      `INSERT INTO trade_decisions (id, ticker, as_of, debate_id, thesis, risk_decision, portfolio_decision, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    )
    .bind(id, ticker, asOf, debateId, JSON.stringify(thesis), JSON.stringify(riskDecision), JSON.stringify(portfolioDecision), status, createdAt)
    .run();
}

// ---------------------------------------------------------------------
// Dashboard-only reads below. See this section's own header note above
// insertTradeDecision: these are unrestricted "give me the current state"
// queries for a live human-facing dashboard (src/dashboard.js), not agent
// inputs -- the required-asOf convention on every read above this point
// exists specifically to prevent an AGENT from seeing future data during a
// simulated backtest, which has no bearing on a dashboard showing what's
// actually true right now. Do not reuse these for anything that feeds an
// agent prompt.
// ---------------------------------------------------------------------

/** Most recent trade_decisions rows, newest first. Dashboard-only, see section header. */
export async function getRecentTradeDecisions(db, { limit = 20 } = {}) {
  const { results } = await db
    .prepare(`SELECT id, ticker, as_of, debate_id, thesis, risk_decision, portfolio_decision, status, created_at FROM trade_decisions ORDER BY created_at DESC LIMIT ?`)
    .bind(limit)
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
  }));
}

/** Every position currently open (closed_at IS NULL), newest first. Dashboard-only, see section header. */
export async function getAllOpenPositions(db, { limit = 50 } = {}) {
  const { results } = await db
    .prepare(
      `SELECT id, ticker, trade_thesis_id, position_size_pct, direction, entry_price, stop_loss_pct, take_profit_pct, opened_at
       FROM positions WHERE closed_at IS NULL ORDER BY opened_at DESC LIMIT ?`
    )
    .bind(limit)
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
 * Most recently closed positions. Dashboard-only, see section header.
 * HONEST GAP (surfaced while building this, not fixed here): closePosition
 * never records an exit price, only closed_at/close_reason -- so realized
 * P&L cannot actually be computed from this table today, only direction/
 * entry price/close reason/timing. Flagged in plan.md rather than silently
 * shown as if a return figure existed.
 */
export async function getRecentlyClosedPositions(db, { limit = 20 } = {}) {
  const { results } = await db
    .prepare(
      `SELECT id, ticker, trade_thesis_id, position_size_pct, direction, entry_price, opened_at, closed_at, close_reason
       FROM positions WHERE closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT ?`
    )
    .bind(limit)
    .all();

  return results.map((r) => ({
    id: r.id,
    ticker: r.ticker,
    tradeThesisId: r.trade_thesis_id,
    positionSizePct: r.position_size_pct,
    direction: r.direction,
    entryPrice: r.entry_price,
    openedAt: r.opened_at,
    closedAt: r.closed_at,
    closeReason: r.close_reason,
  }));
}

/**
 * Most recently updated pipeline_checkpoints rows, across every
 * (run_id, ticker). Dashboard-only, see section header. This is a proxy
 * for "recent pipeline activity", not a strict health signal -- a
 * genuinely stuck/crashed run just stops appearing here rather than
 * showing an explicit failure state, since checkpointer.js has no
 * separate "failed" status, only whichever stage last completed.
 */
export async function getRecentCheckpoints(db, { limit = 30 } = {}) {
  const { results } = await db
    .prepare(`SELECT run_id, ticker, stage, updated_at FROM pipeline_checkpoints ORDER BY updated_at DESC LIMIT ?`)
    .bind(limit)
    .all();

  return results;
}

/**
 * Last-ingested timestamp + row count per ingestion table (news_items,
 * price_bars, fundamental_facts). Dashboard-only, see section header. This
 * is the closest thing to "ingestion health" this project can show today --
 * there is no persisted per-source vendor-error log (graph/pipeline.js's
 * per-source failure isolation only console.error()s, which isn't
 * queryable from D1); a stale lastIngestedAt is the only real signal
 * available without adding that logging table (flagged in plan.md as a
 * future gap, not built here).
 */
export async function getIngestionHealth(db) {
  const [news, bars, facts] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS count, MAX(ingested_at) AS last FROM news_items`).first(),
    db.prepare(`SELECT COUNT(*) AS count, MAX(ingested_at) AS last FROM price_bars`).first(),
    db.prepare(`SELECT COUNT(*) AS count, MAX(ingested_at) AS last FROM fundamental_facts`).first(),
  ]);

  return {
    news: { count: news?.count ?? 0, lastIngestedAt: news?.last ?? null },
    priceBars: { count: bars?.count ?? 0, lastIngestedAt: bars?.last ?? null },
    fundamentals: { count: facts?.count ?? 0, lastIngestedAt: facts?.last ?? null },
  };
}
