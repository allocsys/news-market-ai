// Data-fetching layer for the dashboard, extracted from routes.js (plan.md
// Step 1). One function per dashboard section, each returning a plain
// JSON-serializable shape -- no HTML. `routes.js`'s SSR handlers and
// `api.js`'s /api/* JSON handlers both call these same functions, so there
// is exactly one place each section's D1 reads happen, not two copies that
// could drift.
import {
  getRecentTradeDecisions,
  getAllOpenPositions,
  getRecentlyClosedPositions,
  getRecentCheckpoints,
  getIngestionHealth,
  getDecisionStats,
  getRecentPriceBars,
  getRecentBacktestRuns,
  getOpenPositionsExposureTotal,
} from "../storage/d1.js";
import { parseDashboardParams, PRICE_CHART_TICKER_LIMIT } from "./helpers.js";

/**
 * Wraps a single D1 query promise so a rejection becomes { data: null, error }
 * instead of throwing through the caller, so one panel's failed fetch shows
 * an inline error rather than blanking or 500ing the whole page/response.
 * Callers await this instead of the raw query and never need their own
 * try/catch.
 */
async function safe(promise) {
  try {
    return { data: await promise, error: null };
  } catch (err) {
    console.error("dashboard panel query failed", { message: err.message });
    return { data: null, error: err.message || "failed to load" };
  }
}

export async function getSnapshotData(env, params) {
  const [openPositionsResult, closedPositionsResult, decisionStatsResult, exposureResult] = await Promise.all([
    safe(getAllOpenPositions(env.DB, { limit: params.positionsLimit })),
    safe(getRecentlyClosedPositions(env.DB, { limit: 20 })),
    safe(getDecisionStats(env.DB, { days: params.activityDays })),
    safe(getOpenPositionsExposureTotal(env.DB)),
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
  const decisionStatsResult = await safe(getDecisionStats(env.DB, { days: params.activityDays }));
  return { decisionStats: decisionStatsResult.data ?? { daily: [], totals: {} }, error: decisionStatsResult.error };
}

export async function getChartsData(env, params) {
  const openPositionsResult = await safe(getAllOpenPositions(env.DB, { limit: params.positionsLimit }));
  let priceBarsByTicker = {};
  const error = openPositionsResult.error;
  if (!error) {
    const openPositions = openPositionsResult.data ?? [];
    const chartTickers = [...new Set(openPositions.map((p) => p.ticker))].slice(0, PRICE_CHART_TICKER_LIMIT);
    const entries = await Promise.all(
      chartTickers.map(async (ticker) => {
        const result = await safe(getRecentPriceBars(env.DB, { ticker, limit: 30 }));
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
  const healthResult = await safe(getIngestionHealth(env.DB));
  return { health: healthResult.data, error: healthResult.error };
}

export async function getDecisionsData(env, params) {
  const decisionsResult = await safe(
    getRecentTradeDecisions(env.DB, { limit: params.decisionLimit, status: params.decisionStatus === "all" ? undefined : params.decisionStatus })
  );
  return { decisions: decisionsResult.data ?? [], error: decisionsResult.error };
}

export async function getPositionsData(env, params) {
  const [openPositionsResult, closedPositionsResult, exposureResult] = await Promise.all([
    safe(getAllOpenPositions(env.DB, { limit: params.positionsLimit })),
    safe(getRecentlyClosedPositions(env.DB, { limit: 20 })),
    safe(getOpenPositionsExposureTotal(env.DB)),
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
  const checkpointsResult = await safe(getRecentCheckpoints(env.DB, { limit: 30 }));
  return { checkpoints: checkpointsResult.data ?? [], error: checkpointsResult.error };
}

export async function getBacktestRunsData(env) {
  const backtestRunsResult = await safe(getRecentBacktestRuns(env.DB, { limit: 10 }));
  return { backtestRuns: backtestRunsResult.data ?? [], error: backtestRunsResult.error };
}

export { parseDashboardParams };
