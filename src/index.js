// `backend` Worker entry point. `fetch` serves the JSON API (/api/*,
// /backfill, /backtest/run) and `scheduled` runs the cron tick, exactly
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
// `scheduled` (plan.md Step 4) is a THIN scheduler, not the pipeline
// itself: it enqueues one INGEST message per watchlist ticker plus one
// more for the general (non-ticker-scoped) feeds, and one LLM_JOBS message
// to evaluate open-position exits. It does no fetching, no D1 writes, and
// no LLM calls itself -- INGEST's consumer is the `ingest` Worker
// (src/ingest-worker.js, plan.md Step 5), LLM_JOBS's is the `llm` Worker
// (src/llm-worker.js, plan.md Step 6), each running in its own small
// invocation with its own fresh CPU/wall-time budget instead of one big
// scheduled() invocation doing everything (which is what originally hit the
// free-tier CPU cap Step 0 diagnosed).
//
// This Worker has NO `queue()` export and consumes nothing (Step 5
// follow-up, 2026-09-20). Its last consumer, JOBS's `backfill` handler,
// moved to the `ingest` Worker (src/ingest-worker.js) along with the queue
// itself, renamed BACKFILL -- see wrangler.toml's own comment on that
// queue's history. Everything else this Worker used to consume had already
// moved out earlier:
//   - `ingest_ticker` / `ingest_feeds` (INGEST) -> the `ingest` Worker,
//     plan.md Step 5.
//   - `analyze` and `exit_check` (both formerly JOBS) -> the `llm` Worker,
//     plan.md Step 6, onto a new LLM_JOBS queue (this Worker still
//     PRODUCES onto it).
//   - `backtest` moved again in M3, off LLM_JOBS and onto its own BACKTEST
//     queue (this Worker still PRODUCES onto it) for the new `backtest`
//     Worker (wrangler.backtest.toml).
// This Worker now PRODUCES onto four queues (INGEST, LLM_JOBS, BACKTEST,
// BACKFILL) and consumes none of them -- every message type it used to
// handle now runs in the Worker that actually needs the matching vendor
// key (Finnhub for `ingest`, Gemini for `llm`/`backtest`).
//
// This Worker holds NO vendor key at all anymore: no FINNHUB_API_KEY (moved
// to wrangler.ingest.toml with the BACKFILL consumer) and no Gemini key
// (moved to wrangler.llm.toml in Step 6).

import { loadConfig } from "./config.js";
import { createJobReporter } from "./storage/jobs.js";
import { RunStore } from "./storage/run_store.js";
import { SimClock } from "./backtest/simClock.js";
import {
  handleApiSnapshotRoute,
  handleApiActivityRoute,
  handleApiChartsRoute,
  handleApiHealthRoute,
  handleApiDecisionsRoute,
  handleApiPositionsRoute,
  handleApiPipelineRoute,
  handleApiBacktestRunsRoute,
  handleApiLlmCallsRoute,
  handleApiLlmCallRoute,
  handleApiJobRoute,
  handleApiActiveJobRoute,
  handleApiLatestJobRoute,
} from "./dashboard/api.js";

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

/**
 * A real calendar date in YYYY-MM-DD form. isPlausibleDateString accepts
 * "2024-02-30"; POST /backfill leaves that to Finnhub, but a price backfill
 * turns from/to into unix timestamps, so a bad date would only fail later,
 * inside the job. Used by POST /backfill-prices.
 */
function isRealDate(value) {
  if (!isPlausibleDateString(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

// POST /backfill-prices ticker list: Yahoo-style symbols (BRK-B, ^GSPC, EURUSD=X), bounded.
const MAX_PRICE_BACKFILL_TICKERS = 10;
const PRICE_TICKER_PATTERN = /^[A-Z0-9^.=-]{1,12}$/;

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
    // LLM call log (storage/llm_calls.js): list, then one call in full.
    if (pathname === "/api/llm-calls") return handleApiLlmCallsRoute(request, env, config);
    if (pathname.startsWith("/api/llm-calls/")) return handleApiLlmCallRoute(request, env, config, pathname.slice("/api/llm-calls/".length));

    // Newest in-flight job of a type, for pages that need to show progress
    // for a job submitted earlier. MUST stay above the /api/jobs/ prefix
    // match below, or "active" would be looked up as a job id.
    if (pathname === "/api/jobs/active") return handleApiActiveJobRoute(request, env, config);
    // Most recent FINISHED job of a type, for pages that show how the last run
    // ended. Same rule: above the prefix match, or "latest" would be a job id.
    if (pathname === "/api/jobs/latest") return handleApiLatestJobRoute(request, env, config);

    // Live progress for one job (src/storage/jobs.js's job_progress table),
    // read by `dashboard` at /dashboard/jobs/:id (which polls this on the
    // operator's behalf -- see src/dashboard-worker.js). :id is whatever
    // POST /backfill or POST /backtest/run returned as `id` below.
    if (pathname.startsWith("/api/jobs/")) {
      const id = pathname.slice("/api/jobs/".length);
      if (!id) return jsonResponse({ error: "job id required" }, { status: 400 });
      return handleApiJobRoute(request, env, config, id);
    }

    // Operational entry point for ingestion/ingest.js#backfillHistoricalNews (writes INPUTS_DB
    // since M2; the job row lives in LIVE_DB's job_progress under run_id 'live', since M2b).
    // Query-string only (from/to) -- `dashboard` is the only caller and
    // always forwards as query params, whether it originally received a
    // browser form submission or a scripted JSON request. Since plan.md
    // Step 3, this always enqueues (onto BACKFILL as of the Step 5
    // follow-up -- see wrangler.toml; used to be JOBS, consumed here) and
    // returns an immediate ack -- there's no more synchronous "wait for the
    // real counts" mode, and no more ctx.waitUntil fire-and-forget mode --
    // both scripted and form-submitted callers get the same
    // `{accepted, id, from, to}` shape, same as the old `?async=1` response
    // did (kept intentionally: any legacy `async` query param `dashboard`
    // still sends is simply ignored now, harmless). The real work now runs
    // in the `ingest` Worker's queue() (src/ingest-worker.js).
    if (pathname === "/backfill" && request.method === "POST") {
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      if (!isPlausibleDateString(from) || !isPlausibleDateString(to)) {
        return jsonResponse({ error: "from/to query params are required, as YYYY-MM-DD" }, { status: 400 });
      }

      const id = newJobId("backfill");
      // 'queued' row written before the message is even sent -- best-effort
      // (createJobReporter swallows D1 failures, see storage/jobs.js), so a
      // progress-write hiccup here can never block the real enqueue below.
      await createJobReporter(new RunStore(env.LIVE_DB, "live"), { id, type: "backfill", params: { from, to } }).queued();
      try {
        await env.BACKFILL.send({ type: "backfill", id, from, to });
        return jsonResponse({ accepted: true, id, from, to });
      } catch (err) {
        console.error("backfill enqueue failed", { id, from, to, message: err.message });
        return jsonResponse({ error: "backfill enqueue failed", message: err.message }, { status: 500 });
      }
    }

    // Operational entry point for ingestion/ingest.js#backfillHistoricalPriceBars
    // (Next Steps step A, plan.md) -- writes INPUTS_DB, job row in LIVE_DB's
    // job_progress under run_id 'live', SAME pattern as POST /backfill just
    // above (own job id/type "backfill_prices", enqueued onto the same
    // BACKFILL queue -- see ingest-worker.js's queue() for why this reuses
    // that queue rather than provisioning a new one). `tickers` is optional
    // (comma-separated; defaults to the whole watchlist, resolved inside
    // backfillHistoricalPriceBars itself so the accepted-response echo below
    // can show it either way).
    if (pathname === "/backfill-prices" && request.method === "POST") {
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      if (!isPlausibleDateString(from) || !isPlausibleDateString(to)) {
        return jsonResponse({ error: "from/to query params are required, as YYYY-MM-DD" }, { status: 400 });
      }
      if (!isRealDate(from) || !isRealDate(to)) {
        return jsonResponse({ error: "from/to must be real calendar dates (YYYY-MM-DD)" }, { status: 400 });
      }
      if (from > to) {
        return jsonResponse({ error: "from must not be after to" }, { status: 400 });
      }

      // Omitted or empty means the whole watchlist. Otherwise every entry must look like a symbol,
      // so an arbitrary string never reaches the Yahoo URL or the job row.
      const tickersParam = url.searchParams.get("tickers");
      let tickers;
      if (tickersParam) {
        tickers = [...new Set(tickersParam.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean))];
        if (tickers.length === 0 || tickers.length > MAX_PRICE_BACKFILL_TICKERS || tickers.some((t) => !PRICE_TICKER_PATTERN.test(t))) {
          return jsonResponse({ error: `tickers must be 1-${MAX_PRICE_BACKFILL_TICKERS} comma-separated symbols (letters, digits, . - ^ =)` }, { status: 400 });
        }
      }

      const id = newJobId("backfill-prices");
      await createJobReporter(new RunStore(env.LIVE_DB, "live"), { id, type: "backfill_prices", params: { from, to, tickers } }).queued();
      try {
        await env.BACKFILL.send({ type: "backfill_prices", id, from, to, tickers });
        return jsonResponse({ accepted: true, id, from, to, tickers: tickers ?? config.watchlist.map((w) => w.ticker) });
      } catch (err) {
        console.error("backfill-prices enqueue failed", { id, from, to, message: err.message });
        return jsonResponse({ error: "backfill-prices enqueue failed", message: err.message }, { status: 500 });
      }
    }

    // POST /backtest/run: RE-ENABLED (M3) -- enqueues onto BACKTEST for the
    // new `backtest` Worker (wrangler.backtest.toml) instead of running
    // inline or (pre-M2) via LLM_JOBS. Query-string only, same shape as the
    // pre-M2 route (git history, commit 62ce1f8): testStart/testEnd
    // (YYYY-MM-DD or full ISO), tickers (comma-separated, defaults to the
    // watchlist), graceDays (optional).
    //
    // Two validation layers, in order:
    //   1. shape (isPlausibleDateString, non-empty tickers) -- 400, same as
    //      always.
    //   2. NEW in M3: testEnd must not be in the future (SimClock's
    //      assertNotFuture) -- a caller-requested future window is a
    //      request-level mistake (there's no future news/price data to
    //      backtest against), so this fails loudly here, before a job row
    //      exists or anything is enqueued, rather than letting the backtest
    //      Worker discover it three hops later. This deliberately checks
    //      only testEnd, not testStart+graceDays' computed walk-end -- that
    //      computed overshoot is clampEnd's job, inside the runner itself
    //      (src/backtest/onSignalRunner.js), not a caller mistake worth
    //      rejecting here.
    //
    // The job_progress row is written via RunStore(env.SIM_DB, id) -- NOT
    // RunStore(env.LIVE_DB, "live") the way POST /backfill's row is above.
    // Since M1/M2b every backtest gets its own run_id from the moment it's
    // created, never 'live': this is a `sim` environment row, scoped and
    // queryable (and eventually delete-by-run-cleanable) independently of
    // every other backtest and of the live run.
    if (pathname === "/backtest/run" && request.method === "POST") {
      const testStart = url.searchParams.get("testStart");
      const testEnd = url.searchParams.get("testEnd");
      const tickersParam = url.searchParams.get("tickers");
      const graceDaysParam = url.searchParams.get("graceDays");

      if (!isPlausibleDateString((testStart || "").slice(0, 10)) || !isPlausibleDateString((testEnd || "").slice(0, 10))) {
        return jsonResponse({ error: "testStart/testEnd query params are required, as YYYY-MM-DD (or a full ISO timestamp)" }, { status: 400 });
      }

      const tickers = tickersParam
        ? tickersParam.split(",").map((t) => t.trim()).filter(Boolean)
        : config.watchlist.map((w) => w.ticker);
      if (tickers.length === 0) {
        return jsonResponse({ error: "no tickers given and config.watchlist is empty" }, { status: 400 });
      }

      const graceDaysRaw = graceDaysParam ? Number(graceDaysParam) : undefined;
      if (graceDaysParam !== null && graceDaysParam !== "" && !Number.isFinite(graceDaysRaw)) {
        return jsonResponse({ error: "graceDays must be a number" }, { status: 400 });
      }
      const graceDays = graceDaysRaw;

      // Point-in-time date strings (YYYY-MM-DD) become UTC-midnight ISO
      // timestamps -- onSignalRunner.js/noSignalBaseline.js both expect
      // full ISO strings.
      const testStartIso = testStart.length === 10 ? `${testStart}T00:00:00.000Z` : testStart;
      const testEndIso = testEnd.length === 10 ? `${testEnd}T00:00:00.000Z` : testEnd;

      try {
        new SimClock().assertNotFuture(testEndIso, "testEnd");
      } catch (err) {
        return jsonResponse({ error: err.message }, { status: 400 });
      }

      const id = newJobId("backtest");
      // 'queued' row written before the message is even sent -- best-effort
      // (createJobReporter swallows D1 failures, see storage/jobs.js), so a
      // progress-write hiccup here can never block the real enqueue below.
      // env_run_id/run_id = this backtest's own id, in SIM_DB.
      await createJobReporter(new RunStore(env.SIM_DB, id), { id, type: "backtest", params: { tickers, testStart, testEnd, graceDays } }).queued();
      try {
        await env.BACKTEST.send({ type: "backtest", id, tickers, testStart: testStartIso, testEnd: testEndIso, graceDays });
        return jsonResponse({ accepted: true, id, tickers, testStart, testEnd });
      } catch (err) {
        console.error("backtest enqueue failed", { id, tickers, message: err.message });
        return jsonResponse({ error: "backtest enqueue failed", message: err.message }, { status: 500 });
      }
    }

    return new Response("news-market-ai backend worker is running (private -- see wrangler.toml). Architecture in plan.md.", { status: 200 });
  },
  // No `queue()` export: this Worker has no queue consumers (Step 5
  // follow-up, 2026-09-20). It briefly needed a TRANSITIONAL no-op handler
  // here for one deploy (see git history / plan.md) -- Cloudflare rejects a
  // script upload with no queue() export while a queue consumer trigger is
  // still attached from the Worker's last successful deploy ("Queue
  // handler is missing", code 11001), and this Worker's last deploy before
  // that still had the old JOBS consumer live. That deploy (#328) went
  // through clean, and the observability log shows zero queue-eventType
  // invocations on this Worker since -- confirming JOBS's trigger actually
  // detached, not just that no messages happened to arrive (nothing
  // produces onto JOBS anymore either way, so silence alone wouldn't have
  // proven it). The transitional handler and its test
  // (test/index_queue_transitional.test.js) are removed in this same
  // commit.

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
    // succeed" (that question moved to the `ingest` Worker's queue()).
    try {
      if (config.watchlist.length > 0) {
        const tickerMessages = config.watchlist.map(({ ticker }) => ({ body: { type: "ingest_ticker", ticker, asOf } }));
        await env.INGEST.sendBatch(tickerMessages);
      }
      await env.INGEST.send({ type: "ingest_feeds", asOf });
    } catch (err) {
      console.error("scheduled: INGEST fan-out failed", { message: err.message });
    }

    // Separate try/catch, own message, own queue (plan.md Step 4, LLM_JOBS
    // since Step 6): a failure enqueueing (or later processing, see the
    // `llm` Worker's exit_check branch) the exit check should never be
    // conflated with (or block on) an ingestion enqueue failure above --
    // same "surface, don't swallow, don't conflate" reasoning the old
    // inline scheduled() already applied between ingestion and
    // exit-checking, now applied one layer earlier, at enqueue time instead
    // of at execution time.
    try {
      await env.LLM_JOBS.send({ type: "exit_check", asOf });
    } catch (err) {
      console.error("scheduled: exit_check enqueue failed", { message: err.message });
    }
  },
};
