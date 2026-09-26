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
import { replayNewsItems } from "./backtest/newsReplay.js";
import { getNewsItemsByIds } from "./storage/inputs_view.js";
import { cleanupFailedRun, cleanupCancelledRun } from "./backtest/cleanup.js";
import { SubrequestBudget, countedD1, countedKv, cooldownMemoKv } from "./backtest/subrequestBudget.js";
import { addBacktestRunRowsWritten, getBacktestRowsWrittenToday, failBacktestRun } from "./storage/sim_registry.js";

/**
 * Whether today's cross-run D1 write total (backtest_runs.rows_written,
 * summed by storage/sim_registry.js#getBacktestRowsWrittenToday) has already
 * reached config.backtestDailyWriteBudget. `0` disables the check (same
 * convention as the subrequest budget's own externalLimit/totalLimit).
 * Unlike SubrequestBudget (per-invocation, refuses mid-work), this is a
 * cross-invocation, cross-run DAILY cap, so it is checked at part
 * boundaries, not per-statement -- see the two call sites below for why
 * each exists.
 */
async function dailyWriteBudgetExhausted(db, config) {
  if (!(config.backtestDailyWriteBudget > 0)) return false;
  const writtenToday = await getBacktestRowsWrittenToday(db);
  return writtenToday >= config.backtestDailyWriteBudget;
}

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
          // 'cancelled' (POST /backtest/:id/cancel, src/index.js) is terminal the
          // same way: this message was already in flight (queued with a delay,
          // see the 'continue' branch below) when the operator cancelled, so it
          // arrives here after the fact. The cancel route already did a
          // best-effort cleanup synchronously; retrying it here too (never
          // throws, cheap no-op once the data is already gone) is defense in
          // depth against that first pass having been cut short by its own
          // maxChunks.
          const existing = await runEnv.SIM_DB.prepare(`SELECT status FROM backtest_runs WHERE id = ?`).bind(id).first();
          // A MISSING row (not just an explicit terminal status) is also
          // terminal: purgeFailedAndCancelledRuns (POST /backtest/purge) and
          // deleteFailedOrCancelledBacktestRun delete the registry row itself
          // once a failed/cancelled run's state is fully cleaned up, so a
          // continuation message already queued for that run arrives here
          // with no row at all -- `existing` is null/undefined rather than
          // carrying a status string. Without this check that redelivery
          // would fall through to runManualBacktest and resume a run whose
          // registry entry no longer exists, writing fresh pipeline_checkpoints
          // (and other state) rows that nothing will ever clean up again.
          if ((part > 1 && !existing) || existing?.status === "complete" || existing?.status === "failed" || existing?.status === "cancelled") {
            console.log("backtest job already finished/cancelled/deleted, acking without re-running", { id, status: existing?.status ?? "deleted" });
            if (existing?.status === "cancelled") {
              const cleanup = await cleanupCancelledRun(runEnv.SIM_DB, ctx.store, id);
              console.log("backtest cancelled-run cleanup retry on redelivery", { id, cleanup });
            }
            message.ack();
            continue;
          }
          // BACKTEST_DAILY_WRITE_BUDGET, continuation check (part > 1 only): a
          // brand-new run's part 1 always gets to run (progress guarantee,
          // same reasoning as SubrequestBudget#canStart -- there is no
          // registry row yet to fail against, see commit message for why a
          // pre-check there would have to duplicate runManualBacktest's own
          // trainDays/testDays defaulting). A CONTINUATION always has an
          // existing row (checked just above), so it is safe to refuse here
          // before spending any more of today's write budget on it.
          if (part > 1 && (await unenf(() => dailyWriteBudgetExhausted(runEnv.SIM_DB, config)))) {
            const message_ = `Daily backtest write budget exhausted (BACKTEST_DAILY_WRITE_BUDGET=${config.backtestDailyWriteBudget}); resume after the next UTC day reset`;
            console.error("backtest part refused: daily write budget exhausted", { id, part, budget: config.backtestDailyWriteBudget });
            await failBacktestRun(runEnv.SIM_DB, { id, error: message_, finishedAt: new Date().toISOString() });
            await createJobReporter(new RunStore(runEnv.SIM_DB, id), { id, type: "backtest" }).fail(message_);
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
          // Persist this part's D1 write-row count to the registry regardless
          // of outcome (continue/complete/failed all wrote something) -- see
          // sim_registry.js#addBacktestRunRowsWritten. Unenforced: must not be
          // cut in half by an already-near-limit subrequest budget, same
          // convention as reporter.complete()/fail() below.
          if (budget && budget.rowsWritten > 0) {
            await unenf(() => addBacktestRunRowsWritten(runEnv.SIM_DB, { id, rows: budget.rowsWritten }));
          }
          if (outcome.status === "continue" && (await unenf(() => dailyWriteBudgetExhausted(runEnv.SIM_DB, config)))) {
            // Caught right AFTER this part's own writes landed (the check above
            // just persisted them), so a run that tips the daily total over
            // the cap mid-part still finishes that part cleanly -- it just
            // never gets a continuation message. Same "stop cleanly instead of
            // looping" spirit as MAX_BACKFILL_PARTS (ingest-worker.js).
            const message_ = `Daily backtest write budget exhausted (BACKTEST_DAILY_WRITE_BUDGET=${config.backtestDailyWriteBudget}) after part ${part}; resume after the next UTC day reset`;
            console.error("backtest continuation refused: daily write budget exhausted", { id, part, budget: config.backtestDailyWriteBudget });
            await unenf(() => failBacktestRun(runEnv.SIM_DB, { id, error: message_, finishedAt: new Date().toISOString() }));
            await unenf(() => reporter.fail(message_));
            const cleanup = await unenf(() => cleanupFailedRun(runEnv.SIM_DB, ctx.store, id));
            console.log("backtest job finished", { id, status: "failed", reason: "daily_write_budget", tickers, part, cleanup });
            message.ack();
            continue;
          }
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
        } else if (job.type === "replay") {
          // Operator tool (backtest/newsReplay.js): compare the pre-#132
          // parallel 3-call analyst path against the current batched
          // runAnalystTeam call for a FEW operator-picked historical news
          // items. Small and quick (a handful of items, a few LLM calls each)
          // -- no SubrequestBudget/parts chain, no daily-write-budget check;
          // it writes nothing to backtest_runs and makes no position/decision
          // rows (see newsReplay.js's own header), only this job's own
          // job_progress row, same as every other job type here.
          const { id, ticker, newsItemIds, asOf } = job;
          const ctx = buildBacktestContext(env, id);
          const reporter = createJobReporter(ctx.store, { id, type: "replay", params: { ticker, newsItemIds, asOf } });
          await reporter.start();
          try {
            const newsItems = await getNewsItemsByIds(ctx.inputs, { ids: newsItemIds });
            const found = new Set(newsItems.map((n) => n.id));
            const missing = newsItemIds.filter((nid) => !found.has(nid));
            const results = await replayNewsItems(env, config, ctx, { ticker, newsItems, asOf });
            await reporter.complete({ results, missingNewsItemIds: missing }, "Replay comparison complete");
            console.log("replay job finished", { id, ticker, requested: newsItemIds.length, found: newsItems.length, missing: missing.length });
          } catch (err) {
            console.error("replay job failed", { id, ticker, message: err.message });
            await reporter.fail(err.message);
          }
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
