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
import { renderDashboardHtml } from "./dashboard.js";
import { runManualBacktest } from "./backtest/runBacktest.js";
import { renderLoginPage } from "./login.js";
import { SESSION_COOKIE_NAME, getSessionUsername, createSessionCookie, clearSessionCookie } from "./auth/session.js";

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
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const config = loadConfig(env);

    if (pathname === "/dashboard") {
      // Guarded only once login is actually configured -- see
      // isDashboardAuthConfigured's own header for why an unconfigured
      // login leaves this route exactly as unauthenticated as before.
      if (isDashboardAuthConfigured(config)) {
        const sessionUsername = await getSessionUsername(request, config);
        if (!sessionUsername) return redirect("/login");
      }
      const sessionUsername = isDashboardAuthConfigured(config) ? await getSessionUsername(request, config) : null;
      const html = await renderDashboardHtml(env.DB, { searchParams: url.searchParams, sessionUsername });
      return htmlResponse(html);
    }

    if (pathname === "/login" && request.method === "GET") {
      if (!isDashboardAuthConfigured(config)) {
        return htmlResponse(renderLoginPage({ disabled: true }), { status: 503 });
      }
      // Already logged in -- no reason to show the form again.
      const sessionUsername = await getSessionUsername(request, config);
      if (sessionUsername) return redirect("/dashboard");
      const error = url.searchParams.get("error") === "invalid" ? "Invalid username or password." : null;
      return htmlResponse(renderLoginPage({ error }));
    }

    if (pathname === "/login" && request.method === "POST") {
      if (!isDashboardAuthConfigured(config)) {
        return htmlResponse(renderLoginPage({ disabled: true }), { status: 503 });
      }
      const { username, password } = await readLoginForm(request);
      // Plain equality, same convention as backfillApiSecret/backtestApiSecret
      // elsewhere in this file -- see those checks' own history. A single
      // operator credential pair checked once per login (not per request,
      // unlike the API secrets), so the timing-attack surface here is far
      // smaller than a per-request header comparison.
      if (username !== config.dashboardUsername || password !== config.dashboardPassword) {
        return htmlResponse(renderLoginPage({ error: "Invalid username or password." }), { status: 401 });
      }
      const cookie = await createSessionCookie(username, config);
      return redirect("/dashboard", { "Set-Cookie": cookie });
    }

    if (pathname === "/logout") {
      // GET, not POST -- this is a plain <a href="/logout"> link (see
      // dashboard.js's rail-meta), same zero-client-JS philosophy as every
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
      // Two independent ways in: an active dashboard login session (the
      // browser's own form submit, cookie sent automatically -- no secret
      // typed at all, see dashboard.js#backfillTriggerForm), or the
      // scripted/curl path below (X-Backfill-Secret header or a `secret`
      // form field, unchanged). Either alone is sufficient.
      const sessionUsername = await getSessionUsername(request, config);

      const contentType = request.headers.get("content-type") || "";
      const form = contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")
        ? await request.formData()
        : null;
      const fromForm = (key) => (form ? form.get(key) : null);

      const secret = request.headers.get("X-Backfill-Secret") ?? fromForm("secret");
      const secretAuthorized = Boolean(config.backfillApiSecret) && secret === config.backfillApiSecret;

      if (!sessionUsername && !secretAuthorized) {
        // Disabled, not "open to anyone," when NEITHER auth path is even
        // configured -- see config.js#backfillApiSecret's header for why
        // an unset secret has no default, and isDashboardAuthConfigured
        // above for the login side of the same reasoning.
        if (!config.backfillApiSecret && !isDashboardAuthConfigured(config)) {
          return new Response(JSON.stringify({ error: "backfill endpoint is not configured (set BACKFILL_API_SECRET or the dashboard login)" }), {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }

      const from = url.searchParams.get("from") ?? fromForm("from");
      const to = url.searchParams.get("to") ?? fromForm("to");
      if (!isPlausibleDateString(from) || !isPlausibleDateString(to)) {
        return new Response(JSON.stringify({ error: "from/to query params are required, as YYYY-MM-DD" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }

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
      // Same dual-auth-path convention as /backfill above -- an active
      // dashboard session, or the scripted/curl secret path.
      const sessionUsername = await getSessionUsername(request, config);

      const contentType = request.headers.get("content-type") || "";
      const form = contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")
        ? await request.formData()
        : null;
      const fromForm = (key) => (form ? form.get(key) : null);

      const secret = request.headers.get("X-Backtest-Secret") ?? fromForm("secret");
      const secretAuthorized = Boolean(config.backtestApiSecret) && secret === config.backtestApiSecret;

      if (!sessionUsername && !secretAuthorized) {
        if (!config.backtestApiSecret && !isDashboardAuthConfigured(config)) {
          return new Response(JSON.stringify({ error: "backtest endpoint is not configured (set BACKTEST_API_SECRET or the dashboard login)" }), {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }

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

      try {
        // Point-in-time date strings (YYYY-MM-DD) become UTC-midnight ISO
        // timestamps -- onSignalRunner.js/noSignalBaseline.js both expect
        // full ISO strings, same as every other testStart/testEnd this
        // repo's backtest package handles.
        const testStartIso = testStart.length === 10 ? `${testStart}T00:00:00.000Z` : testStart;
        const testEndIso = testEnd.length === 10 ? `${testEnd}T00:00:00.000Z` : testEnd;

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
