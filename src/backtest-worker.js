// `backtest` Worker entry point (plan.md M3, wrangler.backtest.toml).
//
// Consumes the BACKTEST queue (backend's POST /backtest/run starts a run; this
// Worker also produces the run's own continuation parts, see below) and runs
// each message through runManualBacktest: the real
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
// so a redelivered message continues rather than restarts or conflicts. A
// redelivery for a run whose registry row is already terminal ('complete' or
// 'failed') is acked and skipped: a failed run's data has been deleted (see
// below), so re-running it would restart the whole walk from scratch.
//
// FAILED RUNS: the run's data is deleted, its error log kept -- see
// backtest/cleanup.js (best-effort; runs after the failure is recorded).
//
// FREE-PLAN PARTS: one Worker invocation may make at most 50 subrequests on
// the Free plan, far less than a day of the walk needs. So a run is a chain of
// parts: each part gets a SubrequestBudget (backtest/subrequestBudget.js), does
// as much as fits, and when the budget is spent runManualBacktest returns
// {status:'continue', cursor}; this Worker then sends the next part to its OWN
// queue (BACKTEST producer, delayed) carrying `part` + `cursor` and acks. The
// send is the LAST step, after the progress update, so a failure before it
// retries this part rather than leaving two chains. The budget is enabled only
// when the BACKTEST producer is bound and both limits are > 0; otherwise a
// message runs start-to-finish in one invocation, as before.
//
// max_concurrency = 1 / max_batch_size = 1 (wrangler.backtest.toml) keeps
// runs strictly sequential: the walk is CPU/subrequest heavy and the
// portfolio stage reads cross-ticker exposure, so racing runs buy nothing.

import { loadConfig } from "./config.js";
import { RunStore, readOnly } from "./storage/run_store.js";
import { createJobReporter } from "./storage/jobs.js";
import { runManualBacktest } from "./backtest/runBacktest.js";
import { cleanupFailedRun } from "./backtest/cleanup.js";
import { SubrequestBudget, countedD1, countedKv, cooldownMemoKv } from "./backtest/subrequestBudget.js";

/** Per-message backtest context: SIM_DB read/write under this run's own id, INPUTS_DB read-only. Mirrors llm-worker.js's buildLiveContext shape. */
function buildBacktestContext(env, runId) {
  return { inputs: readOnly(env.INPUTS_DB), store: new RunStore(env.SIM_DB, runId) };
}

/**
 * The per-invocation budget and the env whose D1/KV bindings charge it, or
 * `{ budget: null, runEnv: env }` when budgeting is off. The memo sits OUTSIDE
 * the counting KV wrapper so a cached cooldown read costs nothing.
 */
function buildBudgetedEnv(env, config) {
  const externalLimit = config.backtestMaxExternalSubrequests;
  const totalLimit = config.backtestMaxTotalSubrequests;
  if (!env.BACKTEST || !(externalLimit > 0) || !(totalLimit > 0)) return { budget: null, runEnv: env };
  const budget = new SubrequestBudget({ externalLimit, totalLimit });
  const runEnv = {
    ...env,
    SIM_DB: countedD1(env.SIM_DB, budget),
    INPUTS_DB: countedD1(env.INPUTS_DB, budget),
    ...(env.CACHE_KV ? { CACHE_KV: cooldownMemoKv(countedKv(env.CACHE_KV, budget)) } : {}),
  };
  return { budget, runEnv };
}

export default {
  async fetch() {
    return new Response("news-market-ai backtest worker is running (private, queue-consumer only -- see wrangler.backtest.toml). Architecture in plan.md.", { status: 200 });
  },

  // Consumer for BACKTEST (wrangler.backtest.toml's `[[queues.consumers]]`
  // block). `backend` (src/index.js) starts runs; this Worker's own BACKTEST
  // producer sends each run's continuation parts.
  async queue(batch, env) {
    const config = loadConfig(env);
    for (const message of batch.messages) {
      const job = message.body;
      try {
        if (job.type === "backtest") {
          const { id, tickers, testStart, testEnd, graceDays } = job;
          const part = job.part ?? 1;
          const cursor = job.cursor ?? null;
          const { budget, runEnv } = buildBudgetedEnv(env, config);
          // Bookkeeping that must not be cut in half by the budget: counted, never refused.
          const unenf = (fn) => (budget ? budget.unenforced(fn) : fn());
          // (ctx first: RunStore's constructor is what rejects a message with no id.)
          const ctx = buildBacktestContext(runEnv, id);
          // Redelivery of an already-finished run: skip it. A failed run's data
          // is deleted (backtest/cleanup.js), so re-running it would restart the
          // whole walk from scratch and could overwrite the 'failed' row; a
          // complete run has nothing left to do. A 'running' row (a run whose
          // Worker died mid-walk) still proceeds and resumes from checkpoints.
          const existing = await runEnv.SIM_DB.prepare(`SELECT status FROM backtest_runs WHERE id = ?`).bind(id).first();
          if (existing?.status === "complete" || existing?.status === "failed") {
            console.log("backtest job already finished, acking without re-running", { id, status: existing.status });
            message.ack();
            continue;
          }
          // job_progress (storage/jobs.js) is the dashboard's live percent/
          // phase display -- a SEPARATE, finer-grained record from the
          // backtest_runs registry, which runManualBacktest itself writes
          // ('running' up front, 'complete'/'failed' once it resolves).
          const reporter = createJobReporter(ctx.store, { id, type: "backtest", params: { tickers, testStart, testEnd, graceDays } });
          // start() first (part 1 only -- a continuation's row already exists):
          // it upserts the row to 'running' whether or not backend's 'queued'
          // row exists (a redelivered message may find it already 'running').
          if (part === 1) await unenf(() => reporter.start());
          const outcome = await runManualBacktest(
            runEnv,
            config,
            { inputs: ctx.inputs, store: ctx.store, registryDb: runEnv.SIM_DB },
            {
              id,
              tickers,
              testStart,
              testEnd,
              graceDays,
              onProgress: (progress) => reporter.update(progress),
              cursor,
              budget,
              part,
              maxParts: config.backtestMaxParts > 0 ? config.backtestMaxParts : Infinity,
            }
          );
          if (budget) console.log("backtest part finished", { id, part, status: outcome.status, reason: outcome.reason, ...budget.snapshot() });
          if (outcome.status === "continue") {
            // LAST step, after runManualBacktest's forced progress update: if
            // the send throws, the outer catch retries THIS part (checkpoints
            // make that cheap) instead of leaving a half-started second chain.
            // A Gemini-outage pause (reason 'transient') asks for a longer delay than the
            // usual continuation one; never shorter than it.
            const delaySeconds = Math.max(config.backtestContinuationDelaySeconds, outcome.delaySeconds ?? 0);
            await env.BACKTEST.send(
              { type: "backtest", id, tickers, testStart, testEnd, graceDays, part: part + 1, cursor: outcome.cursor },
              { delaySeconds }
            );
            message.ack();
            continue;
          }
          let cleanup;
          if (outcome.status === "complete") {
            await unenf(() => reporter.complete(outcome.result, "Backtest complete"));
          } else {
            await unenf(() => reporter.fail(outcome.error));
            // AFTER reporter.fail: failJob is an UPDATE, so the job_progress row
            // must exist first (and the cleanup keeps that one row). Delete the
            // failed run's data, keep its error log. Best-effort, never throws.
            cleanup = await unenf(() => cleanupFailedRun(runEnv.SIM_DB, ctx.store, id));
          }
          console.log("backtest job finished", { id, status: outcome.status, tickers, part, ...(cleanup ? { cleanup } : {}) });
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
