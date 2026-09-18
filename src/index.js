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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === "/dashboard") {
      const html = await renderDashboardHtml(env.DB, { searchParams: url.searchParams });
      return new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    // Operational entry point for graph/pipeline.js#backfillHistoricalNews
    // -- see plan.md's Backlog note this closes ("backfillHistoricalNews
    // isn't yet wired to any operational entry point"). POST, not GET:
    // this has side effects (real Finnhub calls, D1 writes), unlike
    // /dashboard's read-only GET.
    if (pathname === "/backfill" && request.method === "POST") {
      const config = loadConfig(env);

      // Disabled, not "open to anyone," when unconfigured -- see
      // config.js#backfillApiSecret's header for why this has no default.
      if (!config.backfillApiSecret) {
        return new Response(JSON.stringify({ error: "backfill endpoint is not configured (BACKFILL_API_SECRET unset)" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      if (request.headers.get("X-Backfill-Secret") !== config.backfillApiSecret) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }

      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
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
      const config = loadConfig(env);

      if (!config.backtestApiSecret) {
        return new Response(JSON.stringify({ error: "backtest endpoint is not configured (BACKTEST_API_SECRET unset)" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      if (request.headers.get("X-Backtest-Secret") !== config.backtestApiSecret) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }

      const testStart = url.searchParams.get("testStart");
      const testEnd = url.searchParams.get("testEnd");
      const tickersParam = url.searchParams.get("tickers");
      const graceDaysParam = url.searchParams.get("graceDays");

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
