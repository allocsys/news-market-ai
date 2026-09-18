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
// `scheduled` (plan.md Step 4) is now a THIN scheduler, not the pipeline
// itself: it enqueues one INGEST message per watchlist ticker plus one
// more for the general (non-ticker-scoped) feeds, and one JOBS message to
// evaluate open-position exits. It does no fetching, no D1 writes, and no
// LLM calls itself -- see queue() below for where each of those actually
// happens, each in its own small invocation with its own fresh CPU/wall-
// time budget, instead of one big scheduled() invocation doing everything
// (which is what originally hit the free-tier CPU cap Step 0 diagnosed).
//
// `queue` handles TWO queues' worth of message types through one handler
// (Cloudflare Workers routes every consumer for a script through the same
// queue() export -- there's no need to branch on which physical queue
// delivered a batch, only on the message's own `type`):
//   - JOBS (plan.md Step 3): `backfill` / `backtest`, enqueued by POST
//     /backfill and POST /backtest/run below; `exit_check` (plan.md Step
//     4), enqueued by scheduled() above, kept on its OWN message so an
//     exit-check failure is never entangled with an ingestion failure. All
//     three are ack-and-log on a business-logic failure -- see that
//     branch's own comment for why retrying wouldn't help any of them.
//   - ANALYZE (plan.md Step 4): `analyze`, enqueued by the new `ingest`
//     Worker's own INGEST consumer (src/ingest-worker.js, plan.md Step 5 --
//     this Worker no longer consumes INGEST itself, see wrangler.toml).
//     Runs runPipelineForTicker for one (ticker, newsItem) pair. UNLIKE
//     every other type here, a failure is RETRIED, not ack'd -- see that
//     branch's own comment for why that's actually correct given
//     checkpointer.js's resume semantics (Adopted Pattern #12).
//
// `ingest_ticker` / `ingest_feeds` (the INGEST queue's message types) moved
// entirely to the new `ingest` Worker (plan.md Step 5, src/ingest-worker.js)
// -- this Worker's scheduled() still ENQUEUES them (see below, unchanged),
// it just no longer consumes them itself. That Worker alone now holds
// FINNHUB_API_KEY for live ingestion and the EDGAR CIK/name-index KV cache
// (see wrangler.ingest.toml) -- with one known, deliberate exception: this
// Worker still separately holds its own FINNHUB_API_KEY too, because the
// `backfill` JOBS job below calls Finnhub directly via
// backfillHistoricalNews, and JOBS has no consumer to move that to without
// a larger redesign (see wrangler.toml's own comment on this).
//
// A business-logic failure (bad backtest run, vendor error mid-backfill,
// etc.) is caught inside its own branch and logged/persisted as data, then
// acked -- not left to the queue's own retry/dead-letter mechanism, which
// exists only for a genuine crash in queue() itself (a real bug), not an
// expected operational failure that already spent real quota once. The
// ANALYZE branch is the one deliberate exception to this, see above.

import { loadConfig } from "./config.js";
import { backfillHistoricalNews, runPipelineForTicker } from "./graph/pipeline.js";
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
    const asOf = new Date().toISOString();
    console.log("scheduled: fanning out cron tick", { cron: event.cron, tickers: config.watchlist.length });

    // INGEST fan-out (plan.md Step 4): one message per watchlist ticker,
    // batched into a single sendBatch call (one subrequest instead of N --
    // matters for the Queues ops/day budget, see plan.md's estimate), plus
    // one more for the general (non-ticker-scoped) feeds. A failure here
    // is an enqueue failure (env.INGEST.sendBatch/send itself throwing),
    // not a pipeline failure -- logged, not left to crash this invocation,
    // same Adopted Pattern #11 reasoning as before, just applied to
    // "could we even hand off the work" now instead of "did the work
    // succeed" (that question moved to queue() below).
    try {
      if (config.watchlist.length > 0) {
        const tickerMessages = config.watchlist.map(({ ticker }) => ({ body: { type: "ingest_ticker", ticker, asOf } }));
        await env.INGEST.sendBatch(tickerMessages);
      }
      await env.INGEST.send({ type: "ingest_feeds", asOf });
    } catch (err) {
      console.error("scheduled: INGEST fan-out failed", { message: err.message });
    }

    // Separate try/catch, own message, own queue (plan.md Step 4): a
    // failure enqueueing (or later processing, see queue()'s exit_check
    // branch) the exit check should never be conflated with (or block on)
    // an ingestion enqueue failure above -- same "surface, don't swallow,
    // don't conflate" reasoning the old inline scheduled() already applied
    // between ingestion and exit-checking, now applied one layer earlier,
    // at enqueue time instead of at execution time.
    try {
      await env.JOBS.send({ type: "exit_check", asOf });
    } catch (err) {
      console.error("scheduled: exit_check enqueue failed", { message: err.message });
    }
  },

  // Consumer for JOBS and ANALYZE (see module header above for the full
  // type-by-type breakdown; INGEST's consumer moved to the new `ingest`
  // Worker in Step 5, src/ingest-worker.js). max_batch_size varies per
  // queue (wrangler.toml) -- JOBS's is 1, ANALYZE's is larger -- so this
  // loops generically over `batch.messages` rather than assuming any
  // particular batch size.
  //
  // Per message: a business-logic failure (a bad backtest run,
  // backfillHistoricalNews throwing on a vendor/DB error, a failed ingest,
  // etc.) is caught inside that message type's own branch, logged, and the
  // message is still acked -- see each branch's own comment for why
  // retrying wouldn't help (ANALYZE is the one exception, see its branch).
  // An unexpected crash in this handler itself (a real bug -- e.g. a
  // malformed message with no recognizable `type`, or a throw from code we
  // didn't anticipate) falls through to message.retry(), so wrangler.toml's
  // max_retries/dead_letter_queue on each queue is the safety net for that,
  // not for ordinary operational failures.
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
        } else if (job.type === "exit_check") {
          // Own message, own queue (plan.md Step 4) -- isolated from
          // INGEST/ANALYZE failures by construction, since this message
          // only ever arrives via JOBS, a completely separate queue/
          // consumer path from either. A failure here is logged and acked,
          // same ack-not-retry reasoning as backfill/backtest above:
          // checkOpenPositionExits already isolates a single position's
          // own exit-evaluation failure internally (see that function's
          // header), so a throw reaching here is a real, unexpected
          // failure -- but retrying wouldn't recover anything either, the
          // next scheduled tick re-evaluates every still-open position
          // regardless.
          try {
            const closed = await checkOpenPositionExits(env, config, env.DB, { asOf: job.asOf });
            console.log("exit_check job completed", { closed: closed.length, closed });
          } catch (err) {
            console.error("exit_check job failed", { message: err.message });
          }
        } else if (job.type === "analyze") {
          // ANALYZE consumer (plan.md Step 4). Deliberately NOT wrapped in its
          // own try/catch the way every branch above is -- a failure here
          // falls through to this function's own outer catch below, which
          // calls message.retry() instead of ack()ing. That's the correct,
          // intentional difference from every other message type in this
          // handler: runPipelineForTicker is checkpoint-resumable (Adopted
          // Pattern #12, graph/checkpointer.js) -- a retried ANALYZE message
          // re-enters resumeFrom and only re-runs whatever stage didn't
          // finish last time, never re-spending an LLM call on an
          // already-checkpointed stage, and never double-opening a position
          // (openPosition's own id-based ON CONFLICT DO NOTHING, see
          // pipeline.js). So retrying costs nothing extra and can actually
          // finish the job, unlike backfill/backtest/exit_check/ingest_*
          // above, where a retry would just redo (and re-spend quota on)
          // work that's already done. wrangler.toml's max_retries/
          // dead_letter_queue on the ANALYZE queue is the real safety net
          // for a persistently failing ticker/item, not a nested try/catch
          // here.
          const { runId, ticker, newsItem, asOf: itemAsOf } = job;
          await runPipelineForTicker(env, config, env.DB, { runId, ticker, newsItem, asOf: itemAsOf });
        } else {
          console.error("queue message with unrecognized type, acking without processing", { type: job?.type, id: job?.id });
        }
        message.ack();
      } catch (err) {
        console.error("queue message handler crashed unexpectedly, retrying", { message: err.message });
        message.retry();
      }
    }
  },
};
