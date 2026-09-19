// `backtest` Worker entry point (plan.md M3, wrangler.backtest.toml).
//
// STATUS AS OF THIS COMMIT: SCAFFOLDING ONLY. This file exists so
// wrangler.backtest.toml's `main` points at something real (a Worker can't
// deploy without one) and so the config/bindings above can be reviewed and
// provisioned independently of the runner rewrite. The `backtest` message
// branch below does NOT yet run a real backtest -- it fails the job loudly,
// the same "reject rather than silently do the wrong thing" convention the
// `llm` Worker's own queue() used for `backtest` messages during M2 (see
// src/llm-worker.js). The actual wiring -- runManualBacktest/
// onSignalRunner.js moved off storage/d1.js onto RunStore(SIM_DB, id), a
// SimClock (src/backtest/simClock.js, already built and tested) threaded
// through the window/walk-end computation, and config.llmLog set so calls
// get logged -- is the next M3 piece, not yet done here.
//
// Once that lands, this Worker's job_progress/llm_calls both go through
// RunStore(env.SIM_DB, <backtest id>) -- NOT "live" -- since every backtest
// gets its own run_id and this Worker holds no LIVE_DB binding at all (see
// wrangler.backtest.toml's own comment on why that binding is deliberately
// absent).

import { loadConfig } from "./config.js";
import { RunStore, readOnly } from "./storage/run_store.js";
import { createJobReporter } from "./storage/jobs.js";

/** Per-message backtest context: SIM_DB read/write under this run's own id, INPUTS_DB read-only. Mirrors llm-worker.js's buildLiveContext shape. */
function buildBacktestContext(env, runId) {
  return { inputs: readOnly(env.INPUTS_DB), store: new RunStore(env.SIM_DB, runId) };
}

export default {
  async fetch() {
    return new Response("news-market-ai backtest worker is running (private, queue-consumer only -- see wrangler.backtest.toml). Architecture in plan.md. Runner wiring not yet complete (M3, in progress).", { status: 200 });
  },

  // Consumer for BACKTEST (wrangler.backtest.toml's `[[queues.consumers]]`
  // block). `backend` (src/index.js) is the only producer.
  async queue(batch, env) {
    const config = loadConfig(env);
    void config; // will be passed into the real runner once it's wired in
    for (const message of batch.messages) {
      const job = message.body;
      try {
        if (job.type === "backtest") {
          const { id, tickers, testStart, testEnd, graceDays } = job;
          const reason = "backtest Worker scaffolding only -- runner not yet wired in (M3 in progress)";
          console.error("backtest job rejected: " + reason, { id, tickers });
          const ctx = buildBacktestContext(env, id);
          const reporter = createJobReporter(ctx.store, { id, type: "backtest", params: { tickers, testStart, testEnd, graceDays } });
          await reporter.start();
          await reporter.fail(reason);
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
