// Deterministic entity/ticker resolution (plan.md Adopted Pattern #10):
// resolve which ticker a news item is about via a lookup step BEFORE any
// agent sees the item -- never let an LLM infer the ticker, which is
// exactly the class of "analyzed the wrong company" bug this pattern exists
// to avoid.
//
// HONEST SCOPE, v1 (superseded below, kept for context): ingestion queries
// GDELT per-ticker (see gdelt.js), so the searched-for ticker itself
// (`hintTicker`) is already a reliable, fully deterministic signal -- that's
// why it's always included with no lookup needed. COMPANY_DOMAIN_MAP was a
// small, hand-maintained supplement for picking up a SECOND company
// mentioned in the same article (e.g. a supplier, an acquisition target),
// covering exactly 3 companies.
//
// UPDATE (this session): real name-based resolution added, same "reuse
// SEC's own public data" approach edgar_cik_lookup.js already established
// for ticker->CIK. SEC's company_tickers.json carries a `title` (legal
// company name) alongside every ticker/CIK -- edgar_cik_lookup.js's new
// `fetchTickerDirectory` exposes that, and this file turns it into a
// ~1000-company name index that gets substring-matched against article
// titles. This is still deterministic/no-LLM (Pattern 10 intact) -- it's a
// bigger, real lookup table instead of a hand-typed one, not inference.
// COMPANY_DOMAIN_MAP is kept, unchanged in role, as an explicit override for
// a specific domain -> ticker pairing (same "override, not sole source"
// relationship edgarCikMap has to the live SEC lookup) -- useful for a
// domain that doesn't cleanly resolve via title-matching (e.g. a subsidiary
// site whose company name text never appears on its own pages).
//
// Building/serving the name index costs a real SEC fetch (or a KV cache
// read) and a per-article scan over ~1000 entries, so it's opt-in via
// config.entityResolutionUseNameIndex (default false, see config.js) --
// every existing caller that doesn't pass a `nameIndex` gets EXACTLY the
// old hintTicker + COMPANY_DOMAIN_MAP behavior, unchanged.
const COMPANY_DOMAIN_MAP = {
  "apple.com": "AAPL",
  "microsoft.com": "MSFT",
  "tesla.com": "TSLA",
};

import { fetchTickerDirectory } from "./sources/edgar_cik_lookup.js";

const NAME_INDEX_CACHE_KEY = "entity:company-name-index:v1";

// Legal-entity suffixes stripped from a SEC-filed title before matching --
// enough to turn "Apple Inc." / "MICROSOFT CORP" / "Alphabet Inc." into
// "apple" / "microsoft" / "alphabet" so they match plain-English headline
// text. Not a general company-name NLP normalizer, just the handful of
// suffixes SEC's own filer titles actually use.
const LEGAL_SUFFIXES = [
  " incorporated", " corporation", " corp", " inc", " co", " ltd",
  " limited", " plc", " group", " holdings", " holding", " company",
  " llc", " lp", " nv", " sa", " ag", " se", " ab", " oyj", " a/s",
];

/**
 * Normalizes a SEC-filed company title for headline matching: lowercase,
 * drop periods/commas, strip a single trailing legal-entity suffix. Only
 * strips ONE suffix (not repeatedly) so a genuinely two-word legal name
 * ("X Holdings Inc") loses "inc" and stops there, rather than being
 * stripped down to nothing.
 */
export function normalizeCompanyName(rawTitle) {
  if (!rawTitle) return "";
  let name = rawTitle.toLowerCase().trim().replace(/[.,]/g, "");
  for (const suffix of LEGAL_SUFFIXES) {
    if (name.endsWith(suffix)) {
      name = name.slice(0, -suffix.length).trim();
      break;
    }
  }
  return name;
}

/**
 * Builds a matchable {name, ticker} index from a ticker->{cik,title}
 * directory (edgar_cik_lookup.js#fetchTickerDirectory). Skips names under 4
 * chars -- too short/generic to safely substring-match a headline without
 * false-positiving on unrelated text -- and dedupes on normalized name
 * (first ticker seen for a given name wins; two tickers colliding on the
 * same normalized name is rare enough not to need a real tie-break here).
 * Sorted longest-name-first purely for deterministic iteration order, not
 * because it changes match correctness (containsWholeName below checks
 * every entry regardless of order).
 */
export function buildCompanyNameIndex(directory) {
  const seen = new Map();
  for (const [ticker, entry] of Object.entries(directory ?? {})) {
    const name = normalizeCompanyName(entry?.title);
    if (name.length < 4) continue;
    if (!seen.has(name)) seen.set(name, ticker);
  }
  return [...seen.entries()]
    .map(([name, ticker]) => ({ name, ticker }))
    .sort((a, b) => b.name.length - a.name.length);
}

/**
 * Whether `haystack` (already lowercased) contains `name` as a whole
 * word/phrase -- a non-alphanumeric character (or a string boundary) on
 * both sides, so "gm" doesn't match inside "telegram" and "apple" doesn't
 * match inside "pineapple". A manual boundary check via String#indexOf
 * rather than a fresh RegExp per company: this runs inside an
 * O(company-count) loop per article, and native substring search is far
 * cheaper than compiling ~1000 regexes per article.
 */
function containsWholeName(haystack, name) {
  const isBoundary = (ch) => ch === undefined || !/[a-z0-9]/.test(ch);
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(name, from);
    if (idx === -1) return false;
    if (isBoundary(haystack[idx - 1]) && isBoundary(haystack[idx + name.length])) return true;
    from = idx + 1;
  }
}

/**
 * Scans `title` for any company name in `nameIndex` (see
 * buildCompanyNameIndex), returning every matched ticker. Deterministic, no
 * LLM (Adopted Pattern #10) -- this is the "second company mentioned in the
 * same article" signal COMPANY_DOMAIN_MAP could only ever catch for 3
 * hardcoded domains, now backed by SEC's real company-name list instead.
 */
export function matchTickersByName(title, nameIndex) {
  if (!title || !nameIndex?.length) return [];
  const haystack = title.toLowerCase();
  const matched = [];
  for (const { name, ticker } of nameIndex) {
    if (containsWholeName(haystack, name)) matched.push(ticker);
  }
  return matched;
}

/**
 * Cache-aside wrapper building/serving the name index via Cloudflare KV --
 * same fails-open convention as edgar_cik_lookup.js#getTickerCikMap: a KV
 * read/write failure never blocks resolution, it just means a live SEC
 * fetch + rebuild happens instead of a cache hit. `kv` is optional --
 * passing undefined/null always fetches+rebuilds live, same as not having
 * KV at all. Reuses config.edgarCikCacheTtlSeconds rather than a separate
 * TTL knob -- company names change exactly as rarely as CIKs do (same file,
 * same filer, same session's own update cadence).
 */
export async function getCompanyNameIndex(config, kv) {
  if (kv) {
    try {
      const cached = await kv.get(NAME_INDEX_CACHE_KEY);
      if (cached) return JSON.parse(cached);
    } catch {
      // fall through to a live fetch+rebuild -- see file header
    }
  }

  const directory = await fetchTickerDirectory(config);
  const index = buildCompanyNameIndex(directory);

  if (kv) {
    try {
      await kv.put(NAME_INDEX_CACHE_KEY, JSON.stringify(index), { expirationTtl: config.edgarCikCacheTtlSeconds ?? 86400 });
    } catch {
      // best-effort only -- see file header
    }
  }

  return index;
}

/**
 * @param title article title
 * @param domain the publishing domain the source adapter reports
 * @param hintTicker the ticker the caller already searched/scoped for, if any
 * @param nameIndex optional pre-built index from getCompanyNameIndex/
 *   buildCompanyNameIndex -- omit for the exact pre-existing behavior
 *   (hintTicker + COMPANY_DOMAIN_MAP only, no name matching)
 * @returns deterministic array of tickers, always including hintTicker
 */
export function resolveTickers({ title, domain, hintTicker, nameIndex } = {}) {
  const tickers = new Set();
  if (hintTicker) tickers.add(hintTicker);

  const mapped = COMPANY_DOMAIN_MAP[domain];
  if (mapped) tickers.add(mapped);

  for (const ticker of matchTickersByName(title, nameIndex)) tickers.add(ticker);

  return [...tickers];
}
