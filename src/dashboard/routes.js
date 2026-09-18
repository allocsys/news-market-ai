import {
  getRecentTradeDecisions,
  getAllOpenPositions,
  getRecentlyClosedPositions,
  getRecentCheckpoints,
  getIngestionHealth,
  getDecisionStats,
  getRecentPriceBars,
  getRecentBacktestRuns,
} from "../storage/d1.js";
import { parseDashboardParams, PRICE_CHART_TICKER_LIMIT } from "./helpers.js";
import { renderShell } from "./shell.js";
import { renderSnapshotView } from "./views/snapshot.js";
import { renderActivityView } from "./views/activity.js";
import { renderChartsView } from "./views/charts.js";
import { renderHealthView } from "./views/health.js";
import { renderDecisionsView } from "./views/decisions.js";
import { renderPositionsView } from "./views/positions.js";
import { renderPipelineView } from "./views/pipeline.js";
import { renderMoreView } from "./views/more.js";
import { renderBackfillView, renderBackfillConfirmPage } from "./views/backfill.js";
import { renderBacktestView, renderBacktestConfirmPage } from "./views/backtest.js";
import { getSessionUsername } from "../auth/session.js";

function isDashboardAuthConfigured(config) {
  return Boolean(config.dashboardUsername && config.dashboardPassword && config.jwtSecret);
}

async function checkAuth(request, config) {
  const sessionUsername = isDashboardAuthConfigured(config) ? await getSessionUsername(request, config) : null;
  if (isDashboardAuthConfigured(config) && !sessionUsername) return { redirect: "/login" };
  return { sessionUsername };
}

function htmlResponse(html) {
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

/**
 * Wraps a single D1 query promise so a rejection becomes { data: null, error }
 * instead of throwing through the route handler -- design.md's Loading/error/
 * empty-states requirement is that one panel's fetch failing must not blank
 * or 500 the whole page. Callers await this instead of the raw query and
 * never need their own try/catch.
 */
async function safe(promise) {
  try {
    return { data: await promise, error: null };
  } catch (err) {
    console.error("dashboard panel query failed", { message: err.message });
    return { data: null, error: err.message || "failed to load" };
  }
}

export async function handleSnapshotRoute(request, env, config) {
  const auth = await checkAuth(request, config);
  if (auth.redirect) return new Response(null, { status: 302, headers: { Location: auth.redirect } });
  const params = parseDashboardParams(new URL(request.url).searchParams);
  const [openPositionsResult, closedPositionsResult, decisionStatsResult] = await Promise.all([
    safe(getAllOpenPositions(env.DB, { limit: params.positionsLimit })),
    safe(getRecentlyClosedPositions(env.DB, { limit: 20 })),
    safe(getDecisionStats(env.DB, { days: params.activityDays })),
  ]);
  // The stat grid is one combined panel drawn from all three queries, so a
  // failure in any of them is reported as one error for the section --
  // there's no meaningful way to show a "half stat grid".
  const error = openPositionsResult.error || closedPositionsResult.error || decisionStatsResult.error || null;
  const bodyHtml = renderSnapshotView({
    openPositions: openPositionsResult.data ?? [],
    closedPositions: closedPositionsResult.data ?? [],
    decisionStats: decisionStatsResult.data ?? { daily: [], totals: {} },
    error,
  });
  return htmlResponse(renderShell({ activeSection: "snapshot", sessionUsername: auth.sessionUsername, bodyHtml }));
}

export async function handleActivityRoute(request, env, config) {
  const auth = await checkAuth(request, config);
  if (auth.redirect) return new Response(null, { status: 302, headers: { Location: auth.redirect } });
  const params = parseDashboardParams(new URL(request.url).searchParams);
  const decisionStatsResult = await safe(getDecisionStats(env.DB, { days: params.activityDays }));
  const bodyHtml = renderActivityView({ decisionStats: decisionStatsResult.data ?? { daily: [], totals: {} }, params, error: decisionStatsResult.error });
  return htmlResponse(renderShell({ activeSection: "activity", sessionUsername: auth.sessionUsername, bodyHtml }));
}

export async function handleChartsRoute(request, env, config) {
  const auth = await checkAuth(request, config);
  if (auth.redirect) return new Response(null, { status: 302, headers: { Location: auth.redirect } });
  const params = parseDashboardParams(new URL(request.url).searchParams);
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
  const bodyHtml = renderChartsView({ priceBarsByTicker, error });
  return htmlResponse(renderShell({ activeSection: "charts", sessionUsername: auth.sessionUsername, bodyHtml }));
}

export async function handleHealthRoute(request, env, config) {
  const auth = await checkAuth(request, config);
  if (auth.redirect) return new Response(null, { status: 302, headers: { Location: auth.redirect } });
  const health = await getIngestionHealth(env.DB);
  const bodyHtml = renderHealthView({ health });
  return htmlResponse(renderShell({ activeSection: "health", sessionUsername: auth.sessionUsername, bodyHtml }));
}

export async function handleDecisionsRoute(request, env, config) {
  const auth = await checkAuth(request, config);
  if (auth.redirect) return new Response(null, { status: 302, headers: { Location: auth.redirect } });
  const params = parseDashboardParams(new URL(request.url).searchParams);
  const decisions = await getRecentTradeDecisions(env.DB, { limit: params.decisionLimit, status: params.decisionStatus === "all" ? undefined : params.decisionStatus });
  const bodyHtml = renderDecisionsView({ decisions, params });
  return htmlResponse(renderShell({ activeSection: "decisions", sessionUsername: auth.sessionUsername, bodyHtml }));
}

export async function handlePositionsRoute(request, env, config) {
  const auth = await checkAuth(request, config);
  if (auth.redirect) return new Response(null, { status: 302, headers: { Location: auth.redirect } });
  const params = parseDashboardParams(new URL(request.url).searchParams);
  const [openPositions, closedPositions] = await Promise.all([
    getAllOpenPositions(env.DB, { limit: params.positionsLimit }),
    getRecentlyClosedPositions(env.DB, { limit: 20 }),
  ]);
  const bodyHtml = renderPositionsView({ openPositions, closedPositions, params });
  return htmlResponse(renderShell({ activeSection: "positions", sessionUsername: auth.sessionUsername, bodyHtml }));
}

export async function handlePipelineRoute(request, env, config) {
  const auth = await checkAuth(request, config);
  if (auth.redirect) return new Response(null, { status: 302, headers: { Location: auth.redirect } });
  const checkpoints = await getRecentCheckpoints(env.DB, { limit: 30 });
  const bodyHtml = renderPipelineView({ checkpoints });
  return htmlResponse(renderShell({ activeSection: "pipeline", sessionUsername: auth.sessionUsername, bodyHtml }));
}

export async function handleBackfillRoute(request, env, config) {
  const auth = await checkAuth(request, config);
  if (auth.redirect) return new Response(null, { status: 302, headers: { Location: auth.redirect } });
  const bodyHtml = renderBackfillView();
  return htmlResponse(renderShell({ activeSection: "backfill", sessionUsername: auth.sessionUsername, bodyHtml }));
}

export async function handleBackfillConfirmRoute(request, env, config) {
  const auth = await checkAuth(request, config);
  if (auth.redirect) return new Response(null, { status: 302, headers: { Location: auth.redirect } });
  const sp = new URL(request.url).searchParams;
  const from = sp.get("from");
  const to = sp.get("to");
  const bodyHtml = renderBackfillConfirmPage({ from, to });
  return htmlResponse(renderShell({ activeSection: "backfill", sessionUsername: auth.sessionUsername, bodyHtml }));
}

export async function handleBacktestRoute(request, env, config) {
  const auth = await checkAuth(request, config);
  if (auth.redirect) return new Response(null, { status: 302, headers: { Location: auth.redirect } });
  const backtestRuns = await getRecentBacktestRuns(env.DB, { limit: 10 });
  const bodyHtml = renderBacktestView({ backtestRuns });
  return htmlResponse(renderShell({ activeSection: "backtest", sessionUsername: auth.sessionUsername, bodyHtml }));
}

export async function handleBacktestConfirmRoute(request, env, config) {
  const auth = await checkAuth(request, config);
  if (auth.redirect) return new Response(null, { status: 302, headers: { Location: auth.redirect } });
  const sp = new URL(request.url).searchParams;
  const testStart = sp.get("testStart");
  const testEnd = sp.get("testEnd");
  const tickers = sp.get("tickers");
  const graceDays = sp.get("graceDays");
  const bodyHtml = renderBacktestConfirmPage({ testStart, testEnd, tickers, graceDays });
  return htmlResponse(renderShell({ activeSection: "backtest", sessionUsername: auth.sessionUsername, bodyHtml }));
}

export async function handleMoreRoute(request, env, config) {
  const auth = await checkAuth(request, config);
  if (auth.redirect) return new Response(null, { status: 302, headers: { Location: auth.redirect } });
  const bodyHtml = renderMoreView();
  return htmlResponse(renderShell({ activeSection: "more", sessionUsername: auth.sessionUsername, bodyHtml }));
}
