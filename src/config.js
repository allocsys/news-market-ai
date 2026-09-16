// Central config loader. Every module that needs Gemini keys, model names,
// or timeouts reads them from here -- nothing else touches `env` directly
// for these values, so there's exactly one place that knows the env var
// names.

function parseList(value) {
  return (value || "").split(",").map((s) => s.trim()).filter(Boolean);
}

export function loadConfig(env) {
  return {
    geminiApiKeys: parseList(env.GEMINI_API_KEYS),
    // Two-tier strategy (plan.md Adopted Pattern #7): quick/cheap model for
    // high-volume analyst passes, deep model reserved for debate/judge/trader.
    geminiQuickModel: env.GEMINI_QUICK_MODEL || "gemini-2.5-flash-lite",
    geminiDeepModel: env.GEMINI_DEEP_MODEL || "gemini-2.5-flash",
    geminiFallbackModels: parseList(env.GEMINI_FALLBACK_MODELS),
    geminiApiBase: "https://generativelanguage.googleapis.com/v1beta",
    geminiRequestTimeoutMs: Number(env.GEMINI_REQUEST_TIMEOUT_MS) || 30000,
    // Depth-vs-cost knob (plan.md Adopted Pattern #7): how many extra
    // bull/bear/judge rounds graph/conditional_logic.js may run when the
    // judge's confidence is too low to act on. 1 means "debate once, then
    // stop regardless of confidence" -- start conservative given the free
    // model-quota budget this is meant to protect.
    maxDebateRounds: Number(env.MAX_DEBATE_ROUNDS) || 1,
    // Watchlist for GDELT ingestion (ingestion/sources/gdelt.js) -- one
    // GDELT query per ticker, since the DOC API has no "everything" mode.
    // v1: the ticker symbol itself is the search query, a blunt but fully
    // deterministic starting point (Adopted Pattern #10 territory -- no LLM
    // guessing). Refine per-ticker queries as false-positive/negative rates
    // from real runs justify it.
    watchlist: parseList(env.WATCHLIST_TICKERS || "AAPL,MSFT,TSLA").map((ticker) => ({ ticker, query: ticker })),
    // GDELT DOC 2.0 request params (ingestion/sources/gdelt.js) -- pulled
    // out to config rather than hardcoded so a rate-limit/shape issue found
    // against the live API (see plan.md known gaps) can be tuned via env
    // vars without a code change.
    gdeltApiBase: env.GDELT_API_BASE || "https://api.gdeltproject.org/api/v2/doc/doc",
    gdeltMode: env.GDELT_MODE || "ArtList",
    gdeltFormat: env.GDELT_FORMAT || "json",
    gdeltSort: env.GDELT_SORT || "DateDesc",
    gdeltMaxRecords: Number(env.GDELT_MAX_RECORDS) || 50,
  };
}
