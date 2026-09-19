// LEGACY old-DB (`DB` binding, migrations/0001-0012) access layer -- what is
// left after M3 is ONLY the dashboard's unrestricted "current state" reads.
// Everything the engine uses moved out:
//   - agent inputs (news/prices/fundamentals): storage/inputs_view.js
//   - state tables (positions, decisions, memory, checkpoints):
//     storage/run_store.js (RunStore), run_id-scoped
//   - the backtest_runs registry (M3): storage/sim_registry.js, on SIM_DB
// The old scope-less state readers/writers that used to live here were deleted,
// not adapted (plan.md "Design: environments"). This file goes away with the
// old binding in M5; the dashboard reads below move to the environment-aware
// views in M4.

// ---------------------------------------------------------------------
// Dashboard-only reads below. These are unrestricted "give me the current
// state" queries for a live human-facing dashboard (src/dashboard.js), not
// agent inputs -- the required-asOf convention on every inputs_view.js/
// RunStore read exists specifically to prevent an AGENT from seeing future data during a
// simulated backtest, which has no bearing on a dashboard showing what's
// actually true right now. Do not reuse these for anything that feeds an
// agent prompt.
// ---------------------------------------------------------------------

/**
 * Most recent trade_decisions rows, newest first. Dashboard-only, see
 * section header. `status`, if given, filters to that exact status
 * (e.g. "approved"/"rejected") -- omitting it preserves the original
 * unfiltered behavior exactly, so the one pre-existing caller (dashboard.js,
 * before this filter existed) is unaffected.
 */
export async function getRecentTradeDecisions(db, { limit = 20, status } = {}) {
  const { results } = status
    ? await db
        .prepare(`SELECT id, ticker, as_of, debate_id, thesis, risk_decision, portfolio_decision, status, created_at, opinions, debate FROM trade_decisions WHERE status = ? ORDER BY created_at DESC LIMIT ?`)
        .bind(status, limit)
        .all()
    : await db
        .prepare(`SELECT id, ticker, as_of, debate_id, thesis, risk_decision, portfolio_decision, status, created_at, opinions, debate FROM trade_decisions ORDER BY created_at DESC LIMIT ?`)
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
    // LLM reasoning chain (migrations/0008_trade_decisions_llm_answers.sql).
    // Nullable: rows written before this migration/change have neither
    // column populated -- dashboard.js renders an honest "not recorded"
    // state for those rather than assuming every row has this data.
    opinions: r.opinions ? JSON.parse(r.opinions) : null,
    debate: r.debate ? JSON.parse(r.debate) : null,
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
 * Total exposure across EVERY open position, not just whatever page of them
 * `getAllOpenPositions` happened to fetch -- previously the dashboard summed
 * the (Rows-limited) `getAllOpenPositions` result client-side, which quietly
 * understated total exposure once the real open-position count exceeded the
 * Rows filter (plan.md Step 1). This is a plain aggregate with no LIMIT and
 * no asOf, same "give me the current state" convention as every other
 * Dashboard-only read in this section -- there is no page size to exceed
 * because there is no row-shaped result, just a sum and a count.
 */
export async function getOpenPositionsExposureTotal(db) {
  const row = await db
    .prepare(`SELECT COALESCE(SUM(position_size_pct), 0) AS total_pct, COUNT(*) AS count FROM positions WHERE closed_at IS NULL`)
    .first();

  return { totalPct: row?.total_pct ?? 0, count: row?.count ?? 0 };
}

/**
 * Most recently closed positions. Dashboard-only, see section header.
 * `exitPrice` (migrations/0009_positions_exit_price.sql) is now recorded
 * by closePosition when computable -- nullable for rows closed before that
 * migration, or for a time_based exit with no price_bars data (same honest
 * gap as entry_price ever being null). This function itself does not
 * compute a realized return; graph/settle.js does that at close time and
 * writes it to decision_memory, not onto this row.
 */
export async function getRecentlyClosedPositions(db, { limit = 20 } = {}) {
  const { results } = await db
    .prepare(
      `SELECT id, ticker, trade_thesis_id, position_size_pct, direction, entry_price, exit_price, opened_at, closed_at, close_reason
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
    exitPrice: r.exit_price,
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

/**
 * Trade-decision counts by status (all-time totals) plus a per-day
 * breakdown for the last `days` days, both by status -- what
 * dashboard.js's new activity chart renders as stacked bars. Dashboard-
 * only, see section header (no asOf gate -- this describes decisions that
 * have ALREADY happened, there's no "future" a live dashboard needs to
 * avoid leaking).
 *
 * `day` buckets on created_at's DATE portion (UTC, since created_at is
 * stored as an ISO string) via SQLite's substr, not strftime, to avoid a
 * dependency on created_at parsing cleanly as a SQLite datetime literal --
 * a plain ISO-8601 string's first 10 characters ARE its UTC date, no
 * parsing needed.
 */
export async function getDecisionStats(db, { days = 14 } = {}) {
  const totalsResult = await db.prepare(`SELECT status, COUNT(*) AS count FROM trade_decisions GROUP BY status`).all();

  const dailyResult = await db
    .prepare(
      `SELECT substr(created_at, 1, 10) AS day, status, COUNT(*) AS count
       FROM trade_decisions
       WHERE created_at >= datetime('now', ?)
       GROUP BY day, status
       ORDER BY day ASC`
    )
    .bind(`-${days} days`)
    .all();

  const totals = totalsResult.results.reduce((acc, r) => {
    acc[r.status] = r.count;
    return acc;
  }, {});

  return { totals, daily: dailyResult.results, days };
}

/**
 * Most recent price bars for `ticker`, oldest-first (chronological, ready
 * to feed straight into a chart x-axis) -- current-state read, not
 * point-in-time, same dashboard-only convention as this section's other
 * reads: a live dashboard chart showing "price right now" has no
 * lookahead concern the way an agent's technical analyst does.
 */
export async function getRecentPriceBars(db, { ticker, limit = 30 }) {
  const { results } = await db
    .prepare(`SELECT date, close FROM price_bars WHERE ticker = ? ORDER BY date DESC LIMIT ?`)
    .bind(ticker, limit)
    .all();

  return results.reverse();
}
