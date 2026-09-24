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
import { fetchIntradayBars as fetchTwelveDataIntradayBars, TWELVE_DATA_SYMBOL_MAP } from "./sources/twelvedata.js";
import { insertPriceBarsIntraday } from "../storage/inputs_view.js";
import { VendorError } from "../shared/errors.js";
import { toDayString, addDays } from "./date_windows.js";

// Chunk size for the batched INSERT OR IGNORE seeding statements below
// (seedBackfillWindow/ensureTodayBackfillRows) -- same one-subrequest-per-
// db.batch()-call reasoning as every other batched insert in this codebase
// (NEWS_ITEM_INSERT_CHUNK_SIZE etc). A full lookback window (90 days) across
// 5 tickers is 450 rows, comfortably chunked at 200/batch.
const BACKFILL_STATUS_INSERT_CHUNK_SIZE = 200;

/**
 * Which vendor owns `ticker`'s intraday bars: 'twelvedata' if it has a
 * Twelve Data symbol mapping (today: XAUUSD only), 'alpaca' otherwise (every
 * other watchlist entry -- AAPL/MSFT/TSLA/USO). Deriving this from
 * TWELVE_DATA_SYMBOL_MAP (twelvedata.js) rather than hardcoding a second
 * ticker list here means the two files can never silently disagree about
 * which vendor a ticker belongs to.
 */
export function resolveIntradayVendor(ticker) {
  return TWELVE_DATA_SYMBOL_MAP[String(ticker).toUpperCase()] ? "twelvedata" : "alpaca";
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

async function markBackfillDone(db, { ticker, date }) {
  await db.prepare(`UPDATE intraday_backfill_status SET status = 'done', error = NULL WHERE ticker = ? AND date = ?`).bind(ticker, date).run();
}

async function markBackfillFailed(db, { ticker, date, error, now = new Date().toISOString() }) {
  await db
    .prepare(`UPDATE intraday_backfill_status SET status = 'failed', last_attempt = ?, error = ? WHERE ticker = ? AND date = ?`)
    .bind(now, String(error).slice(0, 500), ticker, date)
    .run();
}

/** Fetches one (ticker, date)'s bars from the row's own vendor, [date 00:00Z, date+1 00:00Z). Throws a VendorError on failure (propagated to the caller, which marks the row failed). */
async function fetchClaimedDay(config, db, { ticker, date, vendor }) {
  const from = `${date}T00:00:00Z`;
  const to = `${addDays(date, 1)}T00:00:00Z`;
  const fetchBars = vendor === "twelvedata" ? (c, args) => fetchTwelveDataIntradayBars(c, args, { db }) : fetchAlpacaIntradayBars;

  const { bars, errors } = await fetchBars(config, { tickers: [ticker], from, to });
  if (errors.length > 0) {
    // fetchIntradayBars' contract collects per-ticker errors rather than
    // throwing (same shape as tiingo.js/alpaca.js); with exactly one ticker
    // requested here, any entry in `errors` is THIS ticker's failure, so
    // re-throw it to let the caller's try/catch mark the row failed the same
    // way an actual thrown VendorError would.
    throw errors[0].error;
  }
  return bars;
}

/**
 * One cron tick: for every intraday ticker (config.watchlist), seeds its
 * historical window the first time it's ever seen (seedNewTickers), ensures
 * today has a pending row (ensureTodayBackfillRows), then claims and fills
 * AT MOST ONE day per ticker (claimNextBackfillDay -> fetch -> write ->
 * mark done/failed). Returns a per-ticker summary for logging; never throws
 * for a single ticker's vendor failure (that ticker's entry just carries an
 * `error`, see header's Failure Isolation note) -- only a non-VendorError
 * bug propagates.
 *
 * `config.intradayBackfillLookbackDays` (default 90, matching the typical
 * backtest window -- plan.md's "Backtest window is 90 days, so 4-6 months
 * is comfortable headroom" retention note) is how far back a brand-new
 * ticker's seed reaches.
 */
export async function runIntradayBackfillTick(config, db, { now = new Date() } = {}) {
  const tickers = intradayTickers(config);
  const today = toDayString(now.toISOString());
  const lookbackDays = Number.isFinite(Number(config.intradayBackfillLookbackDays)) ? Number(config.intradayBackfillLookbackDays) : 90;

  const seeded = await seedNewTickers(db, { tickers, lookbackDays, today });
  if (seeded.tickers.length > 0) {
    console.log("intraday backfill: seeded new ticker(s)", { tickers: seeded.tickers, lookbackDays, seeded: seeded.seeded });
  }
  await ensureTodayBackfillRows(db, { tickers, date: today });

  const results = [];
  for (const ticker of tickers) {
    const claimed = await claimNextBackfillDay(db, { ticker, now: now.toISOString() });
    if (!claimed) {
      results.push({ ticker, claimed: false });
      continue;
    }
    try {
      const bars = await fetchClaimedDay(config, db, claimed);
      await insertPriceBarsIntraday(db, bars);
      await markBackfillDone(db, claimed);
      results.push({ ticker, claimed: true, date: claimed.date, vendor: claimed.vendor, bars: bars.length, ok: true });
    } catch (err) {
      if (!(err instanceof VendorError)) throw err;
      await markBackfillFailed(db, { ...claimed, error: err.message });
      console.error("intraday backfill: vendor failure for claimed day, marked failed (eligible for re-claim)", { ticker: claimed.ticker, date: claimed.date, vendor: claimed.vendor, message: err.message });
      results.push({ ticker, claimed: true, date: claimed.date, vendor: claimed.vendor, ok: false, error: err.message });
    }
  }

  return { today, seededTickers: seeded.tickers, results };
}
