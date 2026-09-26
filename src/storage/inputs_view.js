// InputsView -- plan.md "Design: environments": input reads (news, price
// bars, fundamentals) live in the shared `inputs` DB (migrations/inputs/),
// every read requires an explicit `asOf` (LookaheadViolationError on a
// missing one -- there is deliberately no "give me everything" read here),
// and the point-in-time cutoff is therefore true by construction for every
// agent input, live or backtest. These functions take the db handle as their
// first argument: pass env.INPUTS_DB directly where writing is allowed
// (`ingest`, `backfill`), and `readOnly(env.INPUTS_DB)` from run_store.js
// everywhere else (`llm`, and the future `backtest` Worker) -- D1 bindings
// can't be made read-only in config, so that wrapper is the code half of the
// isolation rule.
//
// Moved verbatim from storage/d1.js in M2 (the SQL was already
// byte-for-byte what the inputs schema wants); the state-table functions
// that used to sit beside them are replaced by RunStore (run_store.js).

import { LookaheadViolationError } from "../shared/errors.js";
import { assertNoPriceBarLookahead, priceBarCutoffDate } from "../shared/price_availability.js";
import { assertNoIntradayLookahead, intradayBarAvailableAt, intradayCutoffTs } from "../shared/intraday_availability.js";
import { gateIntradayBars, summarizeIntradayRejections } from "../shared/intraday_sanity.js";

/** Rows per D1 round trip in getNewsItemsInRange. A response-size bound only; the function pages until the range is exhausted. */
export const NEWS_RANGE_PAGE_SIZE = 500;

/** Rows a write statement changed, per D1's `meta.changes` (0 for an `ON CONFLICT DO NOTHING` that hit a conflict). */
function rowsChanged(result) {
  return result?.meta?.changes ?? 0;
}

/**
 * Idempotent insert of one normalized news item (+ its revision-1 row and its
 * ticker associations). Returns what was actually NEW, so the ingest Worker can
 * enqueue analysis for new material only:
 *   - `inserted`   -- the `news_items` row did not exist before this call.
 *   - `newTickers` -- the tickers whose `(news_item_id, ticker)` association did
 *                     not exist before. A brand-new item has all of them; an
 *                     already-stored item can still gain one (the same article
 *                     surfacing under a second ticker's feed/query -- its id is
 *                     derived from url + publishedAt only, so the two collide
 *                     on the same row).
 * Why this exists: Finnhub's `/company-news` returns a trailing window, so
 * every 15-minute tick re-fetches the same ~160 items per ticker. Before this
 * returned anything, the ingest Worker treated every fetched item as new and
 * tried to enqueue all of them every tick.
 */
export async function insertNewsItem(db, item) {
  const itemResult = await db
    .prepare(
      `INSERT INTO news_items (id, source, url, first_published_at, ingested_at, title, body, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    )
    .bind(item.id, item.source, item.url, item.publishedAt, item.ingestedAt, item.title, item.body, JSON.stringify(item.raw ?? null))
    .run();
  const inserted = rowsChanged(itemResult) > 0;

  // revision 1 on first insert; re-ingesting the same id with different
  // content is a future concern for the adapter layer to detect and insert
  // as revision 2, not this function's job.
  await db
    .prepare(
      `INSERT INTO news_item_revisions (news_item_id, revision, published_at, ingested_at, title, body, raw)
       VALUES (?, 1, ?, ?, ?, ?, ?)
       ON CONFLICT(news_item_id, revision) DO NOTHING`
    )
    .bind(item.id, item.publishedAt, item.ingestedAt, item.title, item.body, JSON.stringify(item.raw ?? null))
    .run();

  const newTickers = [];
  for (const ticker of item.tickers) {
    const tickerResult = await db
      .prepare(`INSERT INTO news_item_tickers (news_item_id, ticker) VALUES (?, ?) ON CONFLICT DO NOTHING`)
      .bind(item.id, ticker)
      .run();
    if (rowsChanged(tickerResult) > 0) newTickers.push(ticker);
  }

  return { inserted, newTickers };
}

/**
 * Batched sibling of insertNewsItem -- same idempotent per-article writes
 * (news_items row, revision-1 row, ticker associations), but for many items
 * in ONE db.batch() call instead of ~2-5 unbatched .run()s PER ARTICLE. Each
 * individual .run() is its own Worker subrequest, so an unbatched loop over
 * hundreds of articles -- a full historical backfill, or even one ticker's
 * live 15-minute Finnhub page -- can blow Cloudflare's per-invocation
 * subrequest cap partway through (live incident: backfill job
 * backfill-1789920460728-4lahlf crashed mid-"saving" phase at 325/733 on
 * "Too many API requests by single Worker invocation", confirmed via
 * cf_workers_observability_query against news-market-ai-ingest,
 * 2026-09-20). This is the same fix insertFundamentalFacts already applied
 * for fundamentals on 2026-09-17 -- see that function's own header for the
 * matching incident on that path.
 *
 * Returns `{ insertedIds, newTickersPerItem }` so freshness-tracking
 * callers (ingestTickerData/ingestFeedNews's "enqueue analyze only for new
 * material" logic) keep working: `insertedIds` is the Set of item ids whose
 * `news_items` row did not exist before this call; `newTickersPerItem` is an
 * array PARALLEL TO `items` (same index, not keyed by id) -- each entry is
 * the tickers newly associated by THAT item's own ticker-insert statements.
 *
 * Deliberately parallel-array, not id-keyed: `items` can contain two
 * entries with the SAME id (ingestFeedNews's actual live case -- the same
 * article surfacing under two different feed configs, each carrying its
 * own single-ticker hint), and the two must NOT have their new-ticker
 * results merged together. Because a batch executes as one sequential
 * transaction, the second same-id entry's own ticker insert already sees
 * the first entry's ticker as committed (so a genuinely repeated ticker
 * correctly reports empty), while each entry still gets credited only for
 * the ticker(s) IT ITSELF newly added -- exactly the same outcome the old
 * per-item sequential insertNewsItem loop produced one call at a time.
 * `insertedIds` has no equivalent ambiguity worth solving here: it only
 * answers "does this id now exist", not "which item made it exist", so a
 * Set of ids is unambiguous and is left as-is.
 *
 * No-op on an empty array (mirrors insertFundamentalFacts). Callers are
 * expected to chunk `items` themselves (see ingestion/ingest.js's
 * NEWS_ITEM_INSERT_CHUNK_SIZE) -- this function does not chunk internally,
 * same division of responsibility as insertFundamentalFacts/
 * ingestFundamentals.
 */
export async function insertNewsItems(db, items) {
  if (items.length === 0) return { insertedIds: new Set(), newTickersPerItem: [] };

  const itemStmt = db.prepare(
    `INSERT INTO news_items (id, source, url, first_published_at, ingested_at, title, body, raw)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`
  );
  const revisionStmt = db.prepare(
    `INSERT INTO news_item_revisions (news_item_id, revision, published_at, ingested_at, title, body, raw)
     VALUES (?, 1, ?, ?, ?, ?, ?)
     ON CONFLICT(news_item_id, revision) DO NOTHING`
  );
  const tickerStmt = db.prepare(`INSERT INTO news_item_tickers (news_item_id, ticker) VALUES (?, ?) ON CONFLICT DO NOTHING`);

  // One batch entry per statement, same per-item sequence (item row, its
  // revision, then each ticker association) as the unbatched insertNewsItem
  // above -- kept identical purely so the two are easy to diff against each
  // other, not because order matters here (nothing in this batch depends on
  // another statement in the SAME batch having already committed).
  const batch = [];
  for (const item of items) {
    batch.push(itemStmt.bind(item.id, item.source, item.url, item.publishedAt, item.ingestedAt, item.title, item.body, JSON.stringify(item.raw ?? null)));
    batch.push(revisionStmt.bind(item.id, item.publishedAt, item.ingestedAt, item.title, item.body, JSON.stringify(item.raw ?? null)));
    for (const ticker of item.tickers) {
      batch.push(tickerStmt.bind(item.id, ticker));
    }
  }

  const results = await db.batch(batch);

  // Walk `results` in the exact order statements were pushed above to
  // recover per-item/per-ticker outcomes -- db.batch() returns one result
  // per statement, in order, same convention rowsChanged() already reads
  // for insertNewsItem's own single-row .run() calls.
  const insertedIds = new Set();
  const newTickersPerItem = [];
  let i = 0;
  for (const item of items) {
    const itemResult = results[i++];
    i++; // revisionResult -- unused beyond advancing the index, same as insertNewsItem never inspecting its own revision write's outcome
    if (rowsChanged(itemResult) > 0) insertedIds.add(item.id);
    const newTickers = [];
    for (const ticker of item.tickers) {
      const tickerResult = results[i++];
      if (rowsChanged(tickerResult) > 0) newTickers.push(ticker);
    }
    newTickersPerItem.push(newTickers);
  }

  return { insertedIds, newTickersPerItem };
}

/**
 * Point-in-time read: news for `ticker` whose LATEST-AS-OF-asOf revision
 * published at or before `asOf`. This is what makes it revision-aware
 * (plan.md Backtesting Integrity, point 2) -- it serves whichever version of
 * the article actually existed at `asOf`, not necessarily the newest one in
 * the table.
 */
export async function getNewsAsOf(db, { ticker, asOf, limit = 50 }) {
  if (!asOf) {
    throw new LookaheadViolationError("getNewsAsOf requires an explicit asOf timestamp");
  }

  // Bounded by published_at (idx_revisions_published_at) first, ticker checked
  // via an EXISTS point lookup on news_item_tickers' PK (news_item_id, ticker)
  // -- see this file's header note on the 2026-09-25 D1 read-limit incident. A
  // JOIN starting from news_item_tickers instead (t.ticker = ? first) has no
  // date to bound it and walks the ticker's ENTIRE history before this filter
  // or LIMIT ever applies.
  const { results } = await db
    .prepare(
      `SELECT r.news_item_id AS id, r.revision, r.published_at AS published_at, r.title, r.body
       FROM news_item_revisions r
       WHERE r.published_at <= ?
         AND EXISTS (SELECT 1 FROM news_item_tickers t WHERE t.news_item_id = r.news_item_id AND t.ticker = ?)
         AND r.revision = (
           SELECT MAX(r2.revision) FROM news_item_revisions r2
           WHERE r2.news_item_id = r.news_item_id AND r2.published_at <= ?
         )
       ORDER BY r.published_at DESC
       LIMIT ?`
    )
    .bind(asOf, ticker, asOf, limit)
    .all();

  return results;
}

/**
 * Enumeration read, NOT a point-in-time snapshot like getNewsAsOf above --
 * this is what backtest/onSignalRunner.js needs instead: every backfilled
 * news item for `ticker` published in [from, to), so the runner can drive
 * runPipelineForTicker once per item, each call using THAT item's own
 * published_at as its asOf (exactly the live cron path's own convention,
 * see ingestion/ingest.js (runScheduledIngestion was deleted in M2)). getNewsAsOf can't serve
 * this: it answers "what would an agent reading at one single asOf see",
 * capped at `limit` and newest-first, not "list every decision point in a
 * date range" in chronological order.
 *
 * Still bounded on BOTH ends (`from` AND `to` both required) -- same
 * no-"give me everything" convention as every asOf-gated reader above,
 * just with an explicit window instead of a single cutoff. Reuses
 * getNewsAsOf's own revision-selection subquery (latest revision as of
 * the ROW's own published_at, not `to`) so a backfilled item is read the
 * same revision-correct way live ingestion would have seen it at the time
 * it first appeared -- trivial today since insertNewsItem only ever writes
 * revision 1 (see that function's own comment), but this stays correct
 * the day a real revision-2 writer exists.
 *
 * NO ROW CAP (plan.md Next steps, step B): this used to take `limit = 500`, and
 * the only caller passed none, so a backtest silently processed just the first
 * 500 items per ticker per window. It now returns EVERY item in the range,
 * oldest first, by keyset-paging through D1 `pageSize` rows at a time.
 * `pageSize` only bounds one D1 response; it is not a cap. Order is
 * (published_at, news_item_id), a total order, so a page boundary that lands
 * inside a run of identical timestamps neither skips nor repeats a row.
 */
export async function getNewsItemsInRange(db, { ticker, from, to, pageSize = NEWS_RANGE_PAGE_SIZE }) {
  if (!from || !to) {
    throw new LookaheadViolationError("getNewsItemsInRange requires an explicit {from, to} range");
  }
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error(`getNewsItemsInRange: pageSize must be a positive integer, got ${pageSize}`);
  }

  const items = [];
  let cursor = null;
  for (;;) {
    const page = await getNewsItemsPage(db, { ticker, from, to, cursor, pageSize });
    for (const row of page) items.push(row);
    if (page.length < pageSize) return items;
    const last = page[page.length - 1];
    cursor = { publishedAt: last.published_at, id: last.id };
  }
}

/**
 * One keyset page of getNewsItemsInRange: up to `pageSize` rows strictly after
 * `cursor` ({publishedAt, id} of the previous page's last row) in
 * (published_at, news_item_id) order, or from the start of the range when
 * `cursor` is null. With a cursor the lower bound moves up to the cursor's
 * timestamp, so each page scans only the not-yet-read part of the range.
 */
async function getNewsItemsPage(db, { ticker, from, to, cursor, pageSize }) {
  const cursorClause = cursor ? `AND (r.published_at > ? OR (r.published_at = ? AND r.news_item_id > ?))` : "";
  // published_at range first (idx_revisions_published_at bounds the scan to
  // this page's window across ALL tickers), ticker checked via an indexed
  // EXISTS on news_item_tickers' PK -- see getNewsAsOf's comment above and
  // this file's header note on the 2026-09-25 D1 read-limit incident. The old
  // JOIN-from-news_item_tickers shape re-scanned a ticker's whole history on
  // every one of onSignalRunner.js's per-(ticker,day) calls.
  const binds = cursor
    ? [from, to, cursor.publishedAt, cursor.publishedAt, cursor.id, ticker, pageSize]
    : [from, to, ticker, pageSize];

  const { results } = await db
    .prepare(
      `SELECT r.news_item_id AS id, r.revision, r.published_at AS published_at, r.title, r.body
       FROM news_item_revisions r
       WHERE r.published_at >= ? AND r.published_at < ?
         ${cursorClause}
         AND EXISTS (SELECT 1 FROM news_item_tickers t WHERE t.news_item_id = r.news_item_id AND t.ticker = ?)
         AND r.revision = (
           SELECT MAX(r2.revision) FROM news_item_revisions r2
           WHERE r2.news_item_id = r.news_item_id AND r2.published_at <= r.published_at
         )
       ORDER BY r.published_at ASC, r.news_item_id ASC
       LIMIT ?`
    )
    .bind(...binds)
    .all();

  return results;
}

/**
 * Fetch specific news items by id, LATEST revision each -- for the
 * backtest/newsReplay.js operator tool: the caller already knows exactly
 * which ids it wants (picked from a prior getNewsItemsInRange listing), so
 * this is a plain lookup, not a point-in-time read (no asOf gating -- an
 * operator deliberately replaying an old item is not an agent that could
 * leak lookahead). Returns rows in no particular order; missing ids are
 * silently omitted rather than erroring, same "tell the caller what you
 * found" convention as insertNewsItems' insertedIds.
 */
export async function getNewsItemsByIds(db, { ids }) {
  if (!ids || ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const { results } = await db
    .prepare(
      `SELECT r.news_item_id AS id, r.revision, r.published_at AS published_at, r.title, r.body
       FROM news_item_revisions r
       WHERE r.news_item_id IN (${placeholders})
         AND r.revision = (SELECT MAX(r2.revision) FROM news_item_revisions r2 WHERE r2.news_item_id = r.news_item_id)`
    )
    .bind(...ids)
    .all();
  return results;
}

/**
 * Write path for daily OHLCV bars (ingestion/sources/yfinance.js). Upsert on
 * (ticker, date) since re-ingesting the same trading day should overwrite
 * rather than duplicate -- unlike news, a price bar has no meaningful
 * "revision" concept to preserve.
 */
export async function insertPriceBar(db, bar) {
  await db
    .prepare(
      `INSERT INTO price_bars (ticker, date, open, high, low, close, volume, source, ingested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ticker, date) DO UPDATE SET
         open = excluded.open, high = excluded.high, low = excluded.low,
         close = excluded.close, volume = excluded.volume,
         source = excluded.source, ingested_at = excluded.ingested_at`
    )
    .bind(bar.ticker, bar.date, bar.open, bar.high, bar.low, bar.close, bar.volume, bar.source, new Date().toISOString())
    .run();
}

/**
 * Batched sibling of insertPriceBar -- same (ticker, date) upsert, but for
 * many bars in ONE db.batch() call instead of one .run() per bar. Each
 * individual .run() is its own Worker subrequest, same reasoning as
 * insertFundamentalFacts/insertNewsItems' own headers -- a historical
 * price-bar backfill (ingestion/ingest.js#backfillHistoricalPriceBars,
 * plan.md Next Steps step A) can easily write several hundred rows across a
 * multi-ticker, multi-month range in one Worker invocation, and an unbatched
 * loop over that many .run() calls risks the same per-invocation subrequest
 * cap other unbatched insert loops in this codebase have already hit live
 * (see insertNewsItems' own header for that incident). No-op on an empty
 * array (mirrors insertFundamentalFacts/insertNewsItems).
 */
export async function insertPriceBars(db, bars) {
  if (bars.length === 0) return;

  const stmt = db.prepare(
    `INSERT INTO price_bars (ticker, date, open, high, low, close, volume, source, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ticker, date) DO UPDATE SET
       open = excluded.open, high = excluded.high, low = excluded.low,
       close = excluded.close, volume = excluded.volume,
       source = excluded.source, ingested_at = excluded.ingested_at`
  );

  const ingestedAt = new Date().toISOString();
  const batch = bars.map((bar) => stmt.bind(bar.ticker, bar.date, bar.open, bar.high, bar.low, bar.close, bar.volume, bar.source, ingestedAt));

  await db.batch(batch);
}

/**
 * Write path for intraday bars (ingestion/sources/alpaca.js,
 * ingestion/sources/twelvedata.js -- plan.md finding G, step 6). Same
 * batched-upsert shape as insertPriceBars, but keyed on (ticker, ts) rather
 * than (ticker, date): a bar for a given 5-minute window should overwrite on
 * a re-fetch (e.g. a retried backfill day), never duplicate. One db.batch()
 * call for the whole array, same one-subrequest-per-call reasoning as every
 * other batched insert in this file (insertPriceBars/insertNewsItems/
 * insertFundamentalFacts) -- a single backfill day is at most ~288 5-minute
 * bars (24h) or ~78 (one US equity session), so callers do not need to chunk
 * this themselves the way NEWS_ITEM_INSERT_CHUNK_SIZE requires for news.
 * No-op on an empty array (mirrors insertPriceBars).
 *
 * WRITE-TIME SANITY GATE (shared/intraday_sanity.js): every batch, from every
 * vendor, is checked before it is written -- ts canonicalised, price envelope,
 * closed-market windows. A bad bar is DROPPED, not thrown on, and logged
 * loudly (Adopted Pattern #11); the caller gets `{written, rejected}` so it can
 * record what was dropped. `rejected` is `[{ticker, ts, code, reason}]`.
 */
export async function insertPriceBarsIntraday(db, bars) {
  if (bars.length === 0) return { written: 0, rejected: [] };

  const { accepted, rejected } = gateIntradayBars(bars);
  if (rejected.length > 0) {
    console.error("intraday write gate rejected bar(s); NOT written", {
      submitted: bars.length,
      rejected: rejected.length,
      byCode: summarizeIntradayRejections(rejected),
      sample: rejected.slice(0, 5),
    });
  }
  if (accepted.length === 0) return { written: 0, rejected };

  const stmt = db.prepare(
    `INSERT INTO price_bars_intraday (ticker, ts, open, high, low, close, volume, source, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ticker, ts) DO UPDATE SET
       open = excluded.open, high = excluded.high, low = excluded.low,
       close = excluded.close, volume = excluded.volume,
       source = excluded.source, ingested_at = excluded.ingested_at`
  );

  const ingestedAt = new Date().toISOString();
  const batch = accepted.map((bar) => stmt.bind(bar.ticker, bar.ts, bar.open, bar.high, bar.low, bar.close, bar.volume, bar.source, ingestedAt));

  await db.batch(batch);
  return { written: accepted.length, rejected };
}

/**
 * Point-in-time read: the most recent bars for `ticker` that are VISIBLE at
 * `asOf`, most recent first. Same required-asOf, no-"give me everything"
 * convention as getNewsAsOf and getDecisionMemoryAsOf (Backtesting Integrity,
 * point 1).
 *
 * Visible means dated STRICTLY BEFORE asOf's UTC calendar date: a daily bar
 * holds the day's final OHLCV, which does not exist until the day is over, so
 * the bar for day D appears at D+1 00:00Z, not at any time on D (the rule and
 * its rationale live in shared/price_availability.js). Before step C this was
 * `date <= asOf`, so a 09:35 decision on day D saw day D's close. The freshest
 * price any caller can see is therefore the previous UTC day's close, live
 * included. The rows returned are re-checked against the same rule
 * (assertNoPriceBarLookahead) before they leave this function.
 */
export async function getPriceBarsAsOf(db, { ticker, asOf, limit = 200 }) {
  if (!asOf) {
    throw new LookaheadViolationError("getPriceBarsAsOf requires an explicit asOf timestamp");
  }
  const cutoffDate = priceBarCutoffDate(asOf);

  const { results } = await db
    .prepare(
      `SELECT ticker, date, open, high, low, close, volume, source
       FROM price_bars
       WHERE ticker = ? AND date < ?
       ORDER BY date DESC
       LIMIT ?`
    )
    .bind(ticker, cutoffDate, limit)
    .all();

  assertNoPriceBarLookahead(results, asOf);
  return results;
}

/**
 * Point-in-time read (plan.md finding G step 3): the most recent intraday bar
 * for `ticker` that had FULLY CLOSED at `asOf`, or `null` when there is none.
 * The finer-grained sibling of getPriceBarsAsOf, which cannot see anything
 * newer than the previous UTC day's close: two decisions on the same day get
 * the same daily price there, so a same-day replacement trade books 0 P&L.
 * This is what lets them see different, real prices.
 *
 * Same required-asOf, no-"give me everything" convention as every read here
 * (LookaheadViolationError on a missing or unparseable asOf). Visible means
 * `ts + 5 minutes <= asOf`: `ts` is the bar's OPEN time, and its close does not
 * exist until the interval ends (the rule and its rationale live in
 * shared/intraday_availability.js). The row returned is re-checked against the
 * same rule (assertNoIntradayLookahead) before it leaves this function.
 *
 * Returns `{ticker, ts, open, high, low, close, volume, source, availableAt}`;
 * a fill at `asOf` is `close`, and `availableAt` (canonical ts + 5 minutes) is
 * when that close became knowable, for logging.
 *
 * `maxAgeMs` (optional): return `null` instead of a bar whose close became
 * visible more than this long before `asOf`. Without it the newest visible bar
 * is returned however old it is (a weekend, an overnight gap, or data that has
 * aged out of the rolling retention window would all surface a days-old price
 * as if it were current); a caller that must not fill on a stale price passes
 * a bound and falls back (Adopted Pattern #11: log the fallback loudly).
 *
 * `null` means "no usable intraday bar", never "price is zero" or "use the
 * previous value": nothing is interpolated or invented (Pattern #9).
 */
export async function getIntradayPriceAsOf(db, { ticker, asOf, maxAgeMs } = {}) {
  if (!asOf) {
    throw new LookaheadViolationError("getIntradayPriceAsOf requires an explicit asOf timestamp");
  }
  if (!ticker) {
    throw new Error("getIntradayPriceAsOf requires a ticker");
  }
  if (maxAgeMs !== undefined && maxAgeMs !== null && !(Number.isFinite(maxAgeMs) && maxAgeMs >= 0)) {
    throw new Error(`getIntradayPriceAsOf: maxAgeMs must be a non-negative finite number, got ${maxAgeMs}`);
  }
  const cutoff = intradayCutoffTs(asOf);

  const row = await db
    .prepare(
      `SELECT ticker, ts, open, high, low, close, volume, source
       FROM price_bars_intraday
       WHERE ticker = ? AND ts <= ?
       ORDER BY ts DESC
       LIMIT 1`
    )
    .bind(ticker, cutoff)
    .first();
  if (!row) return null;

  assertNoIntradayLookahead([row], asOf);

  const availableAt = intradayBarAvailableAt(row.ts);
  if (maxAgeMs !== undefined && maxAgeMs !== null) {
    const ageMs = Date.parse(asOf) - Date.parse(availableAt);
    if (ageMs > maxAgeMs) return null;
  }
  return { ...row, availableAt };
}

/**
 * Backtest SCORING read, NOT for agents: every bar for `ticker` dated
 * `fromDate <= date < toDate` (both bare `YYYY-MM-DD`), oldest first, no row cap
 * (a ticker has at most one bar per day, so the result is bounded by the span).
 * Same carve-out as RunStore#getRealizedReturnsInRange: the equity-curve scorer
 * (backtest/equity.js) has to read prices across the whole test span, which no
 * asOf-gated read may do, so nothing in the agent/pipeline path calls this;
 * both bounds are required so it can never become "give me everything". It
 * returns only what scoring needs (date, close).
 */
export async function getPriceBarsInRange(db, { ticker, fromDate, toDate }) {
  if (!fromDate || !toDate) {
    throw new LookaheadViolationError("getPriceBarsInRange requires an explicit {fromDate, toDate} range");
  }

  const { results } = await db
    .prepare(
      `SELECT ticker, date, close
       FROM price_bars
       WHERE ticker = ? AND date >= ? AND date < ?
       ORDER BY date ASC`
    )
    .bind(ticker, fromDate, toDate)
    .all();

  return results;
}

/**
 * One row per (ticker, tag, fiscalYear, fiscalPeriod, form) -- a restated
 * figure (10-K/A) for a period already covered by an earlier filing is a
 * NEW row, not an overwrite. See the fundamental_facts table in
 * migrations/inputs/ for why: this is what lets getFundamentalFactsAsOf reconstruct the
 * value that was actually known at a given point in time, restatements
 * included, instead of only ever storing today's (possibly since-corrected)
 * figure.
 */
export async function insertFundamentalFact(db, fact) {
  await db
    .prepare(
      `INSERT INTO fundamental_facts (ticker, cik, tag, val, unit, fiscal_year, fiscal_period, form, filed_at, source, ingested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ticker, tag, fiscal_year, fiscal_period, form) DO UPDATE SET
         val = excluded.val, unit = excluded.unit, filed_at = excluded.filed_at,
         source = excluded.source, ingested_at = excluded.ingested_at`
    )
    .bind(
      fact.ticker, fact.cik, fact.tag, fact.val, fact.unit,
      fact.fiscalYear, fact.fiscalPeriod, fact.form, fact.filedAt, fact.source, new Date().toISOString()
    )
    .run();
}

/**
 * Batched sibling of insertFundamentalFact -- same upsert, but for many
 * rows in one db.batch() call instead of one db-prepared .run() per row.
 * Each individual .run() is its own Worker subrequest, so a per-fact loop
 * over EDGAR's full companyfacts history for even one ticker/tag can blow
 * Cloudflare's per-invocation subrequest cap well before the loop
 * finishes (see ingestion/ingest.js#ingestFundamentals's header for the live
 * incident this fixes: TSLA alone threw "Too many API requests by single
 * Worker invocation" 1047 times in one 15-minute cron run). db.batch()
 * sends the whole array as ONE request to D1, so a chunk of N facts costs
 * one subrequest regardless of N. No-op on an empty array (db.batch([])
 * is otherwise a wasted round trip).
 */
export async function insertFundamentalFacts(db, facts) {
  if (facts.length === 0) return;

  const stmt = db.prepare(
    `INSERT INTO fundamental_facts (ticker, cik, tag, val, unit, fiscal_year, fiscal_period, form, filed_at, source, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ticker, tag, fiscal_year, fiscal_period, form) DO UPDATE SET
       val = excluded.val, unit = excluded.unit, filed_at = excluded.filed_at,
       source = excluded.source, ingested_at = excluded.ingested_at`
  );

  const ingestedAt = new Date().toISOString();
  const batch = facts.map((fact) =>
    stmt.bind(
      fact.ticker, fact.cik, fact.tag, fact.val, fact.unit,
      fact.fiscalYear, fact.fiscalPeriod, fact.form, fact.filedAt, fact.source, ingestedAt
    )
  );

  await db.batch(batch);
}

/**
 * Point-in-time read (plan.md Backtesting Integrity, point 3): for
 * `ticker`/`tag`, the latest-filed-as-of-`asOf` fact PER FISCAL PERIOD --
 * i.e. whatever value an analyst reading at `asOf` would actually have
 * seen, restatements included up to that point but never a later one. Same
 * required-asOf, no-"give me everything" convention as
 * getPriceBarsAsOf/getNewsAsOf. Ordered most-recent-fiscal-period first.
 *
 * HONEST LIMITATION (see plan.md + edgar_fundamentals.js): this reflects
 * whatever this table has actually been populated with. EDGAR only covers
 * US-listed XBRL filers, and this project's ticker->CIK map is currently a
 * small hand-maintained list (same convention as
 * ingestion/entity_resolution.js's domain map) -- a ticker with no rows
 * here is NOT evidence the company has no fundamentals, only that we
 * haven't ingested them.
 */
export async function getFundamentalFactsAsOf(db, { ticker, tag, asOf, limit = 20 }) {
  if (!asOf) {
    throw new LookaheadViolationError("getFundamentalFactsAsOf requires an explicit asOf timestamp");
  }

  const { results } = await db
    .prepare(
      `SELECT ticker, cik, tag, val, unit, fiscal_year, fiscal_period, form, filed_at, source
       FROM (
         SELECT *, ROW_NUMBER() OVER (
           PARTITION BY fiscal_year, fiscal_period ORDER BY filed_at DESC
         ) AS rn
         FROM fundamental_facts
         WHERE ticker = ? AND tag = ? AND filed_at <= ?
       )
       WHERE rn = 1
       ORDER BY fiscal_year DESC, fiscal_period DESC
       LIMIT ?`
    )
    .bind(ticker, tag, asOf, limit)
    .all();

  return results;
}

// ---------------------------------------------------------------------
// Dashboard-only reads (M4, moved from the deleted storage/d1.js). These are
// unrestricted "current state" queries for the human-facing dashboard, NOT
// agent inputs: the required-asOf convention on every read above exists to
// stop an AGENT seeing future data in a simulated run, and has no bearing on
// a dashboard showing what is actually in the inputs DB right now. Never feed
// these to an agent prompt. Pass readOnly(env.INPUTS_DB).
// ---------------------------------------------------------------------

/**
 * Last-ingested timestamp + row count per ingestion table (news_items,
 * price_bars, fundamental_facts) -- the closest thing to "ingestion health"
 * available: there is no persisted per-source vendor-error log, so a stale
 * lastIngestedAt is the only real signal.
 */
export async function getIngestionHealth(db) {
  const [news, bars, facts] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS count, MAX(ingested_at) AS last FROM news_items`).first(),
    db.prepare(`SELECT COUNT(*) AS count, MAX(ingested_at) AS last FROM price_bars`).first(),
    db.prepare(`SELECT COUNT(*) AS count, MAX(ingested_at) AS last FROM fundamental_facts`).first(),
  ]);

  return {
    news: { count: news?.count ?? 0, lastIngestedAt: news?.last ?? null },
    priceBars: { count: bars?.count ?? 0, lastIngestedAt: bars?.last ?? null },
    fundamentals: { count: facts?.count ?? 0, lastIngestedAt: facts?.last ?? null },
  };
}

/**
 * Most recent price bars for `ticker`, oldest-first (chronological, ready to
 * feed straight into a chart x-axis). Current-state read, not point-in-time.
 */
export async function getRecentPriceBars(db, { ticker, limit = 30 }) {
  const { results } = await db
    .prepare(`SELECT date, close FROM price_bars WHERE ticker = ? ORDER BY date DESC LIMIT ?`)
    .bind(ticker, limit)
    .all();

  return results.reverse();
}
