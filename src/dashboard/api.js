// JSON API layer for the dashboard (plan.md Step 1). One route per
// dashboard section, each backed by the same src/dashboard/data.js
// functions routes.js's SSR handlers call -- there is exactly one place
// each section's D1 reads happen, not two copies that could drift.
//
// Auth-gated via routes.js's own `checkAuth` (reused, not duplicated) --
// same session-cookie check the SSR dashboard uses. Unlike the SSR routes,
// though, a failed check here returns a 401 JSON error rather than a
// redirect to /login: redirecting a scripted/API caller to an HTML login
// page would make no sense, and this mirrors how POST /backfill and
// POST /backtest/run (src/index.js) already answer unauthenticated
// scripted callers with JSON rather than a redirect.
import { checkAuth } from "./routes.js";
import { parseDashboardParams } from "./helpers.js";
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

function unauthorized() {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

export async function handleApiSnapshotRoute(request, env, config) {
  const auth = await checkAuth(request, config);
  if (auth.redirect) return unauthorized();
  const params = parseDashboardParams(new URL(request.url).searchParams);
  return Response.json(await getSnapshotData(env, params));
}

export async function handleApiActivityRoute(request, env, config) {
  const auth = await checkAuth(request, config);
  if (auth.redirect) return unauthorized();
  const params = parseDashboardParams(new URL(request.url).searchParams);
  return Response.json(await getActivityData(env, params));
}

export async function handleApiChartsRoute(request, env, config) {
  const auth = await checkAuth(request, config);
  if (auth.redirect) return unauthorized();
  const params = parseDashboardParams(new URL(request.url).searchParams);
  return Response.json(await getChartsData(env, params));
}

export async function handleApiHealthRoute(request, env, config) {
  const auth = await checkAuth(request, config);
  if (auth.redirect) return unauthorized();
  return Response.json(await getHealthData(env));
}

export async function handleApiDecisionsRoute(request, env, config) {
  const auth = await checkAuth(request, config);
  if (auth.redirect) return unauthorized();
  const params = parseDashboardParams(new URL(request.url).searchParams);
  return Response.json(await getDecisionsData(env, params));
}

export async function handleApiPositionsRoute(request, env, config) {
  const auth = await checkAuth(request, config);
  if (auth.redirect) return unauthorized();
  const params = parseDashboardParams(new URL(request.url).searchParams);
  return Response.json(await getPositionsData(env, params));
}

export async function handleApiPipelineRoute(request, env, config) {
  const auth = await checkAuth(request, config);
  if (auth.redirect) return unauthorized();
  return Response.json(await getPipelineData(env));
}

export async function handleApiBacktestRunsRoute(request, env, config) {
  const auth = await checkAuth(request, config);
  if (auth.redirect) return unauthorized();
  return Response.json(await getBacktestRunsData(env));
}
