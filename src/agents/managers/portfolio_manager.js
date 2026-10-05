// Final sign-off step (plan.md Adopted Pattern #3, restructured under
// agents/managers/ alongside research_manager.js). risk_mgmt/risk.js decides
// per-thesis sizing in isolation; this decides whether to actually execute
// given account-level state -- other open positions, correlation exposure,
// total portfolio risk budget. Deliberately NOT an LLM call, same reasoning
// as risk.js: this is the layer that has to be trustworthy and reproducible.
//
// UPDATE: a real positions store now exists (storage/run_store.js: RunStore
// #openPosition/closePosition/getOpenPositionsRiskPctAsOf, run_id-scoped),
// and graph/pipeline.js passes a real point-in-time openPositionsRiskPct
// instead of a hardcoded 0. The ceiling itself lives in
// shared/constants.js (M2): RunStore#commitThesis enforces the SAME value in
// SQL, so the two can never drift apart.
//
// NETTING (previously a known gap, now closed): re-evaluating a thesis for
// a ticker that already has an open position no longer double-counts that
// ticker's exposure. graph/pipeline.js's risk_checked stage now calls
// store.getOpenPositionsRiskPctAsOf with `excludeTicker` set to the current
// ticker, so `openPositionsRiskPct` below already reflects every OTHER
// ticker's exposure only -- this function doesn't need to know about the
// current ticker's own old position at all for the MATH to be correct.
// `isReplacingPosition` is accepted purely so the `reason` string is
// honest about what happened (pipeline.js also closes the old position,
// with close_reason 'replaced', before opening the new one when this is
// true -- see that file for the actual replace logic).
//
// Two things are still placeholders, though: (1) MAX_PORTFOLIO_RISK_PCT
// (shared/constants.js) is not tuned against anything real yet, and (2) the
// concentration cap below is a static ticker->group map, not a computed correlation.
//
// CONCENTRATION CAP: when the caller passes `ticker`, `direction` and `openPositions`
// (RunStore#getOpenPositionsRiskAsOf's `positions`, other tickers only), the sum of open
// SAME-DIRECTION sizes in this ticker's group (shared/constants.js TICKER_GROUPS) plus this
// thesis may not exceed MAX_GROUP_EXPOSURE_PCT. Opposite-direction positions do not count
// (they offset); a position with no stored direction counts (it cannot be netted). Omitting
// any of the three skips the check. RunStore#commitThesis re-checks the same cap in SQL
// (same-group peers, same direction rule, same as-of bound, this ticker excluded), so two runs
// racing cannot both let an entry through; the SQL is authoritative over this pre-check.
//
// DRAWDOWN CIRCUIT BREAKER: when the caller passes `realizedPnlPct` (trailing-
// window realized book P&L, RunStore#getRealizedPnlPctAsOf) and a positive
// `drawdownBreakerPct`, a P&L at or below -drawdownBreakerPct rejects the thesis
// (no new entries). Exits are untouched, so open positions still stop out; a
// would-be flip is blocked too, leaving the open position to its own stops.
// HONEST SCOPE: the P&L the caller passes is realized closes in the window plus open
// positions marked at their last exit-check close (RunStore#getRealizedPnlPctAsOf with
// includeUnrealized; a never-marked position counts as flat), so its freshness is the exit
// check's (15 min live, once per simulated day in a backtest). RunStore#commitThesis re-checks it in
// SQL (same window, same marks, same net-of-cost definition, same `<= -drawdownBreakerPct` trip), so a
// close or mark landing between this pre-check and the commit still blocks the entry; the SQL is
// authoritative over this pre-check. Omitting either option skips the check here; the SQL check runs only
// when the committer passes drawdownBreakerPct + drawdownBreakerWindowDays (entry_fill.js does not: its
// breaker was decided at signal time).

import { PortfolioDecision } from "../../schemas/index.js";
import { FALLBACK_STOP_LOSS_PCT, GROUP_CAP_EPSILON, MAX_PORTFOLIO_RISK_PCT, MAX_PORTFOLIO_STOP_RISK_PCT, groupCapOf, groupOfTicker } from "../../shared/constants.js"; // placeholder values: no real cross-position exposure data yet

export function evaluatePortfolio(
  riskDecision,
  {
    openPositionsRiskPct = 0,
    openPositionsStopRiskPct = 0,
    isReplacingPosition = false,
    realizedPnlPct = null,
    drawdownBreakerPct = 0,
    ticker = null,
    direction = null,
    openPositions = null,
  } = {}
) {
  if (!riskDecision.approved) {
    return PortfolioDecision.parse({
      tradeThesisId: riskDecision.tradeThesisId,
      approvedForExecution: false,
      finalPositionSizePct: 0,
      reason: "risk_mgmt did not approve this thesis; portfolio_manager has nothing to sign off on",
    });
  }

  const breakerTripped = drawdownBreakerPct > 0 && realizedPnlPct != null && realizedPnlPct <= -drawdownBreakerPct;
  if (breakerTripped) {
    return PortfolioDecision.parse({
      tradeThesisId: riskDecision.tradeThesisId,
      approvedForExecution: false,
      finalPositionSizePct: 0,
      reason: `drawdown circuit breaker: trailing realized P&L ${realizedPnlPct} <= -${drawdownBreakerPct} of the book -- no new entries until it recovers or the window rolls`,
    });
  }

  const wouldBeTotalRiskPct = openPositionsRiskPct + riskDecision.positionSizePct;
  const exposureOk = wouldBeTotalRiskPct <= MAX_PORTFOLIO_RISK_PCT;
  // Loss-at-stop: what the book loses if every open position (other tickers) plus this one hit their stops.
  // `openPositionsStopRiskPct` defaults to 0, so a caller that does not pass it keeps the exposure-only check.
  const newStopRiskPct = riskDecision.positionSizePct * (riskDecision.stopLossPct ?? FALLBACK_STOP_LOSS_PCT);
  const wouldBeStopRiskPct = openPositionsStopRiskPct + newStopRiskPct;
  const stopRiskOk = wouldBeStopRiskPct <= MAX_PORTFOLIO_STOP_RISK_PCT;
  // Concentration: same-direction exposure already open in this ticker's group (callers exclude this ticker's own position).
  let groupExposurePct = 0;
  let groupOk = true;
  const groupId = ticker ? groupOfTicker(ticker) : null;
  const checkGroup = groupId !== null && (direction === "long" || direction === "short") && Array.isArray(openPositions);
  if (checkGroup) {
    for (const p of openPositions) {
      if (p.ticker === ticker || groupOfTicker(p.ticker) !== groupId) continue;
      if (p.direction && p.direction !== direction) continue;
      groupExposurePct += p.positionSizePct;
    }
    groupOk = groupExposurePct + riskDecision.positionSizePct <= groupCapOf(groupId) + GROUP_CAP_EPSILON;
  }
  const approvedForExecution = exposureOk && stopRiskOk && groupOk;
  const netNote = isReplacingPosition
    ? " (openPositionsRiskPct already excludes this ticker's existing position, which is being replaced)"
    : "";

  let reason;
  if (approvedForExecution) {
    reason = `combined portfolio risk ${wouldBeTotalRiskPct} <= ceiling ${MAX_PORTFOLIO_RISK_PCT}${netNote}`;
  } else if (!exposureOk) {
    reason = `combined portfolio risk ${wouldBeTotalRiskPct} would exceed ceiling ${MAX_PORTFOLIO_RISK_PCT}${netNote} -- rejected`;
  } else if (!stopRiskOk) {
    reason = `combined loss-at-stop ${wouldBeStopRiskPct} would exceed ceiling ${MAX_PORTFOLIO_STOP_RISK_PCT}${netNote} -- rejected`;
  } else {
    reason = `concentration: open ${direction} exposure in group "${groupId}" ${groupExposurePct} + this thesis ${riskDecision.positionSizePct} would exceed the group cap ${groupCapOf(groupId)} -- rejected`;
  }

  return PortfolioDecision.parse({
    tradeThesisId: riskDecision.tradeThesisId,
    approvedForExecution,
    finalPositionSizePct: approvedForExecution ? riskDecision.positionSizePct : 0,
    reason,
  });
}
