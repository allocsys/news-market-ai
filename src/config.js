// Central config loader. Every module that needs Gemini keys, model names,
// or timeouts reads them from here -- nothing else touches `env` directly
// for these values, so there's exactly one place that knows the env var
// names.

function parseList(value) {
  return (value || "").split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Parses "TICKER|url,TICKER|url,..." into `[{ ticker, url }]`, same shape
 * as watchlist's `{ ticker, query }` pairs. An entry with no "|" (just a
 * bare url) is allowed -- ticker comes back as "" -- for feeds/pages that
 * aren't scoped to one company (see rss.js / html_scrape.js headers on why
 * that's an honest, expected case, not an error).
 */
function parseTickerUrlList(value) {
  return parseList(value).map((entry) => {
    const i = entry.indexOf("|");
    return i === -1 ? { ticker: "", url: entry } : { ticker: entry.slice(0, i).trim(), url: entry.slice(i + 1).trim() };
  });
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
    // Time-based exit knob for graph/exit_check.js#checkOpenPositionExits --
    // a position still open this many days after opened_at closes
    // regardless of price, even if price_bars has no data for it (see that
    // file's header). 10 trading days is a conservative default matching
    // risk.js's "days" TradeThesis.timeHorizon band, not tuned against
    // anything real yet -- same untuned-placeholder caveat as
    // portfolio_manager.js's MAX_PORTFOLIO_RISK_PCT.
    maxPositionHoldDays: Number(env.MAX_POSITION_HOLD_DAYS) || 10,
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
    // yfinance's unofficial chart API (ingestion/sources/yfinance.js) --
    // see that file's header for the real risk that this endpoint now often
    // requires a cookie+crumb handshake this adapter does not perform.
    yfinanceApiBase: env.YFINANCE_API_BASE || "https://query1.finance.yahoo.com/v8/finance/chart",
    yfinanceRange: env.YFINANCE_RANGE || "5d",
    yfinanceInterval: env.YFINANCE_INTERVAL || "1d",
    // RSS feeds (ingestion/sources/rss.js) and standalone article pages to
    // scrape (ingestion/sources/html_scrape.js) -- "TICKER|url" pairs, or a
    // bare url when the source isn't ticker-scoped (see parseTickerUrlList
    // above). No defaults: unlike watchlist/GDELT, these are 100%
    // env-configured -- shipping a hardcoded list of third-party feed/page
    // URLs here would silently start scraping sites on someone else's
    // behalf the moment this code runs, which should be an explicit choice.
    rssFeeds: parseTickerUrlList(env.RSS_FEED_URLS),
    scrapePages: parseTickerUrlList(env.SCRAPE_PAGE_URLS),
    // SEC EDGAR XBRL companyfacts API (ingestion/sources/edgar_fundamentals.js)
    // -- see that file's header for why this is our free point-in-time
    // fundamentals source. SEC REQUIRES a descriptive User-Agent identifying
    // the requester on every request (https://www.sec.gov/os/webmaster-faq#developers)
    // or it returns 403 -- no default here on purpose, same reasoning as
    // rss.js/html_scrape.js not shipping default URLs: a made-up default
    // User-Agent would misrepresent who's actually making the request.
    edgarUserAgent: env.EDGAR_USER_AGENT || "",
    edgarApiBase: env.EDGAR_API_BASE || "https://data.sec.gov/api/xbrl/companyfacts",
    // Hand-maintained ticker -> CIK map, same honest-narrow-scope convention
    // as ingestion/entity_resolution.js's COMPANY_DOMAIN_MAP -- SEC does
    // publish a free ticker->CIK lookup file (company_tickers.json) but
    // fetching+caching+refreshing that is a separate task, not attempted
    // here. "TICKER|cik" pairs, cik as SEC reports it (may or may not be
    // zero-padded in the source file -- edgar_fundamentals.js normalizes it).
    edgarCikMap: Object.fromEntries(parseTickerUrlList(env.EDGAR_CIK_MAP).map(({ ticker, url: cik }) => [ticker, cik])),
  };
}
