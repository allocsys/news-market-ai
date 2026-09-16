// Worker entry point. `fetch` is a placeholder health check for now.
// `scheduled` calls graph/pipeline.js#runScheduledIngestion, which is fully
// wired end to end: GDELT ingestion -> analysts -> debate -> trader -> risk
// -> portfolio (see that file's header for current caveats, notably GDELT's
// metadata-only articles). Any remaining failure (network, malformed vendor
// response, LLM cascade exhausted) is caught and logged here rather than
// left to crash the Worker invocation silently (Adopted Pattern #11).

import { loadConfig } from "./config.js";
import { runScheduledIngestion } from "./graph/pipeline.js";

export default {
  async fetch() {
    return new Response(
      "news-market-ai worker is running. Architecture and design decisions live in plan.md.",
      { status: 200 }
    );
  },

  async scheduled(event, env) {
    const config = loadConfig(env);
    console.log("scheduled run starting", { cron: event.cron, quickModel: config.geminiQuickModel, deepModel: config.geminiDeepModel });
    try {
      const results = await runScheduledIngestion(env, config, env.DB);
      console.log("scheduled run completed", { decisions: results.length });
    } catch (err) {
      // Expected for now -- see header comment. Logged, not silently dropped
      // (plan.md Adopted Pattern #11).
      console.error("scheduled run failed", { message: err.message });
    }
  },
};
