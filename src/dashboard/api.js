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
import { parseDashboardParams, parseLlmParams, parseEnvParam } from "./helpers.js";
import {
  getSnapshotData,
  getActivityData,
  getChartsData,
  getHealthData,
  getDecisionsData,
  getPositionsData,
  getPipelineData,
  getBacktestRunsData,
  getLlmCallsData,
  getLlmCallData,
  resolveEnv,
} from "./data.js";

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
  const envParam = parseEnvParam(new URL(request.url).searchParams);
  return jsonResponse(await getPipelineData(env, { env: envParam }));
}

export async function handleApiBacktestRunsRoute(request, env, config) {
  const auth = await checkAuth(request, config);
  if (auth.redirect) return unauthorized();
  return jsonResponse(await getBacktestRunsData(env));
}

/** GET /api/llm-calls -- `{ calls, nextBeforeId, error }`, newest first, previews only. Filters: llmSource, llmStatus, llmTicker, llmJob, llmRun, llmLimit, llmBefore (helpers.js#parseLlmParams). */
export async function handleApiLlmCallsRoute(request, env, config) {
  const auth = await checkAuth(request, config);
  if (auth.redirect) return unauthorized();
  const params = parseLlmParams(new URL(request.url).searchParams);
  return jsonResponse(await getLlmCallsData(env, params));
}

/** GET /api/llm-calls/:id?env=... -- one call in full. 404 for an unknown/pruned id (or one that exists in a different environment than `env` resolved to), 500 if D1 failed (so the two are distinguishable). */
export async function handleApiLlmCallRoute(request, env, config, id) {
  const auth = await checkAuth(request, config);
  if (auth.redirect) return unauthorized();
  if (!/^\d+$/.test(id)) return jsonResponse({ error: "llm call id must be a number" }, { status: 400 });
  const envParam = parseEnvParam(new URL(request.url).searchParams);
  const { call, error, resolvedEnv, envError } = await getLlmCallData(env, Number(id), envParam);
  if (error) return jsonResponse({ error }, { status: 500 });
  if (!call) return jsonResponse({ error: "llm call not found (it may have been pruned by the retention window, or belong to a different environment)" }, { status: 404 });
  // resolvedEnv/envError ride along so the dashboard Worker can show the
  // environment selector against what actually resolved (a bad ?env= here
  // falls back to live the same way every other env-aware route does),
  // not just echo back whatever the URL asked for.
  return jsonResponse({ ...call, resolvedEnv, envError });
}

const ACTIVE_JOB_TYPES = new Set(["backfill", "backtest"]);

/**
 * GET /api/jobs/active?type=backfill|backtest&env=... -- `{ job }`, where `job`
 * is the newest in-flight job of that type in the resolved environment
 * (RunStore#getActiveJob) or null. Always 200 for a valid type: "nothing
 * running" is an ordinary answer, not a 404, unlike the by-id route below
 * where a missing id is an error. Lets the backfill/backtest pages show
 * progress for a job submitted earlier. `env` defaults to 'live' -- a
 * backfill job only ever runs there, but a backtest job lives under its own
 * run id in SIM_DB (M3), so the backtest page's active-job poll passes it.
 */
export async function handleApiActiveJobRoute(request, env, config) {
  const auth = await checkAuth(request, config);
  if (auth.redirect) return unauthorized();
  const searchParams = new URL(request.url).searchParams;
  const type = searchParams.get("type");
  if (!ACTIVE_JOB_TYPES.has(type)) return jsonResponse({ error: "type must be one of: backfill, backtest" }, { status: 400 });
  const { store } = await resolveEnv(env, parseEnvParam(searchParams));
  return jsonResponse({ job: await store.getActiveJob(type) });
}

/**
 * GET /api/jobs/latest?type=backfill -- `{ job }`, where `job` is the most recent
 * FINISHED ('complete' or 'failed') backfill job (RunStore#getLatestFinishedJob) or
 * null if none has finished. Always 200 for a valid type, like /api/jobs/active:
 * "nothing has run yet" is an ordinary answer. Lets the Backfill page show how the
 * last run ended after its progress bar is gone. Backfill only: a backtest's job row
 * lives under that backtest's own run id, so "the latest backtest job" isn't a
 * question one environment can answer -- its result is the backtest run itself.
 */
export async function handleApiLatestJobRoute(request, env, config) {
  const auth = await checkAuth(request, config);
  if (auth.redirect) return unauthorized();
  const searchParams = new URL(request.url).searchParams;
  const type = searchParams.get("type");
  if (type !== "backfill") return jsonResponse({ error: "type must be: backfill" }, { status: 400 });
  const { store } = await resolveEnv(env, parseEnvParam(searchParams));
  return jsonResponse({ job: await store.getLatestFinishedJob(type) });
}

/** GET /api/jobs/:id?env=... -- one job_progress row (RunStore#getJob) for the resolved environment, for the dashboard's live progress bar. 404 (not 200 + null) when the id doesn't exist in that environment, so a typo'd/expired id -- or an id that belongs to a different environment -- is visibly distinct from "job exists, no progress yet". */
export async function handleApiJobRoute(request, env, config, id) {
  const auth = await checkAuth(request, config);
  if (auth.redirect) return unauthorized();
  const { store } = await resolveEnv(env, parseEnvParam(new URL(request.url).searchParams));
  const job = await store.getJob(id);
  if (!job) return jsonResponse({ error: "job not found" }, { status: 404 });
  return jsonResponse(job);
}
