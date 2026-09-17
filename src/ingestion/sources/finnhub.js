// Finnhub /company-news adapter -- GDELT's replacement as our primary news
// source (see plan.md "GDELT is being replaced" note, 2026-09-18). GDELT's
// live DOC API response shape was never actually confirmed against a
// successful fetch (see that plan.md correction), and its rate limiting
// proved severe enough from this sandbox's egress IP that a single query
// per ticker per cron tick couldn't reliably complete. Finnhub's free tier
// (60 req/min, per https://finnhub.io/docs/api/company-news) explicitly
// permits production use, unlike NewsAPI's free "Developer" tier (dev/test
// only per its own ToS) or Alpha Vantage's news-sentiment endpoint (25
// req/day free, too tight for a real cron-driven watchlist loop).
//
// Same per-ticker query shape as gdelt.js: one request per `{ ticker }` in
// `queries` (default config.watchlist), since /company-news is scoped to a
// single symbol -- no "everything" endpoint here either. This means
// hintTicker stays exactly as reliable a signal as it was for GDELT/RSS
// (Adopted Pattern #10 -- ticker resolution is deterministic, never
// LLM-inferred).
//
// AUTH: Finnhub's own docs (https://finnhub.io/docs/api/authentication)
// support a token EITHER as a query param (?token=) or an X-Finnhub-Token
// header. This adapter uses the header form -- keeps the API key out of
// URLs that might land in logs/error messages (fetchWithTimeout's own
// error paths below only ever include the URL, never headers).
//
// HONEST SCOPE: /company-news returns a headline + `summary` field (often
// a real teaser, sometimes empty depending on the story) but not full
// article body text -- same "vendor gives metadata/teaser, not full text"
// situation as gdelt.js and rss.js. No enrichWithFullText equivalent exists
// here yet; if full-text enrichment is wanted later, gdelt.js's version
// (fetch each item's own `url`, strip HTML, per-item failure isolation,
// timeout-bounded) is the template to copy, not reinvent.
//
// UNVERIFIED: this adapter's field mapping (headline/summary/url/datetime/
// source) is written directly from Finnhub's published API docs, not yet
// checked against a real, successful response from the live endpoint --
// see plan.md's GDELT correction for why an unconfirmed shape should never
// be written up as confirmed. Live-verify via mcp__Madmcp__web_fetch once a
// real FINNHUB_API_KEY exists, before trusting this in production.

import { buildNormalizedItem } from "../normalize.js";
import { resolveTickers, getCompanyNameIndex } from "../entity_resolution.js";
import { validateNormalizedNewsItem } from "../market_data_validator.js";
import { VendorError } from "../../shared/errors.js";
import { createThrottle } from "../../shared/throttle.js";
import { fetchWithTimeout } from "../../shared/fetch_with_timeout.js";
import { withRetry } from "../../shared/retry.js";

/**
 * Fetches recent company news for each `{ ticker }` in `queries` (default:
 * config.watchlist). One Finnhub request per ticker -- /company-news has no
 * batched multi-symbol form. Paced via config.finnhubMinRequestIntervalMs
 * (see config.js -- derived from Finnhub's documented 60 req/min free-tier
 * ceiling, same "real vendor-published number" treatment as
 * gdeltMinRequestIntervalMs/edgarMinRequestIntervalMs).
 *
 * Per-ticker failures (timeout, non-2xx, malformed payload) are isolated --
 * collected in the returned `errors` array rather than thrown, so one
 * failing ticker never blocks the rest of the watchlist in the same run.
 * Same convention as gdelt.js#fetchLatest/yfinance.js#fetchDailyBars.
 */
export async function fetchLatest(config, { queries = config.watchlist } = {}, { kv } = {}) {
  const items = [];
  const errors = [];

  // Opt-in real entity resolution -- see gdelt.js/rss.js's identical
  // wiring for the full rationale (built once per call, fails open, off by
  // default via config.entityResolutionUseNameIndex).
  let nameIndex = [];
  if (config.entityResolutionUseNameIndex) {
    try {
      nameIndex = await getCompanyNameIndex(config, kv);
    } catch (err) {
      console.error("finnhub: entity-resolution name index unavailable, falling back to hintTicker/domain-map matching only", { message: err.message });
    }
  }

  const throttle = createThrottle({ minIntervalMs: config.finnhubMinRequestIntervalMs ?? 0 });

  // Finnhub's /company-news requires an explicit from/to date range (unlike
  // GDELT's implicit "most recent" query) -- default to a short trailing
  // window wide enough to catch anything since the last 15-min cron tick
  // with generous slack for a missed run, not a backtesting window (see
  // config.js#finnhubLookbackDays for the "why a few days, not one" note).
  const to = new Date();
  const from = new Date(to.getTime() - (config.finnhubLookbackDays ?? 3) * 24 * 60 * 60 * 1000);
  const toStr = to.toISOString().slice(0, 10);
  const fromStr = from.toISOString().slice(0, 10);

  for (const { ticker } of queries) {
    await throttle.wait();
    try {
      const url = `${config.finnhubApiBase}?symbol=${encodeURIComponent(ticker)}&from=${fromStr}&to=${toStr}`;

      // Same retry-only-the-fetch convention as gdelt.js/yfinance.js: only
      // network/timeout/status failures are retried (retry.js's default
      // shouldRetry looks at VendorError.transient); a malformed payload
      // below is a permanent failure, not a vendor hiccup.
      const response = await withRetry(
        async () => {
          let res;
          try {
            res = await fetchWithTimeout(url, {
              timeoutMs: config.fetchTimeoutMs,
              headers: { "X-Finnhub-Token": config.finnhubApiKey },
            });
          } catch (err) {
            throw new VendorError("finnhub", `network failure fetching Finnhub company-news for ${ticker}: ${err.message}`, { transient: true });
          }

          if (!res.ok) {
            throw new VendorError("finnhub", `Finnhub company-news for ${ticker} returned ${res.status}`, {
              status: res.status,
              transient: res.status === 429 || res.status >= 500,
            });
          }

          return res;
        },
        { maxAttempts: config.retryMaxAttempts, baseDelayMs: config.retryBaseDelayMs },
      );

      const data = await response.json();
      for (const article of data ?? []) {
        // Finnhub's `datetime` is unix SECONDS, not milliseconds -- *1000
        // before handing to Date, or every item silently timestamps to
        // 1970. (See this file's header: don't repeat a units bug.)
        if (typeof article.datetime !== "number" || !Number.isFinite(article.datetime)) continue; // malformed vendor data -- skip rather than fabricate a date
        const publishedAt = new Date(article.datetime * 1000).toISOString();

        let domain = "";
        try {
          domain = article.url ? new URL(article.url).hostname : "";
        } catch {
          // malformed article URL -- domain stays "", entity_resolution just won't get a domain-map hit
        }

        if (!article.url || !article.headline) continue; // can't build a stable id or a useful item without these

        const tickers = resolveTickers({ title: article.headline, domain, hintTicker: ticker, nameIndex });

        const item = await buildNormalizedItem({
          source: "finnhub",
          url: article.url,
          publishedAt,
          tickers,
          title: article.headline,
          body: article.summary ?? "",
          raw: article,
        });

        validateNormalizedNewsItem(item, { source: "finnhub" });
        items.push(item);
      }
    } catch (err) {
      // A single ticker's query failure does NOT abort the rest of the
      // watchlist -- same convention as gdelt.js#fetchLatest and
      // pipeline.js#collectNewsItems. Only VendorError is swallowed here;
      // anything else (a real bug, e.g. a schema/validation throw) still
      // propagates.
      if (err instanceof VendorError) {
        errors.push({ ticker, error: err });
      } else {
        throw err;
      }
    }
  }

  return { items, errors };
}
