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
//
// JSON responses are built with `new Response(JSON.stringify(...), {...})`,
// not the static `Response.json(...)` helper -- matches the one existing
// convention this codebase already uses (and tests) for every other JSON
// response in src/index.js, rather than introducing a second, unproven one.
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
import { getJob } from "../storage/jobs.js";

function jsonResponse(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function unauthorized() {
  return jsonResponse({ error: "unauthorized" }, { status: 401 });
}

export async function handleApiSnapshotRoute(request, env, config) {
  const auth = await checkAuth(request, config);
  if (auth.redirect) return unauthorized();
  const params = parseDashboardParams(new URL(request.url).searchParams);
  return jsonResponse(await getSnapshotData(env, params));
}

export async function handleApiActivityRoute(request, env, config) {
  const auth = await checkAuth(request, config);
  if (auth.redirect) return unauthorized();
  const params = parseDashboardParams(new URL(request.url).searchParams);
  return jsonResponse(await getActivityData(env, params));
}

export async function handleApiChartsRoute(request, env, config) {
  const auth = await checkAuth(request, config);
  if (auth.redirect) return unauthorized();
  const params = parseDashboardParams(new URL(request.url).searchParams);
  return jsonResponse(await getChartsData(env, params));
}

export async function handleApiHealthRoute(request, env, config) {
  const auth = await checkAuth(request, config);
  if (auth.redirect) return unauthorized();
  return jsonResponse(await getHealthData(env));
}

export async function handleApiDecisionsRoute(request, env, config) {
  const auth = await checkAuth(request, config);
  if (auth.redirect) return unauthorized();
  const params = parseDashboardParams(new URL(request.url).searchParams);
  return jsonResponse(await getDecisionsData(env, params));
}

export async function handleApiPositionsRoute(request, env, config) {
  const auth = await checkAuth(request, config);
  if (auth.redirect) return unauthorized();
  const params = parseDashboardParams(new URL(request.url).searchParams);
  return jsonResponse(await getPositionsData(env, params));
}

export async function handleApiPipelineRoute(request, env, config) {
  const auth = await checkAuth(request, config);
  if (auth.redirect) return unauthorized();
  return jsonResponse(await getPipelineData(env));
}

export async function handleApiBacktestRunsRoute(request, env, config) {
  const auth = await checkAuth(request, config);
  if (auth.redirect) return unauthorized();
  return jsonResponse(await getBacktestRunsData(env));
}

/** GET /api/jobs/:id -- one job_progress row (src/storage/jobs.js), for the dashboard's live progress bar. 404 (not 200 + null) when the id doesn't exist, so a typo'd/expired id is visibly distinct from "job exists, no progress yet". */
export async function handleApiJobRoute(request, env, config, id) {
  const auth = await checkAuth(request, config);
  if (auth.redirect) return unauthorized();
  const job = await getJob(env.DB, id);
  if (!job) return jsonResponse({ error: "job not found" }, { status: 404 });
  return jsonResponse(job);
}
