// `backend` Worker entry point. `fetch` serves the JSON API (/api/*,
// /backfill, /backtest/run) and `scheduled` runs the cron pipeline, exactly
// as before -- what changed in Step 2 is everything HTML/login: that moved
// to the new `dashboard` Worker (src/dashboard-worker.js), which is now the
// only public entry point. `backend` has no public route (see wrangler.toml)
// -- reachable only via `dashboard`'s BACKEND service binding -- so the
// routes below no longer check a session cookie themselves; the caller
// already did, one hop up. This is the "fails closed instead of serving an
// open dashboard when login is unconfigured" property plan.md's Step 2
// describes: there is no code path left in this Worker that could serve an
// unauthenticated dashboard, because there is no dashboard here at all.
//
// `scheduled` calls graph/pipeline.js#runScheduledIngestion, fully wired
// end to end: gdelt/rss/html_scrape news ingestion + yfinance price bars +
// edgar_fundamentals facts -> analysts (incl. technical, fed by the price
// bars above) -> debate -> trader -> risk -> portfolio (see that file's
// header for current caveats and the per-source failure isolation model).
// Any remaining failure (network, malformed vendor response, LLM cascade
// exhausted) is caught and logged here rather than left to crash the
// Worker invocation silently (Adopted Pattern #11).

import { loadConfig } from "./config.js";
import { runScheduledIngestion, backfillHistoricalNews } from "./graph/pipeline.js";
import { checkOpenPositionExits } from "./graph/exit_check.js";
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

function jsonResponse(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    const config = loadConfig(env);

    // JSON API layer (plan.md Step 1), unauthenticated at this layer since
    // Step 2: the only caller that can reach this Worker at all is
    // `dashboard`'s service binding, which already gated the request on a
    // session cookie before forwarding.
    if (pathname === "/api/snapshot") return handleApiSnapshotRoute(request, env, config);
    if (pathname === "/api/activity") return handleApiActivityRoute(request, env, config);
    if (pathname === "/api/charts") return handleApiChartsRoute(request, env, config);
    if (pathname === "/api/health") return handleApiHealthRoute(request, env, config);
    if (pathname === "/api/decisions") return handleApiDecisionsRoute(request, env, config);
    if (pathname === "/api/positions") return handleApiPositionsRoute(request, env, config);
    if (pathname === "/api/pipeline") return handleApiPipelineRoute(request, env, config);
    if (pathname === "/api/backtest-runs") return handleApiBacktestRunsRoute(request, env, config);

    // Operational entry point for graph/pipeline.js#backfillHistoricalNews.
    // Query-string only (from/to) -- `dashboard` is the only caller and
    // always forwards as query params, whether it originally received a
    // browser form submission or a scripted JSON request. `?async=1`
    // (set by `dashboard` only for a browser form submission) picks
    // between the two response modes: fire-and-forget via ctx.waitUntil
    // with an immediate ack (browser doesn't wait on a long run), or
    // synchronous with the real counts (scripted caller wants the answer).
    if (pathname === "/backfill" && request.method === "POST") {
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      if (!isPlausibleDateString(from) || !isPlausibleDateString(to)) {
        return jsonResponse({ error: "from/to query params are required, as YYYY-MM-DD" }, { status: 400 });
      }

      if (url.searchParams.get("async") === "1") {
        ctx.waitUntil(
          backfillHistoricalNews(config, env.DB, { from, to, kv: env.CACHE_KV })
            .then((result) => console.log("backfill run completed", { from, to, inserted: result.inserted, errorCount: result.errors.length }))
            .catch((err) => console.error("backfill run failed", { from, to, message: err.message }))
        );
        return jsonResponse({ accepted: true, from, to });
      }

      try {
        const result = await backfillHistoricalNews(config, env.DB, { from, to, kv: env.CACHE_KV });
        console.log("backfill run completed", { from, to, inserted: result.inserted, errorCount: result.errors.length });
        return jsonResponse({ inserted: result.inserted, errorCount: result.errors.length });
      } catch (err) {
        // A malformed request already returned 400 above -- anything thrown
        // here is a real failure (vendor/DB), not a client mistake, same
        // "surface, don't swallow" treatment as scheduled()'s try/catches.
        console.error("backfill run failed", { from, to, message: err.message });
        return jsonResponse({ error: "backfill run failed", message: err.message }, { status: 500 });
      }
    }

    // Operational entry point for backtest/runBacktest.js -- same
    // query-string-only, `?async=1`-flag shape as /backfill above. See
    // runBacktest.js's own COST WARNING re: real Gemini calls on the
    // "signal on" side.
    if (pathname === "/backtest/run" && request.method === "POST") {
      const testStart = url.searchParams.get("testStart");
      const testEnd = url.searchParams.get("testEnd");
      const tickersParam = url.searchParams.get("tickers");
      const graceDaysParam = url.searchParams.get("graceDays");

      if (!isPlausibleDateString((testStart || "").slice(0, 10)) || !isPlausibleDateString((testEnd || "").slice(0, 10))) {
        return jsonResponse({ error: "testStart/testEnd query params are required, as YYYY-MM-DD (or a full ISO timestamp)" }, { status: 400 });
      }

      const tickers = tickersParam ? tickersParam.split(",").map((t) => t.trim()).filter(Boolean) : config.watchlist.map((w) => w.ticker);
      if (tickers.length === 0) {
        return jsonResponse({ error: "no tickers given and config.watchlist is empty" }, { status: 400 });
      }

      const graceDays = graceDaysParam ? Number(graceDaysParam) : undefined;
      const id = `backtest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // Point-in-time date strings (YYYY-MM-DD) become UTC-midnight ISO
      // timestamps -- onSignalRunner.js/noSignalBaseline.js both expect
      // full ISO strings.
      const testStartIso = testStart.length === 10 ? `${testStart}T00:00:00.000Z` : testStart;
      const testEndIso = testEnd.length === 10 ? `${testEnd}T00:00:00.000Z` : testEnd;

      if (url.searchParams.get("async") === "1") {
        ctx.waitUntil(
          runManualBacktest(env, config, env.DB, { id, tickers, testStart: testStartIso, testEnd: testEndIso, graceDays })
            .then((outcome) => console.log("backtest run finished", { id, status: outcome.status, tickers }))
            .catch((err) => console.error("backtest run request failed", { id, message: err.message }))
        );
        return jsonResponse({ accepted: true, id, tickers, testStart, testEnd });
      }

      try {
        const outcome = await runManualBacktest(env, config, env.DB, { id, tickers, testStart: testStartIso, testEnd: testEndIso, graceDays });
        console.log("backtest run finished", { id, status: outcome.status, tickers });
        return jsonResponse(outcome, { status: outcome.status === "failed" ? 500 : 200 });
      } catch (err) {
        // runManualBacktest itself catches and persists a failure as data
        // (status: 'failed') -- reaching here means something broke before
        // or after that (e.g. the insertBacktestRun call itself), a real
        // bug rather than an expected backtest-run failure.
        console.error("backtest run request failed", { id, message: err.message });
        return jsonResponse({ error: "backtest run request failed", message: err.message }, { status: 500 });
      }
    }

    return new Response("news-market-ai backend worker is running (private -- see wrangler.toml). Architecture in plan.md.", { status: 200 });
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
