// Worker entry point. `fetch` is a placeholder health check for now.
// `scheduled` calls graph/pipeline.js#runScheduledIngestion, which is fully
// wired end to end: gdelt/rss/html_scrape news ingestion + yfinance price
// bars + edgar_fundamentals facts -> analysts (incl. technical, now
// actually fed by the price bars above) -> debate -> trader -> risk ->
// portfolio (see that file's header for current caveats and the
// per-source failure isolation model). Any remaining failure (network,
// malformed vendor response, LLM cascade exhausted) is caught and logged
// here rather than left to crash the Worker invocation silently (Adopted
// Pattern #11).

import { loadConfig } from "./config.js";
import { runScheduledIngestion, backfillHistoricalNews } from "./graph/pipeline.js";
import { checkOpenPositionExits } from "./graph/exit_check.js";
import {
  handleSnapshotRoute,
  handleActivityRoute,
  handleChartsRoute,
  handleHealthRoute,
  handleDecisionsRoute,
  handlePositionsRoute,
  handlePipelineRoute,
  handleBackfillRoute,
  handleBackfillConfirmRoute,
  handleBacktestRoute,
  handleBacktestConfirmRoute,
  handleMoreRoute,
} from "./dashboard/routes.js";
import {
  handleApiSnapshotRoute,
  handleApiActivityRoute,
  handleApiChartsRoute,
  handleApiHealthRoute,
  handleApiDecisionsRoute,
  handleApiPositionsRoute,
  handleApiPipelineRoute,
  handleApiBacktestRunsRoute,
} from "./dashboard/api.js";
import { runManualBacktest } from "./backtest/runBacktest.js";
import { renderLoginPage } from "./login.js";
import { renderShell } from "./dashboard/shell.js";
import { renderRunAcceptedPage } from "./dashboard/views/status.js";
import { getSessionUsername, createSessionCookie, clearSessionCookie } from "./auth/session.js";

/**
 * Basic YYYY-MM-DD shape check -- just enough to reject obvious garbage
 * (empty string, "tomorrow", a swapped from/to) with a clear 400 before it
 * reaches fetchLatest's `new Date(...)`, which would otherwise silently
 * produce an "Invalid Date" and a broken Finnhub URL instead of a useful
 * error. Not a full calendar-validity check (e.g. "2024-02-30" passes this
 * regex) -- that's Finnhub's own problem to reject, same as any other
 * vendor-input validation this project doesn't duplicate client-side.
 */
function isPlausibleDateString(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * Whether the one-operator dashboard login (src/login.js, src/auth/session.js)
 * is usable at all -- ALL THREE of DASHBOARD_USERNAME/DASHBOARD_PASSWORD/
 * JWT_SECRET must be set, same "no partial config" reasoning as any other
 * multi-part secret in this file. See config.js#dashboardUsername's own
 * header for what happens on each side of this: configured means GET
 * /dashboard now requires a session (redirects to /login) and POST /login
 * actually works; unconfigured means /dashboard stays exactly as
 * unauthenticated as it always was, and /login shows a "not configured"
 * notice rather than a form that could never succeed.
 */
function isDashboardAuthConfigured(config) {
  return Boolean(config.dashboardUsername && config.dashboardPassword && config.jwtSecret);
}

/** Reads username/password from a POST /login body -- always form-urlencoded, this is a plain <form method="post"> submit, never JSON/query-string (unlike /backfill and /backtest/run, which also serve scripted callers). */
async function readLoginForm(request) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("application/x-www-form-urlencoded") && !contentType.includes("multipart/form-data")) {
    return { username: "", password: "" };
  }
  const form = await request.formData();
  return { username: String(form.get("username") ?? ""), password: String(form.get("password") ?? "") };
}

function redirect(location, extraHeaders = {}) {
  return new Response(null, { status: 302, headers: { Location: location, ...extraHeaders } });
}

function htmlResponse(html, { status = 200 } = {}) {
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    const config = loadConfig(env);

    if (pathname === "/dashboard") {
      return redirect("/dashboard/snapshot");
    }

    if (pathname === "/dashboard/snapshot") {
      return handleSnapshotRoute(request, env, config);
    }
    if (pathname === "/dashboard/activity") {
      return handleActivityRoute(request, env, config);
    }
    if (pathname === "/dashboard/charts") {
      return handleChartsRoute(request, env, config);
    }
    if (pathname === "/dashboard/health") {
      return handleHealthRoute(request, env, config);
    }
    if (pathname === "/dashboard/decisions") {
      return handleDecisionsRoute(request, env, config);
    }
    if (pathname === "/dashboard/positions") {
      return handlePositionsRoute(request, env, config);
    }
    if (pathname === "/dashboard/pipeline") {
      return handlePipelineRoute(request, env, config);
    }
    if (pathname === "/dashboard/backfill") {
      return handleBackfillRoute(request, env, config);
    }
    if (pathname === "/dashboard/backfill/confirm") {
      return handleBackfillConfirmRoute(request, env, config);
    }
    if (pathname === "/dashboard/backtest") {
      return handleBacktestRoute(request, env, config);
    }
    if (pathname === "/dashboard/backtest/confirm") {
      return handleBacktestConfirmRoute(request, env, config);
    }
    if (pathname === "/dashboard/more") {
      return handleMoreRoute(request, env, config);
    }

    // JSON API layer (plan.md Step 1) -- same data each /dashboard/* SSR
    // page renders, as Response.json(...) instead of HTML, for a future
    // client-rendered dashboard (Step 2) or any other scripted caller.
    if (pathname === "/api/snapshot") {
      return handleApiSnapshotRoute(request, env, config);
    }
    if (pathname === "/api/activity") {
      return handleApiActivityRoute(request, env, config);
    }
    if (pathname === "/api/charts") {
      return handleApiChartsRoute(request, env, config);
    }
    if (pathname === "/api/health") {
      return handleApiHealthRoute(request, env, config);
    }
    if (pathname === "/api/decisions") {
      return handleApiDecisionsRoute(request, env, config);
    }
    if (pathname === "/api/positions") {
      return handleApiPositionsRoute(request, env, config);
    }
    if (pathname === "/api/pipeline") {
      return handleApiPipelineRoute(request, env, config);
    }
    if (pathname === "/api/backtest-runs") {
      return handleApiBacktestRunsRoute(request, env, config);
    }

    if (pathname === "/login" && request.method === "GET") {
      if (!isDashboardAuthConfigured(config)) {
        return htmlResponse(renderLoginPage({ disabled: true }), { status: 503 });
      }
      // Already logged in -- no reason to show the form again.
      const sessionUsername = await getSessionUsername(request, config);
      if (sessionUsername) return redirect("/dashboard/snapshot");
      const error = url.searchParams.get("error") === "invalid" ? "Invalid username or password." : null;
      return htmlResponse(renderLoginPage({ error }));
    }

    if (pathname === "/login" && request.method === "POST") {
      if (!isDashboardAuthConfigured(config)) {
        return htmlResponse(renderLoginPage({ disabled: true }), { status: 503 });
      }
      const { username, password } = await readLoginForm(request);
      // Plain equality -- a single operator credential pair checked once
      // per login (not per request the way the now-removed shared API
      // secrets were), so the timing-attack surface here is far smaller
      // than a per-request header comparison would be.
      if (username !== config.dashboardUsername || password !== config.dashboardPassword) {
        return htmlResponse(renderLoginPage({ error: "Invalid username or password." }), { status: 401 });
      }
      const cookie = await createSessionCookie(username, config);
      return redirect("/dashboard/snapshot", { "Set-Cookie": cookie });
    }

    if (pathname === "/logout") {
      // GET, not POST -- this is a plain <a href="/logout"> link (see
      // dashboard/shell.js's rail-meta), same zero-client-JS philosophy as every
      // other navigation on this page. Clearing a cookie is idempotent and
      // only ever affects the browser making the request, so a bare GET
      // here doesn't carry the usual CSRF-via-GET risk a state-mutating
      // action normally would.
      return redirect("/login", { "Set-Cookie": clearSessionCookie() });
    }

    // Operational entry point for graph/pipeline.js#backfillHistoricalNews
    // -- see plan.md's Backlog note this closes ("backfillHistoricalNews
    // isn't yet wired to any operational entry point"). POST, not GET:
    // this has side effects (real Finnhub calls, D1 writes), unlike
    // /dashboard's read-only GET.
    if (pathname === "/backfill" && request.method === "POST") {
      const sessionUsername = await getSessionUsername(request, config);

      if (!sessionUsername) {
        if (!isDashboardAuthConfigured(config)) {
          return new Response(JSON.stringify({ error: "backfill endpoint is not configured (set up the dashboard login)" }), {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }

      const contentType = request.headers.get("content-type") || "";
      const isFormSubmit = contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data");
      const form = isFormSubmit ? await request.formData() : null;
      const fromForm = (key) => (form ? form.get(key) : null);

      const from = url.searchParams.get("from") ?? fromForm("from");
      const to = url.searchParams.get("to") ?? fromForm("to");
      if (!isPlausibleDateString(from) || !isPlausibleDateString(to)) {
        return new Response(JSON.stringify({ error: "from/to query params are required, as YYYY-MM-DD" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }

      // Dashboard confirm-page submission:
      // don't make the operator's browser wait on the full backfill --
      // kick it off in the background and respond immediately with a page
      // confirming the run was accepted, rather than a bare JSON blob or a
      // redirect to a page that looks unchanged.
      if (isFormSubmit) {
        ctx.waitUntil(
          backfillHistoricalNews(config, env.DB, { from, to, kv: env.CACHE_KV })
            .then((result) => console.log("backfill run completed", { from, to, inserted: result.inserted, errorCount: result.errors.length }))
            .catch((err) => console.error("backfill run failed", { from, to, message: err.message }))
        );
        const bodyHtml = renderRunAcceptedPage({
          title: "Backfill",
          detail: `Backfilling historical news from ${from} to ${to}.`,
          backLink: "/dashboard/backfill",
          backLabel: "Backfill",
        });
        return htmlResponse(renderShell({ activeSection: "backfill", sessionUsername, bodyHtml }));
      }

      // Scripted/API caller (no form body) -- keep the original synchronous
      // JSON response so nothing outside the dashboard UI breaks.
      try {
        const result = await backfillHistoricalNews(config, env.DB, { from, to, kv: env.CACHE_KV });
        console.log("backfill run completed", { from, to, inserted: result.inserted, errorCount: result.errors.length });
        return new Response(JSON.stringify({ inserted: result.inserted, errorCount: result.errors.length }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      } catch (err) {
        // A malformed request already returned 400 above -- anything thrown
        // here is a real failure (vendor/DB), not a client mistake, same
        // "surface, don't swallow" treatment as scheduled()'s try/catches.
        console.error("backfill run failed", { from, to, message: err.message });
        return new Response(JSON.stringify({ error: "backfill run failed", message: err.message }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
    }

    // Operational entry point for backtest/runBacktest.js -- the last open
    // item plan.md's "Backtest harness" Known Gaps note flagged ("wiring
    // ... together behind one real invocation ... mirroring POST /backfill's
    // own gated-secret pattern"). POST, not GET, and gated the same way
    // /backfill is: this has side effects (D1 writes) and, on the "signal
    // on" side, real Gemini calls -- see runBacktest.js's own COST WARNING.
    // Deliberately NOT wired into scheduled() -- manual-trigger only, per
    // the explicit "not automatic yet" decision this endpoint exists under.
    if (pathname === "/backtest/run" && request.method === "POST") {
      const sessionUsername = await getSessionUsername(request, config);

      if (!sessionUsername) {
        if (!isDashboardAuthConfigured(config)) {
          return new Response(JSON.stringify({ error: "backtest endpoint is not configured (set up the dashboard login)" }), {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }

      const contentType = request.headers.get("content-type") || "";
      const isFormSubmit = contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data");
      const form = isFormSubmit ? await request.formData() : null;
      const fromForm = (key) => (form ? form.get(key) : null);

      const testStart = url.searchParams.get("testStart") ?? fromForm("testStart");
      const testEnd = url.searchParams.get("testEnd") ?? fromForm("testEnd");
      const tickersParam = url.searchParams.get("tickers") ?? fromForm("tickers");
      const graceDaysParam = url.searchParams.get("graceDays") ?? fromForm("graceDays");

      if (!isPlausibleDateString((testStart || "").slice(0, 10)) || !isPlausibleDateString((testEnd || "").slice(0, 10))) {
        return new Response(JSON.stringify({ error: "testStart/testEnd query params are required, as YYYY-MM-DD (or a full ISO timestamp)" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }

      const tickers = tickersParam ? tickersParam.split(",").map((t) => t.trim()).filter(Boolean) : config.watchlist.map((w) => w.ticker);
      if (tickers.length === 0) {
        return new Response(JSON.stringify({ error: "no tickers given and config.watchlist is empty" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }

      const graceDays = graceDaysParam ? Number(graceDaysParam) : undefined;
      const id = `backtest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // Point-in-time date strings (YYYY-MM-DD) become UTC-midnight ISO
      // timestamps -- onSignalRunner.js/noSignalBaseline.js both expect full
      // ISO strings, same as every other testStart/testEnd this repo's
      // backtest package handles.
      const testStartIso = testStart.length === 10 ? `${testStart}T00:00:00.000Z` : testStart;
      const testEndIso = testEnd.length === 10 ? `${testEnd}T00:00:00.000Z` : testEnd;

      // Dashboard confirm-page submission:
      // runManualBacktest already persists a 'running' row before the slow
      // Gemini-backed part starts, so it's safe to let it finish in the
      // background and respond immediately with an accepted/in-progress
      // page instead of blocking the operator's browser on the whole run.
      if (isFormSubmit) {
        ctx.waitUntil(
          runManualBacktest(env, config, env.DB, { id, tickers, testStart: testStartIso, testEnd: testEndIso, graceDays })
            .then((outcome) => console.log("backtest run finished", { id, status: outcome.status, tickers }))
            .catch((err) => console.error("backtest run request failed", { id, message: err.message }))
        );
        const bodyHtml = renderRunAcceptedPage({
          title: "Backtest",
          detail: `Running a backtest for ${tickers.join(", ")} from ${testStart} to ${testEnd}.`,
          backLink: "/dashboard/backtest",
          backLabel: "Backtest",
        });
        return htmlResponse(renderShell({ activeSection: "backtest", sessionUsername, bodyHtml }));
      }

      // Scripted/API caller (no form body) -- keep the original synchronous
      // JSON response so nothing outside the dashboard UI breaks.
      try {
        const outcome = await runManualBacktest(env, config, env.DB, { id, tickers, testStart: testStartIso, testEnd: testEndIso, graceDays });
        console.log("backtest run finished", { id, status: outcome.status, tickers });
        return new Response(JSON.stringify(outcome), {
          status: outcome.status === "failed" ? 500 : 200,
          headers: { "content-type": "application/json" },
        });
      } catch (err) {
        // runManualBacktest itself catches and persists a failure as data
        // (status: 'failed') -- reaching here means something broke before
        // or after that (e.g. the insertBacktestRun call itself), a real
        // bug rather than an expected backtest-run failure.
        console.error("backtest run request failed", { id, message: err.message });
        return new Response(JSON.stringify({ error: "backtest run request failed", message: err.message }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
    }

    return new Response(
      "news-market-ai worker is running. Architecture and design decisions live in plan.md.",
      { status: 200 }
    );
  },

  async scheduled(event, env) {
    const config = loadConfig(env);
    console.log("scheduled run starting", { cron: event.cron, quickModel: config.geminiQuickModel, deepModel: config.geminiDeepModel });
    try {
      const results = await runScheduledIngestion(env, config, env.DB);
      console.log("scheduled run completed", { decisions: results.length });
    } catch (err) {
      // Expected for now -- see header comment. Logged, not silently dropped
      // (plan.md Adopted Pattern #11).
      console.error("scheduled run failed", { message: err.message });
    }

    // Separate try/catch: a failure evaluating exits on existing positions
    // should never be conflated with (or block on) an ingestion failure
    // above -- same Adopted Pattern #11 "surface, don't swallow" reasoning,
    // applied independently to each concern.
    try {
      const closed = await checkOpenPositionExits(env, config, env.DB, { asOf: new Date().toISOString() });
      console.log("exit check completed", { closed: closed.length, closed });
    } catch (err) {
      console.error("exit check failed", { message: err.message });
    }
  },
};
