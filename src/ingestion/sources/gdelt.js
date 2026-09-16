// GDELT DOC 2.0 API adapter.
//
// Why GDELT first (see plan.md): free, returns JSON natively, updates every
// 15 minutes, and archives back to 2015 with real timestamps -- currently
// our strongest free source for point-in-time backtesting.
//
// HONEST SCOPE: GDELT DOC API returns article METADATA only (title, url,
// seendate, domain) -- not full article body text. `body` below is left as
// an empty string; fetching+parsing full text from each article URL is a
// real future task (paywalls, robots.txt, wildly inconsistent per-publisher
// HTML) deliberately not attempted here. Downstream analysts read
// `newsItem.body` in their prompts, so until this is filled in they are
// effectively analyzing headlines only -- flagged here rather than silently
// degrading without a trace.
//
// Ticker resolution is deterministic (Adopted Pattern #10, see
// ../entity_resolution.js), never inferred by an LLM. Every returned item is
// run through market_data_validator.js#validateNormalizedNewsItem before
// being handed back, and a vendor failure surfaces as a typed VendorError
// (Adopted Pattern #11) rather than an empty/partial silent result.

import { buildNormalizedItem } from "../normalize.js";
import { resolveTickers } from "../entity_resolution.js";
import { validateNormalizedNewsItem } from "../market_data_validator.js";
import { VendorError } from "../../shared/errors.js";
import { createThrottle } from "../../shared/throttle.js";

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
  // No documented GDELT rate limit exists (unlike EDGAR's ~10 req/sec fair-
  // use guidance) -- config.gdeltMinRequestIntervalMs defaults to 0, a true
  // no-op, same "no default without an explicit reason" convention as
  // rssFeeds/scrapePages. Reusable if GDELT ever documents a real limit or
  // a live deployment starts getting rate-limited in practice.
  const throttle = createThrottle({ minIntervalMs: config.gdeltMinRequestIntervalMs ?? 0 });

  for (const { ticker, query } of queries) {
    await throttle.wait();
    const url = `${config.gdeltApiBase}?query=${encodeURIComponent(query)}&mode=${config.gdeltMode}&maxrecords=${config.gdeltMaxRecords}&format=${config.gdeltFormat}&sort=${config.gdeltSort}`;

    let response;
    try {
      response = await fetch(url);
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
