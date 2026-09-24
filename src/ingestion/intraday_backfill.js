// Gradual intraday backfill job -- plan.md finding G, step 6:
// "Gradual backfill, not a bulk loop: resumable, not a single long-running
// job. New intraday_backfill_status table in inputs (ticker, date, vendor,
// status, last_attempt) tracked per (symbol, day); a cron-driven Worker tick
// claims the next unfilled day per ticker and advances the status row, so an
// interrupted run resumes from where it left off instead of re-fetching or
// silently skipping gaps -- same self-continuing-parts shape as the existing
// news backfill (POST /backfill)."
//
// UNLIKE backfillHistoricalNews (ingestion/ingest.js), this has no explicit
// re-enqueue/continuation message of its own: the cron tick itself IS the
// continuation mechanism. Every `*/15` tick calls runIntradayBackfillTick
// once; each call claims and fills at most one day PER TICKER (five tickers
// today -- AAPL/MSFT/TSLA/USO/XAUUSD, see resolveIntradayVendor below), so a
// window's worth of days is filled gradually across many ticks rather than
// in one invocation. This keeps each tick small and bounded (at most one
// HTTP request per ticker, well inside any subrequest budget) and means a
// crashed/killed invocation loses at most the day(s) it was mid-claim on --
// their status rows are left `in_progress` and simply get re-claimed (see
// claimNextBackfillDay's own comment on that gap) by a later tick, never
// silently skipped.
//
// VENDOR SPLIT (plan.md, decided 2026-09-23, unchanged here): Alpaca for
// AAPL/MSFT/TSLA/USO, Twelve Data free Basic for XAUUSD only --
// resolveIntradayVendor derives this from twelvedata.js's own
// TWELVE_DATA_SYMBOL_MAP rather than a second, easily-drifting copy of the
// same list.
//
// FAILURE ISOLATION (Adopted Pattern #11, same convention as every other
// ingestion path in this repo): a VendorError fetching one ticker's claimed
// day is logged and that (ticker, date) row is marked 'failed' with the
// error message -- it does NOT abort the other tickers' claims in the same
// tick, and a 'failed' row is eligible to be re-claimed by a future tick
// (see claimNextBackfillDay), so a transient vendor failure self-heals
// without operator intervention. A non-VendorError (an actual bug) still
// propagates.

import { fetchIntradayBars as fetchAlpacaIntradayBars } from "./sources/alpaca.js";
// twelvedata.js itself is no longer imported here -- 'twelvedata' is not a
// live route any ticker resolves to anymore (see resolveIntradayVendor). The
// old TWELVE_DATA_SYMBOL_MAP list lives on in twelvedata.js's own file for
// reference (step 4 -- purging old twelvedata rows -- and any rollback know
// exactly what to touch there without this file needing to import it).
import { fetchIntradayBars as fetchTiingoFxIntradayBars, TIINGO_FX_INTRADAY_TICKERS } from "./sources/tiingo_fx_intraday.js";
import { insertPriceBarsIntraday } from "../storage/inputs_view.js";
import { summarizeIntradayRejections } from "../shared/intraday_sanity.js";
import { VendorError } from "../shared/errors.js";
import { toDayString, addDays } from "./date_windows.js";

// Chunk size for the batched INSERT OR IGNORE seeding statements below
// (seedBackfillWindow/ensureTodayBackfillRows) -- same one-subrequest-per-
// db.batch()-call reasoning as every other batched insert in this codebase
// (NEWS_ITEM_INSERT_CHUNK_SIZE etc). A full lookback window (90 days) across
// 5 tickers is 450 rows, comfortably chunked at 200/batch.
const BACKFILL_STATUS_INSERT_CHUNK_SIZE = 200;

/**
 * Which vendor owns `ticker`'s intraday bars: 'tiingo_fx_intraday' if it's
 * in TIINGO_FX_INTRADAY_TICKERS (today: XAUUSD only -- the plan.md finding G
 * follow-up vendor switch, 2026-09-24, replacing the untrustworthy Twelve
 * Data XAUUSD feed), 'alpaca' otherwise (every other watchlist entry --
 * AAPL/MSFT/TSLA/USO). 'twelvedata' is deliberately NOT a route any ticker
 * can resolve to anymore -- see the import comment above.
 */
export function resolveIntradayVendor(ticker) {
  return TIINGO_FX_INTRADAY_TICKERS.has(String(ticker).toUpperCase()) ? "tiingo_fx_intraday" : "alpaca";
}

/** config.watchlist's tickers, in order -- the fixed set this job backfills/keeps current. */
function intradayTickers(config) {
  return (config.watchlist ?? []).map((w) => w.ticker);
}

/**
 * Idempotent seed (INSERT ... ON CONFLICT DO NOTHING, batched): one
 * `pending` intraday_backfill_status row per (ticker, date) in
 * [fromDate, toDate] inclusive, for every ticker in `tickers`. Safe to call
 * repeatedly -- an already-seeded (ticker, date) is left untouched, whatever
 * its current status (never resets a 'done'/'failed'/'in_progress' row back
 * to 'pending').
 */
export async function seedBackfillRows(db, { tickers, fromDate, toDate }) {
  if (tickers.length === 0) return { seeded: 0 };
  if (!fromDate || !toDate) throw new Error("seedBackfillRows requires an explicit {fromDate, toDate} range");

  const rows = [];
  for (const ticker of tickers) {
    const vendor = resolveIntradayVendor(ticker);
    for (let date = fromDate; date <= toDate; date = addDays(date, 1)) {
      rows.push({ ticker, date, vendor });
    }
  }

  const stmt = db.prepare(`INSERT INTO intraday_backfill_status (ticker, date, vendor, status) VALUES (?, ?, ?, 'pending') ON CONFLICT(ticker, date) DO NOTHING`);
  let seeded = 0;
  for (let i = 0; i < rows.length; i += BACKFILL_STATUS_INSERT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + BACKFILL_STATUS_INSERT_CHUNK_SIZE);
    const results = await db.batch(chunk.map((r) => stmt.bind(r.ticker, r.date, r.vendor)));
    seeded += results.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
  }
  return { seeded };
}

/**
 * Seeds a ticker's trailing `lookbackDays`-day window (ending `today`,
 * exclusive -- today itself is handled by ensureTodayBackfillRows below,
 * which runs every tick, not just once) the FIRST time this job ever sees
 * that ticker: a ticker with zero existing intraday_backfill_status rows is
 * assumed brand-new to this job and gets its whole historical window seeded
 * in one go; a ticker that already has any rows (seeded by an earlier tick,
 * or by this same call on a previous tick's continuation) is left alone --
 * re-seeding an already-covered ticker every tick would just be a wasted D1
 * round trip (ON CONFLICT DO NOTHING makes it a no-op, but the SELECT COUNT
 * to decide "was it ever seeded" is cheaper than that).
 */
async function seedNewTickers(db, { tickers, lookbackDays, today }) {
  const fromDate = addDays(today, -lookbackDays);
  const toDate = addDays(today, -1);
  const newTickers = [];
  for (const ticker of tickers) {
    const row = await db.prepare(`SELECT 1 FROM intraday_backfill_status WHERE ticker = ? LIMIT 1`).bind(ticker).first();
    if (!row) newTickers.push(ticker);
  }
  if (newTickers.length === 0) return { seeded: 0, tickers: [] };
  const { seeded } = await seedBackfillRows(db, { tickers: newTickers, fromDate, toDate });
  return { seeded, tickers: newTickers };
}

/**
 * Ensures every ticker has a `pending` row for `date` (default: today, UTC)
 * -- the "going forward" half of coverage, run every tick regardless of
 * whether a ticker was already seeded historically. Idempotent (ON CONFLICT
 * DO NOTHING via seedBackfillRows with fromDate = toDate = date).
 */
export async function ensureTodayBackfillRows(db, { tickers, date }) {
  return seedBackfillRows(db, { tickers, fromDate: date, toDate: date });
}

/**
 * Claims the OLDEST 'pending' or 'failed' row for `ticker` (oldest date
 * first -- fills history before chasing today's gap), marking it
 * 'in_progress' with `now` as last_attempt, and returns it (or `null` if
 * nothing is claimable). Two statements (SELECT then UPDATE), not one atomic
 * UPDATE...RETURNING with an ORDER BY/LIMIT subquery -- same
 * read-then-write, accepted-non-atomic tradeoff as
 * shared/d1_rate_limiter.js#reserve (see that function's own comment): this
 * job is cron-triggered, not high-concurrency (one tick every 15 minutes,
 * one claim per ticker per tick), so a genuine race double-claiming the same
 * row is a near-zero-probability, low-cost failure mode (both callers
 * fetch/write the same day; a harmless duplicate upsert, not corruption) --
 * not worth a fully serialized claim.
 *
 * A row stuck 'in_progress' by a crashed invocation (Worker killed mid-fetch,
 * before markBackfillDone/markBackfillFailed could run) is NOT re-claimed by
 * this query on purpose in the common case (WHERE status IN ('pending',
 * 'failed')) -- but `staleAfterMs` (default 30 minutes, comfortably longer
 * than one cron tick) makes an 'in_progress' row whose last_attempt is older
 * than that ALSO claimable again, so a crash doesn't permanently strand a
 * day. 30 minutes is a starting point (two missed ticks' worth of slack),
 * not tuned against a real crash yet.
 */
export async function claimNextBackfillDay(db, { ticker, now = new Date().toISOString(), staleAfterMs = 30 * 60_000 } = {}) {
  const staleCutoff = new Date(Date.parse(now) - staleAfterMs).toISOString();
  const row = await db
    .prepare(
      `SELECT ticker, date, vendor, status FROM intraday_backfill_status
       WHERE ticker = ?
         AND (status IN ('pending', 'failed') OR (status = 'in_progress' AND last_attempt < ?))
       ORDER BY date ASC LIMIT 1`
    )
    .bind(ticker, staleCutoff)
    .first();
  if (!row) return null;

  await db
    .prepare(`UPDATE intraday_backfill_status SET status = 'in_progress', last_attempt = ?, error = NULL WHERE ticker = ? AND date = ?`)
    .bind(now, row.ticker, row.date)
    .run();

  return { ticker: row.ticker, date: row.date, vendor: row.vendor };
}

/**
 * Batched sibling of claimNextBackfillDay (plan.md finding G follow-up,
 * "batch date-range fetching to speed up backfill", deferred design from
 * the 2026-09-24 session -- see plan.md/checkpoint for the full tradeoff
 * writeup): claims up to `batchSize` eligible days for `ticker`, oldest
 * first, same pending/failed/stale-in_progress eligibility rule as
 * claimNextBackfillDay, and marks them all 'in_progress' in one batched
 * UPDATE (one db.batch() call, not one .run() per claimed day).
 *
 * The claimed set is trimmed to the MAXIMAL CONTIGUOUS run of calendar days
 * starting at the oldest eligible row (stops at the first gap) -- e.g. if
 * 01-05 and 01-06 are pending but 01-07 is already 'done' and 01-08 is
 * pending again, a batchSize=4 claim returns only [01-05, 01-06], not
 * [01-05, 01-06, 01-08, ...]. This is what lets the caller (see
 * runIntradayBackfillTick) fetch the WHOLE claimed range in one vendor
 * request (fromDate 00:00Z to (lastDate+1) 00:00Z): a fetch spanning a gap
 * would silently re-fetch/re-write an already-'done' day's bars for free
 * (harmless -- writes are upserts) but would make "how many days did this
 * request actually cover" ambiguous for logging/quota accounting, so
 * contiguity is enforced instead of relying on the harmless case.
 *
 * `batchSize = 1` (config.js's default -- INTRADAY_BACKFILL_BATCH_DAYS
 * unset) makes this claim exactly one day, functionally identical to
 * claimNextBackfillDay; runIntradayBackfillTick special-cases a
 * single-day claim to produce the exact pre-batching result shape (see its
 * own comment), so existing callers/dashboards/logs are unaffected until an
 * operator explicitly opts into a wider batch.
 *
 * TRADEOFF vs claimNextBackfillDay (accepted, see plan.md): a batch fetch
 * failing (one VendorError) fails every day in the batch at once, not just
 * one, and a crashed invocation mid-batch leaves up to batchSize days
 * 'in_progress' instead of just one -- larger batchSize trades failure
 * isolation and crash blast-radius for fewer, larger vendor requests and a
 * faster backfill. Keep batchSize modest (5-7, roughly one trading week)
 * rather than the full lookback window.
 */
export async function claimNextBackfillBatch(db, { ticker, batchSize = 1, now = new Date().toISOString(), staleAfterMs = 30 * 60_000 } = {}) {
  const size = Number.isFinite(Number(batchSize)) && Number(batchSize) >= 1 ? Math.floor(Number(batchSize)) : 1;
  const staleCutoff = new Date(Date.parse(now) - staleAfterMs).toISOString();
  const { results: rows } = await db
    .prepare(
      `SELECT ticker, date, vendor, status FROM intraday_backfill_status
       WHERE ticker = ?
         AND (status IN ('pending', 'failed') OR (status = 'in_progress' AND last_attempt < ?))
       ORDER BY date ASC LIMIT ?`
    )
    .bind(ticker, staleCutoff, size)
    .all();
  if (rows.length === 0) return [];

  const claimed = [rows[0]];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].date !== addDays(claimed[claimed.length - 1].date, 1)) break;
    claimed.push(rows[i]);
  }

  const stmt = db.prepare(`UPDATE intraday_backfill_status SET status = 'in_progress', last_attempt = ?, error = NULL WHERE ticker = ? AND date = ?`);
  await db.batch(claimed.map((row) => stmt.bind(now, row.ticker, row.date)));

  return claimed.map((row) => ({ ticker: row.ticker, date: row.date, vendor: row.vendor }));
}

// `note` (normally null) is written to the row's `error` column so a day that
// finished but had bars dropped by the write-time sanity gate
// (shared/intraday_sanity.js) is distinguishable from a clean one when auditing
// -- status stays 'done' (a re-claim would re-fetch the same bars and get the
// same rejections, burning vendor quota), the note is how it stays visible.
async function markBackfillDone(db, { ticker, date, note = null }) {
  await db.prepare(`UPDATE intraday_backfill_status SET status = 'done', error = ? WHERE ticker = ? AND date = ?`).bind(note, ticker, date).run();
}

async function markBackfillFailed(db, { ticker, date, error, now = new Date().toISOString() }) {
  await db
    .prepare(`UPDATE intraday_backfill_status SET status = 'failed', last_attempt = ?, error = ? WHERE ticker = ? AND date = ?`)
    .bind(now, String(error).slice(0, 500), ticker, date)
    .run();
}

/**
 * Fetches one ticker's bars from `vendor` for [fromDate 00:00Z,
 * (toDate+1) 00:00Z) -- fromDate === toDate for a single claimed day
 * (fetchClaimedDay below), or a wider inclusive range for a batched claim
 * (fetchClaimedBatch below, one vendor request for the whole contiguous
 * batch instead of one per day). Throws a VendorError on failure
 * (propagated to the caller, which marks the row(s) failed).
 */
async function fetchIntradayRange(config, { ticker, vendor, fromDate, toDate }) {
  const from = `${fromDate}T00:00:00Z`;
  const to = `${addDays(toDate, 1)}T00:00:00Z`;
  const fetchBars = vendor === "tiingo_fx_intraday" ? fetchTiingoFxIntradayBars : fetchAlpacaIntradayBars;

  const { bars, errors } = await fetchBars(config, { tickers: [ticker], from, to });
  if (errors.length > 0) {
    // fetchIntradayBars' contract collects per-ticker errors rather than
    // throwing (same shape as tiingo.js/alpaca.js); with exactly one ticker
    // requested here, any entry in `errors` is THIS ticker's failure, so
    // re-throw it to let the caller's try/catch mark the row(s) failed the
    // same way an actual thrown VendorError would.
    throw errors[0].error;
  }
  return bars;
}

/** Single claimed day (claimNextBackfillDay) -- see fetchIntradayRange. */
async function fetchClaimedDay(config, db, { ticker, date, vendor }) {
  return fetchIntradayRange(config, { ticker, vendor, fromDate: date, toDate: date });
}

/** Batched claim (claimNextBackfillBatch) -- one request spanning `dates[0]` through `dates[dates.length - 1]` inclusive; see fetchIntradayRange. `dates` must be the contiguous, date-ascending array claimNextBackfillBatch returns. */
async function fetchClaimedBatch(config, db, { ticker, vendor, dates }) {
  return fetchIntradayRange(config, { ticker, vendor, fromDate: dates[0], toDate: dates[dates.length - 1] });
}

/** Groups bars or rejected-bar entries (both carry a `ts`) by UTC calendar date (`ts.slice(0, 10)`) -- used to split a batched fetch's combined bars/rejections back out per claimed day so each day still gets its own accurate 'done' note. */
function groupByDate(rows) {
  const map = new Map();
  for (const row of rows) {
    const day = row.ts.slice(0, 10);
    if (!map.has(day)) map.set(day, []);
    map.get(day).push(row);
  }
  return map;
}

/**
 * One cron tick: for every intraday ticker (config.watchlist), seeds its
 * historical window the first time it's ever seen (seedNewTickers), ensures
 * today has a pending row (ensureTodayBackfillRows), then claims and fills
 * UP TO `config.intradayBackfillBatchDays` day(s) per ticker
 * (claimNextBackfillBatch -> one fetch spanning the whole claimed range ->
 * write -> mark each claimed day done/failed). Returns a per-ticker summary
 * for logging; never throws for a single ticker's vendor failure (that
 * ticker's entry just carries an `error`, see header's Failure Isolation
 * note) -- only a non-VendorError bug propagates.
 *
 * `config.intradayBackfillLookbackDays` (default 90, matching the typical
 * backtest window -- plan.md's "Backtest window is 90 days, so 4-6 months
 * is comfortable headroom" retention note) is how far back a brand-new
 * ticker's seed reaches.
 *
 * `config.intradayBackfillBatchDays` (default 1) controls the claim size --
 * see claimNextBackfillBatch's header for the full design/tradeoff writeup.
 * A claim of exactly one day (the default, or whenever only one day is
 * eligible even with a larger batchSize) takes the SAME code path and
 * produces the SAME `results` entry shape (`{ticker, claimed, date, vendor,
 * bars, written, rejected, ok}`) this function always has -- batching only
 * changes behavior once a tick actually claims more than one day, in which
 * case the entry carries `dates` (plural, the whole claimed range) instead
 * of a single `date`.
 */
export async function runIntradayBackfillTick(config, db, { now = new Date() } = {}) {
  const tickers = intradayTickers(config);
  const today = toDayString(now.toISOString());
  const lookbackDays = Number.isFinite(Number(config.intradayBackfillLookbackDays)) ? Number(config.intradayBackfillLookbackDays) : 90;
  const batchDays = Number.isFinite(Number(config.intradayBackfillBatchDays)) && Number(config.intradayBackfillBatchDays) >= 1 ? Math.floor(Number(config.intradayBackfillBatchDays)) : 1;

  const seeded = await seedNewTickers(db, { tickers, lookbackDays, today });
  if (seeded.tickers.length > 0) {
    console.log("intraday backfill: seeded new ticker(s)", { tickers: seeded.tickers, lookbackDays, seeded: seeded.seeded });
  }
  await ensureTodayBackfillRows(db, { tickers, date: today });

  const results = [];
  for (const ticker of tickers) {
    const claimed = await claimNextBackfillBatch(db, { ticker, batchSize: batchDays, now: now.toISOString() });
    if (claimed.length === 0) {
      results.push({ ticker, claimed: false });
      continue;
    }

    if (claimed.length === 1) {
      // Single-day claim (the batchDays=1 default, or a batchDays>1 tick
      // that only had one eligible day) -- byte-for-byte the pre-batching
      // code path and result shape.
      const day = claimed[0];
      try {
        const bars = await fetchClaimedDay(config, db, day);
        const { written, rejected } = await insertPriceBarsIntraday(db, bars);
        const note = rejected.length > 0 ? `write gate rejected ${rejected.length}/${bars.length} bar(s): ${JSON.stringify(summarizeIntradayRejections(rejected))}`.slice(0, 500) : null;
        await markBackfillDone(db, { ...day, note });
        results.push({ ticker, claimed: true, date: day.date, vendor: day.vendor, bars: bars.length, written, rejected: rejected.length, ok: true });
      } catch (err) {
        if (!(err instanceof VendorError)) throw err;
        await markBackfillFailed(db, { ...day, error: err.message });
        console.error("intraday backfill: vendor failure for claimed day, marked failed (eligible for re-claim)", { ticker: day.ticker, date: day.date, vendor: day.vendor, message: err.message });
        results.push({ ticker, claimed: true, date: day.date, vendor: day.vendor, ok: false, error: err.message });
      }
      continue;
    }

    // Batched claim (claimed.length > 1, only reachable with batchDays > 1):
    // one wide-range fetch for the whole contiguous run instead of one
    // request per day -- see claimNextBackfillBatch's header for why the
    // claim is guaranteed contiguous before it ever gets here.
    const vendor = claimed[0].vendor;
    const dates = claimed.map((c) => c.date);
    try {
      const bars = await fetchClaimedBatch(config, db, { ticker, vendor, dates });
      const { written, rejected } = await insertPriceBarsIntraday(db, bars);
      const rejectedByDate = groupByDate(rejected);
      const barsByDate = groupByDate(bars);
      for (const date of dates) {
        const dayRejected = rejectedByDate.get(date) ?? [];
        const dayBarCount = (barsByDate.get(date) ?? []).length;
        const note = dayRejected.length > 0 ? `write gate rejected ${dayRejected.length}/${dayBarCount} bar(s): ${JSON.stringify(summarizeIntradayRejections(dayRejected))}`.slice(0, 500) : null;
        await markBackfillDone(db, { ticker, date, note });
      }
      results.push({ ticker, claimed: true, dates, vendor, bars: bars.length, written, rejected: rejected.length, ok: true });
    } catch (err) {
      if (!(err instanceof VendorError)) throw err;
      for (const date of dates) {
        await markBackfillFailed(db, { ticker, date, error: err.message });
      }
      console.error("intraday backfill: vendor failure for claimed batch, marked all claimed days failed (eligible for re-claim)", { ticker, dates, vendor, message: err.message });
      results.push({ ticker, claimed: true, dates, vendor, ok: false, error: err.message });
    }
  }

  return { today, seededTickers: seeded.tickers, results };
}
