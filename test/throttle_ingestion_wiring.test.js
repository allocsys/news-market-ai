// throttle_ingestion_wiring test -- extends throttle.js's wiring (previously
// EDGAR-only, see test/throttle.test.js) to the four remaining ingestion
// adapters: gdelt.js, yfinance.js, rss.js, html_scrape.js. None of these
// vendors has a documented rate limit (unlike EDGAR's ~10 req/sec), so each
// adapter's *MinRequestIntervalMs config field defaults to 0 -- these tests
// verify BOTH that the unconfigured (default) case stays a true no-op AND
// that pacing actually engages once explicitly configured, same two-sided
// convention as throttle.test.js's own edgar_fundamentals.js wiring tests.
//
// Same real-timer tradeoff documented there: no injection seam exists from
// these call sites into createThrottle's now/sleep, so the "configured"
// tests use small-but-real intervals (150ms) and assert on real elapsed gaps
// between mocked-fetch call timestamps -- verifying the actual wiring path,
// not a mock of it. Keeps the added wall-clock cost to ~150ms per adapter.

import test from "node:test";
import assert from "node:assert/strict";
import { fetchLatest as fetchGdeltLatest } from "../src/ingestion/sources/gdelt.js";
import { fetchDailyBars } from "../src/ingestion/sources/yfinance.js";
import { fetchLatest as fetchRssLatest } from "../src/ingestion/sources/rss.js";
import { fetchLatest as fetchScrapeLatest } from "../src/ingestion/sources/html_scrape.js";

function emptyGdeltJson() {
  return { articles: [] };
}

function rssXml() {
  return `<?xml version="1.0"?><rss><channel></channel></rss>`;
}

function yahooChartJson() {
  return { chart: { result: [{ meta: { symbol: "X" }, timestamp: [], indicators: { quote: [{ open: [], high: [], low: [], close: [], volume: [] }] } }], error: null } };
}

function scrapePageHtml() {
  return `<html><head><title>A Page</title></head><body>Some text.</body></html>`;
}

// ---------------------------------------------------------------------------
// gdelt.js#fetchLatest
// ---------------------------------------------------------------------------

test("gdelt.fetchLatest is a no-op (no real delay) when gdeltMinRequestIntervalMs is unset", async (t) => {
  const config = {
    gdeltApiBase: "https://fake.test/gdelt", gdeltMode: "ArtList", gdeltFormat: "json", gdeltSort: "DateDesc", gdeltMaxRecords: 50,
  };
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, json: async () => emptyGdeltJson() }));

  const queries = [{ ticker: "AAPL", query: "AAPL" }, { ticker: "MSFT", query: "MSFT" }];
  const start = Date.now();
  await fetchGdeltLatest(config, { queries });
  assert.ok(Date.now() - start < 50, "expected no throttling delay when unconfigured");
});

test("gdelt.fetchLatest paces successive queries at config.gdeltMinRequestIntervalMs apart when configured", async (t) => {
  const config = {
    gdeltApiBase: "https://fake.test/gdelt", gdeltMode: "ArtList", gdeltFormat: "json", gdeltSort: "DateDesc", gdeltMaxRecords: 50,
    gdeltMinRequestIntervalMs: 150,
  };
  const callTimes = [];
  t.mock.method(global, "fetch", async () => {
    callTimes.push(Date.now());
    return { ok: true, status: 200, json: async () => emptyGdeltJson() };
  });

  const queries = [{ ticker: "AAPL", query: "AAPL" }, { ticker: "MSFT", query: "MSFT" }];
  await fetchGdeltLatest(config, { queries });

  assert.equal(callTimes.length, 2);
  assert.ok(callTimes[1] - callTimes[0] >= 130, `expected ~150ms gap, got ${callTimes[1] - callTimes[0]}ms`);
});

// ---------------------------------------------------------------------------
// yfinance.js#fetchDailyBars
// ---------------------------------------------------------------------------

test("yfinance.fetchDailyBars is a no-op (no real delay) when yfinanceMinRequestIntervalMs is unset", async (t) => {
  const config = { yfinanceApiBase: "https://fake.test/chart", yfinanceInterval: "1d", yfinanceRange: "5d" };
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, json: async () => yahooChartJson() }));

  const start = Date.now();
  await fetchDailyBars(config, { tickers: ["AAPL", "MSFT"] });
  assert.ok(Date.now() - start < 50, "expected no throttling delay when unconfigured");
});

test("yfinance.fetchDailyBars paces successive tickers at config.yfinanceMinRequestIntervalMs apart when configured", async (t) => {
  const config = { yfinanceApiBase: "https://fake.test/chart", yfinanceInterval: "1d", yfinanceRange: "5d", yfinanceMinRequestIntervalMs: 150 };
  const callTimes = [];
  t.mock.method(global, "fetch", async () => {
    callTimes.push(Date.now());
    return { ok: true, status: 200, json: async () => yahooChartJson() };
  });

  await fetchDailyBars(config, { tickers: ["AAPL", "MSFT"] });

  assert.equal(callTimes.length, 2);
  assert.ok(callTimes[1] - callTimes[0] >= 130, `expected ~150ms gap, got ${callTimes[1] - callTimes[0]}ms`);
});

// ---------------------------------------------------------------------------
// rss.js#fetchLatest
// ---------------------------------------------------------------------------

test("rss.fetchLatest is a no-op (no real delay) when rssMinRequestIntervalMs is unset", async (t) => {
  const config = { rssFeeds: [{ ticker: "A", url: "https://fake.test/a.xml" }, { ticker: "B", url: "https://fake.test/b.xml" }] };
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, text: async () => rssXml() }));

  const start = Date.now();
  await fetchRssLatest(config);
  assert.ok(Date.now() - start < 50, "expected no throttling delay when unconfigured");
});

test("rss.fetchLatest paces successive feeds at config.rssMinRequestIntervalMs apart when configured", async (t) => {
  const config = {
    rssFeeds: [{ ticker: "A", url: "https://fake.test/a.xml" }, { ticker: "B", url: "https://fake.test/b.xml" }],
    rssMinRequestIntervalMs: 150,
  };
  const callTimes = [];
  t.mock.method(global, "fetch", async () => {
    callTimes.push(Date.now());
    return { ok: true, status: 200, text: async () => rssXml() };
  });

  await fetchRssLatest(config);

  assert.equal(callTimes.length, 2);
  assert.ok(callTimes[1] - callTimes[0] >= 130, `expected ~150ms gap, got ${callTimes[1] - callTimes[0]}ms`);
});

// ---------------------------------------------------------------------------
// html_scrape.js#fetchLatest
// ---------------------------------------------------------------------------

test("html_scrape.fetchLatest is a no-op (no real delay) when scrapeMinRequestIntervalMs is unset", async (t) => {
  const config = { scrapePages: [{ ticker: "A", url: "https://fake.test/a" }, { ticker: "B", url: "https://fake.test/b" }] };
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, text: async () => scrapePageHtml() }));

  const start = Date.now();
  await fetchScrapeLatest(config);
  assert.ok(Date.now() - start < 50, "expected no throttling delay when unconfigured");
});

test("html_scrape.fetchLatest paces successive pages at config.scrapeMinRequestIntervalMs apart when configured", async (t) => {
  const config = {
    scrapePages: [{ ticker: "A", url: "https://fake.test/a" }, { ticker: "B", url: "https://fake.test/b" }],
    scrapeMinRequestIntervalMs: 150,
  };
  const callTimes = [];
  t.mock.method(global, "fetch", async () => {
    callTimes.push(Date.now());
    return { ok: true, status: 200, text: async () => scrapePageHtml() };
  });

  const { items, errors } = await fetchScrapeLatest(config);

  assert.equal(errors.length, 0);
  assert.equal(items.length, 2);
  assert.equal(callTimes.length, 2);
  assert.ok(callTimes[1] - callTimes[0] >= 130, `expected ~150ms gap, got ${callTimes[1] - callTimes[0]}ms`);
});
