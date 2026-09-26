// Replay comparison (operator tool): pick one or a few already-ingested news
// items from an old date and see, side by side, what the OLD three-separate-
// analyst-calls path (pre-#132) versus the CURRENT batched runAnalystTeam
// path (#132) would each have decided for the resulting trade -- so #132's
// cost/quality trade-off (see PR #132 and #133's checkpoint notes) can be
// inspected against real historical items instead of only trusted from the
// test suite.
//
// READ-ONLY BY DESIGN: this runs the SAME debate -> trader -> risk ->
// portfolio stages graph/pipeline.js#runPipelineForTicker runs, but with NO
// checkpoint(), NO insertTradeDecision(), NO commitThesis() -- nothing is
// persisted to the decision log or the position book. `store` is only read
// from (open-position lookup, portfolio exposure, prior lessons), so this is
// safe to call repeatedly against the same news item with no side effects.
// The caller (backtest-worker.js's "replay" job) hands it a FRESH, disposable
// RunStore id, never a real backtest's or "live"'s -- both modes below read
// the exact same (empty) state, so the comparison is apples to apples and
// never reflects some other run's actual open positions.

import { getPriceBarsAsOf } from "../storage/inputs_view.js";
import { runAnalystTeam } from "../agents/analysts/analystTeam.js";
import { runNewsEventAnalyst } from "../agents/analysts/newsEventAnalyst.js";
import { runSentimentAnalyst } from "../agents/analysts/sentimentAnalyst.js";
import { runTechnicalAnalyst } from "../agents/analysts/technicalAnalyst.js";
import { runBullResearcher } from "../agents/researchers/bull.js";
import { runBearResearcher } from "../agents/researchers/bear.js";
import { runResearchManager } from "../agents/managers/research_manager.js";
import { runTrader } from "../agents/trader/trader.js";
import { evaluateRisk } from "../agents/risk_mgmt/risk.js";
import { evaluatePortfolio } from "../agents/managers/portfolio_manager.js";
import { shouldContinueDebate } from "../graph/conditional_logic.js";
import { loadLessonsForDebate } from "../graph/reflection.js";
import { withLlmLogContext } from "../storage/llm_calls.js";

/** The pre-#132 shape: 3 separate Gemini calls (Promise.all), same as graph/pipeline.js ran before #132. */
async function runParallelAnalysts(env, config, { ticker, newsItem, bars }) {
  const [newsEvent, sentiment, technical] = await Promise.all([
    runNewsEventAnalyst(env, config, newsItem),
    runSentimentAnalyst(env, config, newsItem),
    runTechnicalAnalyst(env, config, { ticker, newsItem, bars }),
  ]);
  return [newsEvent, sentiment, technical].filter(Boolean);
}

/**
 * Stages 2 onward of graph/pipeline.js#runPipelineForTicker (debate -> trader
 * -> risk -> portfolio) for ONE mode's `opinions` -- everything after the
 * analyst stage, minus checkpointing and minus the final commit/
 * insertTradeDecision branch. `store` is read-only here (see header).
 */
async function runDecisionForOpinions(env, config, { store }, { ticker, asOf, opinions }) {
  const priorLessons = await loadLessonsForDebate(store, { ticker, asOf });
  let verdict;
  let rounds = 0;
  do {
    const [bull, bear] = await Promise.all([
      runBullResearcher(env, config, { ticker, opinions }),
      runBearResearcher(env, config, { ticker, opinions }),
    ]);
    verdict = await runResearchManager(env, config, { ticker, asOf, bull, bear, priorLessons });
    rounds += 1;
  } while (shouldContinueDebate(verdict, rounds, config));

  const thesis = await runTrader(env, config, verdict);
  const riskDecision = evaluateRisk(thesis, verdict);
  const existingPosition = await store.getOpenPositionForTickerAsOf({ ticker, asOf });
  const openPositionsRiskPct = await store.getOpenPositionsRiskPctAsOf({ asOf, excludeTicker: ticker });
  const portfolioDecision = evaluatePortfolio(riskDecision, {
    openPositionsRiskPct,
    isReplacingPosition: existingPosition !== null && existingPosition.id !== riskDecision.tradeThesisId,
  });

  return { opinions, verdict, thesis, riskDecision, portfolioDecision };
}

/** The handful of fields worth comparing at a glance -- the rest of each mode's full result is still returned alongside this. */
function summarize(result) {
  return {
    direction: result.thesis?.direction ?? null,
    confidence: result.verdict?.confidence ?? null,
    approvedForExecution: result.portfolioDecision?.approvedForExecution ?? false,
    positionSizePct: result.portfolioDecision?.finalPositionSizePct ?? null,
    stopLossPct: result.riskDecision?.stopLossPct ?? null,
    takeProfitPct: result.riskDecision?.takeProfitPct ?? null,
  };
}

function diffOf(parallel, batched) {
  const p = summarize(parallel);
  const b = summarize(batched);
  return {
    directionMatch: p.direction === b.direction,
    approvedMatch: p.approvedForExecution === b.approvedForExecution,
    positionSizePctDelta: p.positionSizePct != null && b.positionSizePct != null ? Number((b.positionSizePct - p.positionSizePct).toFixed(4)) : null,
    confidenceDelta: p.confidence != null && b.confidence != null ? Number((b.confidence - p.confidence).toFixed(4)) : null,
  };
}

/**
 * Runs ONE news item x ticker through BOTH analyst modes and returns them
 * side by side plus a diff. `newsItem` = { id, title, body }; `asOf` should
 * be the item's own published_at (or an operator-chosen override) -- same
 * "asOf = this item's own timestamp" convention onSignalRunner.js's per-item
 * walk already uses.
 */
export async function replayNewsItem(env, config, ctx, { ticker, newsItem, asOf }) {
  const { inputs, store } = ctx;
  const bars = await getPriceBarsAsOf(inputs, { ticker, asOf });
  // Tagged distinctly from a real pipeline/backtest run's LLM calls (own
  // runId per news item, own ticker) so this shows up identifiably in the
  // LLM-call log rather than looking like a real decision was made.
  const runConfig = withLlmLogContext(config, { source: "replay", runId: `replay:${newsItem.id}`, ticker, store });

  const [parallelOpinions, batchedOpinions] = await Promise.all([
    runParallelAnalysts(env, runConfig, { ticker, newsItem, bars }),
    runAnalystTeam(env, runConfig, { ticker, newsItem, bars }),
  ]);

  const [parallel, batched] = await Promise.all([
    runDecisionForOpinions(env, runConfig, { store }, { ticker, asOf, opinions: parallelOpinions }),
    runDecisionForOpinions(env, runConfig, { store }, { ticker, asOf, opinions: batchedOpinions }),
  ]);

  return {
    newsItemId: newsItem.id,
    ticker,
    asOf,
    parallel: { ...parallel, summary: summarize(parallel) },
    batched: { ...batched, summary: summarize(batched) },
    diff: diffOf(parallel, batched),
  };
}

/**
 * Runs replayNewsItem for each selected item, IN SEQUENCE (own Gemini-call
 * budget per item, same reasoning as onSignalRunner.js's own per-day loop --
 * a handful of operator-selected items is small enough that sequential is
 * simplest and keeps concurrent-call/rate-limit pressure predictable).
 * `newsItems` rows come from storage/inputs_view.js (getNewsItemsByIds/
 * getNewsItemsInRange): { id, published_at, title, body }.
 */
export async function replayNewsItems(env, config, ctx, { ticker, newsItems, asOf }) {
  const results = [];
  for (const newsItem of newsItems) {
    const itemAsOf = asOf ?? newsItem.publishedAt ?? newsItem.published_at;
    if (!itemAsOf) throw new Error(`replayNewsItems: no asOf given and news item ${newsItem.id} has no published_at`);
    results.push(await replayNewsItem(env, config, ctx, { ticker, newsItem, asOf: itemAsOf }));
  }
  return results;
}
