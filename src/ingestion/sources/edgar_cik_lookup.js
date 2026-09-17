// Real ticker -> CIK resolution via SEC's public company_tickers.json,
// replacing config.edgarCikMap's hand-maintained list as the DEFAULT source
// (see plan.md's next-step note this closes) -- edgarCikMap itself stays,
// repurposed as an explicit per-ticker override rather than removed, since
// pinning/correcting a specific ticker without waiting on SEC's file (or
// debugging a lookup miss against it) is still a legitimate thing to want.
//
// SEC's file (https://www.sec.gov/files/company_tickers.json) is a single
// ~1000-entry JSON object keyed by an arbitrary numeric string, each value
// shaped `{ cik_str, ticker, title }` -- NOT an array, and NOT keyed by
// ticker or CIK, so it has to be scanned into a ticker-keyed map on our
// side (fetchTickerCikMap below does this once per fetch).
//
// CACHING: ticker->CIK mappings change rarely (new listings/delistings,
// not intraday), so this is cached in Cloudflare KV rather than re-fetched
// on every lookup -- one write per cache-miss (see config.edgarCikCacheTtlSeconds),
// comfortably inside KV's 1K writes/day free-tier cap (same reasoning as
// shared/cooldown.js). FAILS OPEN, same convention as cooldown.js: a KV
// read/write failure never blocks resolution, it just means this call (or
// every call, if KV stays unreachable) falls back to a live SEC fetch
// instead of a cache hit.
//
// LIVE-VERIFY CAVEAT: like everything else touching *.sec.gov, this
// sandbox's network block (see plan.md "IMPORTANT ENVIRONMENT FINDING")
// means fetchTickerCikMap's request/response handling is only provable
// against a mocked fetch here, not confirmed against SEC's real file --
// re-verify the parsing against a real response before relying on this in
// production if SEC ever changes the file's shape.
// UPDATE (2026-09-17): fetch() now goes through
// shared/fetch_with_timeout.js#fetchWithTimeout (config.fetchTimeoutMs) --
// see ../ingestion/sources/gdelt.js's header for the live silent-
// scheduled-run-death incident that made a timeout on every ingestion
// fetch a hard requirement, not just a nice-to-have.

import { VendorError } from "../../shared/errors.js";
import { fetchWithTimeout } from "../../shared/fetch_with_timeout.js";

const CACHE_KEY = "edgar:ticker-cik-map:v1";

function normalizeCik(cik) {
  return String(cik).replace(/\D/g, "").padStart(10, "0");
}

/**
 * Fetches SEC's full ticker->CIK mapping fresh from the network (no
 * caching -- see getTickerCikMap for the cached wrapper most callers
 * should use instead). Requires config.edgarUserAgent, same SEC
 * User-Agent policy as edgar_fundamentals.js
 * (https://www.sec.gov/os/webmaster-faq#developers) -- this file is served
 * from www.sec.gov rather than data.sec.gov, but SEC's UA requirement is
 * about identifying the requester on automated requests to SEC systems
 * generally, not specific to one host, so it's honored here too rather
 * than assumed exempt.
 */
export async function fetchTickerCikMap(config) {
  if (!config.edgarUserAgent) {
    throw new VendorError("edgar", "config.edgarUserAgent is not set -- SEC requires a descriptive User-Agent on every request, see edgar_fundamentals.js header");
  }

  let response;
  try {
    response = await fetchWithTimeout(config.edgarTickerCikUrl, { timeoutMs: config.fetchTimeoutMs, headers: { "User-Agent": config.edgarUserAgent, Accept: "application/json" } });
  } catch (err) {
    throw new VendorError("edgar", `network failure fetching SEC ticker->CIK map: ${err.message}`, { transient: true });
  }

  if (!response.ok) {
    throw new VendorError("edgar", `SEC ticker->CIK lookup returned ${response.status}`, {
      status: response.status,
      transient: response.status === 429 || response.status >= 500,
    });
  }

  const data = await response.json();
  const map = {};
  for (const entry of Object.values(data ?? {})) {
    if (!entry?.ticker || entry.cik_str === undefined || entry.cik_str === null) continue;
    map[String(entry.ticker).toUpperCase()] = normalizeCik(entry.cik_str);
  }
  return map;
}

/**
 * Cache-aside wrapper around fetchTickerCikMap, backed by Cloudflare KV.
 * `kv` is optional (matches shared/cooldown.js's convention) -- pass
 * `undefined`/`null` to always fetch live with no caching at all, which is
 * exactly what happens if `kv` is present but unreachable too (fails open,
 * see file header).
 */
export async function getTickerCikMap(config, kv) {
  if (kv) {
    try {
      const cached = await kv.get(CACHE_KEY);
      if (cached) return JSON.parse(cached);
    } catch {
      // fall through to a live fetch -- see file header
    }
  }

  const map = await fetchTickerCikMap(config);

  if (kv) {
    try {
      await kv.put(CACHE_KEY, JSON.stringify(map), { expirationTtl: config.edgarCikCacheTtlSeconds ?? 86400 });
    } catch {
      // best-effort only -- see file header
    }
  }

  return map;
}

/**
 * Resolves one ticker's CIK. config.edgarCikMap (explicit override) wins if
 * present for this ticker; falls back to the live/cached SEC map otherwise.
 * Returns `null` (does NOT throw) when genuinely not found in either --
 * unlike edgar_fundamentals.js#fetchFacts's own "missing from edgarCikMap"
 * check (a hard throw, since that meant "you forgot to configure this"),
 * a miss against the live SEC map after checking the override is just "no
 * such ticker" information, which the caller (fetchLatest) treats as "skip
 * this one" rather than a config error.
 */
export async function resolveCik(config, kv, ticker) {
  const override = config.edgarCikMap?.[ticker];
  if (override) return normalizeCik(override);

  const map = await getTickerCikMap(config, kv);
  return map[ticker.toUpperCase()] ?? null;
}
