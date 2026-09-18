import { parseDashboardParams } from "./helpers.js";
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
import {
  getSnapshotData,
  getActivityData,
  getChartsData,
  getHealthData,
  getDecisionsData,
  getPositionsData,
  getPipelineData,
  getBacktestRunsData,
} from "./data.js";

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
 * This request's own path + query string, handed to the shell as the target of its
 * Refresh link so a refresh reloads the same page with the same filters applied.
 * Only the data-driven sections pass this -- the Backfill/Backtest trigger forms,
 * their confirm pages, and More have nothing that goes stale, so they omit it.
 */
function currentPath(request) {
  const url = new URL(request.url);
  return url.pathname + url.search;
}

export async function handleSnapshotRoute(request, env, config) {
  const auth = await checkAuth(request, config);
  if (auth.redirect) return new Response(null, { status: 302, headers: { Location: auth.redirect } });
  const params = parseDashboardParams(new URL(request.url).searchParams);
  const { openPositions, closedPositions, decisionStats, totalExposurePct, error } = await getSnapshotData(env, params);
  const bodyHtml = renderSnapshotView({ openPositions, closedPositions, decisionStats, totalExposurePct, error });
  return htmlResponse(renderShell({ activeSection: "snapshot", sessionUsername: auth.sessionUsername, bodyHtml, refreshHref: currentPath(request) }));
}

export async function handleActivityRoute(request, env, config) {
  const auth = await checkAuth(request, config);
  if (auth.redirect) return new Response(null, { status: 302, headers: { Location: auth.redirect } });
  const params = parseDashboardParams(new URL(request.url).searchParams);
  const { decisionStats, error } = await getActivityData(env, params);
  const bodyHtml = renderActivityView({ decisionStats, params, error });
  return htmlResponse(renderShell({ activeSection: "activity", sessionUsername: auth.sessionUsername, bodyHtml, refreshHref: currentPath(request) }));
}

export async function handleChartsRoute(request, env, config) {
  const auth = await checkAuth(request, config);
  if (auth.redirect) return new Response(null, { status: 302, headers: { Location: auth.redirect } });
  const params = parseDashboardParams(new URL(request.url).searchParams);
  const { priceBarsByTicker, error } = await getChartsData(env, params);
  const bodyHtml = renderChartsView({ priceBarsByTicker, error });
  return htmlResponse(renderShell({ activeSection: "charts", sessionUsername: auth.sessionUsername, bodyHtml, refreshHref: currentPath(request) }));
}

export async function handleHealthRoute(request, env, config) {
  const auth = await checkAuth(request, config);
  if (auth.redirect) return new Response(null, { status: 302, headers: { Location: auth.redirect } });
  const { health, error } = await getHealthData(env);
  const bodyHtml = renderHealthView({ health, error });
  return htmlResponse(renderShell({ activeSection: "health", sessionUsername: auth.sessionUsername, bodyHtml, refreshHref: currentPath(request) }));
}

export async function handleDecisionsRoute(request, env, config) {
  const auth = await checkAuth(request, config);
  if (auth.redirect) return new Response(null, { status: 302, headers: { Location: auth.redirect } });
  const params = parseDashboardParams(new URL(request.url).searchParams);
  const { decisions, error } = await getDecisionsData(env, params);
  const bodyHtml = renderDecisionsView({ decisions, params, error });
  return htmlResponse(renderShell({ activeSection: "decisions", sessionUsername: auth.sessionUsername, bodyHtml, refreshHref: currentPath(request) }));
}

export async function handlePositionsRoute(request, env, config) {
  const auth = await checkAuth(request, config);
  if (auth.redirect) return new Response(null, { status: 302, headers: { Location: auth.redirect } });
  const params = parseDashboardParams(new URL(request.url).searchParams);
  const { openPositions, openPositionsError, closedPositions, closedPositionsError, totalExposurePct } = await getPositionsData(env, params);
  const bodyHtml = renderPositionsView({ openPositions, openPositionsError, closedPositions, closedPositionsError, params, totalExposurePct });
  return htmlResponse(renderShell({ activeSection: "positions", sessionUsername: auth.sessionUsername, bodyHtml, refreshHref: currentPath(request) }));
}

export async function handlePipelineRoute(request, env, config) {
  const auth = await checkAuth(request, config);
  if (auth.redirect) return new Response(null, { status: 302, headers: { Location: auth.redirect } });
  const { checkpoints, error } = await getPipelineData(env);
  const bodyHtml = renderPipelineView({ checkpoints, error });
  return htmlResponse(renderShell({ activeSection: "pipeline", sessionUsername: auth.sessionUsername, bodyHtml, refreshHref: currentPath(request) }));
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
  const { backtestRuns, error } = await getBacktestRunsData(env);
  const bodyHtml = renderBacktestView({ backtestRuns, error });
  return htmlResponse(renderShell({ activeSection: "backtest", sessionUsername: auth.sessionUsername, bodyHtml, refreshHref: currentPath(request) }));
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
