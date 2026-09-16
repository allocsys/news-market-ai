// Orchestration layer (previously missing entirely -- src/index.js#scheduled
// had only a TODO comment describing this wiring). Wires together every
// stage that already exists as its own agent/module: this file's job is
// sequencing and checkpointing, not agent logic -- it should stay a
// relatively thin "call things in order, save progress" layer.
//
// STATE: runScheduledIngestion below pulls real GDELT articles (see
// ingestion/sources/gdelt.js), one query per config.watchlist ticker.
// runPipelineForTicker itself does not depend on GDELT specifically, only
// on the normalized shape from schemas/index.js -- any future ingestion
// source can feed it the same way. NOT yet exercised against live traffic;
// GDELT DOC API's actual response shape should be spot-checked against a
// real request before trusting this in production (see gdelt.js's own
// header for the known body-text gap).

import { fetchLatest } from "../ingestion/sources/gdelt.js";
import { insertNewsItem, openPosition, getOpenPositionsRiskPctAsOf } from "../storage/d1.js";
import { runNewsEventAnalyst } from "../agents/analysts/newsEventAnalyst.js";
import { runSentimentAnalyst } from "../agents/analysts/sentimentAnalyst.js";
import { runBullResearcher } from "../agents/researchers/bull.js";
import { runBearResearcher } from "../agents/researchers/bear.js";
import { runResearchManager } from "../agents/managers/research_manager.js";
import { runTrader } from "../agents/trader/trader.js";
import { evaluateRisk } from "../agents/risk_mgmt/risk.js";
import { evaluatePortfolio } from "../agents/managers/portfolio_manager.js";
import { checkpoint, resumeFrom } from "./checkpointer.js";
import { shouldContinueDebate } from "./conditional_logic.js";
import { loadLessonsForDebate } from "./reflection.js";
import { VendorError } from "../shared/errors.js";

/**
 * Runs the full analyst -> debate -> trade -> risk -> portfolio pipeline for
 * ONE ticker mentioned in ONE already-ingested, already-normalized news
 * item. Checkpoints after every stage so a crashed/interrupted run resumes
 * from the next stage instead of re-spending LLM calls (Adopted Pattern #12).
 *
 * `runId` should be stable for a given ingestion batch (e.g. the news item's
 * id) so resume can find the right checkpoint row.
 */
export async function runPipelineForTicker(env, config, db, { runId, ticker, newsItem, asOf }) {
  const resume = await resumeFrom(db, { runId, ticker });
  let stage = resume.stage;
  const state = resume.state ?? {};

  // nextStage(lastCompletedStage) is null in TWO cases: a brand-new run
  // (resumeFrom found no checkpoint row at all, so state is also null) and
  // a fully-completed run (every stage's checkpoint exists, so state is
  // populated). Disambiguate on `resume.state` rather than `stage` alone --
  // this is exactly the ambiguity a naive resume implementation misses.
  if (stage === null && resume.state !== null) {
    return state.portfolioDecision;
  }

  if (stage === null || stage === "ingested") {
    const [newsOpinion, sentimentOpinion] = await Promise.all([
      runNewsEventAnalyst(env, config, newsItem),
      runSentimentAnalyst(env, config, newsItem),
    ]);
    state.opinions = [newsOpinion, sentimentOpinion];
    await checkpoint(db, { runId, ticker, stage: "analyzed", state });
    stage = "analyzed";
  }

  if (stage === "analyzed") {
    const priorLessons = await loadLessonsForDebate(db, { ticker, asOf });
    let verdict;
    let rounds = 0;
    do {
      const [bull, bear] = await Promise.all([
        runBullResearcher(env, config, { ticker, opinions: state.opinions }),
        runBearResearcher(env, config, { ticker, opinions: state.opinions }),
      ]);
      verdict = await runResearchManager(env, config, { ticker, asOf, bull, bear, priorLessons });
      rounds += 1;
    } while (shouldContinueDebate(verdict, rounds, config));

    state.verdict = verdict;
    await checkpoint(db, { runId, ticker, stage: "debated", state });
    stage = "debated";
  }

  if (stage === "debated") {
    state.thesis = await runTrader(env, config, state.verdict);
    await checkpoint(db, { runId, ticker, stage: "traded", state });
    stage = "traded";
  }

  if (stage === "traded") {
    state.riskDecision = evaluateRisk(state.thesis, state.verdict);
    await checkpoint(db, { runId, ticker, stage: "risk_checked", state });
    stage = "risk_checked";
  }

  if (stage === "risk_checked") {
    // openPositionsRiskPct now comes from a real point-in-time read (see
    // storage/d1.js#getOpenPositionsRiskPctAsOf) instead of a hardcoded 0 --
    // MAX_PORTFOLIO_RISK_PCT in portfolio_manager.js is still an untuned
    // placeholder ceiling, see that file's header for the known limitation
    // on re-evaluating an already-open ticker.
    const openPositionsRiskPct = await getOpenPositionsRiskPctAsOf(db, { asOf });
    state.portfolioDecision = evaluatePortfolio(state.riskDecision, { openPositionsRiskPct });

    if (state.portfolioDecision.approvedForExecution) {
      // id = tradeThesisId (ticker|asOf) so a checkpoint-resumed re-run of
      // this stage can't double-open the same position (ON CONFLICT DO
      // NOTHING in openPosition).
      await openPosition(db, {
        id: state.riskDecision.tradeThesisId,
        ticker,
        tradeThesisId: state.riskDecision.tradeThesisId,
        positionSizePct: state.portfolioDecision.finalPositionSizePct,
        openedAt: asOf,
      });
    }

    await checkpoint(db, { runId, ticker, stage: "portfolio_checked", state });
  }

  return state.portfolioDecision;
}

/**
 * Entry point for the cron trigger (src/index.js#scheduled). Pulls fresh
 * news, normalizes it (ingestion/normalize.js), and runs the pipeline above
 * per ticker per item. Explicit try/catch per Adopted Pattern #11 (surface
 * vendor failures, never silently skip) -- logs and re-throws rather than
 * swallowing, since a cron-triggered failure needs to be visible in Workers
 * logs, not just dropped.
 */
export async function runScheduledIngestion(env, config, db) {
  let items;
  try {
    items = await fetchLatest(config);
  } catch (err) {
    if (err instanceof VendorError) {
      console.error("ingestion vendor failure", { vendor: err.vendor, transient: err.transient, message: err.message });
    }
    throw err;
  }

  const results = [];
  for (const item of items) {
    await insertNewsItem(db, item); // persist before running agents, so a mid-pipeline crash doesn't lose the raw ingested article
    for (const ticker of item.tickers) {
      results.push(await runPipelineForTicker(env, config, db, { runId: item.id, ticker, newsItem: item, asOf: item.publishedAt }));
    }
  }
  return results;
}
