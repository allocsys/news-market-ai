// Ingestion orchestration -- what used to share graph/pipeline.js with the
// analysis pipeline, split out in M2 because the two touch different
// databases: everything here WRITES the shared `inputs` DB (news, price
// bars, fundamentals) and is called only from the `ingest` Worker
// (ingestTickerData/ingestFeedNews) and `backend`'s backfill consumer
// (backfillHistoricalNews); graph/pipeline.js only ever READS inputs (through
// readOnly(env.INPUTS_DB)) and writes run state through a RunStore. Keeping
// them in separate modules means the `llm` bundle no longer links any code
// that inserts into inputs. Every function takes the inputs db handle as its
// `db` argument -- pass env.INPUTS_DB.
//
// (runScheduledIngestion -- the old all-in-one "ingest then run the pipeline
// inline" sweep -- was deleted rather than ported: nothing called it since
// the Step 4 cron fan-out replaced it, and it is exactly the ingest+analyze
// coupling this split removes.)
//
// STATE: the functions below pull from every ingestion adapter
// that's wired in (finnhub, rss, html_scrape for news items; yfinance for
// price bars; edgar_fundamentals for XBRL facts). NOT yet exercised against
// LIVE vendor traffic -- see each adapter's own header for the specific
// unverified risk (finnhub's field-mapping is doc-derived, not yet
// live-confirmed; yfinance's cookie/crumb gap; etc). GDELT (gdelt.js) was
// the original news source here but was unwired 2026-09-18 -- its live
// response shape was never actually confirmed and its rate limiting proved
// too severe from this sandbox's egress IP; the file and its tests remain
// in the repo, just not imported by this module -- see plan.md's GDELT
// correction/replacement note. This session's change is the WIRING half
// only (calling adapters from here, feeding their output into storage,
// fully covered by mocked-fetch tests in test/ingestion_wiring.test.js);
// the LIVE spot-check half is blocked from this sandbox's network egress
// (confirmed 403/host_not_allowed against query1.finance.yahoo.com,
// data.sec.gov, and similarly against finnhub.io) and remains an open item
// -- see plan.md.
//
// FAILURE ISOLATION (Adopted Pattern #11 read literally: "surface a typed
// error and follow an explicit configured fallback order -- never silently
// serve thinner data without logging that a source was skipped"): each
// source below is its own failure domain. A VendorError from any one
// source (news or price/fundamentals) is logged with full vendor/transient
// detail and that source is skipped -- it does NOT abort the others. This
// is a deliberate change from the old GDELT-only behavior (which rethrew
// and killed the entire scheduled run on any GDELT failure); with five
// independent vendors now in play, one flaky/misconfigured source (e.g.
// EDGAR with no edgarUserAgent set) killing every other source's ingestion
// would be a worse failure mode than degrading to fewer items with a clear
// log line. A non-VendorError (an actual bug, not a vendor failure) still
// propagates immediately, same as before.

import { fetchLatest as fetchFinnhubLatest } from "../ingestion/sources/finnhub.js";
import { fetchLatest as fetchRssLatest } from "../ingestion/sources/rss.js";
// gdelt.js is intentionally NOT imported here anymore (2026-09-18) -- see
// plan.md's GDELT correction/replacement note. The file and its test
// coverage are kept in the repo, unwired but easy to re-enable, per an
// explicit product decision (not a unilateral removal): re-import
// fetchLatest/enrichWithFullText from "../ingestion/sources/gdelt.js" and
// add a "gdelt" entry back into collectNewsItems's `sources` array below
// if GDELT is ever reinstated as a source.
import { fetchLatest as fetchScrapeLatest } from "../ingestion/sources/html_scrape.js";
import { fetchDailyBars } from "../ingestion/sources/yfinance.js";
import { fetchLatest as fetchEdgarFactsLatest } from "../ingestion/sources/edgar_fundamentals.js";
import { insertNewsItem, insertPriceBar, insertFundamentalFacts } from "../storage/inputs_view.js";
import { VendorError } from "../shared/errors.js";

/** Logs a VendorError with full vendor/transient detail, one line per skipped source (see header's Failure Isolation note). Non-VendorErrors are not this function's job -- callers still let those propagate. */
function logSkippedSource(stage, source, err) {
  console.error(`${stage} vendor failure -- skipping source`, { source, vendor: err.vendor, transient: err.transient, message: err.message });
}

/**
 * Collects normalized news items from every news source (gdelt, rss,
 * html_scrape). Each source is attempted independently -- a VendorError
 * from one is logged and that source's items are simply absent from the
 * result, rather than aborting the others (see header's Failure Isolation
 * note). html_scrape's fetchLatest already isolates failures per-page
 * internally and returns `{items, errors}` rather than throwing, so its
 * per-page errors are logged here too, for the same "never silently skip"
 * reason, even though they don't hit the try/catch below.
 */
export async function collectNewsItems(config, kv) {
  const items = [];

  const sources = [
    {
      name: "finnhub",
      // GDELT's replacement (see plan.md, 2026-09-18) -- same failure-
      // isolation shape as every other source here: a per-ticker
      // VendorError is logged and that ticker's items are simply absent,
      // never aborts the rest of the watchlist or the other sources.
      run: async () => {
        const { items: finnhubItems, errors: finnhubErrors } = await fetchFinnhubLatest(config, {}, { kv });
        for (const { error } of finnhubErrors) {
          logSkippedSource("news ingestion", "finnhub", error);
        }
        return finnhubItems;
      },
    },
    { name: "rss", run: () => fetchRssLatest(config, {}, { kv }) },
    {
      name: "scrape",
      run: async () => {
        const { items: scraped, errors } = await fetchScrapeLatest(config, {}, { kv });
        for (const { url, error } of errors) {
          console.error("scrape vendor failure -- skipping page", { url, message: error.message });
        }
        return scraped;
      },
    },
  ];

  for (const { name, run } of sources) {
    try {
      items.push(...(await run()));
    } catch (err) {
      if (err instanceof VendorError) {
        logSkippedSource("news ingestion", name, err);
      } else {
        throw err;
      }
    }
  }

  return items;
}

/**
 * Fetches fresh daily price bars (yfinance) and upserts every bar via
 * storage/inputs_view.js#insertPriceBar. This is what makes the technical analyst
 * (agents/analysts/technicalAnalyst.js) actually have data to work with
 * instead of permanently self-skipping on an empty price_bars table -- see
 * that agent's header for the hasData gate this feeds. A VendorError here
 * (including yfinance's documented cookie/crumb risk, see that adapter's
 * header) is logged and swallowed -- price data is a strict enhancement to
 * the pipeline, not a hard dependency (runPipelineForTicker already
 * tolerates an empty getPriceBarsAsOf result), so one bad yfinance request
 * should not block news ingestion or the pipeline run. `kv` (typically
 * env.CACHE_KV, same as ingestFundamentals below) is passed through to
 * fetchDailyBars for its cross-invocation 429 cooldown -- omitting it still
 * works, it just means every invocation retries every ticker regardless of
 * a recent 429 (fails open, same convention as edgar_cik_lookup.js).
 */
export async function ingestPriceBars(config, db, kv, { tickers } = {}) {
  const { bars, errors } = await fetchDailyBars(config, tickers ? { tickers } : {}, { kv });
  for (const { error } of errors) {
    logSkippedSource("price bar ingestion", "yfinance", error);
  }

  for (const bar of bars) {
    await insertPriceBar(db, bar);
  }
  return { count: bars.length };
}

/**
 * Fetches fresh EDGAR XBRL facts for the resolved ticker list (edgarCikMap
 * if non-empty, else config.watchlist -- see
 * edgar_fundamentals.js#fetchLatest) and upserts them via
 * storage/inputs_view.js#insertFundamentalFact. A no-op (returns `{count: 0}`
 * without ever calling fetch) when BOTH edgarCikMap and watchlist are
 * empty -- config.js ships no default map or User-Agent on purpose (see
 * that file's header), so a fully unconfigured deployment should not error
 * here, only a misconfigured one (tickers resolved, User-Agent missing, or
 * a ticker that resolves to no CIK anywhere) should, and even that is
 * caught and logged (or, for a single unresolvable ticker, logged and
 * skipped -- see fetchLatest's own header) rather than aborting the run --
 * same "strict enhancement, not a hard dependency" reasoning as
 * ingestPriceBars. `kv` (optional, typically env.CACHE_KV) is passed
 * through to fetchLatest for resolveCik's live-SEC-lookup cache -- omitting
 * it still works, it just means every lookup misses cache and re-fetches
 * SEC's file live (fails open, see edgar_cik_lookup.js header).
 */
// D1 subrequest budget for the batched insert below. Each db.batch() call
// is ONE Worker subrequest no matter how many facts are in it, but D1
// still bounds a single batch's total statement count/payload size, so
// this stays well under that rather than trying to push everything
// through in one call. 200 is generous headroom under both that D1 limit
// and Cloudflare's own per-invocation subrequest cap for any watchlist
// size this project runs today.
const FUNDAMENTALS_INSERT_CHUNK_SIZE = 200;

export async function ingestFundamentals(config, db, kv, { tickers } = {}) {
  let facts;
  try {
    facts = await fetchEdgarFactsLatest(config, tickers ? { tickers } : {}, { kv });
  } catch (err) {
    if (err instanceof VendorError) {
      logSkippedSource("fundamentals ingestion", "edgar", err);
      return { count: 0 };
    }
    throw err;
  }

  // UPDATE (2026-09-17): batched via insertFundamentalFacts instead of one
  // insertFundamentalFact call per fact. The old per-fact loop meant one D1
  // subrequest per row -- EDGAR's full companyfacts history for a single
  // mature ticker/tag easily runs into the hundreds of historical/restated
  // entries, and this loop pulls 3 tags per ticker, so it was blowing
  // Cloudflare's per-invocation subrequest cap partway through a single
  // cron run (live incident: "Too many API requests by single Worker
  // invocation" x1047 in one run, all logged with ticker=TSLA before the
  // cap was hit -- see cf_workers_observability_query for that trace).
  // Chunking (rather than one db.batch() for all facts) keeps each batch
  // call's own size bounded and means a genuinely malformed chunk (e.g. a
  // D1 constraint violation) only loses that chunk's rows, not the whole
  // run's insert -- same Failure Isolation spirit as the old per-fact
  // try/catch, just scoped to a chunk instead of a single row now.
  let inserted = 0;
  for (let i = 0; i < facts.length; i += FUNDAMENTALS_INSERT_CHUNK_SIZE) {
    const chunk = facts.slice(i, i + FUNDAMENTALS_INSERT_CHUNK_SIZE);
    try {
      await insertFundamentalFacts(db, chunk);
      inserted += chunk.length;
    } catch (err) {
      console.error("fundamentals ingestion -- skipping one chunk of fact inserts", {
        chunkStart: i, chunkSize: chunk.length, message: err.message,
      });
    }
  }
  return { count: inserted };
}

/**
 * Historical news backfill for a real end-to-end backtest run -- the
 * remaining blocker plan.md's Backlog flagged once realized returns were
 * wired (see graph/settle.js): every ingestion adapter was "what's new
 * now" only, with finnhub.js hardcoding a trailing lookback window even
 * though Finnhub's /company-news endpoint accepts an arbitrary from/to
 * range. This just calls that range through and persists whatever comes
 * back via storage/inputs_view.js#insertNewsItem -- the exact same point-in-time
 * storage path live ingestion uses, so a backfilled article is
 * indistinguishable from a live-ingested one to any asOf-gated read
 * (getNewsAsOf, etc).
 *
 * SCOPE: finnhub only. rss.js and html_scrape.js are inherently "what's
 * published right now" sources (a live feed/page, not a queryable
 * archive with a date-range parameter) -- there is no from/to to give
 * them, so they cannot be backfilled this way. That's a real, permanent
 * gap for those two sources, not an oversight left for later (see
 * plan.md's Known Gaps for the "why").
 *
 * Same failure-isolation convention as collectNewsItems: a per-ticker
 * VendorError from fetchLatest is logged and skipped, never aborts the
 * rest of the range/watchlist. `from`/`to` are required (unlike
 * fetchLatest's own trailing-window default) -- this function's whole
 * purpose is an explicit historical range, so a caller forgetting to pass
 * one should fail loudly rather than silently backfill "the last 3 days"
 * again. Intended for a one-off backfill script/CLI, not the live cron
 * path (collectNewsItems above is the whole-watchlist sweep, unchanged).
 */
export async function backfillHistoricalNews(config, db, { from, to, kv, onProgress } = {}) {
  if (!from || !to) {
    throw new Error("backfillHistoricalNews requires an explicit {from, to} range -- use collectNewsItems for the live trailing-window path instead");
  }

  // `onProgress` (optional, the queue consumer's live-progress reporter --
  // see src/storage/jobs.js) is told about two phases, mapped onto 0-100 here
  // so the dashboard just draws it: fetching = 5-50 (one step per ticker),
  // saving = 50-100 (one step per article). It must never affect the
  // backfill's own outcome, so it is only ever awaited, never inspected.
  const tickerCount = config.watchlist?.length ?? 0;
  await onProgress?.({ phase: "fetching", percent: 5, done: 0, total: tickerCount, detail: `Fetching Finnhub news for ${tickerCount} ticker${tickerCount === 1 ? "" : "s"}`, force: true });

  const { items, errors } = await fetchFinnhubLatest(config, { from, to }, {
    kv,
    onTickerDone: ({ ticker, index, total }) =>
      onProgress?.({ phase: "fetching", percent: 5 + Math.round((45 * (index + 1)) / total), done: index + 1, total, detail: `Fetched ${ticker} (${index + 1}/${total})` }),
  });
  for (const { error } of errors) {
    logSkippedSource("historical news backfill", "finnhub", error);
  }

  const totalItems = items.length;
  await onProgress?.({ phase: "saving", percent: 50, done: 0, total: totalItems, detail: totalItems > 0 ? `Saving ${totalItems} article${totalItems === 1 ? "" : "s"}` : "No articles returned for this range", force: true });

  let inserted = 0;
  for (const item of items) {
    await insertNewsItem(db, item);
    inserted++;
    // Every 25th article, not every one: the reporter throttles writes
    // anyway, but this also keeps the per-article loop free of extra awaits.
    if (inserted % 25 === 0) {
      await onProgress?.({ phase: "saving", percent: 50 + Math.round((50 * inserted) / totalItems), done: inserted, total: totalItems, detail: `Saved ${inserted}/${totalItems} articles` });
    }
  }

  return { inserted, errors };
}

/**
 * Step 4 cron fan-out -- one INGEST message per ticker (src/index.js's
 * `scheduled` sends these instead of one whole-watchlist sweep).
 * Fetches finnhub news, price bars, and fundamentals SCOPED TO
 * THIS ONE TICKER ONLY (unlike collectNewsItems' whole-watchlist sweep
 * above), writes them to D1, and returns the inserted news items so
 * the INGEST consumer can enqueue one ANALYZE message per item for this
 * ticker. This is what turns one 15-minute cron tick into N small
 * invocations instead of one big one (plan.md Step 4's whole point) --
 * each ticker's finnhub/yfinance/edgar calls, and their D1 writes, happen
 * in their own Worker invocation with its own fresh CPU budget.
 *
 * General (non-ticker-scoped) feeds -- rss, html_scrape -- are NOT part of
 * this path; see ingestFeedNews below for those. Same failure-isolation
 * convention as collectNewsItems: a VendorError from any of the three
 * sub-fetches is logged and that source is skipped, never aborts the
 * others for this ticker.
 */
export async function ingestTickerData(config, db, kv, { ticker, asOf }) {
  const { items, errors } = await fetchFinnhubLatest(config, { queries: [{ ticker }] }, { kv });
  for (const { error } of errors) {
    logSkippedSource("ticker ingest", "finnhub", error);
  }

  const insertedNews = [];
  for (const item of items) {
    await insertNewsItem(db, item);
    insertedNews.push(item);
  }

  // Price bars / fundamentals are a strict enhancement, not a hard
  // dependency of this ticker's news ingestion (same reasoning as
  // ingestPriceBars/ingestFundamentals's own headers) -- a failure in
  // either is already logged-and-swallowed inside those functions, so no
  // extra try/catch is needed here.
  await ingestPriceBars(config, db, kv, { tickers: [ticker] });
  await ingestFundamentals(config, db, kv, { tickers: [ticker] });

  return insertedNews;
}

/**
 * Step 4 cron fan-out -- the "feeds" half of collectNewsItems (rss +
 * html_scrape), sent as a single separate INGEST message per cron tick
 * rather than fanned out per ticker, since neither source has a
 * per-ticker query mode to begin with (see rss.js/html_scrape.js's own
 * headers -- a feed/page is fetched once regardless of how many tickers
 * it might mention). Finnhub is deliberately excluded here -- that's
 * ingestTickerData's job now, not this one's, to avoid double-fetching/
 * double-inserting the same finnhub articles from two different fan-out
 * paths landing in the same cron tick.
 */
export async function ingestFeedNews(config, db, kv) {
  const items = [];

  const sources = [
    { name: "rss", run: () => fetchRssLatest(config, {}, { kv }) },
    {
      name: "scrape",
      run: async () => {
        const { items: scraped, errors } = await fetchScrapeLatest(config, {}, { kv });
        for (const { url, error } of errors) {
          console.error("scrape vendor failure -- skipping page", { url, message: error.message });
        }
        return scraped;
      },
    },
  ];

  for (const { name, run } of sources) {
    try {
      items.push(...(await run()));
    } catch (err) {
      if (err instanceof VendorError) {
        logSkippedSource("feed ingest", name, err);
      } else {
        throw err;
      }
    }
  }

  const insertedNews = [];
  for (const item of items) {
    await insertNewsItem(db, item);
    insertedNews.push(item);
  }
  return insertedNews;
}

