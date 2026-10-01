// Fill step for 'pending_entry' decisions (next-session-open fill, PR 3).
//
// The pipeline stores an approved thesis whose entry price is stale as a trade decision with status
// 'pending_entry' and NO position (graph/pipeline.js, shared/entry_timing.js). This step runs where
// time advances -- the live exit cron (*/15) and the backtest daily walk -- and, for every pending
// decision visible at `asOf`:
//   - finds the first bar that OPENS at/after the decision's asOf and has closed by `asOf`
//     (shared/entry_timing.js#findFillBar; intraday bars first, a UTC day with none falls back to
//     its daily bar, same merge as the exit walk);
//   - opens the position through RunStore#commitThesis at that bar's open, with asOf = the bar's open
//     instant. The stop/target PERCENTAGES stored in the risk decision therefore apply to the fill
//     price (computed at fill time, so an overnight gap does not skew them). commitThesis re-runs the
//     same SQL guards as a normal open -- newer-position guard, hold/flip rule, portfolio risk ceiling
//     against what is open AT the fill instant -- and upgrades the pending decision row in place to
//     opened / held / rejected / superseded;
//   - settles whatever the commit replaced or flipped, like the pipeline does;
//   - expires a decision no bar filled by its fill_expires_at as 'skipped_no_fill'.
// Idempotent: commitThesis only upgrades a row that is still 'pending_entry', and ids are the
// tradeThesisId, so a re-run after a crash (before or after settle) is a no-op or finishes the settle.
//
// HONEST SCOPE: the drawdown-breaker / sizing in portfolioDecision was decided at signal time and is
// not re-evaluated at fill; only the SQL risk ceiling is re-checked.

import { findFirstBarOpenAtOrAfter } from "./bar_fill.js";
import { isPendingEntryExpired } from "../shared/entry_timing.js";
import { DEFAULT_FLIP_MIN_CONFIDENCE } from "../shared/constants.js";
import { recordExcursionBeforeClose } from "./exit_check.js";
import { settlePositionOutcome } from "./settle.js";
import { withLlmLogContext } from "../storage/llm_calls.js";

function findFillForPending(inputs, pending, { asOf }) {
  // Window rule lives in bar_fill.js (shared with the read-only replay): the decision's asOf is the anchor.
  return findFirstBarOpenAtOrAfter(inputs, { ticker: pending.ticker, from: pending.asOf, asOf });
}

/**
 * `ctx` is `{ inputs, store }` (same as checkOpenPositionExits). Processes every pending entry with
 * as_of <= `asOf`. Returns `{ filled, expired, waiting }`: filled = [{ id, ticker, openedAt }] for
 * decisions this call committed (their final status may still be held/rejected/superseded -- read the
 * decision row), expired = [{ id, ticker }], waiting = count still waiting for a bar.
 */
export async function fillPendingEntries(env, config, { inputs, store }, { asOf }) {
  config = withLlmLogContext(config, { store });
  const pendings = await store.listPendingEntriesAsOf({ asOf });
  const filled = [];
  const expired = [];
  let waiting = 0;

  for (const pending of pendings) {
    const fill = await findFillForPending(inputs, pending, { asOf });
    const expiryMs = Date.parse(pending.fillExpiresAt);
    // A bar that opened after the deadline is too late, same as no bar at all.
    const fillInTime = fill != null && !Number.isNaN(expiryMs) && Date.parse(fill.openedAt) < expiryMs;

    if (!fillInTime) {
      if (isPendingEntryExpired(pending.fillExpiresAt, asOf)) {
        if (await store.expirePendingEntry({ id: pending.id })) expired.push({ id: pending.id, ticker: pending.ticker });
      } else {
        waiting += 1;
      }
      continue;
    }

    const { thesis, riskDecision, portfolioDecision, debate } = pending;
    const confidence = debate?.confidence ?? null;
    const tradeThesisId = riskDecision?.tradeThesisId ?? pending.id;

    // MAE/MFE for a position this commit may close as flipped/replaced, before the closing write
    // (same rule and reason as the pipeline's portfolio_checked stage).
    const existing = await store.getOpenPositionForTickerAsOf({ ticker: pending.ticker, asOf: fill.openedAt });
    if (existing && existing.id !== tradeThesisId) {
      const heldByRule =
        existing.direction != null &&
        (existing.direction === thesis.direction || confidence < (config.flipMinConfidence ?? DEFAULT_FLIP_MIN_CONFIDENCE));
      if (!heldByRule) await recordExcursionBeforeClose(config, { inputs, store }, existing, { asOf: fill.openedAt });
    }

    await store.commitThesis({
      id: pending.id,
      ticker: pending.ticker,
      tradeThesisId,
      positionSizePct: portfolioDecision.finalPositionSizePct,
      direction: thesis.direction,
      entryPrice: fill.price,
      entryPriceSource: fill.source,
      entryPriceBarTs: fill.barTs,
      stopLossPct: riskDecision.stopLossPct ?? null,
      takeProfitPct: riskDecision.takeProfitPct ?? null,
      asOf: fill.openedAt,
      exitPrice: fill.price,
      confidence,
      flipMinConfidence: config.flipMinConfidence,
      thesis,
      riskDecision,
      portfolioDecision,
      opinions: pending.opinions,
      debate,
      createdAt: pending.createdAt,
    });
    filled.push({ id: pending.id, ticker: pending.ticker, openedAt: fill.openedAt });

    for (const replaced of await store.getUnsettledReplacedPositions({ ticker: pending.ticker, closedAt: fill.openedAt })) {
      await settlePositionOutcome(env, config, store, { position: replaced, exitPrice: replaced.exitPrice, closedAt: fill.openedAt, closeReason: replaced.closeReason });
    }
  }

  return { filled, expired, waiting };
}
