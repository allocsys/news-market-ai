// edgar_cik_lookup.test.js -- covers edgar_cik_lookup.js (fetchTickerCikMap,
// getTickerCikMap's KV cache-aside behavior, resolveCik's override-then-live
// precedence) plus edgar_fundamentals.js#fetchLatest's new wiring of it:
// the watchlist fallback when edgarCikMap is empty, and skip-not-throw for
// a ticker that resolves to no CIK anywhere. See plan.md's "real ticker->CIK
// lookup" next-step note this closes, and edgar_cik_lookup.js's own header
// for the live-verify caveat (SEC's real file is unreachable from this
// sandbox, so everything here is against mocked fetch, same as EDGAR's
// other adapters).

import test from "node:test";
import assert from "node:assert/strict";
import { VendorError } from "../src/shared/errors.js";
import { fetchTickerCikMap, fetchTickerDirectory, getTickerCikMap, resolveCik } from "../src/ingestion/sources/edgar_cik_lookup.js";
import { fetchLatest as fetchEdgarLatest } from "../src/ingestion/sources/edgar_fundamentals.js";

const BASE_CONFIG = {
  edgarUserAgent: "test-suite contact@example.com",
  edgarTickerCikUrl: "https://fake.test/company_tickers.json",
  edgarApiBase: "https://fake.test/companyfacts",
};

function mockSecTickerJson() {
  // SEC's real shape: an object keyed by arbitrary numeric strings, NOT an
  // array and NOT keyed by ticker -- see edgar_cik_lookup.js header.
  return {
    "0": { cik_str: 320193, ticker: "aapl", title: "Apple Inc." }, // lowercase on purpose -- must be uppercased
    "1": { cik_str: 789019, ticker: "MSFT", title: "MICROSOFT CORP" },
    "2": { cik_str: 0, ticker: "", title: "malformed entry -- no ticker, should be skipped" },
  };
}

function mockCompanyFactsJson() {
  return { facts: { "us-gaap": { Revenues: { units: { USD: [{ fy: 2026, fp: "Q2", form: "10-Q", filed: "2026-07-25", val: 1, end: "2026-06-30" }] } } } } };
}

/** In-memory fake KV -- matches the same get/put(key, value, {expirationTtl}) shape shared/cooldown.js's real Cloudflare KV binding exposes. */
function fakeKv() {
  const store = new Map();
  return {
    store,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

// ---------------------------------------------------------------------------
// fetchTickerCikMap
// ---------------------------------------------------------------------------

test("fetchTickerCikMap throws a non-transient VendorError when edgarUserAgent is not configured", async () => {
  await assert.rejects(() => fetchTickerCikMap({ ...BASE_CONFIG, edgarUserAgent: "" }), (err) => {
    assert.ok(err instanceof VendorError);
    assert.equal(err.transient, false);
    return true;
  });
});

test("fetchTickerCikMap parses SEC's numeric-keyed shape into an uppercased ticker -> zero-padded CIK map, skipping malformed entries", async (t) => {
  let capturedUrl, capturedHeaders;
  t.mock.method(global, "fetch", async (url, opts) => {
    capturedUrl = url;
    capturedHeaders = opts.headers;
    return { ok: true, status: 200, json: async () => mockSecTickerJson() };
  });

  const map = await fetchTickerCikMap(BASE_CONFIG);
  assert.equal(capturedUrl, BASE_CONFIG.edgarTickerCikUrl);
  assert.equal(capturedHeaders["User-Agent"], BASE_CONFIG.edgarUserAgent);
  assert.deepEqual(map, { AAPL: "0000320193", MSFT: "0000789019" }); // malformed 3rd entry skipped, AAPL uppercased
});

test("fetchTickerCikMap throws a transient VendorError on a network failure", async (t) => {
  t.mock.method(global, "fetch", async () => {
    throw new Error("connection reset");
  });
  await assert.rejects(() => fetchTickerCikMap(BASE_CONFIG), (err) => {
    assert.ok(err instanceof VendorError);
    assert.equal(err.transient, true);
    return true;
  });
});

test("fetchTickerCikMap throws a transient VendorError on a 503, non-transient on a 404", async (t) => {
  t.mock.method(global, "fetch", async () => ({ ok: false, status: 503 }));
  await assert.rejects(() => fetchTickerCikMap(BASE_CONFIG), (err) => {
    assert.equal(err.transient, true);
    return true;
  });

  t.mock.method(global, "fetch", async () => ({ ok: false, status: 404 }));
  await assert.rejects(() => fetchTickerCikMap(BASE_CONFIG), (err) => {
    assert.equal(err.transient, false);
    return true;
  });
});

// ---------------------------------------------------------------------------
// fetchTickerDirectory
// ---------------------------------------------------------------------------

test("fetchTickerDirectory parses SEC's shape into an uppercased ticker -> {cik, title} directory, skipping malformed entries", async (t) => {
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, json: async () => mockSecTickerJson() }));

  const directory = await fetchTickerDirectory(BASE_CONFIG);
  assert.deepEqual(directory, {
    AAPL: { cik: "0000320193", title: "Apple Inc." },
    MSFT: { cik: "0000789019", title: "MICROSOFT CORP" },
  });
});

test("fetchTickerDirectory throws the same VendorError conditions as fetchTickerCikMap (shared fetch helper)", async (t) => {
  await assert.rejects(() => fetchTickerDirectory({ ...BASE_CONFIG, edgarUserAgent: "" }), (err) => {
    assert.ok(err instanceof VendorError);
    assert.equal(err.transient, false);
    return true;
  });

  t.mock.method(global, "fetch", async () => ({ ok: false, status: 503 }));
  await assert.rejects(() => fetchTickerDirectory(BASE_CONFIG), (err) => {
    assert.ok(err instanceof VendorError);
    assert.equal(err.transient, true);
    return true;
  });
});

test("fetchTickerDirectory and fetchTickerCikMap agree on the CIK half of the same underlying data", async (t) => {
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, json: async () => mockSecTickerJson() }));

  const directory = await fetchTickerDirectory(BASE_CONFIG);
  const cikMap = await fetchTickerCikMap(BASE_CONFIG);
  for (const [ticker, cik] of Object.entries(cikMap)) {
    assert.equal(directory[ticker].cik, cik);
  }
});

// ---------------------------------------------------------------------------
// getTickerCikMap (KV cache-aside)
// ---------------------------------------------------------------------------

test("getTickerCikMap fetches live and does not touch kv when kv is not provided", async (t) => {
  let fetchCalls = 0;
  t.mock.method(global, "fetch", async () => {
    fetchCalls++;
    return { ok: true, status: 200, json: async () => mockSecTickerJson() };
  });

  const map = await getTickerCikMap(BASE_CONFIG, undefined);
  assert.deepEqual(map, { AAPL: "0000320193", MSFT: "0000789019" });
  assert.equal(fetchCalls, 1);
});

test("getTickerCikMap returns a cache hit without calling fetch", async (t) => {
  const kv = fakeKv();
  await kv.put("edgar:ticker-cik-map:v1", JSON.stringify({ AAPL: "0000320193" }));
  let fetchCalled = false;
  t.mock.method(global, "fetch", async () => {
    fetchCalled = true;
    return { ok: true, status: 200, json: async () => mockSecTickerJson() };
  });

  const map = await getTickerCikMap(BASE_CONFIG, kv);
  assert.deepEqual(map, { AAPL: "0000320193" });
  assert.equal(fetchCalled, false);
});

test("getTickerCikMap on a cache miss fetches live and writes the result to kv with the configured TTL", async (t) => {
  const kv = fakeKv();
  let fetchCalls = 0;
  t.mock.method(global, "fetch", async () => {
    fetchCalls++;
    return { ok: true, status: 200, json: async () => mockSecTickerJson() };
  });

  const config = { ...BASE_CONFIG, edgarCikCacheTtlSeconds: 3600 };
  const map = await getTickerCikMap(config, kv);
  assert.equal(fetchCalls, 1);
  assert.deepEqual(map, { AAPL: "0000320193", MSFT: "0000789019" });
  assert.deepEqual(JSON.parse(kv.store.get("edgar:ticker-cik-map:v1")), map);
});

test("getTickerCikMap fails open on a kv.get failure (falls through to live fetch, still succeeds, still attempts to write the fresh value)", async (t) => {
  const kv = {
    get: async () => {
      throw new Error("kv unreachable");
    },
    put: async (key, value) => {
      kv.written = { key, value };
    },
  };
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, json: async () => mockSecTickerJson() }));

  const map = await getTickerCikMap(BASE_CONFIG, kv);
  assert.deepEqual(map, { AAPL: "0000320193", MSFT: "0000789019" });
  assert.ok(kv.written); // read failure didn't stop the write attempt
});

test("getTickerCikMap fails open on a kv.put failure (still returns the live-fetched map)", async (t) => {
  const kv = {
    get: async () => null,
    put: async () => {
      throw new Error("kv unreachable");
    },
  };
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, json: async () => mockSecTickerJson() }));

  const map = await getTickerCikMap(BASE_CONFIG, kv);
  assert.deepEqual(map, { AAPL: "0000320193", MSFT: "0000789019" });
});

// ---------------------------------------------------------------------------
// resolveCik
// ---------------------------------------------------------------------------

test("resolveCik returns the edgarCikMap override, normalized, without ever touching kv or fetch", async (t) => {
  let fetchCalled = false;
  t.mock.method(global, "fetch", async () => {
    fetchCalled = true;
    return { ok: true, status: 200, json: async () => mockSecTickerJson() };
  });
  const kv = { get: async () => { fetchCalled = true; }, put: async () => {} };

  const config = { ...BASE_CONFIG, edgarCikMap: { AAPL: "320193" } };
  const cik = await resolveCik(config, kv, "AAPL");
  assert.equal(cik, "0000320193");
  assert.equal(fetchCalled, false); // override short-circuits everything else
});

test("resolveCik falls back to the live/cached SEC map when there's no override for this ticker", async (t) => {
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, json: async () => mockSecTickerJson() }));
  const config = { ...BASE_CONFIG, edgarCikMap: { TSLA: "1318605" } }; // override exists, but not for AAPL

  const cik = await resolveCik(config, undefined, "AAPL");
  assert.equal(cik, "0000320193");
});

test("resolveCik returns null (does not throw) when the ticker is in neither edgarCikMap nor the live SEC map", async (t) => {
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, json: async () => mockSecTickerJson() }));
  const config = { ...BASE_CONFIG, edgarCikMap: {} };

  const cik = await resolveCik(config, undefined, "NOTAREALTICKER");
  assert.equal(cik, null);
});

// ---------------------------------------------------------------------------
// edgar_fundamentals.js#fetchLatest -- CIK-resolution wiring
// ---------------------------------------------------------------------------

/** Routes the shared global.fetch mock to the right mock JSON by URL, since fetchLatest hits both the SEC ticker-map URL and the per-ticker companyfacts URL in the same run. */
function routedFetch(t) {
  t.mock.method(global, "fetch", async (url) => {
    if (url === BASE_CONFIG.edgarTickerCikUrl) {
      return { ok: true, status: 200, json: async () => mockSecTickerJson() };
    }
    return { ok: true, status: 200, json: async () => mockCompanyFactsJson() };
  });
}

test("fetchLatest falls back to config.watchlist's tickers, resolved live against SEC, when edgarCikMap is empty", async (t) => {
  routedFetch(t);
  const config = { ...BASE_CONFIG, edgarCikMap: {}, watchlist: [{ ticker: "AAPL", query: "AAPL" }, { ticker: "MSFT", query: "MSFT" }] };

  const facts = await fetchEdgarLatest(config, { tags: ["Revenues"] }, {});
  assert.equal(facts.length, 2); // one Revenues fact per resolved ticker
  assert.deepEqual(new Set(facts.map((f) => f.ticker)), new Set(["AAPL", "MSFT"]));
  assert.equal(facts.find((f) => f.ticker === "AAPL").cik, "0000320193");
});

test("fetchLatest skips (logs, does not throw) a watchlist ticker that resolves to no CIK anywhere, and still processes the others", async (t) => {
  routedFetch(t);
  const warnLogs = [];
  t.mock.method(console, "warn", (...args) => warnLogs.push(args));
  const config = { ...BASE_CONFIG, edgarCikMap: {}, watchlist: [{ ticker: "AAPL" }, { ticker: "NOTAREALTICKER" }] };

  const facts = await fetchEdgarLatest(config, { tags: ["Revenues"] }, {});
  assert.equal(facts.length, 1);
  assert.equal(facts[0].ticker, "AAPL");
  assert.ok(warnLogs.some(([msg, detail]) => msg.includes("skipping ticker") && detail.ticker === "NOTAREALTICKER"));
});

test("fetchLatest is still a no-op (count 0, no fetch call) when both edgarCikMap and watchlist are empty", async (t) => {
  let fetchCalled = false;
  t.mock.method(global, "fetch", async () => {
    fetchCalled = true;
    return { ok: true, status: 200, json: async () => mockCompanyFactsJson() };
  });
  const config = { ...BASE_CONFIG, edgarCikMap: {}, watchlist: [] };

  const facts = await fetchEdgarLatest(config, { tags: ["Revenues"] }, {});
  assert.deepEqual(facts, []);
  assert.equal(fetchCalled, false);
});

test("fetchLatest passes a kv through to resolveCik so repeated tickers across a run share the SEC lookup cache", async (t) => {
  const kv = fakeKv();
  let tickerMapFetches = 0;
  t.mock.method(global, "fetch", async (url) => {
    if (url === BASE_CONFIG.edgarTickerCikUrl) {
      tickerMapFetches++;
      return { ok: true, status: 200, json: async () => mockSecTickerJson() };
    }
    return { ok: true, status: 200, json: async () => mockCompanyFactsJson() };
  });
  const config = { ...BASE_CONFIG, edgarCikMap: {}, watchlist: [{ ticker: "AAPL" }, { ticker: "MSFT" }] };

  await fetchEdgarLatest(config, { tags: ["Revenues"] }, { kv });
  // Both tickers miss cache on the very first lookup (empty kv going in), so
  // the SEC file itself should only be fetched once (AAPL's miss populates
  // the cache; MSFT's lookup then hits it) -- proves the cache is actually
  // being read, not just written to.
  assert.equal(tickerMapFetches, 1);
});
