// Analysis pipeline (analysts -> debate -> trader -> risk -> portfolio) for
// ONE ticker mentioned in ONE already-ingested news item. This file's job is
// sequencing and checkpointing, not agent logic -- it should stay a
// relatively thin "call things in order, save progress" layer.
//
// M2: the pipeline runs inside an ENVIRONMENT and is handed its storage as
// `ctx = { inputs, store }` (plan.md "Design: environments"):
//   - `inputs`: an inputs-DB handle for news/price/fundamentals reads
//     (storage/inputs_view.js, asOf-gated). Pass readOnly(env.INPUTS_DB) --
//     this module never writes inputs.
//   - `store`: a RunStore for the environment being run ('live', or a
//     backtest id). Every state read/write -- checkpoints, positions,
//     decisions, memory -- goes through it, so a run can only ever see or
//     touch its own environment's rows.
// (Ingestion, which WRITES inputs, lives in ingestion/ingest.js.)
// Not yet injected: a clock. `createdAt` below still reads the real time;
// the SimClock rewrite in M3 replaces it.
//
// NAMING: `pipelineRunId` is the per-(news item, ticker) pipeline execution
// (what the old code called `runId`); the environment id is `store.runId`.
// The ANALYZE queue message's wire field is still `runId` so in-flight
// messages keep working -- llm-worker.js maps it to `pipelineRunId`.

import { getPriceBarsAsOf } from "../storage/inputs_view.js";
import { runNewsEventAnalyst } from "../agents/analysts/newsEventAnalyst.js";
import { runSentimentAnalyst } from "../agents/analysts/sentimentAnalyst.js";
import { runTechnicalAnalyst } from "../agents/analysts/technicalAnalyst.js";
import { runBullResearcher } from "../agents/researchers/bull.js";
import { runBearResearcher } from "../agents/researchers/bear.js";
import { runResearchManager } from "../agents/managers/research_manager.js";
import { runTrader } from "../agents/trader/trader.js";
import { evaluateRisk } from "../agents/risk_mgmt/risk.js";
import { evaluatePortfolio } from "../agents/managers/portfolio_manager.js";
import { checkpoint, resumeFrom } from "./checkpointer.js";
import { shouldContinueDebate } from "./conditional_logic.js";
import { loadLessonsForDebate } from "./reflection.js";
import { settlePositionOutcome } from "./settle.js";
import { TRADE_DECISION_STATUS } from "../shared/constants.js";
import { withLlmLogContext } from "../storage/llm_calls.js";

/**
 * Runs the full analyst -> debate -> trade -> risk -> portfolio pipeline for
 * ONE ticker mentioned in ONE already-ingested, already-normalized news
 * item. Checkpoints after every stage so a crashed/interrupted run resumes
 * from the next stage instead of re-spending LLM calls (Adopted Pattern #12).
 *
 * `pipelineRunId` should be stable for a given ingestion batch (e.g. the
 * news item's id) so resume can find the right checkpoint row.
 */
export async function runPipelineForTicker(env, config, { inputs, store }, { pipelineRunId, ticker, newsItem, asOf }) {
  // Tag every LLM call this run makes (analysts, debate, trader, and the
  // reflection when an old position is replaced below) with its runId/ticker
  // for the dashboard's LLM-call log. `source` is left as whatever the caller
  // set -- the llm Worker marks a backtest run "backtest" (+ its job id) before
  // it gets here -- and only defaults to "pipeline" for the live path. `store`
  // rides along so callStructured's log write lands in this environment's
  // llm_calls (env_run_id = store.runId).
  config = withLlmLogContext(config, { source: config.llmLog?.source ?? "pipeline", runId: pipelineRunId, ticker, store });
  const resume = await resumeFrom(store, { pipelineRunId, ticker });
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
    // priceBars feeds the technical analyst only -- see that agent's own
    // header for why an empty result (yfinance not wired into this
    // pipeline yet, a separate known gap) makes it return null rather than
    // asking the LLM to analyze nothing.
    const priceBars = await getPriceBarsAsOf(inputs, { ticker, asOf });
    const [newsOpinion, sentimentOpinion, technicalOpinion] = await Promise.all([
      runNewsEventAnalyst(env, config, newsItem),
      runSentimentAnalyst(env, config, newsItem),
      runTechnicalAnalyst(env, config, { ticker, newsItem, bars: priceBars }),
    ]);
    state.opinions = [newsOpinion, sentimentOpinion, technicalOpinion].filter(Boolean);
    await checkpoint(store, { pipelineRunId, ticker, stage: "analyzed", state });
    stage = "debated"; // next-needed after "analyzed" is written, per resumeFrom's own convention
  }

  if (stage === "debated") {
    const priorLessons = await loadLessonsForDebate(store, { ticker, asOf });
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
    await checkpoint(store, { pipelineRunId, ticker, stage: "debated", state });
    stage = "traded"; // next-needed after "debated" is written
  }

  if (stage === "traded") {
    state.thesis = await runTrader(env, config, state.verdict);
    await checkpoint(store, { pipelineRunId, ticker, stage: "traded", state });
    stage = "risk_checked"; // next-needed after "traded" is written
  }

  if (stage === "risk_checked") {
    state.riskDecision = evaluateRisk(state.thesis, state.verdict);
    await checkpoint(store, { pipelineRunId, ticker, stage: "risk_checked", state });
    stage = "portfolio_checked"; // next-needed after "risk_checked" is written
  }

  if (stage === "portfolio_checked") {
    // NETTING: find this ticker's own existing open position (if any) BEFORE
    // computing the portfolio-wide risk sum, then exclude the ticker via
    // `excludeTicker` -- openPositionsRiskPct below is therefore "every OTHER
    // ticker's exposure", never double-counting this ticker against itself
    // (RunStore#commitThesis re-checks the same ceiling in SQL, against the
    // same other-tickers sum; the SQL is authoritative if the two ever
    // disagree because another run committed in between). `existingPosition`
    // only feeds the human-readable reason: on a queue-retried re-run it is
    // this thesis's OWN already-opened position, which is not a replacement.
    const tradeThesisId = state.riskDecision.tradeThesisId;
    const existingPosition = await store.getOpenPositionForTickerAsOf({ ticker, asOf });
    const openPositionsRiskPct = await store.getOpenPositionsRiskPctAsOf({ asOf, excludeTicker: ticker });
    state.portfolioDecision = evaluatePortfolio(state.riskDecision, {
      openPositionsRiskPct,
      isReplacingPosition: existingPosition !== null && existingPosition.id !== tradeThesisId,
    });

    // The persisted decision row: the full chain as a real, queryable row
    // (state.opinions = the Analyst Team's per-article output, technical
    // possibly absent; state.verdict = the Research Manager's DebateVerdict
    // with bull/bear nested). id = tradeThesisId, the same value as the
    // position's id, so every write below is idempotent across a
    // checkpoint-resumed / queue-retried re-run of this stage.
    const decision = {
      id: tradeThesisId,
      ticker,
      asOf,
      thesis: state.thesis,
      riskDecision: state.riskDecision,
      portfolioDecision: state.portfolioDecision,
      createdAt: new Date().toISOString(),
      opinions: state.opinions,
      debate: state.verdict,
    };

    if (!state.portfolioDecision.approvedForExecution) {
      // risk_mgmt / portfolio_manager itself said no: nothing to execute.
      await store.insertTradeDecision({ ...decision, status: TRADE_DECISION_STATUS.REJECTED });
    } else {
      // Fetched ONCE -- it's both the exitPrice for a replaced existing
      // position and the entryPrice for the new one below, since both
      // happen at the same ticker/asOf.
      const priceBars = await getPriceBarsAsOf(inputs, { ticker, asOf, limit: 1 });
      const currentPrice = priceBars[0]?.close ?? null;

      if (currentPrice == null) {
        // HONEST SCOPE: no price_bars data for this ticker as of `asOf`
        // (yfinance ingestion gap -- see plan.md). Opening a position with
        // entryPrice: null would permanently block stop-loss/take-profit
        // (agents/risk_mgmt/exit.js#evaluateExit requires both entryPrice
        // AND currentPrice) and, if it later closed via the time_based
        // exit, would produce an unrecoverable null realized return
        // (graph/settle.js#computeRealizedReturn never fabricates a
        // number) -- a PnL-blind position that can never be measured,
        // closed or open. Same problem applies to replacing an existing
        // position: closing it with exitPrice: null loses ITS realized
        // PnL immediately rather than eventually. So: skip both the
        // replace-close and the open entirely rather than accept either
        // outcome. The approval is still recorded ('skipped_no_price_data',
        // distinct from 'rejected') so this is visible on the dashboard as
        // a real thesis blocked by a data gap, not a risk rejection. A
        // later news item for this ticker (fresh asOf/tradeThesisId) gets
        // a fresh chance once price_bars has data.
        console.error("pipeline: skipping position open/replace -- no price_bars data for ticker", { ticker, asOf });
        await store.insertTradeDecision({ ...decision, status: TRADE_DECISION_STATUS.SKIPPED_NO_PRICE_DATA });
      } else {
        // ONE atomic batch (plan.md "Atomic portfolio commit"): close this
        // ticker's older open position as 'replaced' (recording
        // currentPrice as its exit), open the new one, and write the
        // decision row with its outcome -- opened / rejected (SQL ceiling)
        // / superseded (a newer position already exists) -- all guarded by
        // the same predicate. Replaces the old read-then-close-then-open
        // sequence that let overlapping open positions happen.
        await store.commitThesis({
          ...decision,
          tradeThesisId,
          positionSizePct: state.portfolioDecision.finalPositionSizePct,
          direction: state.thesis.direction,
          entryPrice: currentPrice,
          stopLossPct: state.riskDecision.stopLossPct ?? null,
          takeProfitPct: state.riskDecision.takeProfitPct ?? null,
          exitPrice: currentPrice,
        });

        // Settle whatever the batch replaced (realized return + reflection).
        // Found by querying rather than by remembering `existingPosition`, so
        // a retry after a crash between the batch and this step still
        // settles it -- see getUnsettledReplacedPositions.
        for (const replaced of await store.getUnsettledReplacedPositions({ ticker, closedAt: asOf })) {
          await settlePositionOutcome(env, config, store, { position: replaced, exitPrice: replaced.exitPrice, closedAt: asOf, closeReason: "replaced" });
        }
      }
    }

    await checkpoint(store, { pipelineRunId, ticker, stage: "portfolio_checked", state });
  }

  return state.portfolioDecision;
}
