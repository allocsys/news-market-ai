// GDELT DOC 2.0 API adapter.
//
// Why GDELT first (see plan.md): free, returns JSON natively, updates every
// 15 minutes, and archives back to 2015 with real timestamps -- currently
// our strongest free source for point-in-time backtesting.
//
// HONEST SCOPE: GDELT DOC API returns article METADATA only (title, url,
// seendate, domain) -- not full article body text. `fetchLatest` below
// leaves `body` as an empty string, unchanged -- it stays a pure metadata
// fetch, so nothing about its existing behavior/tests changes.
// UPDATE (2026-09-17): full-text fetching now exists as an explicit,
// separate opt-in step -- see `enrichWithFullText` below -- rather than
// remaining a documented-but-unfixed gap. It is best-effort by design, not
// a guarantee: paywalls, robots.txt, and wildly inconsistent per-publisher
// HTML mean some articles will still end up empty or noisy even with this
// wired in (html_scrape.js's own live-verified finding -- major finance
// publishers returning a 401 bot-challenge page -- applies here too, since
// GDELT article URLs point at exactly that kind of site). Downstream
// analysts reading `newsItem.body` will still see headline-only items for
// any article this step fails on -- flagged per-article via the returned
// `errors`, not silently degraded without a trace.
// UPDATE (2026-09-17, later same day): this loop was also the culprit in a
// live silent-scheduled-run-death incident -- it fetches every item's own
// URL (up to gdeltMaxRecords x watchlist.length, e.g. 50 x 3 = 150 arbitrary
// news-site pages) SERIALLY, and previously had NO timeout at all on any of
// those fetches. One hung page fetch blocked the whole Worker invocation
// until Cloudflare killed it outright -- not a catchable error, so nothing
// ever logged "completed" or "failed" after it. Now goes through
// shared/fetch_with_timeout.js#fetchWithTimeout (config.fetchTimeoutMs) so
// a hung fetch surfaces as a normal, logged, per-article error instead.
//
// Ticker resolution is deterministic (Adopted Pattern #10, see
// ../entity_resolution.js), never inferred by an LLM. Every returned item is
// run through market_data_validator.js#validateNormalizedNewsItem before
// being handed back, and a vendor failure surfaces as a typed VendorError
// (Adopted Pattern #11) rather than an empty/partial silent result.

import { buildNormalizedItem } from "../normalize.js";
import { resolveTickers } from "../entity_resolution.js";
import { validateNormalizedNewsItem } from "../market_data_validator.js";
import { stripHtml } from "../jsonify.js";
import { VendorError } from "../../shared/errors.js";
import { createThrottle } from "../../shared/throttle.js";
import { fetchWithTimeout } from "../../shared/fetch_with_timeout.js";

/** GDELT's seendate is "YYYYMMDDTHHMMSSZ" -- reformat to real ISO8601, or null if malformed. */
function parseGdeltDate(seendate) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(seendate ?? "");
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
}

/**
 * Fetches recent articles for each `{ ticker, query }` pair in `queries`
 * (see config.js#watchlist -- callers, typically graph/pipeline.js, pass
 * their configured watchlist here). One GDELT request per query, since the
 * DOC API requires an explicit search term -- there is no "everything"
 * endpoint to poll instead. Request params (base URL, mode, format, sort,
 * maxrecords) all come from config.js's gdelt* fields, not hardcoded here,
 * so they're tunable via env vars if the live API's behavior/shape needs
 * adjusting without a code change.
 */
export async function fetchLatest(config, { queries = config.watchlist } = {}) {
  const items = [];
  // UPDATE (2026-09-17): GDELT DOES now have a known, live-confirmed limit
  // -- a real 429 response body this session stated it verbatim ("please
  // limit requests to one every 5 seconds"), so config.js's loadConfig now
  // defaults gdeltMinRequestIntervalMs to 5000, same "real vendor-published
  // number" treatment as edgarMinRequestIntervalMs. The `?? 0` fallback
  // below only fires for a raw config object that bypasses loadConfig
  // entirely (this file's own tests construct one directly) -- production
  // callers (graph/pipeline.js) always go through loadConfig, so they get
  // the real 5000ms default. Note pacing alone may not fully resolve the
  // observed live 429s -- see plan.md, repeated 429s even with spacing
  // suggest a possible shared/rate-limited egress IP on the fetch infra
  // used for live-verification, not purely a per-instance cadence issue.
  const throttle = createThrottle({ minIntervalMs: config.gdeltMinRequestIntervalMs ?? 0 });

  for (const { ticker, query } of queries) {
    await throttle.wait();
    const url = `${config.gdeltApiBase}?query=${encodeURIComponent(query)}&mode=${config.gdeltMode}&maxrecords=${config.gdeltMaxRecords}&format=${config.gdeltFormat}&sort=${config.gdeltSort}`;

    let response;
    try {
      response = await fetchWithTimeout(url, { timeoutMs: config.fetchTimeoutMs });
    } catch (err) {
      throw new VendorError("gdelt", `network failure fetching GDELT DOC API: ${err.message}`, { transient: true });
    }

    if (!response.ok) {
      throw new VendorError("gdelt", `GDELT DOC API returned ${response.status}`, {
        status: response.status,
        transient: response.status === 429 || response.status >= 500,
      });
    }

    const data = await response.json();
    for (const article of data.articles ?? []) {
      const publishedAt = parseGdeltDate(article.seendate);
      if (!publishedAt) continue; // malformed date from vendor -- skip rather than insert garbage

      const tickers = resolveTickers({ title: article.title, domain: article.domain, hintTicker: ticker });

      const item = await buildNormalizedItem({
        source: "gdelt",
        url: article.url,
        publishedAt,
        tickers,
        title: article.title,
        body: "",
        raw: article,
      });

      validateNormalizedNewsItem(item, { source: "gdelt" });
      items.push(item);
    }
  }

  return items;
}

/**
 * Best-effort full-text enrichment for `fetchLatest`'s metadata-only items
 * (see HONEST SCOPE above). Fetches each item's own `url`, strips the
 * returned HTML via `jsonify.js#stripHtml`, and returns a NEW items array
 * with `body` filled in on success. Does NOT re-derive `title`/`publishedAt`
 * from the page (unlike `html_scrape.js#fetchArticle`) -- GDELT's own
 * values are already the normalized, validated ones for these items;
 * re-deriving from a scrape would risk replacing a good value with a worse
 * one for no benefit.
 *
 * Per-article failure isolation, same convention as `html_scrape.js
 * #fetchLatest`: a failure (network error, non-2xx, timeout, or any
 * unexpected response shape) is caught, recorded in the returned `errors`
 * array, and that item comes back UNCHANGED -- still a valid metadata-only
 * item, never dropped from the batch -- rather than aborting enrichment for
 * every other article. Full text is a strict enhancement on top of an
 * already-valid item, not a hard requirement. Each fetch is bounded by
 * config.fetchTimeoutMs (shared/fetch_with_timeout.js) -- see this file's
 * header for the live incident (Worker invocation hanging indefinitely on
 * one untimed-out article fetch) that made this a hard requirement, not
 * just a nice-to-have.
 *
 * Paced via `config.gdeltArticleFetchMinIntervalMs` (default 0, true no-op
 * -- same "arbitrary third-party sites, no single documented rate limit to
 * derive a default from" reasoning as `scrapeMinRequestIntervalMs`, NOT the
 * same field as `gdeltMinRequestIntervalMs`, which paces the DOC API search
 * endpoint itself, a completely different host/limit).
 */
export async function enrichWithFullText(config, items) {
  const throttle = createThrottle({ minIntervalMs: config.gdeltArticleFetchMinIntervalMs ?? 0 });
  const errors = [];

  const enriched = [];
  for (const item of items) {
    await throttle.wait();
    try {
      const response = await fetchWithTimeout(item.url, { timeoutMs: config.fetchTimeoutMs });
      if (!response.ok) {
        throw new Error(`fetching full text for ${item.url} returned ${response.status}`);
      }
      const html = await response.text();
      enriched.push({ ...item, body: stripHtml(html), raw: { ...item.raw, fullTextFetched: true } });
    } catch (err) {
      errors.push({ url: item.url, error: err });
      enriched.push(item); // unchanged -- still a valid metadata-only item, never dropped
    }
  }

  return { items: enriched, errors };
}
