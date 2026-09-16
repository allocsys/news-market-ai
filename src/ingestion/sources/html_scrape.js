// Scraped-HTML adapter -- the second jsonify.js consumer (plan.md ingestion
// section: "anything gets jsonified into the same shape"). For sources with
// no feed/API at all, just a list of article page URLs.
//
// HONEST SCOPE, read before relying on this:
// 1. `publishedAt` extraction is best-effort meta-tag sniffing (see
//    extractPublishedAt below) -- pages that don't expose one of the
//    checked tags have no reliable published time. Rather than guess, that
//    case falls back to `fetchedAt` (the time WE fetched the page) and the
//    returned item carries `publishedAtIsFetchTime: true` in `raw` so
//    callers/backtesting can tell a real timestamp from a fallback one.
//    Backtesting Integrity (plan.md) needs the REAL publish time to avoid
//    lookahead bias -- an item with this flag set should be treated as
//    untrustworthy for point-in-time backtesting until a better source for
//    that ticker/domain is found.
// 2. Body extraction (jsonify.js#stripHtml) is tag-stripping, not
//    readability/boilerplate-removal -- nav/sidebar/related-links text that
//    survived the script/style/nav/header/footer strip will be mixed into
//    `body`. Expect noisier text than gdelt.js or rss.js's body field.
// 3. No robots.txt / paywall handling of any kind -- this fetches the URL
//    as given and takes whatever comes back.

import { buildNormalizedItem } from "../normalize.js";
import { resolveTickers } from "../entity_resolution.js";
import { validateNormalizedNewsItem } from "../market_data_validator.js";
import { stripHtml, extractPageTitle } from "../jsonify.js";
import { VendorError } from "../../shared/errors.js";
import { createThrottle } from "../../shared/throttle.js";

const PUBLISHED_META_PATTERNS = [
  /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']*)["']/i,
  /<meta[^>]+name=["']publish(?:ed)?-?date["'][^>]+content=["']([^"']*)["']/i,
  /<meta[^>]+itemprop=["']datePublished["'][^>]+content=["']([^"']*)["']/i,
  /<time[^>]+datetime=["']([^"']*)["']/i,
];

/** Tries a fixed list of common meta-tag conventions for a real publish timestamp; returns null if none match or none parse. */
function extractPublishedAt(html) {
  for (const pattern of PUBLISHED_META_PATTERNS) {
    const m = pattern.exec(html);
    if (!m) continue;
    const d = new Date(m[1]);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

/**
 * Fetches and normalizes a single article page. `tickerHint` plays the same
 * role as gdelt.js's per-ticker query / rss.js's per-feed ticker -- pass it
 * when the caller already knows which ticker this URL is about.
 */
export async function fetchArticle(config, { url, tickerHint } = {}) {
  let response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw new VendorError("scrape", `network failure fetching ${url}: ${err.message}`, { transient: true });
  }

  if (!response.ok) {
    throw new VendorError("scrape", `${url} returned ${response.status}`, {
      status: response.status,
      transient: response.status === 429 || response.status >= 500,
    });
  }

  const html = await response.text();
  const title = extractPageTitle(html);
  if (!title) throw new VendorError("scrape", `${url}: could not find a <title> or og:title`);

  const fetchedAt = new Date().toISOString();
  const realPublishedAt = extractPublishedAt(html);
  const publishedAt = realPublishedAt ?? fetchedAt;

  let domain = "";
  try {
    domain = new URL(url).hostname;
  } catch {
    // malformed URL would already have failed fetch() above in practice; kept defensive
  }

  const tickers = resolveTickers({ title, domain, hintTicker: tickerHint });

  const item = await buildNormalizedItem({
    source: `scrape:${domain || "unknown"}`,
    url,
    publishedAt,
    tickers,
    title,
    body: stripHtml(html),
    raw: { publishedAtIsFetchTime: realPublishedAt === null, fetchedAt },
  });

  validateNormalizedNewsItem(item, { source: `scrape:${domain || "unknown"}` });
  return item;
}

/**
 * Fetches every `{ url, ticker }` pair in `pages` (default: config.
 * scrapePages) and returns the successfully-normalized items. Unlike
 * gdelt.js/rss.js, a single bad page here (404, unparseable, no title)
 * does NOT abort the whole batch -- scraping arbitrary third-party HTML is
 * expected to fail per-page far more often than a real API, so one bad URL
 * shouldn't lose every other page's data. Failures are collected and
 * returned alongside successes rather than silently swallowed (Adopted
 * Pattern #11: no silent degradation) -- callers that need "throw on any
 * failure" semantics should inspect `errors` themselves.
 */
export async function fetchLatest(config, { pages = config.scrapePages } = {}) {
  const items = [];
  const errors = [];
  // No documented per-page rate limit -- config.scrapeMinRequestIntervalMs
  // defaults to 0, a true no-op, same convention as rss.js/gdelt.js. Only
  // paces calls made through THIS loop -- a direct fetchArticle call (like
  // fetchFacts in edgar_fundamentals.js) is unaffected.
  const throttle = createThrottle({ minIntervalMs: config.scrapeMinRequestIntervalMs ?? 0 });

  for (const { ticker, url } of pages) {
    await throttle.wait();
    try {
      items.push(await fetchArticle(config, { url, tickerHint: ticker }));
    } catch (err) {
      errors.push({ url, error: err });
    }
  }

  return { items, errors };
}
