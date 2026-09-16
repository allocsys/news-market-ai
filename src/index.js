// Worker entry point. `fetch` is a placeholder health check for now;
// `scheduled` is where the ingestion -> agents pipeline will be wired up
// once at least one ingestion adapter (src/ingestion/sources/gdelt.js) is
// actually implemented -- see plan.md next steps.

import { loadConfig } from "./config.js";

export default {
  async fetch() {
    return new Response(
      "news-market-ai worker is running. Architecture and design decisions live in plan.md.",
      { status: 200 }
    );
  },

  async scheduled(event, env) {
    const config = loadConfig(env);
    // TODO: call ingestion adapters (src/ingestion/sources/*.js), write
    // normalized items via src/storage/d1.js#insertNewsItem, then run the
    // Analyst Team -> Researcher Team -> Trader -> Risk agents per ticker.
    console.log("scheduled run fired", { cron: event.cron, quickModel: config.geminiQuickModel, deepModel: config.geminiDeepModel });
  },
};
