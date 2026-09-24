// `ingest` Worker entry point (plan.md Step 5, extended in a Step 5
// follow-up on 2026-09-20). Owns two queues' consumers now:
//   - INGEST: `ingest_ticker` / `ingest_feeds`, moved here verbatim from
//     `backend`'s queue() (src/index.js), which no longer has an INGEST
//     consumer binding at all (see wrangler.toml there) and therefore
//     never receives these message types anymore. `backend`'s scheduled()
//     still PRODUCES onto INGEST (unchanged) -- this Worker is the other
//     end of that same queue, just living in its own deployable unit now,
//     same relationship `dashboard` has to `backend` via its BACKEND
//     service binding (Step 2), just via a queue instead of a service
//     binding here.
//   - BACKFILL (added in the follow-up): `backfill`, moved here from
//     `backend`'s old JOBS consumer for the same reason -- `backend`'s
//     POST /backfill still PRODUCES the message (now onto BACKFILL,
//     renamed from JOBS), this Worker is the only consumer.
//
// This Worker alone holds `FINNHUB_API_KEY` now, for BOTH live ingestion
// AND backfill, and touches the EDGAR CIK/name-index KV cache (via
// ingestTickerData/ingestFeedNews's own calls into ingestPriceBars/
// ingestFundamentals and each adapter's entity-resolution wiring) -- no
// other Worker in this repo has a reason to hold a Finnhub key or EDGAR
// User-Agent identity anymore; `backend` gave up its own copy in the same
// follow-up that added the BACKFILL consumer here. It binds D1 directly
// (M2: the INPUTS_DB binding -- this Worker is now the only writer of the
// inputs database, live ingestion and backfill alike; only `backend` runs
// migrations) rather than going through a service binding, since
// ingestTickerData/ingestFeedNews/backfillHistoricalNews all write straight
// to D1 (insertNewsItem/insertPriceBar/insertFundamentalFacts) -- there's
// no synchronous caller waiting on a response the way dashboard->backend's
// service binding has one. It also binds LIVE_DB (rw, added in the
// follow-up) -- narrowly, for job_progress reporting during backfill only;
// see wrangler.ingest.toml's own comment on why that's a wider grant than
// the ingest_ticker/ingest_feeds code paths need.
//
// Same ack-and-log-on-business-logic-failure convention as every other
// non-`analyze` message type in `backend`'s queue() (see that file's own
// header for the full reasoning) -- there's no partial state worth
// resuming for either message type here, the next cron tick's own
// ingest_ticker/ingest_feeds message just tries again from scratch. An
// unexpected crash in this handler itself (not a business-logic failure --
// a real bug, e.g. a malformed message) falls through to message.retry(),
// same safety-net split as backend's queue().

import { loadConfig } from "./config.js";
import { ingestTickerData, ingestFeedNews, backfillHistoricalNews, backfillHistoricalPriceBars } from "./ingestion/ingest.js";
import { runIntradayBackfillTick } from "./ingestion/intraday_backfill.js";
import { purgeOldIntradayBars } from "./ingestion/intraday_purge.js";
import { sendInChunks } from "./ingestion/enqueue.js";
import { createJobReporter } from "./storage/jobs.js";
import { RunStore } from "./storage/run_store.js";

// Backfill self-continuation (see wrangler.ingest.toml's BACKFILL producer
// binding). One invocation writes at most about this many NET-NEW articles
// (checked per date window -- see backfillHistoricalNews -- so it can overshoot
// by up to one window: roughly watchlist size x ~35 articles/ticker/day x the
// window's days), then re-enqueues a follow-up message for the rest.
// Deliberately conservative and NOT yet measured against real D1/CPU limits --
// the 2026-09-20 incident died at ~325 articles on the old unbatched path, the
// batched path costs ~2 subrequests per 100 articles, so this leaves wide
// headroom; raise it once a real run shows how much one invocation can take.
export const MAX_ITEMS_PER_BACKFILL_INVOCATION = 500;

// Cap on Finnhub requests (external subrequests) per backfill invocation,
// checked before each date window starts. maxInserts alone can't bound a rerun
// over an already-stored range (it inserts nothing), and each window costs one
// request per ticker plus one per split. 40 is a guess kept under 50, the
// Workers Free plan's external-subrequest limit, in case that is the plan this
// runs on (unchecked -- the 1000-subrequest figure in the incident above
// suggests a paid plan); at 3 tickers and 5-day windows it is 13 windows, ~65
// days, per invocation. Raise it once the plan's real limit is known.
export const MAX_FINNHUB_REQUESTS_PER_BACKFILL_INVOCATION = 40;

// Hard stop on a continuation chain, so a bug or a pathological range can't
// re-enqueue itself forever. Hitting it fails the job (with the count saved so
// far in the error) rather than looping.
export const MAX_BACKFILL_PARTS = 50;

/**
 * Enqueues one ANALYZE message per (fresh item, ticker) pair onto `queue`, in
 * chunks that respect Cloudflare Queues' sendBatch limits (see
 * ingestion/enqueue.js), then logs the outcome.
 *
 * `fresh` is what ingestTickerData/ingestFeedNews return: only items that are
 * new since the last tick, NOT everything the vendor's trailing window
 * returned. A queue failure here is not retried: the items are already stored,
 * so a re-run would see them as existing and enqueue nothing. It is logged
 * loudly with a count and the affected `ticker:runId` labels instead, because
 * this is the one place where stored-but-never-analyzed items can come from.
 */
async function enqueueAnalyze(queue, { jobName, context, fetched, fresh }) {
  const messages = [];
  for (const { item, tickers } of fresh) {
    for (const ticker of tickers) {
      messages.push({ body: { type: "analyze", runId: item.id, ticker, newsItem: item, asOf: item.publishedAt } });
    }
  }

  const { sent, failures } = await sendInChunks(queue, messages);
  console.log(`${jobName} job completed`, { ...context, fetched, freshItems: fresh.length, analyzeMessages: messages.length, enqueued: sent });
  if (failures.length > 0) {
    console.error(`${jobName} could not enqueue every ANALYZE message -- these items are stored but will not be analyzed`, {
      ...context,
      lost: messages.length - sent,
      failures,
    });
  }
}

/**
 * Turns backfillHistoricalPriceBars' result into what the operator sees.
 * Nothing saved is a FAILED job: reporting "complete, 0 bars" would hide
 * exactly the failure this backfill is most likely to hit (yfinance 429s, see
 * ingestion/sources/yfinance.js's header). Some tickers missing is still a
 * complete job, but the detail names each one and why, so a partial fill is
 * never mistaken for a full one.
 */
export function summarizePriceBackfill(result) {
  const reasons = new Map(result.failedTickers.map(({ ticker, message }) => [ticker, message]));
  for (const ticker of result.tickersWithNoBars) reasons.set(ticker, "returned no bars for this range");
  const missing = [...reasons].map(([ticker, message]) => `${ticker} (${message})`);

  if (result.inserted === 0) {
    return { ok: false, error: `No price bars saved${missing.length ? ` -- ${missing.join("; ")}` : ""}` };
  }

  const filled = result.tickers - reasons.size;
  const bars = `Saved ${result.inserted} price bar${result.inserted === 1 ? "" : "s"} for ${filled} of ${result.tickers} ticker${result.tickers === 1 ? "" : "s"}`;
  return { ok: true, detail: missing.length ? `${bars}; no bars for ${missing.join("; ")}` : bars };
}

export default {
  async fetch() {
    return new Response("news-market-ai ingest worker is running (private, queue-consumer only -- see wrangler.ingest.toml). Architecture in plan.md.", { status: 200 });
  },

  // Consumer for INGEST only (wrangler.ingest.toml's single
  // `[[queues.consumers]]` block) -- unlike backend's queue(), which (as of
  // Step 6) consumes only JOBS (`backfill` only; `backtest`/`exit_check`
  // moved to `llm`'s LLM_JOBS queue), this Worker only ever receives
  // `ingest_ticker` / `ingest_feeds` messages, so there's no third branch
  // to dispatch on.
  async queue(batch, env) {
    const config = loadConfig(env);
    for (const message of batch.messages) {
      const job = message.body;
      try {
        if (job.type === "ingest_ticker") {
          // Per-ticker branch (plan.md Step 4, moved here unchanged in
          // Step 5). A failure is logged and acked, not retried -- no
          // partial state worth resuming, the next cron tick's own
          // ingest_ticker message for this same ticker just tries again.
          const { ticker, asOf } = job;
          try {
            const { fetched, fresh } = await ingestTickerData(config, env.INPUTS_DB, env.CACHE_KV, { ticker, asOf });
            await enqueueAnalyze(env.ANALYZE, { jobName: "ingest_ticker", context: { ticker }, fetched, fresh });
          } catch (err) {
            console.error("ingest_ticker job failed", { ticker, message: err.message });
          }
        } else if (job.type === "ingest_feeds") {
          // General-feeds branch (rss + html_scrape, moved here unchanged
          // in Step 5). A feed item may resolve to several tickers, so
          // this enqueues one ANALYZE message per (item, ticker) pair,
          // same loop shape ingest_ticker's single-ticker case doesn't need.
          try {
            const { fetched, fresh } = await ingestFeedNews(config, env.INPUTS_DB, env.CACHE_KV);
            await enqueueAnalyze(env.ANALYZE, { jobName: "ingest_feeds", context: {}, fetched, fresh });
          } catch (err) {
            console.error("ingest_feeds job failed", { message: err.message });
          }
        } else if (job.type === "backfill") {
          // BACKFILL consumer (Step 5 follow-up, 2026-09-20) -- moved here
          // verbatim from backend's old JOBS consumer (src/index.js), so
          // `backend` never needs a Finnhub key. Same reporter
          // start/complete/fail shape, same LIVE_DB job_progress target
          // (RunStore(env.LIVE_DB, "live") -- this Worker's only use of
          // that binding, see wrangler.ingest.toml's own comment on it).
          // Same business-logic-failure-acks convention as ingest_ticker/
          // ingest_feeds above: a vendor/D1 error mid-backfill is caught,
          // logged and reported as `failed`, not retried -- retrying a call
          // that already spent real Finnhub quota on failure would just
          // spend it again for the same result.
          // `from` is the cursor for THIS part's fetch; `originalFrom` is the
          // range the operator asked for (what the job row's params show).
          // A first message (from backend's POST /backfill) has none of the
          // continuation fields, so the defaults make it part 1 with zero
          // carried totals.
          // `truncatedSoFar` counts ticker-days Finnhub capped even at one
          // day (see finnhub.js#createWindowedFetcher); optional, so a
          // message without it just starts from 0.
          const { id, from, to, originalFrom = from, part = 1, insertedSoFar = 0, errorCountSoFar = 0, truncatedSoFar = 0 } = job;
          const reporter = createJobReporter(new RunStore(env.LIVE_DB, "live"), { id, type: "backfill", params: { from: originalFrom, to } });
          await reporter.start();
          try {
            const result = await backfillHistoricalNews(config, env.INPUTS_DB, {
              from,
              to,
              kv: env.CACHE_KV,
              originalFrom,
              maxInserts: MAX_ITEMS_PER_BACKFILL_INVOCATION,
              maxRequests: MAX_FINNHUB_REQUESTS_PER_BACKFILL_INVOCATION,
              // Progress counts days of the whole original range, so it keeps
              // moving forward across parts; the prefix says which part is
              // running.
              onProgress: part > 1 ? (p) => reporter.update({ ...p, detail: p.detail ? `Part ${part}: ${p.detail}` : p.detail }) : reporter.update,
            });
            const inserted = insertedSoFar + result.inserted;
            const errorCount = errorCountSoFar + result.errors.length;
            const truncated = truncatedSoFar + result.truncated.length;
            if (result.nextFrom) {
              // More left than one invocation should write: hand the rest to a
              // follow-up message. A send failure lands in the catch below and
              // fails the job, same as any other error in this branch. Not
              // acked-before-send: if this invocation dies between send and ack
              // the message is redelivered and the same part re-runs, which is
              // safe (pre-filter + ON CONFLICT DO NOTHING) but may start a
              // second chain over the same range -- harmless duplicate work.
              if (part >= MAX_BACKFILL_PARTS) {
                throw new Error(`backfill needed more than ${MAX_BACKFILL_PARTS} parts -- stopped after ${inserted} articles saved; narrow the range and re-run`);
              }
              await env.BACKFILL.send({ type: "backfill", id, from: result.nextFrom, to, originalFrom, part: part + 1, insertedSoFar: inserted, errorCountSoFar: errorCount, truncatedSoFar: truncated });
              console.log("backfill part completed, continuation enqueued", { id, part, nextFrom: result.nextFrom, inserted, errorCount, truncated });
            } else {
              console.log("backfill job completed", { id, from: originalFrom, to, parts: part, inserted, errorCount, truncated });
              await reporter.complete(
                { inserted, errorCount, truncated, parts: part },
                `Inserted ${inserted} article${inserted === 1 ? "" : "s"}${errorCount ? `, ${errorCount} vendor error${errorCount === 1 ? "" : "s"}` : ""}${truncated ? `, ${truncated} ticker-day${truncated === 1 ? "" : "s"} hit Finnhub's per-request cap (articles probably missing)` : ""}`
              );
            }
          } catch (err) {
            console.error("backfill job failed", { id, from, to, message: err.message });
            await reporter.fail(err.message);
          }
        } else if (job.type === "backfill_prices") {
          // BACKFILL_PRICES (Next Steps step A, plan.md) -- rides the SAME
          // BACKFILL queue/consumer as the news `backfill` branch above
          // (same LIVE_DB job_progress target, same ack-and-log-on-
          // business-logic-failure convention) rather than provisioning a
          // new queue: backfillHistoricalPriceBars is a single-request-
          // per-ticker, single-invocation job with none of the
          // parts/continuation machinery the news backfill needs (see that
          // function's own header), so it doesn't need a queue of its own
          // either -- max_batch_size 1 here already gives it a whole
          // invocation to itself. No `part`/`insertedSoFar`-style
          // continuation fields: unlike `backfill`, this message type is
          // never re-enqueued by this Worker.
          const { id, from, to, tickers } = job;
          const reporter = createJobReporter(new RunStore(env.LIVE_DB, "live"), { id, type: "backfill_prices", params: { from, to, tickers } });
          await reporter.start();
          try {
            const result = await backfillHistoricalPriceBars(config, env.INPUTS_DB, env.CACHE_KV, { tickers, from, to, onProgress: reporter.update });
            const summary = summarizePriceBackfill(result);
            const failedTickers = result.failedTickers.map((f) => f.ticker);
            console.log("backfill_prices job finished", { id, from, to, tickers: result.tickers, inserted: result.inserted, failedTickers, tickersWithNoBars: result.tickersWithNoBars, ok: summary.ok });
            // Nothing saved is a failure, not a 'complete' with 0 bars: the catch below reports it as `failed`.
            if (!summary.ok) throw new Error(summary.error);
            await reporter.complete({ inserted: result.inserted, tickers: result.tickers, failedTickers, tickersWithNoBars: result.tickersWithNoBars }, summary.detail);
          } catch (err) {
            console.error("backfill_prices job failed", { id, from, to, message: err.message });
            await reporter.fail(err.message);
          }
        } else if (job.type === "intraday_backfill_tick") {
          // Gradual intraday backfill (plan.md finding G step 6,
          // ingestion/intraday_backfill.js) -- rides the same BACKFILL
          // queue/consumer as `backfill`/`backfill_prices` above, produced
          // by backend's scheduled() every `*/15` cron tick (src/index.js).
          // No job_progress row: unlike a one-shot operator-triggered
          // backfill, this is an ongoing, self-continuing background job
          // with no single "done" moment to report -- its state IS the
          // intraday_backfill_status table, queryable directly. A per-
          // ticker vendor failure is caught and logged INSIDE
          // runIntradayBackfillTick (that ticker's status row is marked
          // 'failed', eligible for a later tick to re-claim) -- it never
          // reaches here, so this branch's own try/catch only guards
          // against an actual bug (a non-VendorError), same ack-and-log
          // convention as ingest_ticker/ingest_feeds above.
          try {
            const result = await runIntradayBackfillTick(config, env.INPUTS_DB);
            console.log("intraday_backfill_tick completed", { today: result.today, seededTickers: result.seededTickers, results: result.results });
          } catch (err) {
            console.error("intraday_backfill_tick job failed", { message: err.message });
          }
        } else if (job.type === "intraday_purge_tick") {
          // Rolling retention purge (plan.md finding G step 6,
          // ingestion/intraday_purge.js) -- produced by backend's
          // scheduled() on a once-daily gate (see that Worker's own
          // comment on the UTC-hour check), not every 15-minute tick.
          // Reads env.SIM_DB (added to wrangler.ingest.toml alongside
          // INPUTS_DB/LIVE_DB, same wider-grant-than-strictly-needed
          // tradeoff those bindings' own comments already flag) only to
          // check for an active backtest before deleting anything -- never
          // writes to it.
          try {
            const result = await purgeOldIntradayBars(env.INPUTS_DB, env.SIM_DB, { retentionDays: config.intradayRetentionDays });
            console.log("intraday_purge_tick completed", result);
          } catch (err) {
            console.error("intraday_purge_tick job failed", { message: err.message });
          }
        } else {
          console.error("ingest queue message with unrecognized type, acking without processing", { type: job?.type });
        }
        message.ack();
      } catch (err) {
        console.error("ingest queue message handler crashed unexpectedly, retrying", { message: err.message });
        message.retry();
      }
    }
  },
};
