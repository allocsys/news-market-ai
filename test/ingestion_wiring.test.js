// ingestion_wiring test (plan.md open item: wire GDELT/yfinance/rss/
// html_scrape/edgar_fundamentals into graph/pipeline.js end-to-end -- the
// WIRING half specifically, see pipeline.js's header for why the LIVE
// spot-check half is a separate, currently-blocked item).
//
// Covers graph/pipeline.js#collectNewsItems, #ingestPriceBars, and
// #ingestFundamentals against mocked global.fetch and a minimal in-memory
// fake of the price_bars/fundamental_facts tables -- same conventions as
// price_bars_pointintime.test.js and fundamentals_pointintime.test.js.
// Does NOT exercise runScheduledIngestion end-to-end, since that also
// calls runPipelineForTicker, which needs live Gemini calls across six
// agent modules -- same documented scope limit as
// checkpoint_resume.test.js's header.

import test from "node:test";
import assert from "node:assert/strict";
import { collectNewsItems, ingestPriceBars, ingestFundamentals, backfillHistoricalNews } from "../src/graph/pipeline.js";
import { fetchLatest as fetchFinnhubLatest } from "../src/ingestion/sources/finnhub.js";
import { VendorError } from "../src/shared/errors.js";

/**
 * Minimal in-memory fake of storage/d1.js#insertNewsItem's three tables
 * (news_items, news_item_revisions, news_item_tickers) -- FakeDb above only
 * understands the price_bars/fundamental_facts INSERT shapes ingestPriceBars/
 * ingestFundamentals issue, so backfillHistoricalNews (which calls
 * insertNewsItem) needs its own fake rather than overloading that one.
 */
class FakeNewsDb {
  constructor() {
    this.newsItems = [];
    this.tickers = [];
  }

  prepare(sql) {
    const db = this;
    return {
      bind(...args) {
        return {
          async run() {
            if (/INSERT INTO news_items/.test(sql)) {
              const [id, source, url, firstPublishedAt] = args;
              db.newsItems.push({ id, source, url, firstPublishedAt });
            } else if (/INSERT INTO news_item_revisions/.test(sql)) {
              // exercised by insertNewsItem but not asserted on here -- news_items is the signal this test suite cares about
            } else if (/INSERT INTO news_item_tickers/.test(sql)) {
              const [newsItemId, ticker] = args;
              db.tickers.push({ newsItemId, ticker });
            } else {
              throw new Error(`FakeNewsDb: unsupported run() query: ${sql}`);
            }
          },
        };
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** Minimal in-memory fake understanding only the two upsert queries pipeline.js's helpers actually issue (insertPriceBar, insertFundamentalFact). */
class FakeDb {
  constructor() {
    this.priceBars = [];
    this.fundamentalFacts = [];
    this.batchCalls = []; // records each db.batch() call's statement count, for asserting the subrequest-storm fix actually batches
  }

  /** Mirrors real D1's db.batch(statements): each element is already a bound Statement (from prepare().bind()), run sequentially, one "request" for the whole array. */
  async batch(statements) {
    this.batchCalls.push(statements.length);
    const results = [];
    for (const stmt of statements) {
      results.push(await stmt.run());
    }
    return results;
  }

  prepare(sql) {
    const db = this;
    return {
      bind(...args) {
        return {
          async run() {
            if (/INSERT INTO price_bars/.test(sql)) {
              const [ticker, date, open, high, low, close, volume, source] = args;
              db.priceBars.push({ ticker, date, open, high, low, close, volume, source });
            } else if (/INSERT INTO fundamental_facts/.test(sql)) {
              const [ticker, cik, tag, val, unit, fiscalYear, fiscalPeriod, form, filedAt, source] = args;
              db.fundamentalFacts.push({ ticker, cik, tag, val, unit, fiscalYear, fiscalPeriod, form, filedAt, source });
            } else {
              throw new Error(`FakeDb: unsupported run() query: ${sql}`);
            }
          },
        };
      },
    };
  }
}

function mockRssXml() {
  return `<?xml version="1.0"?>
    <rss><channel>
      <item>
        <title>Acme Corp beats earnings</title>
        <link>https://news.example.com/acme-earnings</link>
        <pubDate>Tue, 15 Sep 2026 14:30:00 GMT</pubDate>
        <description>Acme reported strong Q3 results.</description>
      </item>
    </channel></rss>`;
}

function mockFinnhubJson() {
  return [{ url: "https://finnhub.example.com/story", datetime: 1757941800, headline: "Finnhub story about Acme", summary: "A brief summary." }];
}

function mockYahooChart({ ticker = "AAPL" } = {}) {
  return {
    chart: {
      result: [
        {
          meta: { symbol: ticker },
          timestamp: [1767571200],
          indicators: { quote: [{ open: [100], high: [105], low: [99], close: [103], volume: [1000] }] },
        },
      ],
      error: null,
    },
  };
}

function mockCompanyFactsJson() {
  return {
    facts: {
      "us-gaap": {
        Revenues: { units: { USD: [{ fy: 2026, fp: "Q2", form: "10-Q", filed: "2026-07-25", val: 1000000, end: "2026-06-30" }] } },
        EarningsPerShareDiluted: { units: {} },
        NetIncomeLoss: { units: {} },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// collectNewsItems
// ---------------------------------------------------------------------------

test("collectNewsItems merges items from finnhub, rss, and html_scrape into one list", async (t) => {
  const config = {
    watchlist: [{ ticker: "AAPL", query: "AAPL" }],
    finnhubApiBase: "https://fake.test/finnhub", finnhubApiKey: "test-key", finnhubLookbackDays: 3,
    rssFeeds: [{ ticker: "AAPL", url: "https://fake.test/feed.xml" }],
    scrapePages: [],
  };

  t.mock.method(global, "fetch", async (url) => {
    if (String(url).includes("finnhub")) return { ok: true, status: 200, json: async () => mockFinnhubJson() };
    if (String(url).includes("feed.xml")) return { ok: true, status: 200, text: async () => mockRssXml() };
    throw new Error(`unexpected fetch: ${url}`);
  });

  const items = await collectNewsItems(config);
  assert.equal(items.length, 2);
  const sources = items.map((i) => i.source).sort();
  assert.ok(sources.some((s) => s.startsWith("rss:")));
  assert.ok(sources.some((s) => s === "finnhub"));
});

test("collectNewsItems logs and skips a source that throws a VendorError, without losing the other sources' items", async (t) => {
  const config = {
    watchlist: [{ ticker: "AAPL", query: "AAPL" }],
    finnhubApiBase: "https://fake.test/finnhub", finnhubApiKey: "test-key", finnhubLookbackDays: 3,
    rssFeeds: [{ ticker: "AAPL", url: "https://fake.test/feed.xml" }],
    scrapePages: [],
    retryMaxAttempts: 1, // this test asserts isolation, not retry timing -- see retry.js wiring
  };

  t.mock.method(global, "fetch", async (url) => {
    if (String(url).includes("finnhub")) return { ok: false, status: 503 }; // Finnhub down
    if (String(url).includes("feed.xml")) return { ok: true, status: 200, text: async () => mockRssXml() };
    throw new Error(`unexpected fetch: ${url}`);
  });

  const errorLogs = [];
  t.mock.method(console, "error", (...args) => errorLogs.push(args));

  const items = await collectNewsItems(config);
  assert.equal(items.length, 1); // only the RSS item survives
  assert.equal(items[0].source.startsWith("rss:"), true);
  assert.ok(errorLogs.some(([msg, detail]) => msg.includes("news ingestion") && detail.source === "finnhub"));
});

test("collectNewsItems returns an empty list, not an error, when rssFeeds/scrapePages are unconfigured (no defaults, per config.js)", async (t) => {
  const config = {
    watchlist: [{ ticker: "AAPL", query: "AAPL" }],
    finnhubApiBase: "https://fake.test/finnhub", finnhubApiKey: "test-key", finnhubLookbackDays: 3,
    rssFeeds: [],
    scrapePages: [],
  };
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, json: async () => [] }));

  const items = await collectNewsItems(config);
  assert.deepEqual(items, []);
});

test("collectNewsItems logs (but does not throw on) a per-page html_scrape failure, while keeping successful pages", async (t) => {
  const config = {
    watchlist: [],
    rssFeeds: [],
    scrapePages: [
      { ticker: "AAPL", url: "https://fake.test/good-page" },
      { ticker: "MSFT", url: "https://fake.test/bad-page" },
    ],
  };

  t.mock.method(global, "fetch", async (url) => {
    if (String(url).includes("bad-page")) return { ok: false, status: 404 };
    return { ok: true, status: 200, text: async () => `<html><head><title>Good Page Story</title></head><body>Some article text.</body></html>` };
  });

  const errorLogs = [];
  t.mock.method(console, "error", (...args) => errorLogs.push(args));

  const items = await collectNewsItems(config);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Good Page Story");
  assert.ok(errorLogs.some(([msg, detail]) => msg.includes("scrape") && detail?.url?.includes("bad-page")));
});

// ---------------------------------------------------------------------------
// ingestPriceBars
// ---------------------------------------------------------------------------

test("ingestPriceBars fetches yfinance bars and upserts each one via insertPriceBar", async (t) => {
  const config = { watchlist: [{ ticker: "AAPL" }], yfinanceApiBase: "https://fake.test/chart", yfinanceInterval: "1d", yfinanceRange: "5d" };
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, json: async () => mockYahooChart({ ticker: "AAPL" }) }));

  const db = new FakeDb();
  const result = await ingestPriceBars(config, db);

  assert.equal(result.count, 1);
  assert.equal(db.priceBars.length, 1);
  assert.equal(db.priceBars[0].ticker, "AAPL");
  assert.equal(db.priceBars[0].close, 103);
  assert.equal(db.priceBars[0].source, "yfinance");
});

test("ingestPriceBars logs and returns count:0 on a yfinance VendorError, without throwing", async (t) => {
  // retryMaxAttempts: 1 -- this test asserts isolation, not retry timing -- see retry.js wiring
  const config = { watchlist: [{ ticker: "AAPL" }], yfinanceApiBase: "https://fake.test/chart", yfinanceInterval: "1d", yfinanceRange: "5d", retryMaxAttempts: 1 };
  t.mock.method(global, "fetch", async () => ({ ok: false, status: 429 }));

  const errorLogs = [];
  t.mock.method(console, "error", (...args) => errorLogs.push(args));

  const db = new FakeDb();
  const result = await ingestPriceBars(config, db);

  assert.deepEqual(result, { count: 0 });
  assert.equal(db.priceBars.length, 0);
  assert.ok(errorLogs.some(([msg, detail]) => msg.includes("price bar ingestion") && detail.source === "yfinance"));
});

test("ingestPriceBars rethrows a non-VendorError (a real bug, not a vendor failure)", async (t) => {
  const config = { watchlist: [{ ticker: "AAPL" }], yfinanceApiBase: "https://fake.test/chart", yfinanceInterval: "1d", yfinanceRange: "5d" };
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, json: async () => { throw new TypeError("malformed json"); } }));

  const db = new FakeDb();
  await assert.rejects(() => ingestPriceBars(config, db), TypeError);
});

// ---------------------------------------------------------------------------
// finnhub.js explicit {from, to} range
// ---------------------------------------------------------------------------

test("finnhub fetchLatest uses an explicit {from, to} range instead of the trailing lookback window, when provided", async (t) => {
  const config = { watchlist: [{ ticker: "AAPL" }], finnhubApiBase: "https://fake.test/finnhub", finnhubApiKey: "test-key", finnhubLookbackDays: 3 };

  let capturedUrl;
  t.mock.method(global, "fetch", async (url) => {
    capturedUrl = String(url);
    return { ok: true, status: 200, json: async () => [] };
  });

  await fetchFinnhubLatest(config, { from: "2024-01-01", to: "2024-01-31" }, {});

  assert.ok(capturedUrl.includes("from=2024-01-01"));
  assert.ok(capturedUrl.includes("to=2024-01-31"));
});

test("finnhub fetchLatest still defaults to the trailing lookback window when from/to are omitted (regression guard)", async (t) => {
  const config = { watchlist: [{ ticker: "AAPL" }], finnhubApiBase: "https://fake.test/finnhub", finnhubApiKey: "test-key", finnhubLookbackDays: 3 };

  let capturedUrl;
  t.mock.method(global, "fetch", async (url) => {
    capturedUrl = String(url);
    return { ok: true, status: 200, json: async () => [] };
  });

  await fetchFinnhubLatest(config, {}, {});

  const todayStr = new Date().toISOString().slice(0, 10);
  assert.ok(capturedUrl.includes(`to=${todayStr}`));
  assert.ok(!capturedUrl.includes("from=2024")); // sanity: not accidentally picking up a stale hardcoded date
});

// ---------------------------------------------------------------------------
// backfillHistoricalNews
// ---------------------------------------------------------------------------

test("backfillHistoricalNews requires an explicit {from, to} range", async () => {
  const config = { watchlist: [{ ticker: "AAPL" }], finnhubApiBase: "https://fake.test/finnhub", finnhubApiKey: "test-key" };
  const db = new FakeNewsDb();
  await assert.rejects(() => backfillHistoricalNews(config, db, {}), /requires an explicit \{from, to\}/);
});

test("backfillHistoricalNews fetches finnhub for the given range and persists every item via insertNewsItem", async (t) => {
  const config = { watchlist: [{ ticker: "AAPL" }], finnhubApiBase: "https://fake.test/finnhub", finnhubApiKey: "test-key" };

  let capturedUrl;
  t.mock.method(global, "fetch", async (url) => {
    capturedUrl = String(url);
    return { ok: true, status: 200, json: async () => mockFinnhubJson() };
  });

  const db = new FakeNewsDb();
  const result = await backfillHistoricalNews(config, db, { from: "2024-01-01", to: "2024-01-31" });

  assert.equal(result.inserted, 1);
  assert.equal(result.errors.length, 0);
  assert.equal(db.newsItems.length, 1);
  assert.equal(db.newsItems[0].source, "finnhub");
  assert.ok(db.tickers.some((t2) => t2.ticker === "AAPL"));
  assert.ok(capturedUrl.includes("from=2024-01-01"));
  assert.ok(capturedUrl.includes("to=2024-01-31"));
});

test("backfillHistoricalNews logs and skips a ticker's VendorError without throwing, same isolation as collectNewsItems", async (t) => {
  const config = {
    watchlist: [{ ticker: "AAPL" }, { ticker: "MSFT" }],
    finnhubApiBase: "https://fake.test/finnhub", finnhubApiKey: "test-key", retryMaxAttempts: 1,
  };

  t.mock.method(global, "fetch", async (url) => {
    if (String(url).includes("symbol=AAPL")) return { ok: false, status: 503 };
    return { ok: true, status: 200, json: async () => mockFinnhubJson() };
  });

  const errorLogs = [];
  t.mock.method(console, "error", (...args) => errorLogs.push(args));

  const db = new FakeNewsDb();
  const result = await backfillHistoricalNews(config, db, { from: "2024-01-01", to: "2024-01-31" });

  assert.equal(result.inserted, 1); // only MSFT's item persisted
  assert.equal(result.errors.length, 1);
  assert.ok(errorLogs.some(([msg, detail]) => msg.includes("historical news backfill") && detail.source === "finnhub"));
});

// ---------------------------------------------------------------------------
// ingestFundamentals
// ---------------------------------------------------------------------------

test("ingestFundamentals fetches EDGAR facts for every ticker in edgarCikMap and upserts via insertFundamentalFact", async (t) => {
  const config = { edgarUserAgent: "test-suite contact@example.com", edgarApiBase: "https://fake.test/companyfacts", edgarCikMap: { AAPL: "320193" } };
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, json: async () => mockCompanyFactsJson() }));

  const db = new FakeDb();
  const result = await ingestFundamentals(config, db);

  assert.equal(result.count, 1);
  assert.equal(db.fundamentalFacts.length, 1);
  assert.equal(db.fundamentalFacts[0].ticker, "AAPL");
  assert.equal(db.fundamentalFacts[0].tag, "Revenues");
  assert.equal(db.fundamentalFacts[0].val, 1000000);
});

test("ingestFundamentals is a silent no-op (count:0, no fetch call) when edgarCikMap is empty -- unconfigured, not an error", async (t) => {
  const config = { edgarUserAgent: "", edgarApiBase: "https://fake.test/companyfacts", edgarCikMap: {} };
  let fetchCalled = false;
  t.mock.method(global, "fetch", async () => {
    fetchCalled = true;
    return { ok: true, status: 200, json: async () => mockCompanyFactsJson() };
  });

  const db = new FakeDb();
  const result = await ingestFundamentals(config, db);

  assert.deepEqual(result, { count: 0 });
  assert.equal(fetchCalled, false); // no tickers to loop over -- fetchFacts never called
});

test("ingestFundamentals logs and returns count:0 when the map is set but edgarUserAgent is missing (misconfiguration, not a live vendor failure, but still non-fatal here)", async (t) => {
  const config = { edgarUserAgent: "", edgarApiBase: "https://fake.test/companyfacts", edgarCikMap: { AAPL: "320193" } };

  const errorLogs = [];
  t.mock.method(console, "error", (...args) => errorLogs.push(args));

  const db = new FakeDb();
  const result = await ingestFundamentals(config, db);

  assert.deepEqual(result, { count: 0 });
  assert.ok(errorLogs.some(([msg, detail]) => msg.includes("fundamentals ingestion") && detail.source === "edgar"));
});

// Regression coverage for the live subrequest-cap incident (see
// pipeline.js#ingestFundamentals's header): a per-fact D1 .run() loop threw
// "Too many API requests by single Worker invocation" 1047 times in one
// cron run for TSLA alone. These two tests assert the actual fix -- many
// facts go through db.batch() in chunks, not one .run() per fact -- rather
// than just re-checking the already-covered row counts above.

test("ingestFundamentals batches many facts from one EDGAR response into a single db.batch() call, not one run() per fact", async (t) => {
  const manyEntries = Array.from({ length: 40 }, (_, i) => ({
    fy: 2020 + Math.floor(i / 4), fp: ["Q1", "Q2", "Q3", "FY"][i % 4], form: "10-Q", filed: "2026-07-25", val: 1000 + i, end: "2026-06-30",
  }));
  const config = { edgarUserAgent: "test-suite contact@example.com", edgarApiBase: "https://fake.test/companyfacts", edgarCikMap: { TSLA: "1318605" } };
  t.mock.method(global, "fetch", async () => ({
    ok: true, status: 200,
    json: async () => ({ facts: { "us-gaap": { Revenues: { units: { USD: manyEntries } }, EarningsPerShareDiluted: { units: {} }, NetIncomeLoss: { units: {} } } } }),
  }));

  const db = new FakeDb();
  const result = await ingestFundamentals(config, db);

  assert.equal(result.count, 40);
  assert.equal(db.fundamentalFacts.length, 40);
  assert.equal(db.batchCalls.length, 1); // one db.batch() call for the whole chunk, not 40 separate subrequests
  assert.equal(db.batchCalls[0], 40);
});

test("ingestFundamentals splits a fact count over the chunk size into multiple bounded db.batch() calls", async (t) => {
  const manyEntries = Array.from({ length: 450 }, (_, i) => ({
    fy: 2000 + Math.floor(i / 4), fp: ["Q1", "Q2", "Q3", "FY"][i % 4], form: "10-Q", filed: "2026-07-25", val: i, end: "2026-06-30",
  }));
  const config = { edgarUserAgent: "test-suite contact@example.com", edgarApiBase: "https://fake.test/companyfacts", edgarCikMap: { TSLA: "1318605" } };
  t.mock.method(global, "fetch", async () => ({
    ok: true, status: 200,
    json: async () => ({ facts: { "us-gaap": { Revenues: { units: { USD: manyEntries } }, EarningsPerShareDiluted: { units: {} }, NetIncomeLoss: { units: {} } } } }),
  }));

  const db = new FakeDb();
  const result = await ingestFundamentals(config, db);

  assert.equal(result.count, 450);
  assert.equal(db.batchCalls.length, 3); // 200 + 200 + 50, per FUNDAMENTALS_INSERT_CHUNK_SIZE
  assert.ok(db.batchCalls.every((size) => size <= 200));
  assert.deepEqual(db.batchCalls, [200, 200, 50]);
});
