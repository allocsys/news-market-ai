// Date-windowed Finnhub backfill (ingestion/ingest.js#backfillHistoricalNews,
// sources/finnhub.js#createWindowedFetcher). Background: Finnhub's
// /company-news returns only the newest ~245 articles per request however wide
// the range (INFERRED from stored data -- AAPL/MSFT/TSLA each had ~245, none
// older than 2026-09-14, after a 90-day backfill), so a one-request-per-ticker
// backfill inserted nothing new past about a week. These tests run on the real
// inputs schema (test/helpers/sqlite_d1.js) with a fetch mock that behaves like
// that: it honours ?from=&to= and then keeps only the newest `cap` articles.

import test from "node:test";
import assert from "node:assert/strict";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { INPUTS_DIR } from "./helpers/engine_ctx.js";
import { loadConfig } from "../src/config.js";
import { backfillHistoricalNews } from "../src/ingestion/ingest.js";
import { createWindowedFetcher } from "../src/ingestion/sources/finnhub.js";
import { addDays } from "../src/ingestion/date_windows.js";

/** A real loadConfig, with pacing at 1ms (0 would fall back to the 1100ms default) and no retries, so tests neither sleep nor retry a 503. */
function makeConfig(overrides = {}) {
  return loadConfig({
    WATCHLIST_TICKERS: "AAPL",
    FINNHUB_API_KEY: "test-key",
    ENTITY_RESOLUTION_USE_NAME_INDEX: "false",
    FINNHUB_MIN_REQUEST_INTERVAL_MS: "1",
    RETRY_MAX_ATTEMPTS: "1",
    ...overrides,
  });
}

async function count(db, table) {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first();
  return row.n;
}

/**
 * Stands in for Finnhub: `perDay` distinct articles per ticker per calendar day (a number, or a function of the day), every request filtered to its ?from=&to= (both inclusive), then cut to the newest `cap`, like the real endpoint appears to. `sharedArticle` makes every ticker return the SAME articles (same url and datetime, so the same id). `failFrom` answers a request whose from= equals it with a 503. Returns the recorded requests.
 */
function mockFinnhub(t, { perDay = 1, cap = 245, sharedArticle = false, failFrom = null } = {}) {
  const requests = [];
  t.mock.method(global, "fetch", async (url) => {
    const u = new URL(String(url));
    if (!u.hostname.includes("finnhub")) return { ok: true, status: 200, json: async () => ({}) };
    const symbol = u.searchParams.get("symbol");
    const from = u.searchParams.get("from");
    const to = u.searchParams.get("to");
    requests.push({ symbol, from, to });
    if (failFrom && from === failFrom) return { ok: false, status: 503 };

    const articles = [];
    for (let day = from; day <= to; day = addDays(day, 1)) {
      const n = typeof perDay === "function" ? perDay(day) : perDay;
      for (let i = 0; i < n; i++) {
        articles.push({
          url: `https://finnhub.example.com/${sharedArticle ? "shared" : symbol}/${day}/${i}`,
          datetime: Date.parse(`${day}T12:00:00Z`) / 1000 + i,
          headline: sharedArticle ? `Shared story ${day} ${i}` : `${symbol} story ${day} ${i}`,
          summary: "",
        });
      }
    }
    articles.sort((a, b) => b.datetime - a.datetime); // newest first, so the cap drops the OLDEST
    const body = articles.slice(0, cap);
    return { ok: true, status: 200, json: async () => body };
  });
  return requests;
}

// ---------------------------------------------------------------------------
// The bug: a range with more articles than one request can return
// ---------------------------------------------------------------------------

test("backfill reaches every day of a range holding more articles than one request can return", async (t) => {
  const db = createTestD1([INPUTS_DIR]);
  const requests = mockFinnhub(t, { perDay: 30 }); // 12 days x 30 = 360, over the 245 cap

  const result = await backfillHistoricalNews(makeConfig(), db, { from: "2025-09-01", to: "2025-09-12" });

  assert.equal(result.inserted, 360, "a single request would have stopped at 245 and never reached the oldest days");
  assert.equal(await count(db, "news_items"), 360);
  const earliest = await db.prepare("SELECT MIN(first_published_at) AS m FROM news_items").first();
  assert.ok(earliest.m.startsWith("2025-09-01"), `earliest stored article is from the start of the range, got ${earliest.m}`);
  assert.equal(result.nextFrom, null);
  assert.equal(result.windows, 3);
  assert.equal(requests.length, 3, "no window came back capped, so no splits");
  assert.deepEqual(result.truncated, []);
});

test("backfill walks the range in consecutive windows that tile it exactly", async (t) => {
  const db = createTestD1([INPUTS_DIR]);
  const requests = mockFinnhub(t, { perDay: 1 });

  await backfillHistoricalNews(makeConfig(), db, { from: "2025-09-01", to: "2025-09-12" });

  assert.deepEqual(requests, [
    { symbol: "AAPL", from: "2025-09-01", to: "2025-09-05" },
    { symbol: "AAPL", from: "2025-09-06", to: "2025-09-10" },
    { symbol: "AAPL", from: "2025-09-11", to: "2025-09-12" },
  ]);
});

test("backfill honours FINNHUB_BACKFILL_WINDOW_DAYS", async (t) => {
  const db = createTestD1([INPUTS_DIR]);
  const requests = mockFinnhub(t, { perDay: 1 });

  await backfillHistoricalNews(makeConfig({ FINNHUB_BACKFILL_WINDOW_DAYS: "10" }), db, { from: "2025-09-01", to: "2025-09-12" });

  assert.deepEqual(requests.map((r) => [r.from, r.to]), [
    ["2025-09-01", "2025-09-10"],
    ["2025-09-11", "2025-09-12"],
  ]);
});

// ---------------------------------------------------------------------------
// Adaptive splitting
// ---------------------------------------------------------------------------

test("a window whose response looks capped is split and refetched, losing nothing", async (t) => {
  const db = createTestD1([INPUTS_DIR]);
  const requests = mockFinnhub(t, { perDay: 60 }); // one 5-day window = 300 articles, the mock returns 245

  const result = await backfillHistoricalNews(makeConfig(), db, { from: "2025-09-01", to: "2025-09-05" });

  assert.deepEqual(requests.map((r) => [r.from, r.to]), [
    ["2025-09-01", "2025-09-05"], // comes back at 245, over the 230 threshold
    ["2025-09-01", "2025-09-03"], // 180
    ["2025-09-04", "2025-09-05"], // 120
  ]);
  assert.equal(result.inserted, 300, "every article, including the ones the capped response dropped");
  assert.equal(result.requests, 3);
  assert.deepEqual(result.truncated, []);
});

test("a single day still at the cap is reported as truncated and warned about, not silently accepted", async (t) => {
  const db = createTestD1([INPUTS_DIR]);
  mockFinnhub(t, { perDay: 300 }); // one day, 300 articles, the mock returns 245
  const warnings = [];
  t.mock.method(console, "warn", (...args) => warnings.push(args));

  const result = await backfillHistoricalNews(makeConfig(), db, { from: "2025-09-01", to: "2025-09-01" });

  assert.equal(result.inserted, 245, "what Finnhub did return is still kept");
  assert.deepEqual(result.truncated, [{ ticker: "AAPL", from: "2025-09-01", to: "2025-09-01", raw: 245 }]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /hit the per-request article cap/);
  assert.equal(warnings[0][1].ticker, "AAPL");
});

test("a capped response is recognised by its RAW article count, even when most of its articles are unusable", async (t) => {
  const requests = [];
  t.mock.method(global, "fetch", async (url) => {
    const u = new URL(String(url));
    const from = u.searchParams.get("from");
    const to = u.searchParams.get("to");
    requests.push([from, to]);
    if (from < to) {
      // 230 articles with no headline: the adapter skips all of them, but the response was still full.
      return { ok: true, status: 200, json: async () => Array.from({ length: 230 }, (_, i) => ({ url: `https://finnhub.example.com/bad-${i}`, datetime: 1757941800 + i, summary: "" })) };
    }
    return { ok: true, status: 200, json: async () => [{ url: `https://finnhub.example.com/ok-${from}`, datetime: Date.parse(`${from}T12:00:00Z`) / 1000, headline: `ok ${from}`, summary: "" }] };
  });

  const fetcher = await createWindowedFetcher(makeConfig());
  const { items, errors, truncated } = await fetcher.fetchWindow("AAPL", { from: "2025-09-01", to: "2025-09-02" });

  assert.deepEqual(requests, [
    ["2025-09-01", "2025-09-02"],
    ["2025-09-01", "2025-09-01"],
    ["2025-09-02", "2025-09-02"],
  ]);
  assert.equal(items.length, 2);
  assert.equal(errors.length, 0);
  assert.equal(truncated.length, 0);
  assert.equal(fetcher.requestCount(), 3);
});

test("FINNHUB_WINDOW_SPLIT_THRESHOLD changes when a window is split", async (t) => {
  const db = createTestD1([INPUTS_DIR]);
  const requests = mockFinnhub(t, { perDay: 20 }); // a 5-day window = 100 articles

  await backfillHistoricalNews(makeConfig({ FINNHUB_WINDOW_SPLIT_THRESHOLD: "100" }), db, { from: "2025-09-01", to: "2025-09-05" });

  assert.equal(requests.length, 3, "100 raw articles is at the threshold, so the window splits");
});

// ---------------------------------------------------------------------------
// Continuation cursor and per-call bounds
// ---------------------------------------------------------------------------

test("maxInserts stops at a window boundary and the cursor is the next window's first day; a follow-up finishes the range", async (t) => {
  const db = createTestD1([INPUTS_DIR]);
  mockFinnhub(t, { perDay: 40 }); // 200 per 5-day window, 20 days = 800
  const config = makeConfig();

  const first = await backfillHistoricalNews(config, db, { from: "2025-09-01", to: "2025-09-20", maxInserts: 300 });
  assert.equal(first.inserted, 400, "stops only after the window that crossed the cap");
  assert.equal(first.windows, 2);
  assert.equal(first.nextFrom, "2025-09-11", "exactly the first day of the next unprocessed window, no step back");

  const second = await backfillHistoricalNews(config, db, { from: first.nextFrom, to: "2025-09-20", originalFrom: "2025-09-01", maxInserts: 300 });
  assert.equal(second.inserted, 400);
  assert.equal(second.nextFrom, null);
  assert.equal(await count(db, "news_items"), 800, "nothing lost, nothing stored twice");
});

test("maxRequests stops a rerun over an already-stored range, which maxInserts alone never would", async (t) => {
  const db = createTestD1([INPUTS_DIR]);
  const requests = mockFinnhub(t, { perDay: 10 });
  const config = makeConfig();
  await backfillHistoricalNews(config, db, { from: "2025-09-01", to: "2025-09-20" });
  requests.length = 0; // count only the rerun's requests

  const rerun = await backfillHistoricalNews(config, db, { from: "2025-09-01", to: "2025-09-20", maxRequests: 2 });

  assert.equal(rerun.inserted, 0, "everything was already stored");
  assert.equal(rerun.windows, 2);
  assert.equal(rerun.nextFrom, "2025-09-11");
  assert.equal(requests.length, 2);
});

test("a call always processes its first window, even when the request budget is smaller than one window", async (t) => {
  const db = createTestD1([INPUTS_DIR]);
  mockFinnhub(t, { perDay: 1 });

  const result = await backfillHistoricalNews(makeConfig({ WATCHLIST_TICKERS: "AAPL,MSFT,TSLA" }), db, { from: "2025-09-01", to: "2025-09-20", maxRequests: 1 });

  assert.equal(result.windows, 1, "otherwise a continuation chain could never advance");
  assert.equal(result.nextFrom, "2025-09-06");
});

test("an empty range (from after to) does no fetching and returns cleanly", async (t) => {
  const db = createTestD1([INPUTS_DIR]);
  const requests = mockFinnhub(t);

  const result = await backfillHistoricalNews(makeConfig(), db, { from: "2025-09-05", to: "2025-09-01" });

  assert.equal(requests.length, 0);
  assert.equal(result.inserted, 0);
  assert.equal(result.windows, 0);
  assert.equal(result.nextFrom, null);
});

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

test("progress counts days of the ORIGINAL range and only moves forward across continuation parts", async (t) => {
  const db = createTestD1([INPUTS_DIR]);
  mockFinnhub(t, { perDay: 40 });
  const config = makeConfig();
  const part1 = [];
  const part2 = [];

  const first = await backfillHistoricalNews(config, db, { from: "2025-09-01", to: "2025-09-20", maxInserts: 300, onProgress: (p) => part1.push(p) });
  await backfillHistoricalNews(config, db, { from: first.nextFrom, to: "2025-09-20", originalFrom: "2025-09-01", maxInserts: 300, onProgress: (p) => part2.push(p) });

  const all = [...part1, ...part2];
  assert.ok(all.every((p) => p.total === 20), "total is the whole original range in days, in every part");
  for (let i = 1; i < all.length; i++) {
    assert.ok(all[i].done >= all[i - 1].done, `done never goes backwards (call ${i})`);
    assert.ok(all[i].percent >= all[i - 1].percent, `percent never goes backwards (call ${i})`);
  }
  const endOfPart1 = part1.at(-1);
  assert.equal(endOfPart1.done, 10);
  assert.equal(endOfPart1.force, true, "the write that ends a part is forced, so the job row matches where the part really ended");
  assert.equal(part2[0].done, 10, "part 2 starts where part 1 ended, not back at zero");
  const last = part2.at(-1);
  assert.equal(last.done, 20);
  assert.equal(last.percent, 100);
  assert.equal(last.force, true);
});

// ---------------------------------------------------------------------------
// Saving: shared articles and vendor failures
// ---------------------------------------------------------------------------

test("an article returned for two tickers is stored once and associated with both, even in a big window", async (t) => {
  const db = createTestD1([INPUTS_DIR]);
  mockFinnhub(t, { perDay: 1, sharedArticle: true });

  const result = await backfillHistoricalNews(makeConfig({ WATCHLIST_TICKERS: "AAPL,MSFT" }), db, { from: "2025-09-01", to: "2025-09-01" });

  assert.equal(result.inserted, 1);
  assert.equal(await count(db, "news_items"), 1);
  const tickers = await db.prepare("SELECT ticker FROM news_item_tickers ORDER BY ticker").all();
  assert.deepEqual(tickers.results.map((r) => r.ticker), ["AAPL", "MSFT"]);
});

test("a failed request loses only its own window: the error names the ticker and window, the other windows are saved", async (t) => {
  const db = createTestD1([INPUTS_DIR]);
  mockFinnhub(t, { perDay: 1, failFrom: "2025-09-06" });
  const errorLogs = [];
  t.mock.method(console, "error", (...args) => errorLogs.push(args));

  const result = await backfillHistoricalNews(makeConfig(), db, { from: "2025-09-01", to: "2025-09-12" });

  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].ticker, "AAPL");
  assert.deepEqual(result.errors[0].window, { from: "2025-09-06", to: "2025-09-10" });
  assert.equal(result.inserted, 7, "days 1-5 and 11-12");
  assert.equal(result.nextFrom, null);
  const logged = errorLogs.find(([msg]) => msg.includes("historical news backfill"));
  assert.ok(logged, "the skipped window is logged");
  assert.equal(logged[1].source, "finnhub");
  assert.equal(logged[1].ticker, "AAPL");
  assert.deepEqual(logged[1].window, { from: "2025-09-06", to: "2025-09-10" });
});
