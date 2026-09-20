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

import { fetchLatest as fetchFinnhubLatest, createWindowedFetcher } from "../ingestion/sources/finnhub.js";
import { toDayString, addDays, daysBetween, buildWindows } from "./date_windows.js";
import { fetchLatest as fetchRssLatest } from "../ingestion/sources/rss.js";
// gdelt.js is intentionally NOT imported here anymore (2026-09-18) -- see
// plan.md's GDELT correction/replacement note. The file and its test
// coverage are kept in the repo, unwired but easy to re-enable, per an
// explicit product decision (not a unilateral removal): re-import
// fetchLatest/enrichWithFullText from "../ingestion/sources/gdelt.js" and
// add a "gdelt" entry back into collectNewsItems's `sources` array below
// if GDELT is ever reinstated as a source.
import { fetchLatest as fetchScrapeLatest } from "../ingestion/sources/html_scrape.js";
import { fetchDailyBars, fetchHistoricalBars } from "../ingestion/sources/yfinance.js";
import { fetchLatest as fetchEdgarFactsLatest } from "../ingestion/sources/edgar_fundamentals.js";
import { insertNewsItems, insertPriceBar, insertPriceBars, insertFundamentalFacts } from "../storage/inputs_view.js";
import { VendorError } from "../shared/errors.js";

// D1/subrequest budget for the batched news-item inserts below (backfill,
// ingestTickerData, ingestFeedNews). Deliberately kept at 100, not the
// fundamentals path's 200 (FUNDAMENTALS_INSERT_CHUNK_SIZE): a news item's
// batch entry count is variable (item row + revision row + one row per
// ticker, vs. a fundamental fact's fixed one row), and this same size also
// bounds filterUnstoredIds' own `WHERE id IN (...)` below, which D1 caps at
// ~100 bound params per statement -- so this one constant has to satisfy
// both, and 100 is the smaller/safer of the two limits. See
// backfillHistoricalNews's own header for the live incident this fixes
// ("Too many API requests by single Worker invocation", backfill job
// backfill-1789920460728-4lahlf, 2026-09-20).
const NEWS_ITEM_INSERT_CHUNK_SIZE = 100;

// Window size backfillHistoricalNews falls back to when the config carries no
// usable finnhubBackfillWindowDays (loadConfig always sets it; this is for the
// bare config objects tests and one-off scripts pass). Same value as config.js.
const DEFAULT_BACKFILL_WINDOW_DAYS = 5;

/**
 * Pre-filters `items` down to ones NOT already in news_items, via one
 * batched `SELECT id ... WHERE id IN (...)` per call (the caller is
 * responsible for keeping `items.length` within NEWS_ITEM_INSERT_CHUNK_SIZE,
 * same D1 bound-param reasoning as that constant's own comment). This is
 * what makes a retried or overlapping backfill cheap: without it, re-running
 * the same date range re-does insertNewsItems' full write batch (news_items
 * + revisions + tickers) for articles already stored, just to have every
 * statement no-op on ON CONFLICT DO NOTHING -- correct, but a wasted D1
 * round trip at exactly the scale (hundreds of articles) this fix is
 * trying to keep cheap. A no-op (returns `items` unchanged) on an empty
 * array, same convention as insertNewsItems/insertFundamentalFacts.
 */
async function filterUnstoredItems(db, items) {
  if (items.length === 0) return items;
  const ids = items.map((item) => item.id);
  const { results } = await db
    .prepare(`SELECT id FROM news_items WHERE id IN (${ids.map(() => "?").join(",")})`)
    .bind(...ids)
    .all();
  const existing = new Set(results.map((row) => row.id));
  return items.filter((item) => !existing.has(item.id));
}

/**
 * Collapses items that share an id into one whose `tickers` is the union. The
 * same article comes back from several tickers' /company-news queries (each
 * carrying its own hint), and its id is derived from url + publishedAt only. A
 * backfill window fetches every ticker before saving, so merging here keeps
 * every ticker association: left as separate entries, a duplicate that landed
 * in a later 100-item chunk than its twin would be dropped whole by the
 * already-stored pre-filter, and its ticker never written.
 */
function mergeDuplicateItems(items) {
  const byId = new Map();
  for (const item of items) {
    const existing = byId.get(item.id);
    if (!existing) {
      byId.set(item.id, item);
    } else if (item.tickers.some((ticker) => !existing.tickers.includes(ticker))) {
      byId.set(item.id, { ...existing, tickers: [...new Set([...existing.tickers, ...item.tickers])] });
    }
  }
  return [...byId.values()];
}

/** Logs a VendorError with full vendor/transient detail, one line per skipped source (see header's Failure Isolation note). Non-VendorErrors are not this function's job -- callers still let those propagate. `context` (optional) adds fields to the log line, e.g. the ticker and window of a backfill request. */
function logSkippedSource(stage, source, err, context = {}) {
  console.error(`${stage} vendor failure -- skipping source`, { source, vendor: err.vendor, transient: err.transient, message: err.message, ...context });
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
 * range. This walks that range in date windows (see WINDOWED FETCH below) and persists whatever comes
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
// WINDOWED FETCH (2026-09-20 fix). Finnhub's /company-news returns only the
// newest ~245 articles (INFERRED from stored data, not documented by Finnhub)
// per request however wide the range, so the old one-request-per-ticker fetch
// for the whole range could never reach past about a week: live, 30-day and
// 90-day backfills both reported "Inserted 0 articles" because the ~245 newest
// per ticker were already stored. The range is now walked in consecutive,
// non-overlapping windows of config.finnhubBackfillWindowDays (default 5)
// days. For each window every watchlist ticker is fetched
// (sources/finnhub.js#createWindowedFetcher, which splits any window whose
// response looks capped), then that window's articles are pre-filtered and
// saved before the next window starts.
//
// UNVERIFIED ASSUMPTION: windows are inclusive at both ends, which assumes
// Finnhub treats `to` as inclusive. Stored data supports it (to=<today>
// requests have produced today's articles) but it is not confirmed. After a
// real run, query the inputs DB for weekday days with no finnhub articles for
// any ticker; a gap on the first day of each window (or the last) would mean
// the assumption is wrong and windows need a one-day overlap.
//
// PER-CALL BOUNDS, both checked only at window boundaries and both optional
// (default unlimited -- unchanged for callers that don't pass them):
//   - `maxInserts` caps NET-NEW articles written. Once `inserted` reaches it
//     and windows remain, the call stops; it can overshoot by up to one
//     window's worth of articles.
//   - `maxRequests` caps Finnhub requests (external subrequests). A window is
//     only started if requests so far plus one per ticker fit under it, so a
//     rerun over an already-stored range (which inserts nothing and would
//     never trip `maxInserts`) still stops. Splitting a capped window can
//     push a window slightly past it.
// The first window of a call always runs, so every call makes progress and a
// chain of continuations always terminates. When the call stops early the
// result carries `nextFrom`, the first day of the next unprocessed window (a
// YYYY-MM-DD the caller re-enqueues a follow-up backfill from); it is null when
// the whole range was processed. Windows are aligned from `from`, so a
// follow-up starting at `nextFrom` continues the same window grid.
//
// PROGRESS: `originalFrom` (default `from`) is the start of the range the
// operator asked for. onProgress reports done/total as DAYS of that whole
// range covered so far (percent = 5 + 95 * done / total), so it only ever moves
// forward across a chain of continuation parts. The progress writer is
// throttled (storage/jobs.js), so the write that ends each window is forced:
// the last write of a call then always matches where the call really ended --
// complete() only sets percent/phase, it never touches done/total.
// `onProgress` must never affect the backfill's own outcome, so it is only
// ever awaited, never inspected.
export async function backfillHistoricalNews(config, db, { from, to, originalFrom, kv, onProgress, maxInserts = Infinity, maxRequests = Infinity } = {}) {
  if (!from || !to) {
    throw new Error("backfillHistoricalNews requires an explicit {from, to} range -- use collectNewsItems for the live trailing-window path instead");
  }

  const fromDay = toDayString(from);
  const toDay = toDayString(to);
  const rangeStart = originalFrom ? toDayString(originalFrom) : fromDay;
  const configuredWindowDays = Number(config.finnhubBackfillWindowDays);
  const windowDays = Number.isFinite(configuredWindowDays) && configuredWindowDays >= 1 ? Math.floor(configuredWindowDays) : DEFAULT_BACKFILL_WINDOW_DAYS;
  const windows = buildWindows(fromDay, toDay, windowDays);
  const tickers = config.watchlist ?? [];

  const totalDays = Math.max(0, daysBetween(rangeStart, toDay) + 1);
  const clampDays = (days) => Math.min(totalDays, Math.max(0, days));
  const percentFor = (days) => (totalDays > 0 ? 5 + Math.round((95 * days) / totalDays) : 100);
  let daysDone = clampDays(daysBetween(rangeStart, fromDay));

  await onProgress?.({
    phase: "fetching",
    percent: percentFor(daysDone),
    done: daysDone,
    total: totalDays,
    detail: `Fetching Finnhub news for ${tickers.length} ticker${tickers.length === 1 ? "" : "s"} in ${windows.length} window${windows.length === 1 ? "" : "s"} of up to ${windowDays} days`,
    force: true,
  });

  const fetcher = await createWindowedFetcher(config, { kv });

  // Saving is chunked plus pre-filtered plus batched (2026-09-20): the old
  // one-insertNewsItem-call-per-article loop did 2-3 unbatched D1 .run()s per
  // article, and 733 articles blew Cloudflare's per-invocation subrequest cap
  // partway through a real run (live incident: job
  // backfill-1789920460728-4lahlf, crashed mid-saving at 325/733 on 'Too many
  // API requests by single Worker invocation' -- see
  // NEWS_ITEM_INSERT_CHUNK_SIZE's own comment). filterUnstoredItems first,
  // then insertNewsItems as one db.batch() per chunk, mirrors
  // ingestFundamentals' own fix for the identical fundamentals-side failure.
  // `inserted` means net-new articles (insertedIds.size), not articles
  // processed, so a retried or overlapping backfill reports zero accurately
  // instead of re-claiming credit for articles a previous run already saved.
  // KNOWN LIMIT: the pre-filter skips an article whose id is already stored
  // even when it is now being fetched under a ticker it has no association
  // for (the live ingest path does add those, this one does not).
  // UNLIKE ingestFundamentals' own chunk loop, a chunk's write failure here
  // is NOT caught-and-skipped -- it propagates. This is deliberate, not an
  // oversight: the caller (ingest-worker.js's `backfill` branch) wraps the
  // whole call in its own try/catch and reports the job `failed` via the
  // progress reporter on any error (see that Worker's own comment: "retrying
  // a call that already spent real Finnhub quota on failure would just spend
  // it again") -- a D1 write error here means the job's core deliverable
  // (saved articles) is broken, which should surface as a failed job for the
  // operator to see, not a silently-degraded partial save. Fundamentals are a
  // strict enhancement to the pipeline (see ingestFundamentals' own header); a
  // backfill's whole point IS saving articles, so the two warrant different
  // failure-isolation scopes.
  let inserted = 0;
  let processed = 0;
  let windowsDone = 0;
  let nextFrom = null;
  const errors = [];
  const truncated = [];

  for (const [windowIndex, win] of windows.entries()) {
    if (windowIndex > 0 && (inserted >= maxInserts || fetcher.requestCount() + tickers.length > maxRequests)) {
      nextFrom = win.from;
      break;
    }

    const fetched = [];
    for (const [tickerIndex, { ticker }] of tickers.entries()) {
      const result = await fetcher.fetchWindow(ticker, win);
      fetched.push(...result.items);
      errors.push(...result.errors);
      truncated.push(...result.truncated);
      for (const { error, window } of result.errors) {
        logSkippedSource("historical news backfill", "finnhub", error, { ticker, window });
      }
      await onProgress?.({ phase: "fetching", percent: percentFor(daysDone), done: daysDone, total: totalDays, detail: `Window ${win.from}..${win.to}: fetched ${ticker} (${tickerIndex + 1}/${tickers.length})` });
    }

    // Chronological (ties broken by id), one entry per article id.
    const items = mergeDuplicateItems(fetched);
    items.sort((a, b) => (a.publishedAt < b.publishedAt ? -1 : a.publishedAt > b.publishedAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    await onProgress?.({ phase: "saving", percent: percentFor(daysDone), done: daysDone, total: totalDays, detail: items.length > 0 ? `Window ${win.from}..${win.to}: saving ${items.length} article${items.length === 1 ? "" : "s"}` : `Window ${win.from}..${win.to}: no articles` });

    let windowInserted = 0;
    for (let i = 0; i < items.length; i += NEWS_ITEM_INSERT_CHUNK_SIZE) {
      const chunk = items.slice(i, i + NEWS_ITEM_INSERT_CHUNK_SIZE);
      const toInsert = await filterUnstoredItems(db, chunk);
      if (toInsert.length > 0) {
        const { insertedIds } = await insertNewsItems(db, toInsert);
        windowInserted += insertedIds.size;
      }
    }

    inserted += windowInserted;
    processed += items.length;
    windowsDone++;
    daysDone = clampDays(daysBetween(rangeStart, addDays(win.to, 1)));
    await onProgress?.({ phase: "saving", percent: percentFor(daysDone), done: daysDone, total: totalDays, detail: `Window ${win.from}..${win.to} done (${daysDone}/${totalDays} days): ${items.length} fetched, ${windowInserted} new`, force: true });
  }

  return { inserted, processed, errors, truncated, nextFrom, windows: windowsDone, requests: fetcher.requestCount() };
}

// D1 batch-insert chunk size for backfillHistoricalPriceBars below, same
// one-subrequest-per-db.batch()-call reasoning as FUNDAMENTALS_INSERT_CHUNK_SIZE.
// A year of daily bars is only ~252 rows per ticker, so even the full
// 3-ticker watchlist over a year (~750 rows) fits in a handful of chunks at
// this size, comfortably inside one Worker invocation -- unlike the news
// backfill, this never needs continuation/parts (see fetchHistoricalBars's
// own header: one HTTP request per ticker for the whole range, not a
// per-request article-style cap to walk around).
const PRICE_BAR_INSERT_CHUNK_SIZE = 200;

/**
 * Historical price-bar backfill -- plan.md Next Steps step A (backtest audit
 * finding 1: price_bars held only 5 days each for AAPL/TSLA and zero for
 * MSFT, so a backtest window couldn't open positions outside a handful of
 * days and the buy-and-hold baseline silently measured a ~5-day return).
 * Fetches `tickers` (default config.watchlist) over an explicit [from, to]
 * range via ingestion/sources/yfinance.js#fetchHistoricalBars and writes
 * every returned bar through the batched storage/inputs_view.js#insertPriceBars
 * -- the exact same point-in-time (ticker, date) upsert live ingestion uses,
 * so a backfilled bar is indistinguishable from a live-ingested one to any
 * asOf-gated read (getPriceBarsAsOf).
 *
 * UNLIKE backfillHistoricalNews, this is a SINGLE Worker invocation with no
 * parts/continuation mechanism: fetchHistoricalBars makes exactly one HTTP
 * request per ticker for the WHOLE range (see that function's own header),
 * so even a full-year, 3-ticker backfill is 3 requests and (at 252
 * trading days/ticker) under 1,000 rows -- well inside one invocation's
 * CPU/subrequest budget once writes are chunked/batched (see
 * PRICE_BAR_INSERT_CHUNK_SIZE above). If this project's watchlist or backfill
 * range grows enough to change that assumption, revisit before relying on
 * this staying single-shot.
 *
 * Same failure-isolation convention as every other ingestion path here: a
 * per-ticker VendorError (network failure, non-2xx, or an active 429
 * cross-invocation cooldown -- see yfinance.js's header on how sustained
 * that 429 has been observed to be, MSFT especially) is logged and that
 * ticker's bars are simply absent from the result, never aborts the rest of
 * the tickers. `from`/`to` are required, same explicit-range-only convention
 * as backfillHistoricalNews (no silent trailing-window default).
 */
export async function backfillHistoricalPriceBars(config, db, kv, { tickers, from, to, onProgress } = {}) {
  if (!from || !to) {
    throw new Error("backfillHistoricalPriceBars requires an explicit {from, to} range -- use ingestPriceBars for the live trailing-window path instead");
  }

  const resolvedTickers = tickers && tickers.length > 0 ? tickers : (config.watchlist ?? []).map((w) => w.ticker);

  await onProgress?.({
    phase: "fetching",
    percent: 5,
    detail: `Fetching yfinance daily bars for ${resolvedTickers.length} ticker${resolvedTickers.length === 1 ? "" : "s"}, ${from}..${to}`,
    force: true,
  });

  const { bars, errors, requests } = await fetchHistoricalBars(config, { tickers: resolvedTickers, from, to }, { kv });
  for (const { ticker, error } of errors) {
    logSkippedSource("historical price backfill", "yfinance", error, { ticker });
  }

  await onProgress?.({
    phase: "saving",
    percent: 50,
    detail: `Saving ${bars.length} bar${bars.length === 1 ? "" : "s"}`,
    force: true,
  });

  let inserted = 0;
  for (let i = 0; i < bars.length; i += PRICE_BAR_INSERT_CHUNK_SIZE) {
    const chunk = bars.slice(i, i + PRICE_BAR_INSERT_CHUNK_SIZE);
    await insertPriceBars(db, chunk);
    inserted += chunk.length;
  }

  // A ticker with neither an error nor any returned bars is its own signal
  // (an empty-but-200 response, e.g. a bad/delisted symbol or a range with no
  // trading days) -- surfaced separately from `errors` so a caller/operator
  // can tell "we don't know why this ticker has no bars" apart from a logged
  // vendor failure.
  const tickersWithNoBars = resolvedTickers.filter((ticker) => !bars.some((bar) => bar.ticker === ticker) && !errors.some((e) => e.ticker === ticker));

  await onProgress?.({
    phase: "saving",
    percent: 100,
    detail: `Saved ${inserted} bar${inserted === 1 ? "" : "s"} across ${resolvedTickers.length} ticker${resolvedTickers.length === 1 ? "" : "s"}`,
    force: true,
  });

  return { inserted, errors, tickers: resolvedTickers.length, requests, tickersWithNoBars };
}

/**
 * Step 4 cron fan-out -- one INGEST message per ticker (src/index.js's
 * `scheduled` sends these instead of one whole-watchlist sweep).
 * Fetches finnhub news, price bars, and fundamentals SCOPED TO
 * THIS ONE TICKER ONLY (unlike collectNewsItems' whole-watchlist sweep
 * above), writes them to D1, and returns what the INGEST consumer should
 * enqueue ANALYZE messages for. This is what turns one 15-minute cron tick into N small
 * invocations instead of one big one (plan.md Step 4's whole point) --
 * each ticker's finnhub/yfinance/edgar calls, and their D1 writes, happen
 * in their own Worker invocation with its own fresh CPU budget.
 *
 * General (non-ticker-scoped) feeds -- rss, html_scrape -- are NOT part of
 * this path; see ingestFeedNews below for those. Same failure-isolation
 * convention as collectNewsItems: a VendorError from any of the three
 * sub-fetches is logged and that source is skipped, never aborts the
 * others for this ticker.
 *
 * Returns `{ fetched, fresh }`. `fetched` is how many items Finnhub returned;
 * `fresh` is `[{ item, tickers: [ticker] }]` for only the items that are NEW
 * for this ticker -- the news_items row was just inserted, or the
 * (item, ticker) association was. Finnhub's /company-news returns a trailing
 * window (finnhubLookbackDays), so on any given tick most of `fetched` is
 * already stored; returning all of it (what this used to do) made the
 * consumer re-enqueue the whole window every 15 minutes -- past Cloudflare's
 * 100-message sendBatch cap, and past the Queues daily-ops budget had that cap
 * been worked around by chunking alone.
 */
export async function ingestTickerData(config, db, kv, { ticker, asOf }) {
  const { items, errors } = await fetchFinnhubLatest(config, { queries: [{ ticker }] }, { kv });
  for (const { error } of errors) {
    logSkippedSource("ticker ingest", "finnhub", error);
  }

  // UPDATE (2026-09-20): batched, replacing a plain per-item insertNewsItem
  // loop. Same subrequest-cap fix as backfillHistoricalNews above -- this
  // loop runs on EVERY 15-minute cron tick, not just a one-off backfill, and
  // observability confirmed it as the live cause of TSLA silently getting no
  // fresh news for hours: TSLA is processed last in a 4-message ingest
  // batch (ingest_feeds + 3x ingest_ticker), so by the time its own
  // Finnhub page (~100-160 items) hit this loop, AAPL/MSFT's own unbatched
  // inserts had already spent most of the invocation's shared subrequest
  // budget. No pre-filter here (unlike backfill) -- unlike a backfill's
  // deliberately overlapping ranges, Finnhub's trailing-window page is not
  // expected to be mostly-duplicate on a normal tick, so the extra SELECT
  // round trip isn't worth it; ON CONFLICT DO NOTHING already makes a
  // redundant insert a correct no-op either way.
  const fresh = [];
  for (let i = 0; i < items.length; i += NEWS_ITEM_INSERT_CHUNK_SIZE) {
    const chunk = items.slice(i, i + NEWS_ITEM_INSERT_CHUNK_SIZE);
    const { insertedIds, newTickersPerItem } = await insertNewsItems(db, chunk);
    for (let j = 0; j < chunk.length; j++) {
      const item = chunk[j];
      if (insertedIds.has(item.id) || newTickersPerItem[j].includes(ticker)) fresh.push({ item, tickers: [ticker] });
    }
  }

  // Price bars / fundamentals are a strict enhancement, not a hard
  // dependency of this ticker's news ingestion (same reasoning as
  // ingestPriceBars/ingestFundamentals's own headers) -- a failure in
  // either is already logged-and-swallowed inside those functions, so no
  // extra try/catch is needed here.
  await ingestPriceBars(config, db, kv, { tickers: [ticker] });
  await ingestFundamentals(config, db, kv, { tickers: [ticker] });

  return { fetched: items.length, fresh };
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
 *
 * Returns `{ fetched, fresh }` like ingestTickerData, except each `fresh` entry
 * carries the tickers that are NEW for that item (`newTickers` from
 * insertNewsItem): every resolved ticker for a brand-new item, only the added
 * one when an already-stored article shows up under another feed's ticker
 * hint. Items with no new ticker are left out.
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

  // UPDATE (2026-09-20): batched, same subrequest-cap fix and no-pre-filter
  // reasoning as ingestTickerData above -- this runs once per cron tick
  // alongside the per-ticker ingest_ticker messages, sharing the same kind
  // of invocation-wide subrequest budget.
  const fresh = [];
  for (let i = 0; i < items.length; i += NEWS_ITEM_INSERT_CHUNK_SIZE) {
    const chunk = items.slice(i, i + NEWS_ITEM_INSERT_CHUNK_SIZE);
    const { newTickersPerItem } = await insertNewsItems(db, chunk);
    for (let j = 0; j < chunk.length; j++) {
      if (newTickersPerItem[j].length > 0) fresh.push({ item: chunk[j], tickers: newTickersPerItem[j] });
    }
  }
  return { fetched: items.length, fresh };
}

