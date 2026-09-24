// Covers ingestion/intraday_backfill.js (plan.md finding G, step 6):
// seeding intraday_backfill_status rows for a brand-new ticker, the
// "ensure today" going-forward row, claiming the oldest pending/failed day
// per ticker, vendor routing (Alpaca vs Tiingo FX, XAUUSD only -- see
// plan.md finding G follow-up, 2026-09-24, replacing Twelve Data), a full
// tick writing bars via insertPriceBarsIntraday and marking the row 'done',
// and failure isolation (one ticker's vendor error never blocks another's).
//
// Both vendors are mocked at global fetch (same style as
// alpaca_intraday.test.js / tiingo_fx_intraday.test.js); nothing here
// touches a real vendor API. Runs against a REAL sqlite inputs DB
// (migrations/inputs/), which is where price_bars_intraday AND
// intraday_backfill_status both live.

import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import {
  resolveIntradayVendor,
  seedBackfillRows,
  ensureTodayBackfillRows,
  claimNextBackfillDay,
  claimNextBackfillBatch,
  runIntradayBackfillTick,
} from "../src/ingestion/intraday_backfill.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { INPUTS_DIR } from "./helpers/engine_ctx.js";

const newDb = () => createTestD1([INPUTS_DIR]);

function baseConfig(overrides = {}) {
  return {
    ...loadConfig({
      ALPACA_API_KEY_ID: "alpaca-key",
      ALPACA_API_SECRET_KEY: "alpaca-secret",
      TIINGO_API_KEY: "tiingo-key",
      WATCHLIST_TICKERS: "AAPL,XAUUSD",
    }),
    retryBaseDelayMs: 1,
    alpacaMinRequestIntervalMs: 0,
    tiingoFxIntradayMinRequestIntervalMs: 0,
    ...overrides,
  };
}

/** One in-range 5-minute bar for either vendor's raw payload shape, keyed by which URL matched. */
function alpacaBar(t, base = 100) {
  return { t, o: base, h: base + 1, l: base - 1, c: base + 0.5, v: 1000 };
}
function tiingoFxRow(dateIso, base = 3500) {
  return { date: dateIso, open: base, high: base + 1, low: base - 1, close: base + 0.5 };
}

/**
 * Dispatches to Alpaca's /v2/stocks/{ticker}/bars or Tiingo's
 * /tiingo/fx/{ticker}/prices based on the URL, so one mock covers a
 * mixed-vendor tick. `alpacaByTicker`/`tiingoOk` control each vendor's
 * response; a ticker/vendor not listed gets an empty-but-ok response.
 */
function mockVendors(t, { alpacaByTicker = {}, tiingoOk = true } = {}) {
  const calls = [];
  t.mock.method(global, "fetch", async (url) => {
    const u = new URL(String(url));
    calls.push(u);
    if (u.hostname === "data.alpaca.markets") {
      const ticker = decodeURIComponent(u.pathname.split("/")[3]).toUpperCase();
      const spec = alpacaByTicker[ticker];
      if (spec instanceof Error) throw spec;
      if (typeof spec === "number") return { ok: false, status: spec, text: async () => "simulated error", json: async () => ({}) };
      return { ok: true, status: 200, json: async () => spec ?? { bars: [], next_page_token: null } };
    }
    if (u.hostname === "api.tiingo.com") {
      if (!tiingoOk) return { ok: false, status: 500, text: async () => "simulated error", json: async () => ({}) };
      const from = new Date(u.searchParams.get("startDate"));
      return {
        ok: true,
        status: 200,
        json: async () => [tiingoFxRow(new Date(from.getTime() + 5 * 60_000).toISOString())],
      };
    }
    throw new Error(`unexpected host in test: ${u.hostname}`);
  });
  return calls;
}

// ---------------------------------------------------------------------------
// vendor routing
// ---------------------------------------------------------------------------

test("resolveIntradayVendor: XAUUSD -> tiingo_fx_intraday, everything else -> alpaca", () => {
  assert.equal(resolveIntradayVendor("XAUUSD"), "tiingo_fx_intraday");
  assert.equal(resolveIntradayVendor("xauusd"), "tiingo_fx_intraday", "case-insensitive");
  for (const ticker of ["AAPL", "MSFT", "TSLA", "USO"]) {
    assert.equal(resolveIntradayVendor(ticker), "alpaca", ticker);
  }
});

// ---------------------------------------------------------------------------
// seeding + claiming
// ---------------------------------------------------------------------------

test("seedBackfillRows is idempotent: a second call over the same range changes nothing", async () => {
  const db = newDb();
  const first = await seedBackfillRows(db, { tickers: ["AAPL"], fromDate: "2026-01-01", toDate: "2026-01-03" });
  assert.equal(first.seeded, 3);

  const second = await seedBackfillRows(db, { tickers: ["AAPL"], fromDate: "2026-01-01", toDate: "2026-01-03" });
  assert.equal(second.seeded, 0, "already-seeded rows are left alone");

  const { results } = await db.prepare("SELECT date, vendor, status FROM intraday_backfill_status WHERE ticker = 'AAPL' ORDER BY date").all();
  assert.deepEqual(results.map((r) => r.date), ["2026-01-01", "2026-01-02", "2026-01-03"]);
  assert.ok(results.every((r) => r.status === "pending" && r.vendor === "alpaca"));
});

test("ensureTodayBackfillRows never resets an already-seeded row's status", async () => {
  const db = newDb();
  await seedBackfillRows(db, { tickers: ["AAPL"], fromDate: "2026-01-05", toDate: "2026-01-05" });
  await db.prepare("UPDATE intraday_backfill_status SET status = 'done' WHERE ticker = 'AAPL' AND date = '2026-01-05'").run();

  await ensureTodayBackfillRows(db, { tickers: ["AAPL"], date: "2026-01-05" });

  const row = await db.prepare("SELECT status FROM intraday_backfill_status WHERE ticker = 'AAPL' AND date = '2026-01-05'").first();
  assert.equal(row.status, "done", "ON CONFLICT DO NOTHING must not clobber a done row");
});

test("claimNextBackfillDay claims the OLDEST pending/failed day, oldest first, and marks it in_progress", async () => {
  const db = newDb();
  await seedBackfillRows(db, { tickers: ["AAPL"], fromDate: "2026-01-01", toDate: "2026-01-03" });
  await db.prepare("UPDATE intraday_backfill_status SET status = 'done' WHERE ticker = 'AAPL' AND date = '2026-01-01'").run();

  const claimed = await claimNextBackfillDay(db, { ticker: "AAPL", now: "2026-01-10T00:00:00Z" });
  assert.deepEqual(claimed, { ticker: "AAPL", date: "2026-01-02", vendor: "alpaca" });

  const row = await db.prepare("SELECT status, last_attempt FROM intraday_backfill_status WHERE ticker = 'AAPL' AND date = '2026-01-02'").first();
  assert.equal(row.status, "in_progress");
  assert.equal(row.last_attempt, "2026-01-10T00:00:00Z");
});

test("claimNextBackfillDay returns null once every row is done, and never claims a fresh in_progress row from another (still-live) tick", async () => {
  const db = newDb();
  await seedBackfillRows(db, { tickers: ["AAPL"], fromDate: "2026-01-01", toDate: "2026-01-01" });

  const first = await claimNextBackfillDay(db, { ticker: "AAPL", now: "2026-01-10T00:00:00Z" });
  assert.ok(first);
  const second = await claimNextBackfillDay(db, { ticker: "AAPL", now: "2026-01-10T00:01:00Z" });
  assert.equal(second, null, "already in_progress and not stale -- must not be double-claimed");

  await db.prepare("UPDATE intraday_backfill_status SET status = 'done' WHERE ticker = 'AAPL'").run();
  assert.equal(await claimNextBackfillDay(db, { ticker: "AAPL" }), null);
});

test("a stale in_progress row (crashed invocation) IS reclaimed after staleAfterMs", async () => {
  const db = newDb();
  await seedBackfillRows(db, { tickers: ["AAPL"], fromDate: "2026-01-01", toDate: "2026-01-01" });
  await claimNextBackfillDay(db, { ticker: "AAPL", now: "2026-01-10T00:00:00Z" }); // now stuck in_progress

  const tooSoon = await claimNextBackfillDay(db, { ticker: "AAPL", now: "2026-01-10T00:10:00Z", staleAfterMs: 30 * 60_000 });
  assert.equal(tooSoon, null);

  const stale = await claimNextBackfillDay(db, { ticker: "AAPL", now: "2026-01-10T00:31:00Z", staleAfterMs: 30 * 60_000 });
  assert.deepEqual(stale, { ticker: "AAPL", date: "2026-01-01", vendor: "alpaca" });
});

// ---------------------------------------------------------------------------
// a full tick, end to end
// ---------------------------------------------------------------------------

test("a fresh tick seeds a brand-new watchlist, claims one day per ticker, writes bars via the right vendor, and marks each row done", async (t) => {
  const db = newDb();
  mockVendors(t, { alpacaByTicker: { AAPL: { bars: [alpacaBar("2026-01-14T13:30:00Z")], next_page_token: null } } });

  const config = baseConfig({ intradayBackfillLookbackDays: 3 });
  const result = await runIntradayBackfillTick(config, db, { now: new Date("2026-01-15T12:00:00Z") });

  assert.deepEqual(result.seededTickers.sort(), ["AAPL", "XAUUSD"], "both tickers are brand new");
  assert.equal(result.today, "2026-01-15");

  const byTicker = Object.fromEntries(result.results.map((r) => [r.ticker, r]));
  assert.equal(byTicker.AAPL.claimed, true);
  assert.equal(byTicker.AAPL.ok, true);
  assert.equal(byTicker.AAPL.vendor, "alpaca");
  assert.equal(byTicker.AAPL.date, "2026-01-12", "the oldest seeded day (lookback=3 from 2026-01-15) is claimed first, not today");

  assert.equal(byTicker.XAUUSD.claimed, true);
  assert.equal(byTicker.XAUUSD.ok, true);
  assert.equal(byTicker.XAUUSD.vendor, "tiingo_fx_intraday");

  const statusRow = await db.prepare("SELECT status FROM intraday_backfill_status WHERE ticker = 'AAPL' AND date = '2026-01-12'").first();
  assert.equal(statusRow.status, "done");

  const barRow = await db.prepare("SELECT ticker, ts, close FROM price_bars_intraday WHERE ticker = 'AAPL'").first();
  assert.equal(barRow.ts, "2026-01-14T13:30:00Z");
  assert.equal(barRow.close, 100.5);

  // "today" (2026-01-15) got its own pending row too, for future ticks to claim.
  const todayRow = await db.prepare("SELECT status FROM intraday_backfill_status WHERE ticker = 'AAPL' AND date = '2026-01-15'").first();
  assert.equal(todayRow.status, "pending");
});

test("a vendor failure on one ticker is isolated: that ticker's row is marked failed (with the error message) and the other ticker still succeeds", async (t) => {
  const db = newDb();
  await seedBackfillRows(db, { tickers: ["AAPL", "XAUUSD"], fromDate: "2026-01-14", toDate: "2026-01-14" });
  mockVendors(t, { alpacaByTicker: { AAPL: 500 } }); // AAPL 500s, XAUUSD (tiingo_fx_intraday) succeeds via the default mock

  const config = baseConfig();
  const result = await runIntradayBackfillTick(config, db, { now: new Date("2026-01-15T12:00:00Z") });

  const byTicker = Object.fromEntries(result.results.map((r) => [r.ticker, r]));
  assert.equal(byTicker.AAPL.ok, false);
  assert.match(byTicker.AAPL.error, /500/);
  assert.equal(byTicker.XAUUSD.ok, true);

  const aaplRow = await db.prepare("SELECT status, error FROM intraday_backfill_status WHERE ticker = 'AAPL' AND date = '2026-01-14'").first();
  assert.equal(aaplRow.status, "failed");
  assert.match(aaplRow.error, /500/);

  // A failed day is eligible for a later tick to re-claim (not stranded).
  const reclaimed = await claimNextBackfillDay(db, { ticker: "AAPL", now: "2026-01-16T00:00:00Z" });
  assert.equal(reclaimed.date, "2026-01-14");
});

// ---------------------------------------------------------------------------
// batched claiming (claimNextBackfillBatch) + a batched tick
// (config.intradayBackfillBatchDays > 1) -- 2026-09-24 session
// ---------------------------------------------------------------------------

test("claimNextBackfillBatch claims up to batchSize OLDEST contiguous pending/failed days and marks them all in_progress", async () => {
  const db = newDb();
  await seedBackfillRows(db, { tickers: ["AAPL"], fromDate: "2026-01-01", toDate: "2026-01-05" });

  const claimed = await claimNextBackfillBatch(db, { ticker: "AAPL", batchSize: 3, now: "2026-01-10T00:00:00Z" });
  assert.deepEqual(claimed, [
    { ticker: "AAPL", date: "2026-01-01", vendor: "alpaca" },
    { ticker: "AAPL", date: "2026-01-02", vendor: "alpaca" },
    { ticker: "AAPL", date: "2026-01-03", vendor: "alpaca" },
  ]);

  const { results } = await db.prepare("SELECT date, status, last_attempt FROM intraday_backfill_status WHERE ticker = 'AAPL' ORDER BY date").all();
  assert.deepEqual(
    results.map((r) => [r.date, r.status]),
    [
      ["2026-01-01", "in_progress"],
      ["2026-01-02", "in_progress"],
      ["2026-01-03", "in_progress"],
      ["2026-01-04", "pending"],
      ["2026-01-05", "pending"],
    ]
  );
  assert.ok(results.slice(0, 3).every((r) => r.last_attempt === "2026-01-10T00:00:00Z"));
});

test("claimNextBackfillBatch trims to the maximal CONTIGUOUS run: a 'done' day in the middle stops the batch there, not past it", async () => {
  const db = newDb();
  await seedBackfillRows(db, { tickers: ["AAPL"], fromDate: "2026-01-01", toDate: "2026-01-04" });
  await db.prepare("UPDATE intraday_backfill_status SET status = 'done' WHERE ticker = 'AAPL' AND date = '2026-01-03'").run();

  const claimed = await claimNextBackfillBatch(db, { ticker: "AAPL", batchSize: 4, now: "2026-01-10T00:00:00Z" });
  assert.deepEqual(claimed.map((c) => c.date), ["2026-01-01", "2026-01-02"], "stops at the gap left by the already-done 2026-01-03, never jumps to 2026-01-04");

  const day3 = await db.prepare("SELECT status FROM intraday_backfill_status WHERE ticker = 'AAPL' AND date = '2026-01-03'").first();
  assert.equal(day3.status, "done", "the already-done day in the gap is left untouched");
  const day4 = await db.prepare("SELECT status FROM intraday_backfill_status WHERE ticker = 'AAPL' AND date = '2026-01-04'").first();
  assert.equal(day4.status, "pending", "a pending day past the gap is not claimed this batch");
});

test("claimNextBackfillBatch: batchSize 1 behaves exactly like claimNextBackfillDay", async () => {
  const db = newDb();
  await seedBackfillRows(db, { tickers: ["AAPL"], fromDate: "2026-01-01", toDate: "2026-01-02" });

  const claimed = await claimNextBackfillBatch(db, { ticker: "AAPL", batchSize: 1, now: "2026-01-10T00:00:00Z" });
  assert.deepEqual(claimed, [{ ticker: "AAPL", date: "2026-01-01", vendor: "alpaca" }]);
});

test("claimNextBackfillBatch returns [] once nothing is claimable, and a stale in_progress row IS reclaimed after staleAfterMs (same rule as claimNextBackfillDay)", async () => {
  const db = newDb();
  await seedBackfillRows(db, { tickers: ["AAPL"], fromDate: "2026-01-01", toDate: "2026-01-01" });
  await claimNextBackfillBatch(db, { ticker: "AAPL", batchSize: 3, now: "2026-01-10T00:00:00Z" }); // -> in_progress

  assert.deepEqual(await claimNextBackfillBatch(db, { ticker: "AAPL", batchSize: 3, now: "2026-01-10T00:10:00Z", staleAfterMs: 30 * 60_000 }), []);

  const stale = await claimNextBackfillBatch(db, { ticker: "AAPL", batchSize: 3, now: "2026-01-10T00:31:00Z", staleAfterMs: 30 * 60_000 });
  assert.deepEqual(stale, [{ ticker: "AAPL", date: "2026-01-01", vendor: "alpaca" }]);
});

test("a batched tick (intradayBackfillBatchDays > 1) makes ONE vendor request for the whole claimed range and marks every claimed day done individually", async (t) => {
  const db = newDb();
  // Mon-Wed weekdays on purpose: 2026-01-03 is a Saturday, which the write-time sanity gate (closed_window) would correctly reject.
  await seedBackfillRows(db, { tickers: ["AAPL"], fromDate: "2026-01-12", toDate: "2026-01-14" });
  const calls = mockVendors(t, {
    alpacaByTicker: {
      AAPL: {
        bars: [alpacaBar("2026-01-12T13:30:00Z", 100), alpacaBar("2026-01-13T13:30:00Z", 101), alpacaBar("2026-01-14T13:30:00Z", 102)],
        next_page_token: null,
      },
    },
  });

  const config = { ...baseConfig(), watchlist: [{ ticker: "AAPL", query: "AAPL" }], intradayBackfillBatchDays: 3 };
  const result = await runIntradayBackfillTick(config, db, { now: new Date("2026-01-15T12:00:00Z") });

  const aapl = result.results.find((r) => r.ticker === "AAPL");
  assert.equal(aapl.claimed, true);
  assert.equal(aapl.ok, true);
  assert.deepEqual(aapl.dates, ["2026-01-12", "2026-01-13", "2026-01-14"]);
  assert.equal(aapl.bars, 3);
  assert.equal(aapl.written, 3);

  const alpacaCalls = calls.filter((u) => u.hostname === "data.alpaca.markets");
  assert.equal(alpacaCalls.length, 1, "the whole 3-day claim is fetched in ONE request, not one per day");

  const { results: rows } = await db.prepare("SELECT date, status FROM intraday_backfill_status WHERE ticker = 'AAPL' AND date IN ('2026-01-12','2026-01-13','2026-01-14') ORDER BY date").all();
  assert.deepEqual(rows.map((r) => r.status), ["done", "done", "done"]);

  const { results: barRows } = await db.prepare("SELECT ts FROM price_bars_intraday WHERE ticker = 'AAPL' ORDER BY ts").all();
  assert.deepEqual(barRows.map((r) => r.ts), ["2026-01-12T13:30:00Z", "2026-01-13T13:30:00Z", "2026-01-14T13:30:00Z"]);
});

test("a batched tick's vendor failure marks EVERY claimed day in the batch failed, not just one (accepted tradeoff vs the single-day path)", async (t) => {
  const db = newDb();
  await seedBackfillRows(db, { tickers: ["AAPL"], fromDate: "2026-01-01", toDate: "2026-01-02" });
  mockVendors(t, { alpacaByTicker: { AAPL: 500 } });

  const config = { ...baseConfig(), watchlist: [{ ticker: "AAPL", query: "AAPL" }], intradayBackfillBatchDays: 2 };
  const result = await runIntradayBackfillTick(config, db, { now: new Date("2026-01-15T12:00:00Z") });

  const aapl = result.results.find((r) => r.ticker === "AAPL");
  assert.equal(aapl.ok, false);
  assert.deepEqual(aapl.dates, ["2026-01-01", "2026-01-02"]);

  const { results: rows } = await db.prepare("SELECT date, status, error FROM intraday_backfill_status WHERE ticker = 'AAPL' AND date IN ('2026-01-01','2026-01-02') ORDER BY date").all();
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.status === "failed" && /500/.test(r.error)));
});

test("a ticker with no claimable day (everything already done) is reported claimed:false, not an error", async (t) => {
  const db = newDb();
  await seedBackfillRows(db, { tickers: ["AAPL"], fromDate: "2026-01-14", toDate: "2026-01-14" });
  await db.prepare("UPDATE intraday_backfill_status SET status = 'done' WHERE ticker = 'AAPL' AND date = '2026-01-14'").run();
  // Seed "today" too so ensureTodayBackfillRows inside the tick has nothing new to add for this assertion's date.
  await seedBackfillRows(db, { tickers: ["AAPL"], fromDate: "2026-01-15", toDate: "2026-01-15" });
  await db.prepare("UPDATE intraday_backfill_status SET status = 'done' WHERE ticker = 'AAPL' AND date = '2026-01-15'").run();
  mockVendors(t, {});

  const config = { ...baseConfig(), watchlist: [{ ticker: "AAPL", query: "AAPL" }] };
  const result = await runIntradayBackfillTick(config, db, { now: new Date("2026-01-15T12:00:00Z") });

  const aapl = result.results.find((r) => r.ticker === "AAPL");
  assert.deepEqual(aapl, { ticker: "AAPL", claimed: false });
});
