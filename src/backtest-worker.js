// `backtest` Worker entry point (plan.md M3, wrangler.backtest.toml).
//
// Consumes the BACKTEST queue (backend's POST /backtest/run is the only
// producer) and runs each message through runManualBacktest: the real
// signal on/off comparison, entirely SIM-side. Everything this Worker
// touches is scoped to the backtest's OWN run id:
//   - state/engine tables + job_progress + llm_calls: RunStore(SIM_DB, <id>)
//   - the run registry (backtest_runs): SIM_DB via storage/sim_registry.js
//   - inputs (news/prices/fundamentals): INPUTS_DB through readOnly()
// This Worker holds no LIVE_DB binding at all (see wrangler.backtest.toml's
// comment on why), so "a backtest cannot touch live state" is true by
// construction, not by convention.
//
// DELIVERY: Queues are at-least-once. runManualBacktest never throws for an
// ordinary failed run (it returns {status:'failed'} and writes the registry
// row), so those are acked -- retrying a deterministic failure would fail
// identically. A throw that DOES escape (e.g. the registry insert hitting a
// SIM_DB outage) is unexpected, so the message is retried; the registry
// insert is idempotent on id and the pipeline resumes from its checkpoints,
// so a redelivered message continues rather than restarts or conflicts.
//
// max_concurrency = 1 / max_batch_size = 1 (wrangler.backtest.toml) keeps
// runs strictly sequential: the walk is CPU/subrequest heavy and the
// portfolio stage reads cross-ticker exposure, so racing runs buy nothing.

import { loadConfig } from "./config.js";
import { RunStore, readOnly } from "./storage/run_store.js";
import { createJobReporter } from "./storage/jobs.js";
import { runManualBacktest } from "./backtest/runBacktest.js";

/** Per-message backtest context: SIM_DB read/write under this run's own id, INPUTS_DB read-only. Mirrors llm-worker.js's buildLiveContext shape. */
function buildBacktestContext(env, runId) {
  return { inputs: readOnly(env.INPUTS_DB), store: new RunStore(env.SIM_DB, runId) };
}

export default {
  async fetch() {
    return new Response("news-market-ai backtest worker is running (private, queue-consumer only -- see wrangler.backtest.toml). Architecture in plan.md.", { status: 200 });
  },

  // Consumer for BACKTEST (wrangler.backtest.toml's `[[queues.consumers]]`
  // block). `backend` (src/index.js) is the only producer.
  async queue(batch, env) {
    const config = loadConfig(env);
    for (const message of batch.messages) {
      const job = message.body;
      try {
        if (job.type === "backtest") {
          const { id, tickers, testStart, testEnd, graceDays } = job;
          const ctx = buildBacktestContext(env, id);
          // job_progress (storage/jobs.js) is the dashboard's live percent/
          // phase display -- a SEPARATE, finer-grained record from the
          // backtest_runs registry, which runManualBacktest itself writes
          // ('running' up front, 'complete'/'failed' once it resolves).
          const reporter = createJobReporter(ctx.store, { id, type: "backtest", params: { tickers, testStart, testEnd, graceDays } });
          // start() first: it upserts the row to 'running' whether or not
          // backend's 'queued' row exists (a redelivered message may find it
          // already 'running').
          await reporter.start();
          const outcome = await runManualBacktest(
            env,
            config,
            { inputs: ctx.inputs, store: ctx.store, registryDb: env.SIM_DB },
            { id, tickers, testStart, testEnd, graceDays, onProgress: (progress) => reporter.update(progress) }
          );
          if (outcome.status === "complete") {
            await reporter.complete(outcome.result, "Backtest complete");
          } else {
            await reporter.fail(outcome.error);
          }
          console.log("backtest job finished", { id, status: outcome.status, tickers });
        } else {
          console.error("backtest queue message with unrecognized type, acking without processing", { type: job?.type, id: job?.id });
        }
        message.ack();
      } catch (err) {
        console.error("backtest queue message handler crashed unexpectedly, retrying", { message: err.message });
        message.retry();
      }
    }
  },
};
