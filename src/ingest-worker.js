// `ingest` Worker entry point (plan.md Step 5). Owns the INGEST queue's
// consumer -- `ingest_ticker` / `ingest_feeds`, moved here verbatim from
// `backend`'s queue() (src/index.js), which no longer has an INGEST
// consumer binding at all (see wrangler.toml there) and therefore never
// receives these message types anymore. `backend`'s scheduled() still
// PRODUCES onto INGEST (unchanged) -- this Worker is the other end of that
// same queue, just living in its own deployable unit now, same relationship
// `dashboard` has to `backend` via its BACKEND service binding (Step 2),
// just via a queue instead of a service binding here.
//
// This Worker alone holds `FINNHUB_API_KEY` and touches the EDGAR CIK/
// name-index KV cache (via ingestTickerData/ingestFeedNews's own calls into
// ingestPriceBars/ingestFundamentals and each adapter's entity-resolution
// wiring) -- no other Worker in this repo has a reason to hold a Finnhub
// key or EDGAR User-Agent identity after this step. It binds D1 directly
// (per plan.md's Roadmap rule: "all Workers bind the same D1", only
// `backend` runs migrations) rather than going through a service binding,
// since ingestTickerData/ingestFeedNews both write straight to D1
// (insertNewsItem/insertPriceBar/insertFundamentalFacts) -- there's no
// synchronous caller waiting on a response the way dashboard->backend's
// service binding has one.
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
import { ingestTickerData, ingestFeedNews } from "./graph/pipeline.js";

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
            const insertedNews = await ingestTickerData(config, env.DB, env.CACHE_KV, { ticker, asOf });
            const analyzeMessages = insertedNews.map((item) => ({
              body: { type: "analyze", runId: item.id, ticker, newsItem: item, asOf: item.publishedAt },
            }));
            if (analyzeMessages.length > 0) await env.ANALYZE.sendBatch(analyzeMessages);
            console.log("ingest_ticker job completed", { ticker, newsItems: insertedNews.length, analyzeMessages: analyzeMessages.length });
          } catch (err) {
            console.error("ingest_ticker job failed", { ticker, message: err.message });
          }
        } else if (job.type === "ingest_feeds") {
          // General-feeds branch (rss + html_scrape, moved here unchanged
          // in Step 5). A feed item may resolve to several tickers, so
          // this enqueues one ANALYZE message per (item, ticker) pair,
          // same loop shape ingest_ticker's single-ticker case doesn't need.
          try {
            const insertedNews = await ingestFeedNews(config, env.DB, env.CACHE_KV);
            const analyzeMessages = [];
            for (const item of insertedNews) {
              for (const ticker of item.tickers) {
                analyzeMessages.push({ body: { type: "analyze", runId: item.id, ticker, newsItem: item, asOf: item.publishedAt } });
              }
            }
            if (analyzeMessages.length > 0) await env.ANALYZE.sendBatch(analyzeMessages);
            console.log("ingest_feeds job completed", { newsItems: insertedNews.length, analyzeMessages: analyzeMessages.length });
          } catch (err) {
            console.error("ingest_feeds job failed", { message: err.message });
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
