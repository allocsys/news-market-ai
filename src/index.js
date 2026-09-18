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
//
// `queue` (plan.md Step 3) is the JOBS consumer: POST /backfill and POST
// /backtest/run below no longer run the actual work inline (synchronously
// or via ctx.waitUntil) -- they validate, enqueue a message, and return an
// immediate `{accepted: true, ...}` ack. `queue()` is a separate Worker
// invocation with its own wall-time budget, which is the actual fix for
// ctx.waitUntil's ~30-second-past-response cutoff (plan.md's Step 3
// motivation): a backfill or backtest that used to get cut off mid-run
// under load now just runs to completion in its own invocation instead.
// A business-logic failure (bad backtest run, vendor error mid-backfill) is
// caught inside queue() itself and logged/persisted as data, then acked --
// not left to the queue's own retry/dead-letter mechanism, which exists
// only for a genuine crash in queue() (a real bug), not an expected
// operational failure that already spent real quota once.

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

function newJobId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
    // browser form submission or a scripted JSON request. Since plan.md
    // Step 3, this always enqueues onto JOBS and returns an immediate ack --
    // there's no more synchronous "wait for the real counts" mode, and no
    // more ctx.waitUntil fire-and-forget mode -- both scripted and
    // form-submitted callers get the same `{accepted, id, from, to}` shape,
    // same as the old `?async=1` response did (kept intentionally: any
    // legacy `async` query param `dashboard` still sends is simply ignored
    // now, harmless). See queue() below for where the real work happens.
    if (pathname === "/backfill" && request.method === "POST") {
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      if (!isPlausibleDateString(from) || !isPlausibleDateString(to)) {
        return jsonResponse({ error: "from/to query params are required, as YYYY-MM-DD" }, { status: 400 });
      }

      const id = newJobId("backfill");
      try {
        await env.JOBS.send({ type: "backfill", id, from, to });
        return jsonResponse({ accepted: true, id, from, to });
      } catch (err) {
        console.error("backfill enqueue failed", { id, from, to, message: err.message });
        return jsonResponse({ error: "backfill enqueue failed", message: err.message }, { status: 500 });
      }
    }

    // Operational entry point for backtest/runBacktest.js -- same
    // query-string-only, always-enqueues shape as /backfill above. See
    // runBacktest.js's own COST WARNING re: real Gemini calls on the
    // "signal on" side -- that cost is now spent inside queue(), not this
    // request.
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
      const id = newJobId("backtest");

      // Point-in-time date strings (YYYY-MM-DD) become UTC-midnight ISO
      // timestamps -- onSignalRunner.js/noSignalBaseline.js both expect
      // full ISO strings.
      const testStartIso = testStart.length === 10 ? `${testStart}T00:00:00.000Z` : testStart;
      const testEndIso = testEnd.length === 10 ? `${testEnd}T00:00:00.000Z` : testEnd;

      try {
        await env.JOBS.send({ type: "backtest", id, tickers, testStart: testStartIso, testEnd: testEndIso, graceDays });
        return jsonResponse({ accepted: true, id, tickers, testStart, testEnd });
      } catch (err) {
        console.error("backtest enqueue failed", { id, tickers, message: err.message });
        return jsonResponse({ error: "backtest enqueue failed", message: err.message }, { status: 500 });
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

  // JOBS consumer (plan.md Step 3). Each message is `{ type: 'backfill', id,
  // from, to }` or `{ type: 'backtest', id, tickers, testStart, testEnd,
  // graceDays }`, enqueued by POST /backfill / POST /backtest/run above.
  // max_batch_size = 1 (wrangler.toml) means `batch.messages` is always a
  // single-element array in production, but this loops generically anyway
  // rather than assuming that stays true forever.
  //
  // Per message: a business-logic failure (a bad backtest run,
  // backfillHistoricalNews throwing on a vendor/DB error) is caught here,
  // logged, and the message is still acked -- that failure is already the
  // final, expected outcome (runManualBacktest itself persists it as a
  // 'failed' backtest_runs row; a failed backfill has nothing else useful
  // to persist since it made no lasting DB change), and retrying it would
  // just spend real Gemini/Finnhub quota again for the same result. Only an
  // unexpected crash in this handler itself (a real bug -- e.g. a malformed
  // message with no recognizable `type`, or a throw from code we didn't
  // anticipate) falls through to message.retry(), so wrangler.toml's
  // max_retries/dead_letter_queue is the safety net for that, not for
  // ordinary operational failures.
  async queue(batch, env) {
    const config = loadConfig(env);
    for (const message of batch.messages) {
      const job = message.body;
      try {
        if (job.type === "backfill") {
          const { id, from, to } = job;
          try {
            const result = await backfillHistoricalNews(config, env.DB, { from, to, kv: env.CACHE_KV });
            console.log("backfill job completed", { id, from, to, inserted: result.inserted, errorCount: result.errors.length });
          } catch (err) {
            console.error("backfill job failed", { id, from, to, message: err.message });
          }
        } else if (job.type === "backtest") {
          const { id, tickers, testStart, testEnd, graceDays } = job;
          // runManualBacktest persists its own 'running' row up front and
          // 'complete'/'failed' once it resolves -- it never throws (see its
          // own header comment), so there's no separate catch needed here
          // for the expected-failure case.
          const outcome = await runManualBacktest(env, config, env.DB, { id, tickers, testStart, testEnd, graceDays });
          console.log("backtest job finished", { id, status: outcome.status, tickers });
        } else {
          console.error("JOBS message with unrecognized type, acking without processing", { type: job?.type, id: job?.id });
        }
        message.ack();
      } catch (err) {
        console.error("JOBS message handler crashed unexpectedly, retrying", { message: err.message });
        message.retry();
      }
    }
  },
};
