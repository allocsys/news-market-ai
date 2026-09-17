// Orchestration layer (previously missing entirely -- src/index.js#scheduled
// had only a TODO comment describing this wiring). Wires together every
// stage that already exists as its own agent/module: this file's job is
// sequencing and checkpointing, not agent logic -- it should stay a
// relatively thin "call things in order, save progress" layer.
//
// STATE: runScheduledIngestion below now pulls from every ingestion adapter
// that exists (gdelt, rss, html_scrape for news items; yfinance for price
// bars; edgar_fundamentals for XBRL facts), not just GDELT. NOT yet
// exercised against LIVE vendor traffic -- see each adapter's own header
// for the specific unverified risk (GDELT's empty-body gap, yfinance's
// cookie/crumb gap, etc). This session's change is the WIRING half only
// (calling adapters from here, feeding their output into storage, fully
// covered by mocked-fetch tests in test/ingestion_wiring.test.js); the
// LIVE spot-check half is blocked from this sandbox's network egress
// (confirmed 403/host_not_allowed against api.gdeltproject.org,
// query1.finance.yahoo.com, data.sec.gov) and remains an open item -- see
// plan.md.
//
// FAILURE ISOLATION (Adopted Pattern #11 read literally: "surface a typed
// error and follow an explicit configured fallback order -- never silently
// serve thinner data without logging that a source was skipped"): each
// source below is its own failure domain. A VendorError from any one
// source (news or price/fundamentals) is logged with full vendor/transient
// detail and that source is skipped -- it does NOT abort the others. This
// is a deliberate change from the old GDELT-only behavior (which rethrew
// and killed the entire scheduled run on any GDELT failure); with five
// independent vendors now in play, one flaky/misconfigured source (e.g.
// EDGAR with no edgarUserAgent set) killing every other source's ingestion
// would be a worse failure mode than degrading to fewer items with a clear
// log line. A non-VendorError (an actual bug, not a vendor failure) still
// propagates immediately, same as before.

import { fetchLatest as fetchGdeltLatest, enrichWithFullText as enrichGdeltFullText } from "../ingestion/sources/gdelt.js";
import { fetchLatest as fetchRssLatest } from "../ingestion/sources/rss.js";
import { fetchLatest as fetchScrapeLatest } from "../ingestion/sources/html_scrape.js";
import { fetchDailyBars } from "../ingestion/sources/yfinance.js";
import { fetchLatest as fetchEdgarFactsLatest } from "../ingestion/sources/edgar_fundamentals.js";
import {
  insertNewsItem,
  openPosition,
  getOpenPositionsRiskPctAsOf,
  getPriceBarsAsOf,
  insertPriceBar,
  insertFundamentalFacts,
  insertTradeDecision,
} from "../storage/d1.js";
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
    // priceBars feeds the technical analyst only -- see that agent's own
    // header for why an empty result (yfinance not wired into this
    // pipeline yet, a separate known gap) makes it return null rather than
    // asking the LLM to analyze nothing.
    const priceBars = await getPriceBarsAsOf(db, { ticker, asOf });
    const [newsOpinion, sentimentOpinion, technicalOpinion] = await Promise.all([
      runNewsEventAnalyst(env, config, newsItem),
      runSentimentAnalyst(env, config, newsItem),
      runTechnicalAnalyst(env, config, { ticker, newsItem, bars: priceBars }),
    ]);
    state.opinions = [newsOpinion, sentimentOpinion, technicalOpinion].filter(Boolean);
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
      // entryPrice comes from the most recent price_bars row at/before asOf
      // -- may be null (yfinance ingestion isn't wired into this pipeline
      // yet, a separate known gap), in which case the position still opens
      // but agents/risk_mgmt/exit.js#evaluateExit can only apply a
      // time-based exit to it later, never stop-loss/take-profit, until
      // real price data exists for this ticker (see migrations/0006's
      // header for the same honest-null convention).
      const priceBars = await getPriceBarsAsOf(db, { ticker, asOf, limit: 1 });
      const entryPrice = priceBars[0]?.close ?? null;

      // id = tradeThesisId (ticker|asOf) so a checkpoint-resumed re-run of
      // this stage can't double-open the same position (ON CONFLICT DO
      // NOTHING in openPosition).
      await openPosition(db, {
        id: state.riskDecision.tradeThesisId,
        ticker,
        tradeThesisId: state.riskDecision.tradeThesisId,
        positionSizePct: state.portfolioDecision.finalPositionSizePct,
        direction: state.thesis.direction,
        entryPrice,
        stopLossPct: state.riskDecision.stopLossPct ?? null,
        takeProfitPct: state.riskDecision.takeProfitPct ?? null,
        openedAt: asOf,
      });
    }

    // Persist the full decision chain as a real, queryable row -- see
    // storage/d1.js#insertTradeDecision's header for why this previously
    // didn't happen at all (only the opaque pipeline_checkpoints blob did).
    // id = tradeThesisId, same value as the position's own id above, so
    // this is idempotent across a checkpoint-resumed re-run of this stage.
    await insertTradeDecision(db, {
      id: state.riskDecision.tradeThesisId,
      ticker,
      asOf,
      thesis: state.thesis,
      riskDecision: state.riskDecision,
      portfolioDecision: state.portfolioDecision,
      status: state.portfolioDecision.approvedForExecution ? "approved" : "rejected",
      createdAt: new Date().toISOString(),
    });

    await checkpoint(db, { runId, ticker, stage: "portfolio_checked", state });
  }

  return state.portfolioDecision;
}

/** Logs a VendorError with full vendor/transient detail, one line per skipped source (see header's Failure Isolation note). Non-VendorErrors are not this function's job -- callers still let those propagate. */
function logSkippedSource(stage, source, err) {
  console.error(`${stage} vendor failure -- skipping source`, { source, vendor: err.vendor, transient: err.transient, message: err.message });
}

/**
 * Collects normalized news items from every news source (gdelt, rss,
 * html_scrape). Each source is attempted independently -- a VendorError
 * from one is logged and that source's items are simply absent from the
 * result, rather than aborting the others (see header's Failure Isolation
 * note). html_scrape's fetchLatest already isolates failures per-page
 * internally and returns `{items, errors}` rather than throwing, so its
 * per-page errors are logged here too, for the same "never silently skip"
 * reason, even though they don't hit the try/catch below.
 */
export async function collectNewsItems(config) {
  const items = [];

  const sources = [
    {
      name: "gdelt",
      // UPDATE (2026-09-17): full-text enrichment (gdelt.js#enrichWithFullText)
      // now runs by default after the metadata fetch -- gated on
      // config.gdeltFetchFullText (default true, see config.js) so it can
      // still be disabled. Per-article enrichment failures are logged here,
      // same "never silently skip" reasoning as the scrape source below --
      // an item that fails enrichment is NOT dropped, it just stays
      // metadata-only (see enrichWithFullText's own header).
      run: async () => {
        const { items: gdeltItems, errors: gdeltErrors } = await fetchGdeltLatest(config);
        for (const { error } of gdeltErrors) {
          logSkippedSource("news ingestion", "gdelt", error);
        }
        if (config.gdeltFetchFullText === false || gdeltItems.length === 0) return gdeltItems;
        const { items: enriched, errors } = await enrichGdeltFullText(config, gdeltItems);
        for (const { url, error } of errors) {
          console.error("gdelt full-text fetch failed -- keeping metadata-only item", { url, message: error.message });
        }
        return enriched;
      },
    },
    { name: "rss", run: () => fetchRssLatest(config) },
    {
      name: "scrape",
      run: async () => {
        const { items: scraped, errors } = await fetchScrapeLatest(config);
        for (const { url, error } of errors) {
          console.error("scrape vendor failure -- skipping page", { url, message: error.message });
        }
        return scraped;
      },
    },
  ];

  for (const { name, run } of sources) {
    try {
      items.push(...(await run()));
    } catch (err) {
      if (err instanceof VendorError) {
        logSkippedSource("news ingestion", name, err);
      } else {
        throw err;
      }
    }
  }

  return items;
}

/**
 * Fetches fresh daily price bars (yfinance) and upserts every bar via
 * storage/d1.js#insertPriceBar. This is what makes the technical analyst
 * (agents/analysts/technicalAnalyst.js) actually have data to work with
 * instead of permanently self-skipping on an empty price_bars table -- see
 * that agent's header for the hasData gate this feeds. A VendorError here
 * (including yfinance's documented cookie/crumb risk, see that adapter's
 * header) is logged and swallowed -- price data is a strict enhancement to
 * the pipeline, not a hard dependency (runPipelineForTicker already
 * tolerates an empty getPriceBarsAsOf result), so one bad yfinance request
 * should not block news ingestion or the pipeline run.
 */
export async function ingestPriceBars(config, db) {
  const { bars, errors } = await fetchDailyBars(config);
  for (const { error } of errors) {
    logSkippedSource("price bar ingestion", "yfinance", error);
  }

  for (const bar of bars) {
    await insertPriceBar(db, bar);
  }
  return { count: bars.length };
}

/**
 * Fetches fresh EDGAR XBRL facts for the resolved ticker list (edgarCikMap
 * if non-empty, else config.watchlist -- see
 * edgar_fundamentals.js#fetchLatest) and upserts them via
 * storage/d1.js#insertFundamentalFact. A no-op (returns `{count: 0}`
 * without ever calling fetch) when BOTH edgarCikMap and watchlist are
 * empty -- config.js ships no default map or User-Agent on purpose (see
 * that file's header), so a fully unconfigured deployment should not error
 * here, only a misconfigured one (tickers resolved, User-Agent missing, or
 * a ticker that resolves to no CIK anywhere) should, and even that is
 * caught and logged (or, for a single unresolvable ticker, logged and
 * skipped -- see fetchLatest's own header) rather than aborting the run --
 * same "strict enhancement, not a hard dependency" reasoning as
 * ingestPriceBars. `kv` (optional, typically env.CACHE_KV) is passed
 * through to fetchLatest for resolveCik's live-SEC-lookup cache -- omitting
 * it still works, it just means every lookup misses cache and re-fetches
 * SEC's file live (fails open, see edgar_cik_lookup.js header).
 */
// D1 subrequest budget for the batched insert below. Each db.batch() call
// is ONE Worker subrequest no matter how many facts are in it, but D1
// still bounds a single batch's total statement count/payload size, so
// this stays well under that rather than trying to push everything
// through in one call. 200 is generous headroom under both that D1 limit
// and Cloudflare's own per-invocation subrequest cap for any watchlist
// size this project runs today.
const FUNDAMENTALS_INSERT_CHUNK_SIZE = 200;

export async function ingestFundamentals(config, db, kv) {
  let facts;
  try {
    facts = await fetchEdgarFactsLatest(config, {}, { kv });
  } catch (err) {
    if (err instanceof VendorError) {
      logSkippedSource("fundamentals ingestion", "edgar", err);
      return { count: 0 };
    }
    throw err;
  }

  // UPDATE (2026-09-17): batched via insertFundamentalFacts instead of one
  // insertFundamentalFact call per fact. The old per-fact loop meant one D1
  // subrequest per row -- EDGAR's full companyfacts history for a single
  // mature ticker/tag easily runs into the hundreds of historical/restated
  // entries, and this loop pulls 3 tags per ticker, so it was blowing
  // Cloudflare's per-invocation subrequest cap partway through a single
  // cron run (live incident: "Too many API requests by single Worker
  // invocation" x1047 in one run, all logged with ticker=TSLA before the
  // cap was hit -- see cf_workers_observability_query for that trace).
  // Chunking (rather than one db.batch() for all facts) keeps each batch
  // call's own size bounded and means a genuinely malformed chunk (e.g. a
  // D1 constraint violation) only loses that chunk's rows, not the whole
  // run's insert -- same Failure Isolation spirit as the old per-fact
  // try/catch, just scoped to a chunk instead of a single row now.
  let inserted = 0;
  for (let i = 0; i < facts.length; i += FUNDAMENTALS_INSERT_CHUNK_SIZE) {
    const chunk = facts.slice(i, i + FUNDAMENTALS_INSERT_CHUNK_SIZE);
    try {
      await insertFundamentalFacts(db, chunk);
      inserted += chunk.length;
    } catch (err) {
      console.error("fundamentals ingestion -- skipping one chunk of fact inserts", {
        chunkStart: i, chunkSize: chunk.length, message: err.message,
      });
    }
  }
  return { count: inserted };
}

/**
 * Entry point for the cron trigger (src/index.js#scheduled). Pulls fresh
 * news (collectNewsItems) and price/fundamentals data (ingestPriceBars,
 * ingestFundamentals) from every wired adapter, then runs the pipeline
 * above per ticker per news item. Price/fundamentals ingestion happens
 * before the news loop so a same-run technical analyst call already has
 * whatever fresh bars just landed. See header for the failure-isolation
 * model -- a single source's VendorError no longer aborts this whole
 * function, it's logged and that source is skipped.
 */
export async function runScheduledIngestion(env, config, db) {
  await ingestPriceBars(config, db);
  await ingestFundamentals(config, db, env.CACHE_KV);

  const items = await collectNewsItems(config);

  const results = [];
  for (const item of items) {
    await insertNewsItem(db, item); // persist before running agents, so a mid-pipeline crash doesn't lose the raw ingested article
    for (const ticker of item.tickers) {
      results.push(await runPipelineForTicker(env, config, db, { runId: item.id, ticker, newsItem: item, asOf: item.publishedAt }));
    }
  }
  return results;
}
