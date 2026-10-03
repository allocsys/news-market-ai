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
// PAUSE / RESUME (migrations/sim/0003, storage/sim_registry.js): a run can be
// PAUSED instead of failed. A paused run keeps all its data; its continuation
// is parked in backtest_runs.cursor as a RESUME ENVELOPE
//   { part: <the part to run next>, cursor: <runManualBacktest cursor>, job: <the message's params> }
// (the whole job is kept because the registry row lacks enableLlmLog/knobOverrides).
// Resume is MANUAL (POST /backtest/:id/resume re-enqueues from the envelope).
// Triggers:
//   - the operator's Pause button: flips the row to 'paused'; the continuation
//     message already in the queue then arrives, sees 'paused', saves its cursor
//     into the envelope and is acked without running.
//   - the daily quota ledger (storage/quota_usage.js, one row per UTC day): checked at part
//     boundaries against our shares of D1 writes/reads and KV writes/reads
//     (config.js backtestDaily*Budget x quotaPausePct). The ledger replaces the old
//     started_at-bucketed SUM, which did not charge a resumed run's writes to the new day.
//   - every Gemini key on a DAILY quota cooldown (outcome.dailyQuota).
// Each part adds its counts to the ledger in the SAME db.batch as its
// backtest_runs.rows_written update, so the ledger costs no extra subrequest.
//
// max_concurrency = 1 / max_batch_size = 1 (wrangler.backtest.toml) keeps
// runs strictly sequential: the walk is CPU/subrequest heavy and the
// portfolio stage reads cross-ticker exposure, so racing runs buy nothing.

import { loadConfig } from "./config.js";
import { RunStore, readOnly } from "./storage/run_store.js";
import { createJobReporter } from "./storage/jobs.js";
import { runManualBacktest } from "./backtest/runBacktest.js";
import { applyKnobOverrides } from "./backtest/knobOverrides.js";
import { replayNewsItems } from "./backtest/newsReplay.js";
import { getNewsItemsByIds } from "./storage/inputs_view.js";
import { cleanupFailedRun, cleanupCancelledRun } from "./backtest/cleanup.js";
import { SubrequestBudget, countedD1, countedKv } from "./backtest/subrequestBudget.js";
import { cooldownMapKv } from "./shared/cooldown_map_kv.js";
import { pauseBacktestRun } from "./storage/sim_registry.js";
import { getQuotaUsage, mergeGeminiCounts, quotaUsageUpsertStatement, utcDay, nextUtcMidnightIso } from "./storage/quota_usage.js";
import { dailyQuotaCooldownSeconds } from "./shared/cooldown.js";

/**
 * The first daily share (config.js backtestDaily*Budget) that `usage` (today's
 * ledger totals: {d1Written, d1Read, kvReads, kvWrites}) has reached
 * quotaPausePct percent of, as {reason, detail}, or null. A share of 0 disables
 * that counter. quotaPausePct 0 disables the percent check, but the D1 write
 * share (the pre-ledger BACKTEST_DAILY_WRITE_BUDGET hard cap) still applies at 100%.
 * `d1_write_budget` is the reason for D1 writes, `quota_threshold` for the rest.
 */
export function quotaTrigger(config, usage) {
  const pct = config.quotaPausePct > 0 ? config.quotaPausePct : null;
  const checks = [
    ["d1_write_budget", "D1 rows written", usage.d1Written, config.backtestDailyWriteBudget, pct ?? 100],
    ["quota_threshold", "D1 rows read", usage.d1Read, config.backtestDailyReadBudget, pct],
    ["quota_threshold", "KV writes", usage.kvWrites, config.backtestDailyKvWriteBudget, pct],
    ["quota_threshold", "KV reads", usage.kvReads, config.backtestDailyKvReadBudget, pct],
  ];
  for (const [reason, label, used, share, usePct] of checks) {
    if (!(share > 0) || usePct === null) continue;
    if (used >= (share * usePct) / 100) return { reason, detail: `${label} today: ${used} of our ${share}/day share (pause at ${usePct}%)` };
  }
  return null;
}

/** Per-message backtest context: SIM_DB read/write under this run's own id, INPUTS_DB read-only. Mirrors llm-worker.js's buildLiveContext shape. */
function buildBacktestContext(env, runId) {
  return { inputs: readOnly(env.INPUTS_DB), store: new RunStore(env.SIM_DB, runId) };
}

/**
 * The per-invocation budget and the env whose D1/KV bindings charge it, or
 * `{ budget: null, runEnv: env }` when budgeting is off. The cooldown store sits OUTSIDE
 * the counting KV wrapper, so only its real KV operations are charged: ONE read per part
 * (the whole cooldown map) however many model/key pairs the cascade walks, plus one write
 * per cooldown event. This is the only writer of the backtest's KV namespace (queue
 * max_concurrency 1), hence exclusiveWriter.
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
    ...(env.CACHE_KV ? { CACHE_KV: cooldownMapKv(countedKv(env.CACHE_KV, budget), { exclusiveWriter: true }) } : {}),
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
          // Per-run opt-in override (src/index.js's POST /backtest/run) of this
          // Worker's LLM_LOG_ENABLED=false default -- config is loaded once per
          // batch and shared across messages, so this must be a fresh object per
          // job, never a mutation of the shared `config`.
          // Per-run knob overrides (backtest/knobOverrides.js) layer on top of the
          // same fresh-object rule: applyKnobOverrides returns a NEW config, and the
          // very same one when there is nothing to apply.
          const jobConfig = applyKnobOverrides(job.enableLlmLog ? { ...config, llmLogEnabled: true } : config, job.knobOverrides);
          const { budget, runEnv } = buildBudgetedEnv(env, jobConfig);
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

          // The resume envelope (see the header): everything POST /backtest/:id/resume needs to
          // re-enqueue this run, since the registry row alone lacks enableLlmLog/knobOverrides.
          const envelope = (nextPart, cur) => ({
            part: nextPart,
            cursor: cur,
            job: { id, tickers, testStart, testEnd, graceDays, ...(job.enableLlmLog ? { enableLlmLog: true } : {}), ...(job.knobOverrides ? { knobOverrides: job.knobOverrides } : {}) },
          });
          // Parks the run: status 'paused' + the envelope (instead of failing and deleting the
          // data). Unenforced, one write. `changed` is false when the row is no longer
          // running/paused (e.g. cancelled meanwhile): then there is nothing to park.
          const parkRun = async ({ reason, detail, resumeAfter = null, nextPart, cur }) => {
            const changed = await unenf(() => pauseBacktestRun(runEnv.SIM_DB, { id, reason, cursor: envelope(nextPart, cur), pausedAt: new Date().toISOString(), resumeAfter }));
            console.error("backtest paused", { id, part, reason, detail, resumeAfter, changed });
          };

          // The operator paused this run (POST /backtest/:id/pause) while this continuation was
          // in flight: it carries the cursor the pause route could not know, so save it and stop.
          // The original pause reason/time are kept (pauseBacktestRun does not relabel a paused
          // row). A part-1 redelivery has no cursor and nothing to save.
          if (existing?.status === "paused") {
            if (cursor) await unenf(() => pauseBacktestRun(runEnv.SIM_DB, { id, reason: "operator", cursor: envelope(part, cursor), pausedAt: new Date().toISOString() }));
            console.log("backtest job is paused, saved its cursor and acking without running", { id, part, savedCursor: Boolean(cursor) });
            message.ack();
            continue;
          }

          // Today's quota ledger row, read ONCE per part (parts are sequential): the value the
          // thresholds are checked against, plus this part's own counts after it ran. (It replaces
          // the old per-part SUM over backtest_runs, so a part costs no more reads than before.)
          const ledgerDay = utcDay();
          const ledger = budget ? await unenf(() => getQuotaUsage(runEnv.SIM_DB, ledgerDay)) : null;
          // Continuation check (part > 1 only): a brand-new run's part 1 always gets to run
          // (progress guarantee, same reasoning as SubrequestBudget#canStart). A continuation
          // already carries its cursor, so a part that would start over a threshold parks instead
          // of spending more of today's quota -- e.g. a manual resume on the same day.
          if (budget && part > 1) {
            const trigger = quotaTrigger(config, ledger);
            if (trigger) {
              await parkRun({ reason: trigger.reason, detail: trigger.detail, resumeAfter: nextUtcMidnightIso(), nextPart: part, cur: cursor });
              message.ack();
              continue;
            }
          }
          // job_progress (storage/jobs.js) is the dashboard's live percent/
          // phase display -- a SEPARATE, finer-grained record from the
          // backtest_runs registry, which runManualBacktest itself writes
          // ('running' up front, 'complete'/'failed' once it resolves).
          const reporter = createJobReporter(ctx.store, { id, type: "backtest", params: { tickers, testStart, testEnd, graceDays, ...(job.knobOverrides ? { knobOverrides: job.knobOverrides } : {}) } });
          // start() first (part 1 only -- a continuation's row already exists):
          // it upserts the row to 'running' whether or not backend's 'queued'
          // row exists (a redelivered message may find it already 'running').
          if (part === 1) await unenf(() => reporter.start());
          const outcome = await runManualBacktest(
            runEnv,
            jobConfig,
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
              maxParts: jobConfig.backtestMaxParts > 0 ? jobConfig.backtestMaxParts : Infinity,
            }
          );
          // This part's counts, captured BEFORE the ledger batch so the ledger's own writes are not
          // fed back into it (they are logged separately below).
          const counts = budget ? { d1Written: budget.rowsWritten, d1Read: budget.rowsRead, kvReads: budget.kvReads, kvWrites: budget.kvWrites, gemini: { ...budget.geminiCounts } } : null;
          // Persist this part's counts regardless of outcome (continue/complete/failed all wrote
          // something): the run's rows_written total and today's ledger row, in ONE db.batch (one
          // subrequest, +1 row written). Unenforced: must not be cut in half by an already-near-limit
          // subrequest budget, same convention as reporter.complete()/fail() below.
          let ledgerRowsWritten = 0;
          if (budget) {
            const statements = [];
            if (counts.d1Written > 0) statements.push(runEnv.SIM_DB.prepare(`UPDATE backtest_runs SET rows_written = rows_written + ? WHERE id = ?`).bind(counts.d1Written, id));
            statements.push(quotaUsageUpsertStatement(runEnv.SIM_DB, { day: ledgerDay, ...counts, gemini: mergeGeminiCounts(ledger.gemini, counts.gemini) }));
            const results = await unenf(() => runEnv.SIM_DB.batch(statements));
            ledgerRowsWritten = results.reduce((sum, r) => sum + (r?.meta?.rows_written ?? r?.meta?.changes ?? 0), 0);
          }
          if (budget) console.log("backtest part finished", { id, part, status: outcome.status, reason: outcome.reason, ...budget.snapshot(), ledgerDay, ledgerRowsWritten });
          if (outcome.status === "continue" && budget) {
            // Caught right AFTER this part's own writes landed, so a part that tips a daily total over
            // its threshold still finishes cleanly -- it just parks the run (data kept, manual resume)
            // instead of enqueuing the next part. Same "stop cleanly instead of looping" spirit as
            // MAX_BACKFILL_PARTS (ingest-worker.js).
            if (outcome.dailyQuota) {
              // Every Gemini model/key is on a DAILY cooldown: retrying in minutes cannot help.
              // resume-after = the shortest remaining cooldown (Pacific midnight at the latest).
              const seconds = outcome.retryAfterSeconds ?? dailyQuotaCooldownSeconds();
              await parkRun({ reason: "gemini_daily_cap", detail: "Every Gemini model/key is on a daily quota cooldown", resumeAfter: new Date(Date.now() + seconds * 1000).toISOString(), nextPart: part + 1, cur: outcome.cursor });
              message.ack();
              continue;
            }
            const trigger = quotaTrigger(config, {
              d1Written: ledger.d1Written + counts.d1Written,
              d1Read: ledger.d1Read + counts.d1Read,
              kvReads: ledger.kvReads + counts.kvReads,
              kvWrites: ledger.kvWrites + counts.kvWrites,
            });
            if (trigger) {
              await parkRun({ reason: trigger.reason, detail: trigger.detail, resumeAfter: nextUtcMidnightIso(), nextPart: part + 1, cur: outcome.cursor });
              message.ack();
              continue;
            }
          }
          if (outcome.status === "continue") {
            // LAST step, after runManualBacktest's forced progress update: if
            // the send throws, the outer catch retries THIS part (checkpoints
            // make that cheap) instead of leaving a half-started second chain.
            // A Gemini-outage pause (reason 'transient') asks for a longer delay than the
            // usual continuation one; never shorter than it.
            const delaySeconds = Math.max(config.backtestContinuationDelaySeconds, outcome.delaySeconds ?? 0);
            await env.BACKTEST.send(
              // enableLlmLog and knobOverrides MUST ride along: a part that dropped them
              // would finish the run under different knobs than it started with.
              { type: "backtest", id, tickers, testStart, testEnd, graceDays, ...(job.enableLlmLog ? { enableLlmLog: true } : {}), ...(job.knobOverrides ? { knobOverrides: job.knobOverrides } : {}), part: part + 1, cursor: outcome.cursor },
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
          // Same per-run override as the "backtest" branch above -- especially
          // relevant for replay, whose whole point is inspecting the analyst
          // calls the dashboard's "View every LLM call this comparison made"
          // link otherwise has nothing to show for (LLM_LOG_ENABLED=false by
          // default writes zero llm_calls rows for every replay/backtest run).
          const jobConfig = job.enableLlmLog ? { ...config, llmLogEnabled: true } : config;
          const reporter = createJobReporter(ctx.store, { id, type: "replay", params: { ticker, newsItemIds, asOf, enableLlmLog: Boolean(job.enableLlmLog) } });
          await reporter.start();
          try {
            const newsItems = await getNewsItemsByIds(ctx.inputs, { ids: newsItemIds });
            const found = new Set(newsItems.map((n) => n.id));
            const missing = newsItemIds.filter((nid) => !found.has(nid));
            const results = await replayNewsItems(env, jobConfig, ctx, { ticker, newsItems, asOf });
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
