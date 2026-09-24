// Sanity-checks vendor data before it reaches any agent (plan.md Adopted
// Pattern #9: grounded, not free-associated, data claims -- an agent must
// never be allowed to treat stale or malformed data as current). This
// module is where that check lives structurally; TradingAgents has the
// equivalent as dataflows/market_data_validator.py.
//
// UPDATE: a price/volume adapter now exists (ingestion/sources/yfinance.js,
// schemas/index.js#PriceBar), so validatePriceBar below is a real check,
// not a placeholder anymore. validateNormalizedNewsItem still covers the
// GDELT news path.

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
 * Rejects a price bar with internally inconsistent OHLC values, negative
 * volume, or a date in the future relative to `now` -- the same "grounded,
 * not free-associated" principle (plan.md Adopted Pattern #9) as
 * validateNormalizedNewsItem, applied to price data instead of news.
 * Does NOT check staleness (an old bar is still a valid historical bar);
 * callers needing "is this bar current" should check `date` themselves,
 * same division of responsibility as isStale for news.
 */
export function validatePriceBar(bar, { now = new Date(), source } = {}) {
  const vendor = source ?? bar.source;
  const date = new Date(bar.date);

  if (Number.isNaN(date.getTime())) {
    throw new VendorError(vendor, `unparseable date: ${JSON.stringify(bar.date)}`);
  }
  if (date.getTime() > now.getTime()) {
    throw new VendorError(vendor, `date ${bar.date} is in the future relative to ${now.toISOString()}`);
  }

  for (const field of ["open", "high", "low", "close", "volume"]) {
    if (typeof bar[field] !== "number" || Number.isNaN(bar[field])) {
      throw new VendorError(vendor, `${field} is not a valid number: ${JSON.stringify(bar[field])}`);
    }
  }
  if (bar.volume < 0) {
    throw new VendorError(vendor, `volume ${bar.volume} is negative`);
  }
  if (bar.high < bar.low) {
    throw new VendorError(vendor, `high ${bar.high} is less than low ${bar.low}`);
  }
  if (bar.high < bar.open || bar.high < bar.close) {
    throw new VendorError(vendor, `high ${bar.high} is less than open (${bar.open}) or close (${bar.close})`);
  }
  if (bar.low > bar.open || bar.low > bar.close) {
    throw new VendorError(vendor, `low ${bar.low} is greater than open (${bar.open}) or close (${bar.close})`);
  }

  return bar;
}

/**
 * Same checks as validatePriceBar, applied to an intraday bar (`ts`, a full
 * ISO8601 UTC timestamp, instead of `date`, a YYYY-MM-DD day) -- see
 * schemas/index.js#PriceBarIntraday. Kept as a separate function rather than
 * generalizing validatePriceBar over a field name, so a future change to one
 * granularity's rules (e.g. an intraday-only staleness check) doesn't have to
 * thread a parameter through the daily path too.
 */
export function validatePriceBarIntraday(bar, { now = new Date(), source } = {}) {
  const vendor = source ?? bar.source;
  const ts = new Date(bar.ts);

  if (Number.isNaN(ts.getTime())) {
    throw new VendorError(vendor, `unparseable ts: ${JSON.stringify(bar.ts)}`);
  }
  if (ts.getTime() > now.getTime()) {
    throw new VendorError(vendor, `ts ${bar.ts} is in the future relative to ${now.toISOString()}`);
  }

  for (const field of ["open", "high", "low", "close", "volume"]) {
    if (typeof bar[field] !== "number" || Number.isNaN(bar[field])) {
      throw new VendorError(vendor, `${field} is not a valid number: ${JSON.stringify(bar[field])}`);
    }
  }
  if (bar.volume < 0) {
    throw new VendorError(vendor, `volume ${bar.volume} is negative`);
  }
  if (bar.high < bar.low) {
    throw new VendorError(vendor, `high ${bar.high} is less than low ${bar.low}`);
  }
  if (bar.high < bar.open || bar.high < bar.close) {
    throw new VendorError(vendor, `high ${bar.high} is less than open (${bar.open}) or close (${bar.close})`);
  }
  if (bar.low > bar.open || bar.low > bar.close) {
    throw new VendorError(vendor, `low ${bar.low} is greater than open (${bar.open}) or close (${bar.close})`);
  }

  return bar;
}

/**
 * Sanity-checks a fundamental fact before insertion -- same "grounded, not
 * free-associated" principle (Adopted Pattern #9) as validateNormalizedNewsItem
 * and validatePriceBar, applied to XBRL data. Checks `filedAt` (the public
 * timestamp), NOT the fiscal period end -- a fact describing a period that
 * ended in the future would be a legitimate forward-looking estimate in some
 * contexts, but `filedAt` being in the future relative to `now` is always a
 * vendor clock/parsing bug, exactly like validateNormalizedNewsItem's
 * publishedAt check.
 */
export function validateFundamentalFact(fact, { now = new Date(), source } = {}) {
  const vendor = source ?? fact.source;
  const filedAt = new Date(fact.filedAt);

  if (Number.isNaN(filedAt.getTime())) {
    throw new VendorError(vendor, `unparseable filedAt: ${JSON.stringify(fact.filedAt)}`);
  }
  if (filedAt.getTime() > now.getTime()) {
    throw new VendorError(vendor, `filedAt ${fact.filedAt} is in the future relative to ${now.toISOString()}`);
  }
  if (typeof fact.val !== "number" || Number.isNaN(fact.val)) {
    throw new VendorError(vendor, `val is not a valid number: ${JSON.stringify(fact.val)}`);
  }
  if (!fact.ticker || !fact.tag) {
    throw new VendorError(vendor, `missing ticker or tag: ${JSON.stringify({ ticker: fact.ticker, tag: fact.tag })}`);
  }

  return fact;
}
