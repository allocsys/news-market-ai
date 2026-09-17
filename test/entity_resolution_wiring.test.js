// entity_resolution_wiring.test.js -- covers the opt-in
// config.entityResolutionUseNameIndex wiring added this session to
// gdelt.js/rss.js/html_scrape.js's fetchLatest, plus
// graph/pipeline.js#collectNewsItems threading `kv` through to them so the
// name index actually gets cached in production. Complements
// entity_resolution.test.js (pure logic) and edgar_cik_lookup.test.js
// (fetchTickerDirectory) -- this file is specifically about the three
// ingestion adapters' wiring: off by default, fails open when misconfigured,
// resolves real extra tickers when enabled and working.

import test from "node:test";
import assert from "node:assert/strict";
import { fetchLatest as fetchGdeltLatest } from "../src/ingestion/sources/gdelt.js";
import { fetchLatest as fetchRssLatest } from "../src/ingestion/sources/rss.js";
import { fetchLatest as fetchScrapeLatest } from "../src/ingestion/sources/html_scrape.js";
import { collectNewsItems } from "../src/graph/pipeline.js";

const EDGAR_UA = "test-suite contact@example.com";
const TICKER_URL = "https://fake.test/company_tickers.json";

function mockDirectoryJson() {
  return {
    "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." },
    "1": { cik_str: 789019, ticker: "MSFT", title: "MICROSOFT CORPORATION" },
    "2": { cik_str: 1045810, ticker: "NVDA", title: "NVIDIA Corp" },
  };
}

function fakeKv() {
  const store = new Map();
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, value); },
  };
}

// ---------------------------------------------------------------------------
// gdelt.js#fetchLatest
// ---------------------------------------------------------------------------

test("gdelt.fetchLatest never fetches SEC's ticker file when entityResolutionUseNameIndex is unset (default off)", async (t) => {
  const config = { gdeltApiBase: "https://fake.test/gdelt", gdeltMode: "ArtList", gdeltFormat: "json", gdeltSort: "DateDesc", gdeltMaxRecords: 50 };
  const fetchedUrls = [];
  t.mock.method(global, "fetch", async (url) => {
    fetchedUrls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ articles: [{ url: "https://x.example.com/a", seendate: "20260915T143000Z", title: "Microsoft news", domain: "x.example.com" }] }) };
  });

  const { items } = await fetchGdeltLatest(config, { queries: [{ ticker: "AAPL", query: "AAPL" }] });
  assert.deepEqual(items[0].tickers, ["AAPL"]); // no name-index match added -- unchanged pre-session behavior
  assert.equal(fetchedUrls.length, 1); // only the gdelt query itself
});

test("gdelt.fetchLatest resolves extra tickers via the real SEC-backed name index when enabled", async (t) => {
  const config = {
    gdeltApiBase: "https://fake.test/gdelt", gdeltMode: "ArtList", gdeltFormat: "json", gdeltSort: "DateDesc", gdeltMaxRecords: 50,
    edgarUserAgent: EDGAR_UA, edgarTickerCikUrl: TICKER_URL, entityResolutionUseNameIndex: true,
  };
  t.mock.method(global, "fetch", async (url) => {
    if (String(url).includes("company_tickers")) return { ok: true, status: 200, json: async () => mockDirectoryJson() };
    return { ok: true, status: 200, json: async () => ({ articles: [{ url: "https://x.example.com/a", seendate: "20260915T143000Z", title: "Microsoft teams up with NVIDIA on new chips", domain: "x.example.com" }] }) };
  });

  const { items } = await fetchGdeltLatest(config, { queries: [{ ticker: "AAPL", query: "AAPL" }] });
  assert.deepEqual(new Set(items[0].tickers), new Set(["AAPL", "MSFT", "NVDA"]));
});

test("gdelt.fetchLatest fails open (hintTicker-only resolution, logged) when enabled but edgarUserAgent is missing", async (t) => {
  const config = {
    gdeltApiBase: "https://fake.test/gdelt", gdeltMode: "ArtList", gdeltFormat: "json", gdeltSort: "DateDesc", gdeltMaxRecords: 50,
    entityResolutionUseNameIndex: true, // edgarUserAgent left unset -- misconfigured, not vendor-down
  };
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, json: async () => ({ articles: [{ url: "https://x.example.com/a", seendate: "20260915T143000Z", title: "Microsoft news", domain: "x.example.com" }] }) }));
  const errorLogs = [];
  t.mock.method(console, "error", (...args) => errorLogs.push(args));

  const { items } = await fetchGdeltLatest(config, { queries: [{ ticker: "AAPL", query: "AAPL" }] });
  assert.deepEqual(items[0].tickers, ["AAPL"]); // degraded gracefully, no crash
  assert.ok(errorLogs.some(([msg]) => msg.includes("entity-resolution name index unavailable")));
});

// ---------------------------------------------------------------------------
// rss.js#fetchLatest
// ---------------------------------------------------------------------------

function rssXmlWithTitle(title) {
  return `<?xml version="1.0"?><rss><channel><item><title>${title}</title><link>https://news.example.com/story</link><pubDate>Tue, 15 Sep 2026 14:30:00 GMT</pubDate><description>desc</description></item></channel></rss>`;
}

test("rss.fetchLatest never fetches SEC's ticker file by default", async (t) => {
  const config = { rssFeeds: [{ ticker: "", url: "https://fake.test/feed.xml" }] };
  const fetchedUrls = [];
  t.mock.method(global, "fetch", async (url) => { fetchedUrls.push(String(url)); return { ok: true, status: 200, text: async () => rssXmlWithTitle("Microsoft news") }; });

  const items = await fetchRssLatest(config);
  assert.deepEqual(items[0].tickers, []); // no hint, no domain match, no name index -- unchanged
  assert.equal(fetchedUrls.length, 1);
});

test("rss.fetchLatest resolves tickers via the name index when enabled", async (t) => {
  const config = {
    rssFeeds: [{ ticker: "", url: "https://fake.test/feed.xml" }],
    edgarUserAgent: EDGAR_UA, edgarTickerCikUrl: TICKER_URL, entityResolutionUseNameIndex: true,
  };
  t.mock.method(global, "fetch", async (url) => {
    if (String(url).includes("company_tickers")) return { ok: true, status: 200, json: async () => mockDirectoryJson() };
    return { ok: true, status: 200, text: async () => rssXmlWithTitle("Apple supplier ramps production") };
  });

  const items = await fetchRssLatest(config);
  assert.deepEqual(items[0].tickers, ["AAPL"]);
});

// ---------------------------------------------------------------------------
// html_scrape.js#fetchLatest
// ---------------------------------------------------------------------------

function pageHtmlWithTitle(title) {
  return `<html><head><title>${title}</title></head><body>Some article text.</body></html>`;
}

test("html_scrape.fetchLatest never fetches SEC's ticker file by default", async (t) => {
  const config = { scrapePages: [{ ticker: "", url: "https://fake.test/page" }] };
  const fetchedUrls = [];
  t.mock.method(global, "fetch", async (url) => { fetchedUrls.push(String(url)); return { ok: true, status: 200, text: async () => pageHtmlWithTitle("Microsoft news") }; });

  const { items, errors } = await fetchScrapeLatest(config);
  assert.equal(errors.length, 0);
  assert.deepEqual(items[0].tickers, []);
  assert.equal(fetchedUrls.length, 1);
});

test("html_scrape.fetchLatest resolves tickers via the name index when enabled", async (t) => {
  const config = {
    scrapePages: [{ ticker: "", url: "https://fake.test/page" }],
    edgarUserAgent: EDGAR_UA, edgarTickerCikUrl: TICKER_URL, entityResolutionUseNameIndex: true,
  };
  t.mock.method(global, "fetch", async (url) => {
    if (String(url).includes("company_tickers")) return { ok: true, status: 200, json: async () => mockDirectoryJson() };
    return { ok: true, status: 200, text: async () => pageHtmlWithTitle("NVIDIA unveils next-gen GPU") };
  });

  const { items, errors } = await fetchScrapeLatest(config);
  assert.equal(errors.length, 0);
  assert.deepEqual(items[0].tickers, ["NVDA"]);
});

// ---------------------------------------------------------------------------
// graph/pipeline.js#collectNewsItems -- kv threading
// ---------------------------------------------------------------------------

test("collectNewsItems threads kv through to gdelt/rss/scrape so a warm name-index cache is shared across all three (no re-fetch of SEC's file)", async (t) => {
  const kv = fakeKv();
  await kv.put("entity:company-name-index:v1", JSON.stringify([{ name: "microsoft", ticker: "MSFT" }]));
  const config = {
    watchlist: [{ ticker: "AAPL", query: "AAPL" }],
    gdeltApiBase: "https://fake.test/gdelt", gdeltMode: "ArtList", gdeltFormat: "json", gdeltSort: "DateDesc", gdeltMaxRecords: 50,
    gdeltFetchFullText: false, // this test is scoped to kv/name-index caching, not full-text enrichment -- leaving the default (true) on would fetch the mocked article's own URL as an extra request, which the fetch mock below can't distinguish from a SEC company_tickers.json fetch
    rssFeeds: [{ ticker: "", url: "https://fake.test/feed.xml" }],
    scrapePages: [],
    entityResolutionUseNameIndex: true,
  };
  let secFetches = 0;
  t.mock.method(global, "fetch", async (url) => {
    if (String(url).includes("gdelt")) return { ok: true, status: 200, json: async () => ({ articles: [{ url: "https://x.example.com/a", seendate: "20260915T143000Z", title: "Microsoft earnings beat", domain: "x.example.com" }] }) };
    if (String(url).includes("feed.xml")) return { ok: true, status: 200, text: async () => rssXmlWithTitle("Microsoft cloud growth") };
    secFetches++;
    return { ok: true, status: 200, json: async () => ({}) };
  });

  const items = await collectNewsItems(config, kv);
  assert.equal(secFetches, 0); // both sources hit the shared kv cache, never re-fetch SEC's file

  const gdeltItem = items.find((i) => i.source === "gdelt");
  const rssItem = items.find((i) => i.source.startsWith("rss:"));
  assert.ok(gdeltItem.tickers.includes("MSFT"));
  assert.ok(rssItem.tickers.includes("MSFT"));
});

test("collectNewsItems works with no kv argument at all (every pre-existing call site) -- name index just misses cache when enabled, doesn't break", async (t) => {
  const config = {
    watchlist: [{ ticker: "AAPL", query: "AAPL" }],
    gdeltApiBase: "https://fake.test/gdelt", gdeltMode: "ArtList", gdeltFormat: "json", gdeltSort: "DateDesc", gdeltMaxRecords: 50,
    rssFeeds: [],
    scrapePages: [],
    // entityResolutionUseNameIndex left unset -- this is also the default,
    // no-kv path every existing caller before this session already used.
  };
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, json: async () => ({ articles: [] }) }));

  const items = await collectNewsItems(config);
  assert.deepEqual(items, []);
});
