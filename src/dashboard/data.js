// Data-fetching layer for the dashboard, extracted from routes.js (plan.md
// Step 1). One function per dashboard section, each returning a plain
// JSON-serializable shape -- no HTML. `routes.js`'s SSR handlers and
// `api.js`'s /api/* JSON handlers both call these same functions, so there
// is exactly one place each section's D1 reads happen, not two copies that
// could drift.
import { getIngestionHealth, getRecentPriceBars } from "../storage/inputs_view.js";
import { getRecentBacktestRuns } from "../storage/sim_registry.js";
import { RunStore, readOnly } from "../storage/run_store.js";
import { parseDashboardParams, PRICE_CHART_TICKER_LIMIT } from "./helpers.js";

/**
 * Read-only RunStore over LIVE_DB (run_id 'live'): every state-schema panel
 * (positions, decisions, checkpoints, the LLM-call log, job progress). The
 * dashboard API never writes, so the handle is wrapped in readOnly() -- a
 * write method reaching D1 through it throws instead of running. Inputs
 * panels (price charts, ingestion health) read readOnly(env.INPUTS_DB). As of
 * M4 nothing here touches the old `DB` binding; the environment selector
 * (reading a backtest's run_id off SIM_DB) is the next M4 step.
 */
export function liveReadStore(env) {
  return new RunStore(readOnly(env.LIVE_DB), "live");
}

/**
 * Wraps a single D1 query promise so a rejection becomes { data: null, error }
 * instead of throwing through the caller, so one panel's failed fetch shows
 * an inline error rather than blanking or 500ing the whole page/response.
 * Callers await this instead of the raw query and never need their own
 * try/catch.
 */
async function safe(promiseOrFn) {
  try {
    // A function is invoked inside the try, so a synchronous failure while
    // building the query (a missing binding, readOnly() refusing) is reported
    // as that panel's error instead of throwing through the caller.
    return { data: await (typeof promiseOrFn === "function" ? promiseOrFn() : promiseOrFn), error: null };
  } catch (err) {
    console.error("dashboard panel query failed", { message: err.message });
    return { data: null, error: err.message || "failed to load" };
  }
}

export async function getSnapshotData(env, params) {
  const [openPositionsResult, closedPositionsResult, decisionStatsResult, exposureResult] = await Promise.all([
    safe(() => liveReadStore(env).listOpenPositions({ limit: params.positionsLimit })),
    safe(() => liveReadStore(env).listRecentlyClosedPositions({ limit: 20 })),
    safe(() => liveReadStore(env).getDecisionStats({ days: params.activityDays })),
    safe(() => liveReadStore(env).getOpenExposureTotal()),
  ]);
  // The stat grid is one combined panel drawn from all four queries, so a
  // failure in any of them is reported as one error for the section --
  // there's no meaningful way to show a "half stat grid".
  const error = openPositionsResult.error || closedPositionsResult.error || decisionStatsResult.error || exposureResult.error || null;
  return {
    openPositions: openPositionsResult.data ?? [],
    closedPositions: closedPositionsResult.data ?? [],
    decisionStats: decisionStatsResult.data ?? { daily: [], totals: {} },
    totalExposurePct: (exposureResult.data?.totalPct ?? 0) * 100,
    error,
  };
}

export async function getActivityData(env, params) {
  const decisionStatsResult = await safe(() => liveReadStore(env).getDecisionStats({ days: params.activityDays }));
  return { decisionStats: decisionStatsResult.data ?? { daily: [], totals: {} }, error: decisionStatsResult.error };
}

export async function getChartsData(env, params) {
  const openPositionsResult = await safe(() => liveReadStore(env).listOpenPositions({ limit: params.positionsLimit }));
  let priceBarsByTicker = {};
  const error = openPositionsResult.error;
  if (!error) {
    const openPositions = openPositionsResult.data ?? [];
    const chartTickers = [...new Set(openPositions.map((p) => p.ticker))].slice(0, PRICE_CHART_TICKER_LIMIT);
    const entries = await Promise.all(
      chartTickers.map(async (ticker) => {
        const result = await safe(() => getRecentPriceBars(readOnly(env.INPUTS_DB), { ticker, limit: 30 }));
        return [ticker, result];
      })
    );
    // A single ticker's price-bar fetch failing shouldn't blank the whole
    // grid -- skip that cell rather than erroring the whole Charts section.
    priceBarsByTicker = Object.fromEntries(
      entries.filter(([, result]) => !result.error).map(([ticker, result]) => [ticker, result.data])
    );
  }
  return { priceBarsByTicker, error };
}

export async function getHealthData(env) {
  const healthResult = await safe(() => getIngestionHealth(readOnly(env.INPUTS_DB)));
  return { health: healthResult.data, error: healthResult.error };
}

export async function getDecisionsData(env, params) {
  const decisionsResult = await safe(() =>
    liveReadStore(env).listRecentTradeDecisions({ limit: params.decisionLimit, status: params.decisionStatus === "all" ? undefined : params.decisionStatus })
  );
  return { decisions: decisionsResult.data ?? [], error: decisionsResult.error };
}

export async function getPositionsData(env, params) {
  const [openPositionsResult, closedPositionsResult, exposureResult] = await Promise.all([
    safe(() => liveReadStore(env).listOpenPositions({ limit: params.positionsLimit })),
    safe(() => liveReadStore(env).listRecentlyClosedPositions({ limit: 20 })),
    safe(() => liveReadStore(env).getOpenExposureTotal()),
  ]);
  // Open and closed positions are two sub-panels on one page that must fail
  // independently -- each gets its own error, not one shared one. The
  // exposure aggregate failing folds into the open-positions error, since
  // the exposure gauge lives in that same sub-panel.
  return {
    openPositions: openPositionsResult.data ?? [],
    openPositionsError: openPositionsResult.error || exposureResult.error || null,
    closedPositions: closedPositionsResult.data ?? [],
    closedPositionsError: closedPositionsResult.error,
    totalExposurePct: (exposureResult.data?.totalPct ?? 0) * 100,
  };
}

export async function getPipelineData(env) {
  const checkpointsResult = await safe(() => liveReadStore(env).listRecentCheckpoints({ limit: 30 }));
  return { checkpoints: checkpointsResult.data ?? [], error: checkpointsResult.error };
}

export async function getBacktestRunsData(env) {
  // The registry lives on SIM_DB (M3); the dashboard API never writes, so the handle is read-only.
  const backtestRunsResult = await safe(getRecentBacktestRuns(readOnly(env.SIM_DB), { limit: 10 }));
  return { backtestRuns: backtestRunsResult.data ?? [], error: backtestRunsResult.error };
}

/** LLM-call log page: newest-first list (previews only) under the page's filters. `params` is helpers.js#parseLlmParams's output. */
export async function getLlmCallsData(env, params) {
  const result = await safe(
    liveReadStore(env).getRecentLlmCalls({
      limit: params.llmLimit,
      source: params.llmSource === "all" ? undefined : params.llmSource,
      status: params.llmStatus === "all" ? undefined : params.llmStatus,
      ticker: params.llmTicker || undefined,
      jobId: params.llmJob || undefined,
      runId: params.llmRun || undefined,
      beforeId: params.llmBefore ?? undefined,
    })
  );
  return { calls: result.data?.calls ?? [], nextBeforeId: result.data?.nextBeforeId ?? null, error: result.error };
}

/** One call in full: complete prompt, raw response, cascade attempts. `call` is null when the id doesn't exist. */
export async function getLlmCallData(env, id) {
  const result = await safe(liveReadStore(env).getLlmCall(id));
  return { call: result.data, error: result.error };
}

export { parseDashboardParams };
