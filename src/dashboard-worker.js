// Dashboard Worker entry point (plan.md "Step 2 -- Dashboard Worker"). Owns
// login, the session cookie, and every HTML page. All data comes from the
// `backend` Worker's JSON API (src/dashboard/api.js) over a Cloudflare
// service binding (env.BACKEND) -- this Worker has no D1/KV bindings of its
// own. `backend` is private (no public route, see wrangler.toml) and holds
// no login secrets any more -- unlike before Step 2, an unconfigured login
// now means this Worker (the only public one) fails closed (503) rather
// than `backend` quietly serving an open, unauthenticated dashboard.
//
// Views/shell (src/dashboard/*) are imported unmodified from the shared
// src tree, not copied -- same "one repo, shared code imported" rule
// plan.md's Roadmap section states for every step of this split. The JSON
// shape each /api/* route returns is exactly the props object the matching
// render*View function already expects (see src/dashboard/routes.js's own
// former SSR handlers, which destructured the identical shape from data.js
// directly) -- that symmetry is *why* Step 1 built /api/* the way it did.

import { loadConfig } from "./config.js";
import { renderLoginPage } from "./login.js";
import { renderShell } from "./dashboard/shell.js";
import { renderRunAcceptedPage, renderActiveJobPanel } from "./dashboard/views/status.js";
import { renderSnapshotView } from "./dashboard/views/snapshot.js";
import { renderActivityView } from "./dashboard/views/activity.js";
import { renderChartsView } from "./dashboard/views/charts.js";
import { renderHealthView } from "./dashboard/views/health.js";
import { renderDecisionsView } from "./dashboard/views/decisions.js";
import { renderPositionsView } from "./dashboard/views/positions.js";
import { renderPipelineView } from "./dashboard/views/pipeline.js";
import { renderLlmView, renderLlmCallView } from "./dashboard/views/llm.js";
import { renderMoreView } from "./dashboard/views/more.js";
import { renderBackfillView, renderBackfillConfirmPage } from "./dashboard/views/backfill.js";
import { renderBacktestView, renderBacktestConfirmPage } from "./dashboard/views/backtest.js";
import { renderEnvSelector } from "./dashboard/views/env_selector.js";
import { parseDashboardParams, parseLlmParams, parseEnvParam, envSuffix, errorState, ENV_SECTIONS } from "./dashboard/helpers.js";
import { getSessionUsername, createSessionCookie, clearSessionCookie } from "./auth/session.js";

/** Same "no partial config" gate backend used to run itself (src/index.js,
 * pre-Step-2) -- now the ONLY place this check happens, since backend no
 * longer holds any of these three. */
function isDashboardAuthConfigured(config) {
  return Boolean(config.dashboardUsername && config.dashboardPassword && config.jwtSecret);
}

function isPlausibleDateString(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function htmlResponse(html, { status = 200 } = {}) {
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}
function jsonResponse(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function redirect(location, extraHeaders = {}) {
  return new Response(null, { status: 302, headers: { Location: location, ...extraHeaders } });
}
function currentPath(request) {
  const url = new URL(request.url);
  return url.pathname + url.search;
}

async function readForm(request) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("application/x-www-form-urlencoded") && !contentType.includes("multipart/form-data")) return null;
  return request.formData();
}

/**
 * Calls `backend`'s JSON API over the service binding. The URL's origin
 * ("https://backend") is never actually dialed -- service bindings route
 * in-process inside the same Cloudflare account, so this is just a stable,
 * readable placeholder host, same convention Cloudflare's own docs use.
 */
async function callBackend(env, path, init) {
  return env.BACKEND.fetch(`https://backend${path}`, init);
}

async function fetchBackendJson(env, path) {
  const res = await callBackend(env, path);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || `backend ${path} returned ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * HTML for the live-progress panel of the newest in-flight job of `type`
 * ('backfill' | 'backtest'), or "" if none. Lets the backfill/backtest pages
 * show progress for a job submitted earlier -- the run-accepted page that
 * used to be the only place a bar appeared is gone once the operator
 * navigates away. BEST-EFFORT: a failed lookup must never take the page
 * down, so any error just means no panel.
 */
async function activeJobPanelFor(env, type) {
  try {
    const { job } = await fetchBackendJson(env, `/api/jobs/active?type=${encodeURIComponent(type)}`);
    return renderActiveJobPanel(job);
  } catch (err) {
    console.warn("dashboard active-job lookup failed (non-fatal)", { type, message: err.message });
    return "";
  }
}

/**
 * HTML for the environment selector (Live + recent backtests) on an env-aware
 * page. BEST-EFFORT, same as activeJobPanelFor: if the registry lookup fails
 * the selector still renders with just "Live" (plus the active backtest, if
 * any) rather than the page erroring over a convenience control.
 * `resolvedEnv`/`envError` are what the backend actually resolved, not what
 * the URL asked for.
 */
async function envSelectorFor(env, { resolvedEnv, envError, url }) {
  let runs = [];
  try {
    ({ backtestRuns: runs = [] } = await fetchBackendJson(env, "/api/backtest-runs"));
  } catch (err) {
    console.warn("dashboard env-selector run lookup failed (non-fatal)", { message: err.message });
  }
  return renderEnvSelector({ runs, resolvedEnv, envError, pathname: url.pathname, search: url.search });
}

/**
 * Session gate shared by every /dashboard/* route. `__disabled__` means the
 * login isn't configured at all -- distinct from `redirect: "/login"`
 * (configured, but this request has no valid session) so callers can 503
 * with the disabled notice instead of bouncing to a login form that could
 * never succeed.
 */
async function requireSession(request, config) {
  if (!isDashboardAuthConfigured(config)) return { redirect: "__disabled__" };
  const sessionUsername = await getSessionUsername(request, config);
  if (!sessionUsername) return { redirect: "/login" };
  return { sessionUsername };
}

const SECTION_RENDERERS = {
  snapshot: renderSnapshotView,
  activity: renderActivityView,
  charts: renderChartsView,
  health: renderHealthView,
  decisions: renderDecisionsView,
  positions: renderPositionsView,
  pipeline: renderPipelineView,
  llm: renderLlmView,
  backtest: renderBacktestView,
};

const SECTION_API_PATH = {
  snapshot: "/api/snapshot",
  activity: "/api/activity",
  charts: "/api/charts",
  health: "/api/health",
  decisions: "/api/decisions",
  positions: "/api/positions",
  pipeline: "/api/pipeline",
  llm: "/api/llm-calls",
  backtest: "/api/backtest-runs",
};

// Sections whose render*View needs `params` alongside the /api/* JSON body
// (activity/decisions/positions filter UI reads its own current filter
// state back out of `params`, same as routes.js's former SSR handlers did),
// mapped to the parser that turns the query string into that section's
// params. The LLM-calls page has its own param set (see helpers.js#parseLlmParams).
const SECTION_PARAM_PARSERS = {
  activity: parseDashboardParams,
  decisions: parseDashboardParams,
  positions: parseDashboardParams,
  llm: parseLlmParams,
};

/** GET /dashboard/<section> -- fetch that section's JSON from backend, render it through the same view function routes.js's SSR handler used, wrap in the shell. */
async function renderSection(request, env, config, section) {
  const auth = await requireSession(request, config);
  if (auth.redirect === "__disabled__") return htmlResponse(renderLoginPage({ disabled: true }), { status: 503 });
  if (auth.redirect) return redirect(auth.redirect);

  const url = new URL(request.url);
  const apiPath = SECTION_API_PATH[section] + (url.search || "");
  const render = SECTION_RENDERERS[section];

  try {
    const data = await fetchBackendJson(env, apiPath);
    const parseParams = SECTION_PARAM_PARSERS[section];
    const props = parseParams ? { ...data, params: parseParams(url.searchParams) } : data;
    const activePanel = section === "backtest" ? await activeJobPanelFor(env, "backtest") : "";
    const resolvedEnv = data.resolvedEnv ?? "live";
    const envBar = ENV_SECTIONS.includes(section)
      ? await envSelectorFor(env, { resolvedEnv, envError: data.envError ?? null, url })
      : "";
    const bodyHtml = envBar + activePanel + render(props);
    return htmlResponse(renderShell({ activeSection: section, sessionUsername: auth.sessionUsername, bodyHtml, refreshHref: currentPath(request), env: resolvedEnv }));
  } catch (err) {
    // backend unreachable, or returned something unexpected -- rendered as
    // a generic panel rather than guessing at the section's own error-prop
    // shape (they differ: positions has openPositionsError/closedPositionsError,
    // most others just `error`) and risking a render crash on a malformed prop.
    console.error(`dashboard ${section} backend fetch failed`, { message: err.message });
    const bodyHtml = `<section><h2>${section}</h2>${errorState(err.message)}</section>`;
    return htmlResponse(renderShell({ activeSection: section, sessionUsername: auth.sessionUsername, bodyHtml, refreshHref: currentPath(request), env: parseEnvParam(url.searchParams) }));
  }
}

/** GET /dashboard/llm/:id -- one LLM call in full (backend's /api/llm-calls/:id). A missing id renders the view's own "not found" state (with a 404 status) rather than the generic backend-error panel. */
async function renderLlmCall(request, env, config, id) {
  const auth = await requireSession(request, config);
  if (auth.redirect === "__disabled__") return htmlResponse(renderLoginPage({ disabled: true }), { status: 503 });
  if (auth.redirect) return redirect(auth.redirect);

  // A backtest's calls are logged under its own run id, so the id alone isn't
  // enough to find one -- the list page's `?env=` has to travel with it.
  const callEnv = parseEnvParam(new URL(request.url).searchParams);

  const shell = (bodyHtml, status = 200) =>
    htmlResponse(renderShell({ activeSection: "llm", sessionUsername: auth.sessionUsername, bodyHtml, refreshHref: currentPath(request), env: callEnv }), { status });

  if (!/^\d+$/.test(id)) return shell(renderLlmCallView({ call: null, env: callEnv }), 404);
  try {
    const call = await fetchBackendJson(env, `/api/llm-calls/${id}${envSuffix(callEnv)}`);
    return shell(renderLlmCallView({ call, env: callEnv }));
  } catch (err) {
    if (err.status === 404) return shell(renderLlmCallView({ call: null, env: callEnv }), 404);
    console.error("dashboard llm call backend fetch failed", { id, message: err.message });
    return shell(renderLlmCallView({ error: err.message, env: callEnv }), 500);
  }
}

/** Shared POST /backfill and POST /backtest/run handler shape: check the
 * session here (this Worker is the only one that can), then forward to
 * backend, which now trusts any caller reaching it (only this Worker can,
 * via the service binding -- backend has no public route). */
async function handleTriggerRoute(request, env, config, { backendPath, buildQuery, formSubmitAccepted }) {
  const sessionUsername = await getSessionUsername(request, config);
  if (!sessionUsername) {
    if (!isDashboardAuthConfigured(config)) {
      return jsonResponse({ error: `${backendPath} is not configured (set up the dashboard login)` }, { status: 503 });
    }
    return jsonResponse({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const form = await readForm(request);
  const isFormSubmit = Boolean(form);
  const fromForm = (key) => (form ? form.get(key) : null);

  const built = buildQuery(url.searchParams, fromForm);
  if (built.error) return jsonResponse({ error: built.error }, { status: 400 });

  // Since plan.md Step 3, backend always enqueues onto JOBS and returns an
  // immediate `{accepted, id, ...}` ack regardless of caller -- no more
  // `?async=1` distinction to make here (backend ran the real work
  // synchronously, or via ctx.waitUntil, before Step 3; now it never does).
  const qs = new URLSearchParams(built.params);

  try {
    const res = await callBackend(env, `${backendPath}?${qs.toString()}`, { method: "POST" });
    const body = await res.json();
    if (!res.ok) {
      return isFormSubmit
        ? htmlResponse(renderShell({ activeSection: built.activeSection, sessionUsername, bodyHtml: `<section>${errorState(body.message || body.error)}</section>` }), { status: res.status })
        : jsonResponse(body, { status: res.status });
    }
    if (isFormSubmit) {
      const bodyHtml = renderRunAcceptedPage(formSubmitAccepted(built.params, body));
      return htmlResponse(renderShell({ activeSection: built.activeSection, sessionUsername, bodyHtml }));
    }
    return jsonResponse(body);
  } catch (err) {
    console.error(`${backendPath} forward failed`, { message: err.message });
    return jsonResponse({ error: `${backendPath} request failed`, message: err.message }, { status: 500 });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const config = loadConfig(env);

    // Live progress polling target for the run-accepted page's client-side
    // JS (dashboard/views/status.js) -- proxies backend's GET /api/jobs/:id
    // the same way every other /dashboard/* read does, just returning raw
    // JSON instead of rendering a section, since this is fetched by script,
    // not navigated to.
    if (pathname.startsWith("/dashboard/jobs/")) {
      const auth = await requireSession(request, config);
      if (auth.redirect === "__disabled__") return jsonResponse({ error: "dashboard is not configured" }, { status: 503 });
      if (auth.redirect) return jsonResponse({ error: "unauthorized" }, { status: 401 });
      const id = pathname.slice("/dashboard/jobs/".length);
      const envParam = url.searchParams.get("env");
      const qs = envParam ? `?env=${encodeURIComponent(envParam)}` : "";
      try {
        const job = await fetchBackendJson(env, `/api/jobs/${encodeURIComponent(id)}${qs}`);
        return jsonResponse(job);
      } catch (err) {
        return jsonResponse({ error: err.message }, { status: err.status || 500 });
      }
    }

    if (pathname === "/dashboard") return redirect("/dashboard/snapshot");
    if (pathname === "/dashboard/snapshot") return renderSection(request, env, config, "snapshot");
    if (pathname === "/dashboard/activity") return renderSection(request, env, config, "activity");
    if (pathname === "/dashboard/charts") return renderSection(request, env, config, "charts");
    if (pathname === "/dashboard/health") return renderSection(request, env, config, "health");
    if (pathname === "/dashboard/decisions") return renderSection(request, env, config, "decisions");
    if (pathname === "/dashboard/positions") return renderSection(request, env, config, "positions");
    if (pathname === "/dashboard/pipeline") return renderSection(request, env, config, "pipeline");
    if (pathname === "/dashboard/llm") return renderSection(request, env, config, "llm");
    if (pathname.startsWith("/dashboard/llm/")) return renderLlmCall(request, env, config, pathname.slice("/dashboard/llm/".length));
    if (pathname === "/dashboard/backtest") return renderSection(request, env, config, "backtest");

    // Pure UI, no backend data needed -- forms and their confirm pages.
    if (pathname === "/dashboard/backfill" || pathname === "/dashboard/backtest/confirm" || pathname === "/dashboard/backfill/confirm" || pathname === "/dashboard/more") {
      const auth = await requireSession(request, config);
      if (auth.redirect === "__disabled__") return htmlResponse(renderLoginPage({ disabled: true }), { status: 503 });
      if (auth.redirect) return redirect(auth.redirect);

      if (pathname === "/dashboard/backfill") {
        const activePanel = await activeJobPanelFor(env, "backfill");
        return htmlResponse(renderShell({ activeSection: "backfill", sessionUsername: auth.sessionUsername, bodyHtml: activePanel + renderBackfillView() }));
      }
      if (pathname === "/dashboard/backfill/confirm") {
        const bodyHtml = renderBackfillConfirmPage({ from: url.searchParams.get("from"), to: url.searchParams.get("to") });
        return htmlResponse(renderShell({ activeSection: "backfill", sessionUsername: auth.sessionUsername, bodyHtml }));
      }
      if (pathname === "/dashboard/backtest/confirm") {
        const bodyHtml = renderBacktestConfirmPage({
          testStart: url.searchParams.get("testStart"),
          testEnd: url.searchParams.get("testEnd"),
          tickers: url.searchParams.get("tickers"),
          graceDays: url.searchParams.get("graceDays"),
        });
        return htmlResponse(renderShell({ activeSection: "backtest", sessionUsername: auth.sessionUsername, bodyHtml }));
      }
      return htmlResponse(renderShell({ activeSection: "more", sessionUsername: auth.sessionUsername, bodyHtml: renderMoreView() }));
    }

    if (pathname === "/login" && request.method === "GET") {
      if (!isDashboardAuthConfigured(config)) return htmlResponse(renderLoginPage({ disabled: true }), { status: 503 });
      const sessionUsername = await getSessionUsername(request, config);
      if (sessionUsername) return redirect("/dashboard/snapshot");
      const error = url.searchParams.get("error") === "invalid" ? "Invalid username or password." : null;
      return htmlResponse(renderLoginPage({ error }));
    }

    if (pathname === "/login" && request.method === "POST") {
      if (!isDashboardAuthConfigured(config)) return htmlResponse(renderLoginPage({ disabled: true }), { status: 503 });
      const form = await readForm(request);
      const username = String(form?.get("username") ?? "");
      const password = String(form?.get("password") ?? "");
      if (username !== config.dashboardUsername || password !== config.dashboardPassword) {
        return htmlResponse(renderLoginPage({ error: "Invalid username or password." }), { status: 401 });
      }
      const cookie = await createSessionCookie(username, config);
      return redirect("/dashboard/snapshot", { "Set-Cookie": cookie });
    }

    if (pathname === "/logout") {
      return redirect("/login", { "Set-Cookie": clearSessionCookie() });
    }

    if (pathname === "/backfill" && request.method === "POST") {
      return handleTriggerRoute(request, env, config, {
        backendPath: "/backfill",
        buildQuery: (searchParams, fromForm) => {
          const from = searchParams.get("from") ?? fromForm("from");
          const to = searchParams.get("to") ?? fromForm("to");
          if (!isPlausibleDateString(from) || !isPlausibleDateString(to)) {
            return { error: "from/to query params are required, as YYYY-MM-DD" };
          }
          return { params: { from, to }, activeSection: "backfill" };
        },
        formSubmitAccepted: ({ from, to }, body) => ({
          title: "Backfill",
          detail: `Backfilling historical news from ${from} to ${to}.`,
          backLink: "/dashboard/backfill",
          backLabel: "Backfill",
          jobId: body.id,
        }),
      });
    }

    if (pathname === "/backtest/run" && request.method === "POST") {
      return handleTriggerRoute(request, env, config, {
        backendPath: "/backtest/run",
        buildQuery: (searchParams, fromForm) => {
          const testStart = searchParams.get("testStart") ?? fromForm("testStart");
          const testEnd = searchParams.get("testEnd") ?? fromForm("testEnd");
          const tickers = searchParams.get("tickers") ?? fromForm("tickers");
          const graceDays = searchParams.get("graceDays") ?? fromForm("graceDays");
          if (!isPlausibleDateString((testStart || "").slice(0, 10)) || !isPlausibleDateString((testEnd || "").slice(0, 10))) {
            return { error: "testStart/testEnd query params are required, as YYYY-MM-DD (or a full ISO timestamp)" };
          }
          const params = { testStart, testEnd };
          if (tickers) params.tickers = tickers;
          if (graceDays) params.graceDays = graceDays;
          return { params, activeSection: "backtest" };
        },
        formSubmitAccepted: ({ testStart, testEnd, tickers }, body) => ({
          title: "Backtest",
          detail: `Running a backtest for ${tickers || "the full watchlist"} from ${testStart} to ${testEnd}.`,
          backLink: "/dashboard/backtest",
          backLabel: "Backtest",
          jobId: body.id,
          type: "backtest",
        }),
      });
    }

    return new Response("news-market-ai dashboard is running. See plan.md for architecture.", { status: 200 });
  },
};
