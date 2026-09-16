// Sanity-checks vendor data before it reaches any agent (plan.md Adopted
// Pattern #9: grounded, not free-associated, data claims -- an agent must
// never be allowed to treat stale or malformed data as current). This
// module is where that check lives structurally; TradingAgents has the
// equivalent as dataflows/market_data_validator.py.
//
// HONEST STATE: there is no price/volume ingestion adapter yet (only GDELT
// news, itself still a stub -- see ingestion/sources/gdelt.js), so there is
// nothing to validate yet. validateNormalizedNewsItem below covers what we
// DO ingest today; validatePriceBar is a placeholder signature for when a
// price/volume adapter (yfinance, per plan.md) exists, left unimplemented
// rather than faking a check against data we don't have.

import { VendorError } from "../shared/errors.js";

const MAX_NEWS_STALENESS_MS = 24 * 60 * 60 * 1000; // 24h: a "current news" claim older than this is suspect, not breaking news

/**
 * Rejects a normalized news item whose publishedAt is missing, unparseable,
 * or in the future relative to `now` (a vendor clock/parsing bug, not a
 * real future article). Does NOT reject on staleness alone -- old news is
 * still valid news, just not "current" -- callers that need freshness
 * should check publishedAt against MAX_NEWS_STALENESS_MS themselves.
 */
export function validateNormalizedNewsItem(item, { now = new Date(), source } = {}) {
  const publishedAt = new Date(item.publishedAt);
  if (Number.isNaN(publishedAt.getTime())) {
    throw new VendorError(source ?? item.source, `unparseable publishedAt: ${JSON.stringify(item.publishedAt)}`);
  }
  if (publishedAt.getTime() > now.getTime()) {
    throw new VendorError(source ?? item.source, `publishedAt ${item.publishedAt} is in the future relative to ${now.toISOString()}`);
  }
  return item;
}

export function isStale(item, { now = new Date() } = {}) {
  return now.getTime() - new Date(item.publishedAt).getTime() > MAX_NEWS_STALENESS_MS;
}

/**
 * NOT YET IMPLEMENTED -- placeholder for once a price/volume adapter
 * (yfinance, per plan.md ingestion section) exists. Throwing explicitly
 * rather than silently no-op'ing, matching gdelt.js's own stub convention.
 */
export function validatePriceBar() {
  throw new Error("market_data_validator.validatePriceBar: not yet implemented -- no price/volume adapter exists yet, see plan.md next steps");
}
