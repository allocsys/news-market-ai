// What counts as "new" for the ingest Worker, proven on the real inputs schema
// (test/helpers/sqlite_d1.js runs migrations/inputs/0001_init.sql), not a
// hand-written fake -- the point is that D1's `meta.changes` really is 0 for an
// `ON CONFLICT DO NOTHING` that hit a conflict, which is what insertNewsItem's
// return value is built on. (SqliteD1 mirrors D1's result shape; the live
// numbers are additionally visible in the `ingest_ticker job completed` log:
// `fetched` vs `freshItems`.)

import test from "node:test";
import assert from "node:assert/strict";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { INPUTS_DIR } from "./helpers/engine_ctx.js";
import { insertNewsItem } from "../src/storage/inputs_view.js";
import { ingestTickerData, ingestFeedNews } from "../src/ingestion/ingest.js";

const item = (overrides = {}) => ({
  id: "item-1",
  source: "test",
  url: "https://example.test/1",
  publishedAt: "2026-09-18T10:00:00.000Z",
  ingestedAt: "2026-09-18T10:05:00.000Z",
  title: "headline",
  body: "body",
  raw: null,
  tickers: ["AAPL"],
  ...overrides,
});

async function count(db, table) {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first();
  return row.n;
}

// ---------------------------------------------------------------------------
// insertNewsItem
// ---------------------------------------------------------------------------

test("insertNewsItem reports a brand-new item and all of its tickers as new", async () => {
  const db = createTestD1([INPUTS_DIR]);
  const result = await insertNewsItem(db, item({ tickers: ["AAPL", "MSFT"] }));
  assert.deepEqual(result, { inserted: true, newTickers: ["AAPL", "MSFT"] });
});

test("insertNewsItem reports nothing new when the identical item is inserted again", async () => {
  const db = createTestD1([INPUTS_DIR]);
  await insertNewsItem(db, item({ tickers: ["AAPL", "MSFT"] }));
  const again = await insertNewsItem(db, item({ tickers: ["AAPL", "MSFT"] }));
  assert.deepEqual(again, { inserted: false, newTickers: [] });
  assert.equal(await count(db, "news_items"), 1);
  assert.equal(await count(db, "news_item_tickers"), 2);
});

test("insertNewsItem reports only the added ticker when a stored item shows up under another ticker", async () => {
  const db = createTestD1([INPUTS_DIR]);
  await insertNewsItem(db, item({ tickers: ["AAPL"] }));
  const other = await insertNewsItem(db, item({ tickers: ["MSFT"] }));
  assert.deepEqual(other, { inserted: false, newTickers: ["MSFT"] });
  assert.equal(await count(db, "news_items"), 1);
});

test("insertNewsItem lists a ticker once even if the item carries it twice", async () => {
  const db = createTestD1([INPUTS_DIR]);
  const result = await insertNewsItem(db, item({ tickers: ["AAPL", "AAPL"] }));
  assert.deepEqual(result, { inserted: true, newTickers: ["AAPL"] });
});

// ---------------------------------------------------------------------------
// ingestTickerData / ingestFeedNews (Finnhub / RSS mocked at fetch, real SQL underneath)
// ---------------------------------------------------------------------------

function finnhubArticles(count, { offset = 0 } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    url: `https://finnhub.example.com/story-${offset + i}`,
    datetime: 1757941800 + offset + i,
    headline: `Story ${offset + i} about Acme`,
    summary: "A brief summary.",
  }));
}

const tickerConfig = {
  watchlist: [{ ticker: "AAPL", query: "AAPL" }, { ticker: "MSFT", query: "MSFT" }],
  finnhubApiBase: "https://fake.test/finnhub", finnhubApiKey: "test-key", finnhubLookbackDays: 3,
  retryMaxAttempts: 1,
  // yfinance/edgar calls get an empty object from the mocked fetch below; with
  // no edgarCikMap/User-Agent the fundamentals step is a no-op and yfinance
  // logs-and-skips, so neither touches the assertions here.
  edgarCikMap: {}, edgarUserAgent: "",
};

function mockFinnhub(t, articles) {
  t.mock.method(global, "fetch", async (url) => {
    if (String(url).includes("finnhub")) return { ok: true, status: 200, json: async () => articles() };
    return { ok: true, status: 200, json: async () => ({}) };
  });
  t.mock.method(console, "error", () => {}); // vendor skips (yfinance on an empty payload) are logged, not the subject here
}

test("ingestTickerData returns every item as fresh the first time and none when the same window is fetched again", async (t) => {
  const db = createTestD1([INPUTS_DIR]);
  mockFinnhub(t, () => finnhubArticles(163));

  const first = await ingestTickerData(tickerConfig, db, undefined, { ticker: "AAPL", asOf: "2026-09-18T00:00:00.000Z" });
  assert.equal(first.fetched, 163);
  assert.equal(first.fresh.length, 163);
  assert.ok(first.fresh.every((f) => f.tickers.length === 1 && f.tickers[0] === "AAPL"));

  const second = await ingestTickerData(tickerConfig, db, undefined, { ticker: "AAPL", asOf: "2026-09-18T00:00:00.000Z" });
  assert.equal(second.fetched, 163);
  assert.equal(second.fresh.length, 0);
  assert.equal(await count(db, "news_items"), 163);
});

test("ingestTickerData returns only the articles that entered the trailing window since the last tick", async (t) => {
  const db = createTestD1([INPUTS_DIR]);
  let articles = finnhubArticles(10);
  mockFinnhub(t, () => articles);
  const run = () => ingestTickerData(tickerConfig, db, undefined, { ticker: "AAPL", asOf: "2026-09-18T00:00:00.000Z" });

  await run();
  articles = finnhubArticles(10, { offset: 2 }); // window slid: 0-1 dropped out, 10-11 are new
  const slid = await run();
  assert.equal(slid.fetched, 10);
  assert.deepEqual(slid.fresh.map((f) => f.item.title).sort(), ["Story 10 about Acme", "Story 11 about Acme"]);
});

test("ingestTickerData treats an already-stored article as fresh for a ticker it has not been analyzed under yet", async (t) => {
  const db = createTestD1([INPUTS_DIR]);
  mockFinnhub(t, () => finnhubArticles(1));

  const aapl = await ingestTickerData(tickerConfig, db, undefined, { ticker: "AAPL", asOf: "2026-09-18T00:00:00.000Z" });
  const msft = await ingestTickerData(tickerConfig, db, undefined, { ticker: "MSFT", asOf: "2026-09-18T00:00:00.000Z" });
  const msftAgain = await ingestTickerData(tickerConfig, db, undefined, { ticker: "MSFT", asOf: "2026-09-18T00:00:00.000Z" });

  assert.equal(aapl.fresh.length, 1);
  assert.equal(msft.fresh.length, 1);
  assert.deepEqual(msft.fresh[0].tickers, ["MSFT"]);
  assert.equal(msftAgain.fresh.length, 0);
  assert.equal(await count(db, "news_items"), 1);
  assert.equal(await count(db, "news_item_tickers"), 2);
});

test("ingestFeedNews returns only the tickers that are new for each item", async (t) => {
  const db = createTestD1([INPUTS_DIR]);
  const feedXml = `<?xml version="1.0"?><rss><channel><item>
      <title>Story mentioning the ticker</title>
      <link>https://news.example.com/story</link>
      <pubDate>Tue, 15 Sep 2026 14:30:00 GMT</pubDate>
      <description>Body text.</description>
    </item></channel></rss>`;
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, text: async () => feedXml }));

  const feedsConfig = (feeds) => ({ watchlist: [], rssFeeds: feeds, scrapePages: [] });
  const aaplFeed = { ticker: "AAPL", url: "https://fake.test/feed.xml" };
  const msftFeed = { ticker: "MSFT", url: "https://fake.test/feed.xml" };

  const first = await ingestFeedNews(feedsConfig([aaplFeed]), db);
  assert.equal(first.fetched, 1);
  assert.deepEqual(first.fresh.map((f) => f.tickers), [["AAPL"]]);

  const repeat = await ingestFeedNews(feedsConfig([aaplFeed]), db);
  assert.equal(repeat.fetched, 1);
  assert.deepEqual(repeat.fresh, []);

  const gained = await ingestFeedNews(feedsConfig([aaplFeed, msftFeed]), db);
  assert.equal(gained.fetched, 2);
  assert.deepEqual(gained.fresh.map((f) => f.tickers), [["MSFT"]]);
});
