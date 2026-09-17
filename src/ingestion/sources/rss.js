// RSS/Atom feed adapter -- the first real user of jsonify.js's "anything
// gets normalized into the same shape" boundary (plan.md ingestion section).
// Unlike gdelt.js, a feed isn't queried per-ticker: it's a fixed list of
// feed URLs (config.rssFeeds), each optionally tagged with a `ticker` hint
// when the feed itself is ticker-scoped (e.g. a per-company IR feed) --
// general market feeds (Reuters, MarketWatch, ...) have no hint and rely on
// entity_resolution.js's domain map, which is honestly thin (see that
// file's header) -- expect many items here to come back with an empty
// `tickers` array until that map grows.
//
// Same conventions as gdelt.js: VendorError (typed, transient flag) on
// fetch failure, buildNormalizedItem + validateNormalizedNewsItem before
// anything is returned. `body` is the feed's own `<description>`/`<summary>`
// stripped of any inner HTML via jsonify.js#stripHtml -- like gdelt.js this
// is NOT the full article text, just whatever summary the feed itself
// includes (some feeds give a full article, most give a teaser paragraph).
// UPDATE (2026-09-17): fetch() now goes through
// shared/fetch_with_timeout.js#fetchWithTimeout (config.fetchTimeoutMs) --
// see gdelt.js's header for the live silent-scheduled-run-death incident
// that made a timeout on every ingestion fetch a hard requirement.

import { buildNormalizedItem } from "../normalize.js";
import { resolveTickers } from "../entity_resolution.js";
import { validateNormalizedNewsItem } from "../market_data_validator.js";
import { parseFeedItems, stripHtml } from "../jsonify.js";
import { VendorError } from "../../shared/errors.js";
import { createThrottle } from "../../shared/throttle.js";
import { fetchWithTimeout } from "../../shared/fetch_with_timeout.js";

/**
 * Fetches and normalizes every item from each `{ ticker, url }` pair in
 * `feeds` (default: config.rssFeeds). One HTTP request per feed URL, since
 * there's no batched multi-feed endpoint. An item whose feed didn't supply
 * a usable date, or whose date fails validateNormalizedNewsItem (future-
 * dated, unparseable) is skipped rather than inserted with a guessed date --
 * same "skip malformed, don't fabricate" convention as gdelt.js.
 */
export async function fetchLatest(config, { feeds = config.rssFeeds } = {}) {
  const items = [];
  // No documented per-feed rate limit -- config.rssMinRequestIntervalMs
  // defaults to 0, a true no-op, same convention as gdelt.js/yfinance.js.
  // Feeds are third-party sites of wildly varying tolerance, so this is
  // here mainly so an operator hitting 429s from a specific set of feeds
  // can pace requests via env var without a code change.
  const throttle = createThrottle({ minIntervalMs: config.rssMinRequestIntervalMs ?? 0 });

  for (const { ticker, url } of feeds) {
    await throttle.wait();
    let response;
    try {
      response = await fetchWithTimeout(url, { timeoutMs: config.fetchTimeoutMs });
    } catch (err) {
      throw new VendorError("rss", `network failure fetching feed ${url}: ${err.message}`, { transient: true });
    }

    if (!response.ok) {
      throw new VendorError("rss", `feed ${url} returned ${response.status}`, {
        status: response.status,
        transient: response.status === 429 || response.status >= 500,
      });
    }

    const xmlText = await response.text();
    let domain = "";
    try {
      domain = new URL(url).hostname;
    } catch {
      // malformed feed URL -- domain stays "", entity_resolution just won't
      // get a domain-map hit; not fatal on its own.
    }

    for (const entry of parseFeedItems(xmlText)) {
      if (!entry.link || !entry.title) continue; // can't build a stable id or a useful item without these

      if (!entry.publishedAt) continue;
      const parsedDate = new Date(entry.publishedAt);
      if (Number.isNaN(parsedDate.getTime())) continue; // vendor gave an unparseable date -- skip rather than fabricate
      const publishedAt = parsedDate.toISOString();

      const tickers = resolveTickers({ title: entry.title, domain, hintTicker: ticker });

      const item = await buildNormalizedItem({
        source: `rss:${domain || "unknown"}`,
        url: entry.link,
        publishedAt,
        tickers,
        title: entry.title,
        body: stripHtml(entry.summary),
        raw: entry,
      });

      validateNormalizedNewsItem(item, { source: `rss:${domain || "unknown"}` });
      items.push(item);
    }
  }

  return items;
}
