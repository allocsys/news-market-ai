// SEC EDGAR XBRL companyfacts adapter -- this is the concrete "address"
// half of plan.md Backtesting Integrity point 3 (point-in-time
// fundamentals), not just documentation of the limitation.
//
// WHY THIS ACTUALLY SOLVES POINT-IN-TIME, WHEN yfinance/MOST FREE SOURCES
// DON'T: yfinance and similar vendors serve CURRENT fundamentals -- if a
// company restated Q2 2025 revenue in a later filing, a plain "give me Q2
// 2025 revenue" call returns the restated figure with no way to ask "what
// was believed true as of August 2025." SEC EDGAR's companyfacts API
// (https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json) reports
// every XBRL fact tagged with the SEC ACCESSION FILING'S OWN DATE (`filed`)
// -- i.e. the date the fact actually became public -- separately from the
// fiscal period it describes. A later 10-K/A restating an earlier period
// shows up as a distinct fact with a later `filed` date. That `filed` date
// is exactly what storage/d1.js#getFundamentalFactsAsOf filters on, so
// "what did we know as of T" is answerable for real, not just documented as
// a gap -- see that function's header for the query.
//
// HONEST SCOPE -- what this does NOT solve:
// 1. US-listed XBRL filers only. No international companies, no non-XBRL
//    small-cap filers, no private companies.
// 2. Ticker -> CIK resolution (as of this session) is a REAL lookup against
//    SEC's public company_tickers.json (edgar_cik_lookup.js#resolveCik),
//    KV-cached, with config.edgarCikMap kept as an explicit per-ticker
//    override rather than the sole source -- see that file's header for
//    the caching/fails-open details. `fetchFacts` below still only
//    understands `config.edgarCikMap` directly (or an explicitly-passed
//    `cik`) -- it does NOT itself do a live lookup; that's `fetchLatest`'s
//    job (per-ticker resolveCik call, passing the resolved cik in), so
//    calling `fetchFacts` directly with a ticker absent from edgarCikMap
//    still throws immediately rather than triggering a network call, same
//    as before this session.
// 3. Only whatever XBRL "concepts" (tags) the filer actually reports under
//    us-gaap are available -- no non-GAAP/adjusted figures, and taxonomy
//    tag names occasionally change between filers or over time.
// 4. SEC requires a descriptive User-Agent (contact info) on every request
//    or returns 403 -- config.edgarUserAgent has no default (see config.js)
//    and MUST be set before this is used against the live API.
// 5. SEC's fair-use rate limit (documented as ~10 req/sec) IS paced by this
//    adapter now, via shared/throttle.js -- `fetchLatest`'s per-ticker/
//    per-tag loop waits at least `config.edgarMinRequestIntervalMs`
//    between `fetchFacts` calls (default 110ms, just over the 100ms that
//    exactly 10 req/sec implies, as a small safety margin). NOTE: this
//    only paces calls made THROUGH `fetchLatest`'s own loop -- a caller
//    invoking `fetchFacts` directly, repeatedly, itself (bypassing
//    `fetchLatest`) is not throttled by this, same as before.
// UPDATE (2026-09-17): fetch() now goes through
// shared/fetch_with_timeout.js#fetchWithTimeout (config.fetchTimeoutMs) --
// see gdelt.js's header for the live silent-scheduled-run-death incident
// that made a timeout on every ingestion fetch a hard requirement, not just
// a nice-to-have.

import { validateFundamentalFact } from "../market_data_validator.js";
import { VendorError } from "../../shared/errors.js";
import { createThrottle } from "../../shared/throttle.js";
import { fetchWithTimeout } from "../../shared/fetch_with_timeout.js";
import { resolveCik } from "./edgar_cik_lookup.js";

function normalizeCik(cik) {
  return String(cik).replace(/\D/g, "").padStart(10, "0");
}

/**
 * Fetches every fact EDGAR has for `tag` (an XBRL us-gaap concept, e.g.
 * "Revenues") for one ticker, across every unit EDGAR reports it in.
 * Requires `config.edgarUserAgent` -- throws a (non-transient) VendorError
 * if missing, since that's a config gap, not a vendor-side failure to
 * retry.
 *
 * CIK resolution: pass `cik` explicitly to skip lookup entirely (this is
 * what `fetchLatest` below does, after its own resolveCik call against
 * config.edgarCikMap + the live SEC map). With no `cik` passed, falls back
 * to `config.edgarCikMap[ticker]` ONLY -- this does NOT trigger a live SEC
 * lookup itself, so a direct `fetchFacts` call for a ticker absent from
 * edgarCikMap still throws immediately with no network call, same
 * behavior as before edgar_cik_lookup.js existed.
 */
export async function fetchFacts(config, { ticker, tag, cik: explicitCik }) {
  if (!config.edgarUserAgent) {
    throw new VendorError("edgar", "config.edgarUserAgent is not set -- SEC EDGAR requires a descriptive User-Agent (contact info) on every request, see edgar_fundamentals.js header");
  }
  let cik;
  if (explicitCik) {
    cik = normalizeCik(explicitCik);
  } else {
    const rawCik = config.edgarCikMap?.[ticker];
    if (!rawCik) {
      throw new VendorError("edgar", `no CIK configured for ticker ${ticker} in config.edgarCikMap`);
    }
    cik = normalizeCik(rawCik);
  }

  const url = `${config.edgarApiBase}/CIK${cik}.json`;
  let response;
  try {
    response = await fetchWithTimeout(url, { timeoutMs: config.fetchTimeoutMs, headers: { "User-Agent": config.edgarUserAgent, Accept: "application/json" } });
  } catch (err) {
    throw new VendorError("edgar", `network failure fetching EDGAR companyfacts for ${ticker}: ${err.message}`, { transient: true });
  }

  if (!response.ok) {
    throw new VendorError("edgar", `EDGAR companyfacts API returned ${response.status} for ${ticker} (CIK${cik})`, {
      status: response.status,
      transient: response.status === 429 || response.status >= 500,
    });
  }

  const data = await response.json();
  const concept = data.facts?.["us-gaap"]?.[tag];
  if (!concept) return []; // filer simply doesn't report this tag -- not an error, just no data

  const facts = [];
  for (const [unit, entries] of Object.entries(concept.units ?? {})) {
    for (const entry of entries ?? []) {
      // `filed` is the actual public filing date -- see this file's header
      // for why that (not fy/fp) is what makes this point-in-time.
      if (!entry.filed || entry.val === undefined || entry.val === null) continue;

      const filedAt = new Date(entry.filed);
      if (Number.isNaN(filedAt.getTime())) continue; // malformed date from vendor -- skip rather than insert garbage

      const fact = {
        ticker,
        cik,
        tag,
        val: entry.val,
        unit,
        fiscalYear: entry.fy,
        fiscalPeriod: entry.fp,
        form: entry.form,
        filedAt: filedAt.toISOString(),
        source: "edgar",
      };

      validateFundamentalFact(fact, { source: "edgar" });
      facts.push(fact);
    }
  }

  return facts;
}

/**
 * Convenience wrapper: fetches `tags` (default: a small starter set of
 * common concepts) for every ticker. Paces successive `fetchFacts` calls
 * at least `config.edgarMinRequestIntervalMs` apart (default 110ms -- see
 * this file's header, point 5) via a throttle shared across the WHOLE
 * tickers x tags loop, not one throttle per call -- a fresh throttle per
 * call would have no "last call" memory and pace nothing.
 *
 * Default ticker list (when `tickers` isn't passed explicitly): prefers
 * `Object.keys(config.edgarCikMap)` when non-empty (an explicit override
 * map still wins as the ticker source too, not just per-ticker CIK
 * values), otherwise falls back to `config.watchlist`'s tickers -- this is
 * what lets a deployment with NO edgarCikMap at all still pull
 * fundamentals for its whole watchlist, resolving each ticker's CIK live
 * against SEC (see edgar_cik_lookup.js). Both empty (or unset) means an
 * empty ticker list, same "no-op, not an error" behavior as before this
 * session's change.
 *
 * Per-ticker CIK resolution goes through resolveCik (override, then
 * live/KV-cached SEC lookup) BEFORE the throttled fetchFacts call, so an
 * override hit or a cache hit costs no throttle wait at all -- only an
 * actual `fetchFacts` call (a real EDGAR request) is paced. A ticker that
 * resolves to no CIK anywhere (not in edgarCikMap, not in SEC's file --
 * e.g. a typo or a delisted symbol) is logged and SKIPPED, not thrown --
 * unlike fetchFacts's own edgarCikMap-only miss (a config-gap throw, see
 * that function's header), a live-lookup miss here is "no such ticker"
 * information about one entry in a larger batch, not a reason to abort
 * the whole run (Adopted Pattern #11 still honored via the log, just not
 * via a throw).
 */
export async function fetchLatest(config, { tickers, tags = ["Revenues", "EarningsPerShareDiluted", "NetIncomeLoss"] } = {}, { kv } = {}) {
  const resolvedTickers =
    tickers ??
    (Object.keys(config.edgarCikMap ?? {}).length > 0
      ? Object.keys(config.edgarCikMap)
      : (config.watchlist ?? []).map((w) => w.ticker));

  const throttle = createThrottle({ minIntervalMs: config.edgarMinRequestIntervalMs ?? 0 });
  const facts = [];
  for (const ticker of resolvedTickers) {
    const cik = await resolveCik(config, kv, ticker);
    if (!cik) {
      console.warn("edgar_fundamentals: skipping ticker, no CIK resolvable via edgarCikMap or SEC lookup", { ticker });
      continue;
    }
    for (const tag of tags) {
      await throttle.wait();
      facts.push(...(await fetchFacts(config, { ticker, tag, cik })));
    }
  }
  return facts;
}
