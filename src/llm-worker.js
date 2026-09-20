// `llm` Worker entry point (plan.md Step 6). Owns every code path that calls
// Gemini -- there is no other Worker in this repo that does after this step,
// and this is the only one that holds `GEMINI_API_KEYS` (see
// wrangler.llm.toml). Three message types, arriving over two queues:
//
//   - ANALYZE (plan.md Step 4, consumer moved here from `backend` in Step 6):
//     `analyze`, one per (ticker, newsItem) pair, enqueued by the `ingest`
//     Worker's INGEST consumer (src/ingest-worker.js). Runs
//     runPipelineForTicker -- analysts -> debate -> trader -> risk ->
//     portfolio. Its `max_concurrency` (wrangler.llm.toml) is the actual
//     Gemini throttle. UNLIKE the other two types below, a failure here is
//     RETRIED, not ack'd -- see that branch's own comment.
//   - LLM_JOBS (new in Step 6): `backtest` and `exit_check`, moved here from
//     `backend`'s JOBS consumer. Both call Gemini, which is the whole reason
//     they had to move: `backtest` runs the real pipeline over backfilled
//     news (onSignalRunner.js -> runPipelineForTicker), and `exit_check`
//     closes positions and then generates a reflection per close
//     (settle.js -> closeTheLoop -> callStructured). Leaving them on JOBS
//     would have kept `backend` holding Gemini keys, missing this step's
//     "no other Worker holds Gemini keys" goal outright. `backend` still
//     PRODUCES both (POST /backtest/run, scheduled()) via its LLM_JOBS
//     binding -- it just no longer consumes them. JOBS itself now carries
//     `backfill` only (Finnhub, no LLM).
//
// Same ack-and-log-on-business-logic-failure convention `backend`'s queue()
// already established for backtest/exit_check (moved verbatim, not
// changed): no partial state worth resuming, and a retry would just
// re-spend Gemini quota on a result that's already known. An unexpected
// crash in this handler itself (a real bug -- e.g. a malformed message)
// falls through to message.retry(), so each consumer's max_retries/
// dead_letter_queue in wrangler.llm.toml is the safety net for that.
//
// STATE (M2/M2b): analyze and exit_check run against a per-message context --
// INPUTS_DB read-only + a RunStore("live") on LIVE_DB. llm_calls and
// job_progress live in that same state DB (M2b), through that same RunStore.
// The old DB binding (env.DB) is no longer read or written here. The
// `backtest` message type is REJECTED loudly (job marked failed, nothing
// run): backtests run on the `backtest` Worker off the BACKTEST queue (M3), and
// this Worker never binds SIM_DB. Nothing produces one on LLM_JOBS any more; the
// branch stays as a loud guard against a stray or stale message. Only `backend` runs migrations. Same CACHE_KV namespace the other
// Workers use -- the Gemini cascade's `gemini:cooldown:<model>:<keyIndex>`
// keys (src/shared/cooldown.js) are prefix-namespaced, and after this step
// only this Worker's code path writes them.

import { loadConfig } from "./config.js";
import { runPipelineForTicker } from "./graph/pipeline.js";
import { checkOpenPositionExits } from "./graph/exit_check.js";
import { RunStore, readOnly } from "./storage/run_store.js";
import { createJobReporter } from "./storage/jobs.js";
import { withLlmLogContext } from "./storage/llm_calls.js";

// Per-message engine context (M2). `inputs` is a read-only handle onto the
// shared inputs DB (this Worker never writes news/price/fundamentals --
// only `ingest` and backend's backfill do), `store` is the live run's
// RunStore on LIVE_DB. Built per message, not per Worker, so a test can hand
// each invocation its own fake env.
function buildLiveContext(env) {
  return { inputs: readOnly(env.INPUTS_DB), store: new RunStore(env.LIVE_DB, "live") };
}

export default {
  async fetch() {
    return new Response("news-market-ai llm worker is running (private, queue-consumer only -- see wrangler.llm.toml). Architecture in plan.md.", { status: 200 });
  },

  // Consumer for ANALYZE and LLM_JOBS (wrangler.llm.toml's two
  // `[[queues.consumers]]` blocks). Cloudflare routes every consumer for a
  // script through this one queue() export, so this branches on the
  // message's own `type`, not on which physical queue delivered the batch
  // -- same approach as backend's queue() before Step 6.
  async queue(batch, env) {
    const config = loadConfig(env);
    for (const message of batch.messages) {
      const job = message.body;
      try {
        if (job.type === "analyze") {
          // ANALYZE consumer (plan.md Step 4, moved here unchanged in Step
          // 6). Deliberately NOT wrapped in its own try/catch the way the
          // branches below are -- a failure here falls through to this
          // function's own outer catch, which calls message.retry()
          // instead of ack()ing. That's the correct, intentional
          // difference: runPipelineForTicker is checkpoint-resumable
          // (Adopted Pattern #12, graph/checkpointer.js) -- a retried
          // ANALYZE message re-enters resumeFrom and only re-runs whatever
          // stage didn't finish last time, never re-spending an LLM call on
          // an already-checkpointed stage, and never double-opening a
          // position (openPosition's own id-based ON CONFLICT DO NOTHING,
          // see pipeline.js). So retrying costs nothing extra and can
          // actually finish the job. wrangler.llm.toml's max_retries/
          // dead_letter_queue on the ANALYZE consumer is the real safety
          // net for a persistently failing ticker/item.
          // The ANALYZE wire field stays `runId` (it is the news item's id,
          // set by the ingest Worker); inside the engine it is the
          // pipelineRunId that keys checkpoints and the thesis id.
          const { runId, ticker, newsItem, asOf: itemAsOf } = job;
          await runPipelineForTicker(env, withLlmLogContext(config, { source: "pipeline" }), buildLiveContext(env), { pipelineRunId: runId, ticker, newsItem, asOf: itemAsOf });
        } else if (job.type === "backtest") {
          // M2: backtests no longer run here. The engine now takes a
          // {inputs, store} context, and a backtest needs a SIM_DB-backed
          // RunStore plus a SimClock -- both belong to the backtest Worker
          // (M3), which this Worker must never bind (no SIM_DB on llm, by
          // design). Fail loudly rather than ack silently: mark the job
          // failed so the dashboard shows why, log it, and ack (a retry
          // would fail identically).
          const { id, tickers, testStart, testEnd, graceDays } = job;
          const reason = "backtests run on the backtest Worker (BACKTEST queue), not on LLM_JOBS";
          console.error("backtest job rejected: " + reason, { id, tickers });
          // The row lands under the 'live' run: this Worker has no SIM_DB, and
          // a real backtest's jobs get their own run id in the backtest Worker (M3).
          const reporter = createJobReporter(buildLiveContext(env).store, { id, type: "backtest", params: { tickers, testStart, testEnd, graceDays } });
          // start() first: it upserts the row to 'running' whether or not a
          // 'queued' row exists (a message already on the queue predates
          // backtests moving to the BACKTEST queue), and fail() only updates a queued/running row.
          await reporter.start();
          await reporter.fail(reason);
        } else if (job.type === "exit_check") {
          // Own message, own queue (plan.md Step 4) -- isolated from
          // INGEST/ANALYZE failures by construction. A failure here is
          // logged and acked, same ack-not-retry reasoning as backtest
          // above: checkOpenPositionExits already isolates a single
          // position's own exit-evaluation failure internally (see that
          // function's header), so a throw reaching here is a real,
          // unexpected failure -- but retrying wouldn't recover anything
          // either, the next scheduled tick re-evaluates every still-open
          // position regardless.
          const liveCtx = buildLiveContext(env);
          try {
            const closed = await checkOpenPositionExits(env, withLlmLogContext(config, { source: "exit_check" }), liveCtx, { asOf: job.asOf });
            console.log("exit_check job completed", { closed: closed.length, closed });
          } catch (err) {
            console.error("exit_check job failed", { message: err.message });
          }
          // Retention for the LLM call log (storage/llm_calls.js). Rides this
          // scheduled tick (every 15 min) rather than a cron of its own; the
          // DELETE is index-backed and a no-op most ticks. Own try/catch: a
          // failed prune must not affect the exit check above or the ack below.
          if (config.llmLogEnabled) {
            try {
              await liveCtx.store.pruneLlmCalls({ days: config.llmLogRetentionDays });
            } catch (err) {
              console.warn("llm call log prune failed (non-fatal)", { message: err.message });
            }
          }
        } else {
          console.error("llm queue message with unrecognized type, acking without processing", { type: job?.type, id: job?.id });
        }
        message.ack();
      } catch (err) {
        console.error("llm queue message handler crashed unexpectedly, retrying", { message: err.message });
        message.retry();
      }
    }
  },
};
