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
    // Timeout for every plain-`fetch` ingestion call (shared/fetch_with_timeout.js)
    // -- gdelt.js (search + full-text enrichment), html_scrape.js, yfinance.js,
    // rss.js, edgar_fundamentals.js, edgar_cik_lookup.js. UPDATE: added after a
    // live incident where a scheduled run's log showed an EDGAR error and then
    // NOTHING after -- no completed, no failed -- consistent with the Worker
    // invocation hanging forever on an untimed-out fetch (most likely
    // gdelt.js#enrichWithFullText, which fetches up to ~150 arbitrary article
    // URLs serially) until Cloudflare killed the invocation outright, which no
    // try/catch can observe or log. 10s is a starting point, not vendor-derived
    // like edgarMinRequestIntervalMs -- these are arbitrary third-party sites
    // with no documented response-time guarantee, same "no single real number
    // to derive a default from" situation as rssMinRequestIntervalMs.
    fetchTimeoutMs: Number(env.FETCH_TIMEOUT_MS) || 10000,
    // Retry-with-backoff for a single failed vendor request (shared/retry.js
    // #withRetry) -- wired into each ingestion adapter's per-item fetch
    // (currently gdelt.js#fetchLatest, yfinance.js#fetchDailyBars). Before
    // this existed, a single 429/5xx/timeout on one ticker/query was logged
    // into that adapter's `errors` array and skipped for the entire 15-min
    // cron cycle, even when the underlying problem was a few seconds of
    // vendor overload. Only VendorError's `transient: true` failures are
    // retried (see retry.js's default shouldRetry) -- a malformed-payload
    // or other permanent failure still fails on the first attempt, same as
    // today. Shared/generic across adapters, not vendor-derived, same scope
    // as fetchTimeoutMs above -- unlike gdeltMinRequestIntervalMs/
    // edgarMinRequestIntervalMs, which ARE real published per-vendor
    // numbers. 3 attempts / 500ms base (500ms, 1000ms) is a conservative
    // starting point, not tuned against live traffic yet.
    retryMaxAttempts: Number(env.RETRY_MAX_ATTEMPTS) || 3,
    retryBaseDelayMs: Number(env.RETRY_BASE_DELAY_MS) || 500,
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
    // Paces gdelt.js#fetchLatest's per-query loop (shared/throttle.js).
    // UPDATE (2026-09-17): DOES now ship a real default, like
    // edgarMinRequestIntervalMs -- previously this was 0 because no
    // documented limit was known, but a live 429 response body this session
    // gave GDELT's actual own published pacing requirement verbatim
    // ("please limit requests to one every 5 seconds"), so 0 was a stale
    // "no info yet" placeholder, not a considered no-op. 5000ms is that
    // number directly, no safety-margin padding added since GDELT stated it
    // exactly rather than us deriving it from a req/sec rate the way
    // EDGAR's 110ms padding over its 100ms=10/sec figure does. NOTE this
    // does NOT necessarily fix the observed live 429s alone -- see plan.md,
    // the repeated 429 even with spacing between attempts suggests a
    // possible shared/rate-limited egress IP on the fetch infra used for
    // live-verification, which per-Worker-instance pacing wouldn't address
    // -- but it's still the correct, now-documented default regardless.
    gdeltMinRequestIntervalMs: Number(env.GDELT_MIN_REQUEST_INTERVAL_MS) || 5000,

    // UPDATE (2026-09-17): gdelt.js#enrichWithFullText -- an explicit opt-in
    // second step that fetches each article's own page to fill in `body`
    // (fetchLatest alone only ever returns metadata, see that file's HONEST
    // SCOPE note). Defaults to true/enabled -- graph/pipeline.js#collectNewsItems
    // calls it by default -- since a headline-only newsItem.body is a real,
    // previously-documented gap for the analysts reading it; explicit
    // opt-out ("false") exists for anyone who wants cheaper/faster runs or
    // is wary of the extra per-article fetches against arbitrary third-party
    // sites.
    gdeltFetchFullText: env.GDELT_FETCH_FULL_TEXT !== "false",

    // Paces enrichWithFullText's per-article loop -- arbitrary third-party
    // article pages, same "no single documented rate limit to derive a
    // default from" reasoning as scrapeMinRequestIntervalMs below, so this
    // defaults to 0 (a true no-op), NOT gdeltMinRequestIntervalMs's 5000
    // (that field paces GDELT's own DOC API search endpoint specifically --
    // a completely different host/limit from the article pages this fetches).
    gdeltArticleFetchMinIntervalMs: Number(env.GDELT_ARTICLE_FETCH_MIN_REQUEST_INTERVAL_MS) || 0,
    // Caps how many items enrichWithFullText actually fetches per run --
    // added after a live incident where fetching every item's own URL
    // (unbounded, up to ~150) exhausted Cloudflare's per-invocation
    // subrequest cap and starved the downstream Gemini calls in the same
    // invocation (see gdelt.js#enrichWithFullText header). Items beyond
    // this cap are simply left metadata-only (never dropped), same
    // per-item failure convention as an actual fetch error. 15 is a
    // conservative starting point, not derived from a documented Workers
    // limit -- tune via env var per deployment/plan.
    gdeltMaxArticlesToEnrich: Number(env.GDELT_MAX_ARTICLES_TO_ENRICH) || 15,
    // Finnhub /company-news API (ingestion/sources/finnhub.js) -- GDELT's
    // replacement as the primary news source (see plan.md, 2026-09-18).
    // No default API key on purpose, same "no default without an explicit
    // reason" convention as edgarUserAgent/rssFeeds -- a made-up key would
    // just fail every request, and shipping a real one here would be
    // committing a secret to source control. Every ingestion attempt with
    // an empty key surfaces as a normal 401 VendorError (logged, that
    // source skipped), not a special-cased startup failure -- same
    // "strict enhancement, not a hard dependency" treatment collectNewsItems
    // already gives every other news source.
    finnhubApiKey: env.FINNHUB_API_KEY || "",
    finnhubApiBase: env.FINNHUB_API_BASE || "https://finnhub.io/api/v1/company-news",
    // Paces finnhub.js#fetchLatest's per-ticker loop (shared/throttle.js).
    // Finnhub's free tier is documented at 60 requests/minute -- 1100ms
    // (~54/min) leaves a small safety margin under that ceiling, same
    // "real vendor-published number, small padding" treatment as
    // edgarMinRequestIntervalMs's 110ms over EDGAR's 10/sec figure.
    finnhubMinRequestIntervalMs: Number(env.FINNHUB_MIN_REQUEST_INTERVAL_MS) || 1100,
    // How many days back each /company-news call's `from` param reaches --
    // NOT a backtesting window, just wide enough slack to not miss stories
    // if a scheduled run gets delayed/skipped once. 3 days is a
    // conservative starting point, not tuned against real traffic yet --
    // same untuned-placeholder caveat as maxPositionHoldDays.
    finnhubLookbackDays: Number(env.FINNHUB_LOOKBACK_DAYS) || 3,
    // yfinance's unofficial chart API (ingestion/sources/yfinance.js) --
    // see that file's header for the real risk that this endpoint now often
    // requires a cookie+crumb handshake this adapter does not perform.
    yfinanceApiBase: env.YFINANCE_API_BASE || "https://query1.finance.yahoo.com/v8/finance/chart",
    yfinanceRange: env.YFINANCE_RANGE || "5d",
    yfinanceInterval: env.YFINANCE_INTERVAL || "1d",
    // Paces yfinance.js#fetchDailyBars's per-ticker loop (shared/throttle.js).
    // Same reasoning as gdeltMinRequestIntervalMs -- no documented rate limit
    // on this unofficial endpoint, so this defaults to 0, not a guess.
    yfinanceMinRequestIntervalMs: Number(env.YFINANCE_MIN_REQUEST_INTERVAL_MS) || 0,
    // Live incident (2026-09-18): yfinance's 429s were NOT the few-hundred-ms
    // blips shared/retry.js's exponential backoff exists for -- they persisted
    // across every 15-minute cron tick for hours straight, same "probably a
    // shared/rate-limited egress IP" suspicion already documented for GDELT
    // above. Retrying in-process on every single tick (withRetry's backoff)
    // just re-failed after burning several seconds of wall time per ticker,
    // repeated on every invocation -- observed in production as scheduled runs
    // dying with outcome "exceededCpu" before ever reaching Finnhub/Gemini.
    // yfinance.js now skips a 429'd ticker's retry ladder entirely (fails fast,
    // see that file's shouldRetry override) and records a cross-invocation KV
    // cooldown via shared/cooldown.js#setVendorCooldown instead, keyed per
    // ticker -- later invocations within this window skip that ticker
    // outright rather than re-attempting a call already known to be blocked.
    // 900s (15 min, one cron cycle) is a starting point, not tuned against how
    // long the underlying block actually lasts.
    yfinanceCooldownSeconds: Number(env.YFINANCE_COOLDOWN_SECONDS) || 900,
    // RSS feeds (ingestion/sources/rss.js) and standalone article pages to
    // scrape (ingestion/sources/html_scrape.js) -- "TICKER|url" pairs, or a
    // bare url when the source isn't ticker-scoped (see parseTickerUrlList
    // above). No defaults: unlike watchlist/GDELT, these are 100%
    // env-configured -- shipping a hardcoded list of third-party feed/page
    // URLs here would silently start scraping sites on someone else's
    // behalf the moment this code runs, which should be an explicit choice.
    rssFeeds: parseTickerUrlList(env.RSS_FEED_URLS),
    scrapePages: parseTickerUrlList(env.SCRAPE_PAGE_URLS),
    // Paces rss.js#fetchLatest's per-feed loop and html_scrape.js#fetchLatest's
    // per-page loop (shared/throttle.js), respectively. Same reasoning as
    // gdeltMinRequestIntervalMs/yfinanceMinRequestIntervalMs -- these are
    // arbitrary third-party sites with no single documented rate limit to
    // derive a real default from, so both default to 0 (true no-op) rather
    // than a fabricated number; set per-deployment via env var if a
    // specific feed/site needs pacing.
    rssMinRequestIntervalMs: Number(env.RSS_MIN_REQUEST_INTERVAL_MS) || 0,
    scrapeMinRequestIntervalMs: Number(env.SCRAPE_MIN_REQUEST_INTERVAL_MS) || 0,
    // SEC EDGAR XBRL companyfacts API (ingestion/sources/edgar_fundamentals.js)
    // -- see that file's header for why this is our free point-in-time
    // fundamentals source. SEC REQUIRES a descriptive User-Agent identifying
    // the requester on every request (https://www.sec.gov/os/webmaster-faq#developers)
    // or it returns 403 -- no default here on purpose, same reasoning as
    // rss.js/html_scrape.js not shipping default URLs: a made-up default
    // User-Agent would misrepresent who's actually making the request.
    edgarUserAgent: env.EDGAR_USER_AGENT || "",
    edgarApiBase: env.EDGAR_API_BASE || "https://data.sec.gov/api/xbrl/companyfacts",
    // Paces edgar_fundamentals.js#fetchLatest's per-ticker/per-tag loop
    // (shared/throttle.js) to respect SEC's documented ~10 req/sec fair-use
    // guidance -- 100ms is exactly 10/sec, 110ms default leaves a small
    // safety margin. Unlike edgarUserAgent/rssFeeds/scrapePages this DOES
    // ship a real default: it's a technical pacing value derived from
    // SEC's own published number, not third-party identity/URL data we'd
    // be fabricating on someone's behalf by defaulting it.
    edgarMinRequestIntervalMs: Number(env.EDGAR_MIN_REQUEST_INTERVAL_MS) || 110,
    // Explicit ticker -> CIK OVERRIDE map (as of this session -- previously
    // this was the ONLY source, see edgar_cik_lookup.js for the real lookup
    // that now backstops it). Still useful to pin/correct a specific ticker
    // without waiting on SEC's file or debugging a lookup miss against it,
    // but an empty map no longer means "no fundamentals ingestion happens
    // at all" -- fetchLatest falls back to resolving config.watchlist's
    // tickers live against SEC instead (see edgar_fundamentals.js#fetchLatest).
    // "TICKER|cik" pairs, cik as SEC reports it (may or may not be
    // zero-padded in the source file -- edgar_fundamentals.js normalizes it).
    edgarCikMap: Object.fromEntries(parseTickerUrlList(env.EDGAR_CIK_MAP).map(({ ticker, url: cik }) => [ticker, cik])),
    // SEC's official free ticker->CIK lookup file (edgar_cik_lookup.js).
    // Ships a real default -- unlike edgarCikMap/rssFeeds/scrapePages, this
    // is SEC's own published, well-known endpoint (same "technical/official
    // constant, not fabricated third-party data" reasoning as edgarApiBase
    // and edgarMinRequestIntervalMs above), not a value we'd be inventing
    // on someone's behalf by defaulting it.
    edgarTickerCikUrl: env.EDGAR_TICKER_CIK_URL || "https://www.sec.gov/files/company_tickers.json",
    // How long edgar_cik_lookup.js#getTickerCikMap's KV cache entry lives
    // before a lookup re-fetches SEC's file. 24h default: ticker->CIK
    // mappings change on the order of new listings/delistings, not
    // intraday, so this is a conservative-but-not-paranoid refresh cadence
    // that also respects KV's 1K writes/day free-tier cap (one write per
    // cache-miss across the whole deployment, not per ticker/request).
    edgarCikCacheTtlSeconds: Number(env.EDGAR_CIK_CACHE_TTL_SECONDS) || 86400,
    // Bug fix (2026-09-17, see bug.md "Too many API requests by single
    // Worker invocation"): fetchFacts() previously returned EVERY fact
    // entry EDGAR has ever reported for a tag -- 10+ years of quarterly/
    // annual history for a mature ticker -- with no recency filter at all,
    // despite the function being named fetchLatest. Re-fetched and
    // re-upserted on every 15-min cron tick across the whole watchlist x
    // tag set, this blew through the Worker's per-invocation subrequest
    // cap (each D1 batch-insert statement counts as a subrequest, same as
    // each outbound fetch). This caps how far back a `filed` date can be
    // and still be kept. ~370 days covers the last 4 quarters plus one
    // annual (FY) comparison with a little slack -- generous for what the
    // debate/judge/trader stages actually need (recent point-in-time
    // fundamentals), not a tuned/backtested number.
    edgarFactsLookbackDays: Number(env.EDGAR_FACTS_LOOKBACK_DAYS) || 370,
    // Real entity-resolution name matching (entity_resolution.js#getCompanyNameIndex,
    // wired into gdelt.js/rss.js/html_scrape.js's fetchLatest) -- opt-in,
    // default false. Building the index costs a real SEC company_tickers.json
    // fetch (same file/UA requirement as edgar_cik_lookup.js) plus a
    // per-article substring scan over ~1000 company names, so this stays an
    // explicit choice rather than silently turning on the moment ingestion
    // runs -- same "no default without an explicit reason" convention as
    // rssFeeds/scrapePages/edgarUserAgent itself. Requires edgarUserAgent to
    // actually be set when enabled; each adapter fails open (logs, matches
    // on hintTicker/COMPANY_DOMAIN_MAP only) rather than throwing if the
    // index can't be built for any reason -- see gdelt.js/rss.js/
    // html_scrape.js's own wiring.
    // UPDATE (2026-09-17): default flipped false -> true. Unit/wiring test
    // coverage is thorough (see entity_resolution.test.js,
    // entity_resolution_wiring.test.js -- normalization, word-boundary
    // matching, KV cache-aside fail-open behavior, all three adapters'
    // wiring), but this has NOT yet been validated against a live SEC
    // fetch + real headline traffic -- every attempt this session hit
    // unreliable network conditions before a live check could complete.
    // Explicit opt-out remains available ("false") if live behavior turns
    // out to need more false-positive tuning than expected.
    entityResolutionUseNameIndex: env.ENTITY_RESOLUTION_USE_NAME_INDEX === "true",
    // Dashboard login (src/index.js's GET/POST /login, src/auth/session.js)
    // -- a one-time login that then authorizes POST /backfill and POST
    // /backtest/run via a session cookie; it is now the ONLY way to call
    // either route (the shared BACKFILL_API_SECRET/BACKTEST_API_SECRET
    // fallback that used to exist alongside it has been removed entirely).
    // A single operator credential pair, not a user table -- same "no
    // default without an explicit reason" convention as every other
    // secret in this file: unset means the LOGIN feature stays inactive
    // (GET /dashboard remains unauthenticated, exactly as it always has
    // been) rather than either being silently open with a guessable
    // default or silently locking everyone out of a dashboard that used
    // to be public. See src/index.js's dashboard route for the exact
    // isDashboardAuthConfigured() gate this powers.
    dashboardUsername: env.DASHBOARD_USERNAME || "",
    dashboardPassword: env.DASHBOARD_PASSWORD || "",
    // HMAC signing key for the session JWT (src/auth/jwt.js). No default,
    // same reasoning as dashboardUsername/dashboardPassword above -- a
    // separately rotatable secret from those two, since a session-signing
    // key and a login credential are different security boundaries with
    // no reason to be coupled.
    jwtSecret: env.JWT_SECRET || "",
    // How long a login session lasts before the cookie's JWT expires and
    // /login is required again (src/auth/session.js#createSessionCookie).
    // 24h is a starting point for a single-operator internal tool logged
    // into once a day at most, not tuned against anything real yet --
    // same untuned-placeholder caveat as maxPositionHoldDays/
    // MAX_PORTFOLIO_RISK_PCT elsewhere in this file.
    sessionTtlSeconds: Number(env.SESSION_TTL_SECONDS) || 86400,
  };
}
