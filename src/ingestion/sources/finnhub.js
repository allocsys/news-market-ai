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
//
// PER-REQUEST ARTICLE CAP (found 2026-09-20, INFERRED from stored data, not
// documented by Finnhub): one /company-news request returns only the NEWEST
// ~245 articles for its range no matter how wide the range is. AAPL, MSFT and
// TSLA each had ~245 stored finnhub articles, all dated 2026-09-14 or later,
// even though a 90-day backfill had asked for 2026-06-22 onward -- so a
// single-request-per-ticker backfill can never reach further back than about
// a week for these tickers. fetchLatest below (one request per ticker for the
// whole range) is right for the live cron's short trailing window and is left
// exactly as it was; a historical backfill uses createWindowedFetcher
// instead, which asks for short date windows and splits any window whose
// response looks capped.

import { buildNormalizedItem } from "../normalize.js";
import { resolveTickers, getCompanyNameIndex } from "../entity_resolution.js";
import { validateNormalizedNewsItem } from "../market_data_validator.js";
import { splitWindow } from "../date_windows.js";
import { VendorError } from "../../shared/errors.js";
import { createThrottle } from "../../shared/throttle.js";
import { fetchWithTimeout } from "../../shared/fetch_with_timeout.js";
import { withRetry } from "../../shared/retry.js";

/**
 * A response with at least this many RAW articles (before the adapter drops
 * ones missing datetime/url/headline) is treated as capped, so its window is
 * split and refetched. Just under the ~245 observed cap; config.js's
 * finnhubWindowSplitThreshold overrides it.
 */
export const DEFAULT_WINDOW_SPLIT_THRESHOLD = 230;

/**
 * Opt-in real entity resolution -- see gdelt.js/rss.js's identical wiring for
 * the full rationale (built once per call, fails open, off by default via
 * config.entityResolutionUseNameIndex).
 */
async function loadNameIndex(config, kv) {
  if (!config.entityResolutionUseNameIndex) return [];
  try {
    return await getCompanyNameIndex(config, kv);
  } catch (err) {
    console.error("finnhub: entity-resolution name index unavailable, falling back to hintTicker/domain-map matching only", { message: err.message });
    return [];
  }
}

/**
 * One /company-news request for `ticker` over [fromStr, toStr] (YYYY-MM-DD),
 * returning Finnhub's parsed JSON body. Throws VendorError on a network/status
 * failure (retried first when transient).
 */
async function requestCompanyNews(config, ticker, fromStr, toStr) {
  const url = `${config.finnhubApiBase}?symbol=${encodeURIComponent(ticker)}&from=${fromStr}&to=${toStr}`;

  // Same retry-only-the-fetch convention as gdelt.js/yfinance.js: only
  // network/timeout/status failures are retried (retry.js's default
  // shouldRetry looks at VendorError.transient); a malformed payload
  // is a permanent failure, not a vendor hiccup.
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

  return response.json();
}

/**
 * Normalizes Finnhub's article list for `ticker`, pushing each valid item onto
 * `items` (pushed one at a time, so a VendorError thrown by validation partway
 * through still leaves the items before it in `items` -- same as when this
 * loop lived inline in fetchLatest).
 */
async function normalizeArticlesInto(items, data, ticker, nameIndex) {
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
}

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
 *
 * ONE request per ticker for the whole range, so a range wide enough to hold
 * more than Finnhub's per-request article cap (see this file's header) comes
 * back silently truncated to the newest articles. Fine for the live cron's
 * trailing window; a historical backfill uses createWindowedFetcher below.
 */
export async function fetchLatest(config, { queries = config.watchlist, from, to } = {}, { kv, onTickerDone } = {}) {
  const items = [];
  const errors = [];

  const nameIndex = await loadNameIndex(config, kv);

  const throttle = createThrottle({ minIntervalMs: config.finnhubMinRequestIntervalMs ?? 0 });

  // Finnhub's /company-news requires an explicit from/to date range (unlike
  // GDELT's implicit "most recent" query) -- default to a short trailing
  // window wide enough to catch anything since the last 15-min cron tick
  // with generous slack for a missed run, not a backtesting window (see
  // config.js#finnhubLookbackDays for the "why a few days, not one" note).
  // An explicit `from`/`to` (Date or YYYY-MM-DD string) overrides this
  // trailing default; the live cron path (collectNewsItems) never passes
  // these, so its output is unchanged.
  const toDate = to ? new Date(to) : new Date();
  const fromDate = from ? new Date(from) : new Date(toDate.getTime() - (config.finnhubLookbackDays ?? 3) * 24 * 60 * 60 * 1000);
  const toStr = toDate.toISOString().slice(0, 10);
  const fromStr = fromDate.toISOString().slice(0, 10);

  for (const [tickerIndex, { ticker }] of queries.entries()) {
    await throttle.wait();
    try {
      const data = await requestCompanyNews(config, ticker, fromStr, toStr);
      await normalizeArticlesInto(items, data, ticker, nameIndex);
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

    // Optional progress hook (backfill's live progress bar) -- fires once per
    // ticker whether it succeeded or was isolated into `errors` above. Absent
    // for the live cron path, which never passes it.
    await onTickerDone?.({ ticker, index: tickerIndex, total: queries.length });
  }

  return { items, errors };
}

/**
 * Fetcher for a historical backfill, which walks a long range window by
 * window instead of asking for it in one request (see this file's header for
 * why). Built once per backfill call: it holds the entity-resolution name
 * index, ONE throttle shared by every request it makes (so pacing holds
 * across windows and tickers), and a running request count the caller can
 * budget against.
 *
 * `fetchWindow(ticker, { from, to })` fetches one ticker over an inclusive
 * YYYY-MM-DD window and returns `{ items, errors, truncated }`:
 *   - A response with at least `config.finnhubWindowSplitThreshold` RAW
 *     articles (default DEFAULT_WINDOW_SPLIT_THRESHOLD) is assumed capped: it
 *     is discarded and the window is split in half and each half refetched,
 *     recursively, down to a single day. The halves cover the whole window, so
 *     nothing the discarded response held is lost.
 *   - A single day that still comes back at or over the threshold cannot be
 *     split further. Its (probably incomplete) articles are kept and the day
 *     is reported in `truncated` ({ ticker, from, to, raw }) and logged with
 *     console.warn -- never silent.
 *   - A VendorError on any request is isolated into `errors` (each entry
 *     `{ ticker, error, window }`, like fetchLatest's plus the window) and
 *     that span is simply absent from `items`; anything else propagates.
 */
export async function createWindowedFetcher(config, { kv } = {}) {
  const nameIndex = await loadNameIndex(config, kv);
  const throttle = createThrottle({ minIntervalMs: config.finnhubMinRequestIntervalMs ?? 0 });
  const splitThreshold = config.finnhubWindowSplitThreshold ?? DEFAULT_WINDOW_SPLIT_THRESHOLD;
  let requests = 0;

  async function fetchSpan(ticker, from, to, acc) {
    await throttle.wait();
    requests++;

    let data;
    try {
      data = await requestCompanyNews(config, ticker, from, to);
    } catch (err) {
      if (err instanceof VendorError) {
        acc.errors.push({ ticker, error: err, window: { from, to } });
        return;
      }
      throw err;
    }

    const raw = data?.length ?? 0;
    if (raw >= splitThreshold) {
      if (from < to) {
        const [first, second] = splitWindow(from, to);
        await fetchSpan(ticker, first.from, first.to, acc);
        await fetchSpan(ticker, second.from, second.to, acc);
        return;
      }
      acc.truncated.push({ ticker, from, to, raw });
      console.warn("finnhub: a single day hit the per-request article cap, so articles for it are probably missing", { ticker, day: from, raw, splitThreshold });
    }

    try {
      await normalizeArticlesInto(acc.items, data, ticker, nameIndex);
    } catch (err) {
      if (err instanceof VendorError) {
        acc.errors.push({ ticker, error: err, window: { from, to } });
      } else {
        throw err;
      }
    }
  }

  return {
    /** Finnhub requests made so far by this fetcher (each split half counts; a request's internal retries do not). */
    requestCount: () => requests,

    async fetchWindow(ticker, { from, to }) {
      const acc = { items: [], errors: [], truncated: [] };
      await fetchSpan(ticker, from, to, acc);
      return acc;
    },
  };
}
