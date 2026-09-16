// jsonify_adapters test (plan.md open item: "jsonify" adapters for
// non-JSON sources). Covers jsonify.js's pure parsing/stripping helpers
// directly, plus rss.js and html_scrape.js's response handling against a
// mocked fetch -- same convention as price_bars_pointintime.test.js's
// fetchDailyBars tests: verify parsing/error-handling logic without hitting
// a real feed/page over the network.

import test from "node:test";
import assert from "node:assert/strict";
import { parseFeedItems, stripHtml, extractPageTitle, decodeEntities } from "../src/ingestion/jsonify.js";
import { fetchLatest as fetchRss } from "../src/ingestion/sources/rss.js";
import { fetchArticle, fetchLatest as fetchScraped } from "../src/ingestion/sources/html_scrape.js";
import { VendorError } from "../src/shared/errors.js";

// ---------------------------------------------------------------------------
// jsonify.js pure helpers
// ---------------------------------------------------------------------------

test("decodeEntities handles named, decimal, and hex entities", () => {
  assert.equal(decodeEntities("Bull &amp; Bear &mdash; up &#38; down &#x26; sideways"), "Bull & Bear \u2014 up & down & sideways");
});

test("decodeEntities leaves unknown named entities untouched", () => {
  assert.equal(decodeEntities("&madeupentity;"), "&madeupentity;");
});

test("parseFeedItems parses standard RSS 2.0 items, including CDATA", () => {
  const xml = `<?xml version="1.0"?>
    <rss><channel>
      <item>
        <title><![CDATA[Acme Corp beats earnings]]></title>
        <link>https://news.example.com/acme-earnings</link>
        <pubDate>Tue, 15 Sep 2026 14:30:00 GMT</pubDate>
        <description><![CDATA[<p>Acme reported Q3 EPS of $1.20.</p>]]></description>
      </item>
      <item>
        <title>Second Story</title>
        <link>https://news.example.com/second</link>
        <pubDate>Tue, 15 Sep 2026 15:00:00 GMT</pubDate>
        <description>Plain text summary, no HTML.</description>
      </item>
    </channel></rss>`;

  const entries = parseFeedItems(xml);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].title, "Acme Corp beats earnings");
  assert.equal(entries[0].link, "https://news.example.com/acme-earnings");
  assert.equal(entries[0].publishedAt, "Tue, 15 Sep 2026 14:30:00 GMT");
  assert.match(entries[0].summary, /Acme reported Q3 EPS/);
  assert.equal(entries[1].title, "Second Story");
});

test("parseFeedItems parses Atom entries when no RSS items are present", () => {
  const xml = `<?xml version="1.0"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <title>Atom Story</title>
        <link href="https://news.example.com/atom-story" rel="alternate"/>
        <published>2026-09-15T10:00:00Z</published>
        <summary>An atom feed summary.</summary>
      </entry>
    </feed>`;

  const entries = parseFeedItems(xml);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].title, "Atom Story");
  assert.equal(entries[0].link, "https://news.example.com/atom-story");
  assert.equal(entries[0].publishedAt, "2026-09-15T10:00:00Z");
});

test("parseFeedItems returns an empty list for malformed/empty XML rather than throwing", () => {
  assert.deepEqual(parseFeedItems("<not-a-feed>garbage</not-a-feed>"), []);
  assert.deepEqual(parseFeedItems(""), []);
});

test("stripHtml removes script/style/nav content entirely and keeps body text", () => {
  const html = `<html><head><style>.x{color:red}</style></head><body>
    <nav>Home | About | Contact</nav>
    <script>trackPageview();</script>
    <h1>Headline Here</h1>
    <p>First paragraph of the article.</p>
    <p>Second paragraph &amp; more.</p>
    <footer>Copyright 2026</footer>
  </body></html>`;

  const text = stripHtml(html);
  assert.ok(!text.includes("trackPageview"));
  assert.ok(!text.includes("color:red"));
  assert.ok(!text.includes("Home | About"));
  assert.ok(!text.includes("Copyright 2026"));
  assert.ok(text.includes("Headline Here"));
  assert.ok(text.includes("First paragraph of the article."));
  assert.ok(text.includes("Second paragraph & more."));
});

test("stripHtml returns an empty string for empty/null input", () => {
  assert.equal(stripHtml(""), "");
  assert.equal(stripHtml(null), "");
});

test("extractPageTitle prefers og:title over <title>", () => {
  const html = `<html><head>
    <meta property="og:title" content="Clean Article Title">
    <title>Clean Article Title - Example News - Latest Headlines</title>
  </head><body></body></html>`;
  assert.equal(extractPageTitle(html), "Clean Article Title");
});

test("extractPageTitle falls back to <title> when there's no og:title", () => {
  const html = `<html><head><title>Fallback Title</title></head><body></body></html>`;
  assert.equal(extractPageTitle(html), "Fallback Title");
});

// ---------------------------------------------------------------------------
// rss.js (mocked fetch)
// ---------------------------------------------------------------------------

const RSS_XML = `<?xml version="1.0"?>
  <rss><channel>
    <item>
      <title>Acme Corp beats earnings</title>
      <link>https://news.example.com/acme-earnings</link>
      <pubDate>Tue, 15 Sep 2026 14:30:00 GMT</pubDate>
      <description><![CDATA[<p>Acme reported strong Q3 results.</p>]]></description>
    </item>
    <item>
      <title>Undated story, should be skipped</title>
      <link>https://news.example.com/no-date</link>
      <description>No pubDate at all.</description>
    </item>
  </channel></rss>`;

test("rss.fetchLatest parses a feed into normalized items, skipping entries with no usable date", async (t) => {
  const config = { rssFeeds: [{ ticker: "ACME", url: "https://feeds.example.com/acme.xml" }] };
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, text: async () => RSS_XML }));

  const items = await fetchRss(config);
  assert.equal(items.length, 1); // the undated second item is skipped
  assert.equal(items[0].title, "Acme Corp beats earnings");
  assert.equal(items[0].url, "https://news.example.com/acme-earnings");
  assert.equal(items[0].source, "rss:feeds.example.com");
  assert.ok(items[0].tickers.includes("ACME"));
  assert.match(items[0].body, /Acme reported strong Q3 results\./);
  assert.ok(!items[0].body.includes("<p>")); // HTML stripped from the description
});

test("rss.fetchLatest throws a transient VendorError on HTTP 429", async (t) => {
  const config = { rssFeeds: [{ ticker: "ACME", url: "https://feeds.example.com/acme.xml" }] };
  t.mock.method(global, "fetch", async () => ({ ok: false, status: 429 }));

  await assert.rejects(() => fetchRss(config), (err) => {
    assert.ok(err instanceof VendorError);
    assert.equal(err.transient, true);
    return true;
  });
});

test("rss.fetchLatest throws a non-transient VendorError on a network failure vs. HTTP error distinctly", async (t) => {
  const config = { rssFeeds: [{ ticker: "ACME", url: "https://feeds.example.com/acme.xml" }] };
  t.mock.method(global, "fetch", async () => { throw new Error("ECONNRESET"); });

  await assert.rejects(() => fetchRss(config), (err) => {
    assert.ok(err instanceof VendorError);
    assert.equal(err.transient, true); // network-level failures are treated as transient, same as gdelt.js
    return true;
  });
});

// ---------------------------------------------------------------------------
// html_scrape.js (mocked fetch)
// ---------------------------------------------------------------------------

function pageHtml({ withPublishedMeta = true } = {}) {
  const metaTag = withPublishedMeta ? `<meta property="article:published_time" content="2026-09-15T12:00:00Z">` : "";
  return `<html><head>
      <meta property="og:title" content="Widget Co Announces New Product">
      ${metaTag}
    </head><body>
      <nav>Site Nav</nav>
      <article><p>Widget Co unveiled a new product today.</p></article>
    </body></html>`;
}

test("fetchArticle extracts title, real published time, and stripped body", async (t) => {
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, text: async () => pageHtml() }));

  const item = await fetchArticle({}, { url: "https://widgetnews.example.com/story", tickerHint: "WDGT" });
  assert.equal(item.title, "Widget Co Announces New Product");
  assert.equal(item.publishedAt, "2026-09-15T12:00:00.000Z");
  assert.equal(item.raw.publishedAtIsFetchTime, false);
  assert.ok(item.tickers.includes("WDGT"));
  assert.match(item.body, /Widget Co unveiled a new product today\./);
  assert.ok(!item.body.includes("Site Nav"));
});

test("fetchArticle falls back to fetch time and flags it when no published-time meta tag exists", async (t) => {
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, text: async () => pageHtml({ withPublishedMeta: false }) }));

  const before = Date.now();
  const item = await fetchArticle({}, { url: "https://widgetnews.example.com/story2" });
  assert.equal(item.raw.publishedAtIsFetchTime, true);
  assert.ok(new Date(item.publishedAt).getTime() >= before);
});

test("fetchArticle throws a VendorError when no title/og:title can be found", async (t) => {
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, text: async () => "<html><body>No title here</body></html>" }));

  await assert.rejects(() => fetchArticle({}, { url: "https://widgetnews.example.com/no-title" }), VendorError);
});

test("html_scrape.fetchLatest tolerates one bad page and still returns the good ones", async (t) => {
  const pages = [
    { ticker: "GOOD", url: "https://a.example.com/good" },
    { ticker: "BAD", url: "https://b.example.com/bad" },
  ];
  let call = 0;
  t.mock.method(global, "fetch", async (url) => {
    call += 1;
    if (String(url).includes("bad")) return { ok: false, status: 404 };
    return { ok: true, status: 200, text: async () => pageHtml() };
  });

  const { items, errors } = await fetchScraped({}, { pages });
  assert.equal(call, 2);
  assert.equal(items.length, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].url, "https://b.example.com/bad");
  assert.ok(errors[0].error instanceof VendorError);
});
