// entity_resolution.test.js -- covers the real SEC-backed name matching
// added this session (normalizeCompanyName, buildCompanyNameIndex,
// matchTickersByName, getCompanyNameIndex's KV cache-aside/fails-open
// behavior) plus resolveTickers's backward compatibility: every existing
// caller that doesn't pass `nameIndex` must behave EXACTLY as before this
// session (hintTicker + COMPANY_DOMAIN_MAP only). See plan.md's "real
// entity resolution coverage" next-step note this closes.

import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCompanyName,
  buildCompanyNameIndex,
  matchTickersByName,
  getCompanyNameIndex,
  resolveTickers,
} from "../src/ingestion/entity_resolution.js";

const BASE_CONFIG = {
  edgarUserAgent: "test-suite contact@example.com",
  edgarTickerCikUrl: "https://fake.test/company_tickers.json",
};

function mockDirectoryJson() {
  // Same SEC shape edgar_cik_lookup.test.js mocks: object keyed by
  // arbitrary numeric strings, NOT an array, each value {cik_str, ticker, title}.
  return {
    "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." },
    "1": { cik_str: 789019, ticker: "MSFT", title: "MICROSOFT CORPORATION" },
    "2": { cik_str: 1045810, ticker: "NVDA", title: "NVIDIA Corp" },
    "3": { cik_str: 0, ticker: "GE", title: "GE" }, // 2-char title, must be filtered as too short
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
// normalizeCompanyName
// ---------------------------------------------------------------------------

test("normalizeCompanyName lowercases and strips exactly one trailing legal suffix", () => {
  assert.equal(normalizeCompanyName("Apple Inc."), "apple");
  assert.equal(normalizeCompanyName("MICROSOFT CORPORATION"), "microsoft");
  assert.equal(normalizeCompanyName("NVIDIA Corp"), "nvidia");
  assert.equal(normalizeCompanyName("Alphabet Inc."), "alphabet");
});

test("normalizeCompanyName only strips ONE suffix, not repeatedly, so a two-word legal name doesn't get stripped to nothing", () => {
  assert.equal(normalizeCompanyName("Example Holdings Inc"), "example holdings");
});

test("normalizeCompanyName handles empty/missing input", () => {
  assert.equal(normalizeCompanyName(""), "");
  assert.equal(normalizeCompanyName(undefined), "");
  assert.equal(normalizeCompanyName(null), "");
});

// ---------------------------------------------------------------------------
// buildCompanyNameIndex
// ---------------------------------------------------------------------------

test("buildCompanyNameIndex normalizes titles, filters names under 4 chars, and sorts longest-first", () => {
  const directory = {
    AAPL: { cik: "0000320193", title: "Apple Inc." },
    MSFT: { cik: "0000789019", title: "MICROSOFT CORPORATION" },
    GE: { cik: "0000000001", title: "GE" }, // too short, filtered
  };
  const index = buildCompanyNameIndex(directory);
  assert.deepEqual(index.map((e) => e.name), ["microsoft", "apple"]);
  assert.deepEqual(index.map((e) => e.ticker), ["MSFT", "AAPL"]);
});

test("buildCompanyNameIndex dedupes when two tickers normalize to the same name, keeping the first seen", () => {
  const directory = {
    AAA: { cik: "1", title: "Example Inc." },
    BBB: { cik: "2", title: "Example Corp" }, // both normalize to "example"
  };
  const index = buildCompanyNameIndex(directory);
  assert.equal(index.length, 1);
  assert.equal(index[0].ticker, "AAA");
});

test("buildCompanyNameIndex handles an empty/missing directory", () => {
  assert.deepEqual(buildCompanyNameIndex({}), []);
  assert.deepEqual(buildCompanyNameIndex(undefined), []);
});

// ---------------------------------------------------------------------------
// matchTickersByName
// ---------------------------------------------------------------------------

const SAMPLE_INDEX = buildCompanyNameIndex({
  AAPL: { title: "Apple Inc." },
  MSFT: { title: "Microsoft Corporation" },
  NVDA: { title: "NVIDIA Corp" },
});

test("matchTickersByName matches a whole company name inside a headline", () => {
  assert.deepEqual(matchTickersByName("Apple suppliers rally on strong iPhone demand", SAMPLE_INDEX), ["AAPL"]);
});

test("matchTickersByName matches multiple companies mentioned in the same headline", () => {
  const result = matchTickersByName("Microsoft and NVIDIA announce new AI partnership", SAMPLE_INDEX);
  assert.deepEqual(new Set(result), new Set(["MSFT", "NVDA"]));
});

test("matchTickersByName does not match a name as a substring of an unrelated word (word-boundary check)", () => {
  // "apple" must not match inside "pineapple"
  assert.deepEqual(matchTickersByName("Pineapple exports rise this quarter", SAMPLE_INDEX), []);
});

test("matchTickersByName returns [] for no title, no index, or no match", () => {
  assert.deepEqual(matchTickersByName("", SAMPLE_INDEX), []);
  assert.deepEqual(matchTickersByName("Apple news", []), []);
  assert.deepEqual(matchTickersByName("Apple news", undefined), []);
  assert.deepEqual(matchTickersByName("Totally unrelated headline about weather", SAMPLE_INDEX), []);
});

test("matchTickersByName is case-insensitive", () => {
  assert.deepEqual(matchTickersByName("APPLE UNVEILS NEW PRODUCT", SAMPLE_INDEX), ["AAPL"]);
});

// ---------------------------------------------------------------------------
// getCompanyNameIndex (KV cache-aside, fails open)
// ---------------------------------------------------------------------------

test("getCompanyNameIndex fetches live and builds the index when kv is not provided", async (t) => {
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, json: async () => mockDirectoryJson() }));

  const index = await getCompanyNameIndex(BASE_CONFIG, undefined);
  assert.ok(index.some((e) => e.ticker === "AAPL" && e.name === "apple"));
  assert.ok(index.some((e) => e.ticker === "MSFT" && e.name === "microsoft"));
  assert.ok(!index.some((e) => e.ticker === "GE")); // 2-char title filtered
});

test("getCompanyNameIndex returns a cache hit without calling fetch", async (t) => {
  const kv = fakeKv();
  const cached = [{ name: "apple", ticker: "AAPL" }];
  await kv.put("entity:company-name-index:v1", JSON.stringify(cached));
  let fetchCalled = false;
  t.mock.method(global, "fetch", async () => { fetchCalled = true; return { ok: true, status: 200, json: async () => mockDirectoryJson() }; });

  const index = await getCompanyNameIndex(BASE_CONFIG, kv);
  assert.deepEqual(index, cached);
  assert.equal(fetchCalled, false);
});

test("getCompanyNameIndex on a cache miss fetches live, builds the index, and writes it to kv with the configured TTL", async (t) => {
  const kv = fakeKv();
  let fetchCalls = 0;
  t.mock.method(global, "fetch", async () => { fetchCalls++; return { ok: true, status: 200, json: async () => mockDirectoryJson() }; });

  const config = { ...BASE_CONFIG, edgarCikCacheTtlSeconds: 3600 };
  const index = await getCompanyNameIndex(config, kv);
  assert.equal(fetchCalls, 1);
  assert.ok(index.some((e) => e.ticker === "AAPL"));
  assert.deepEqual(JSON.parse(kv.store.get("entity:company-name-index:v1")), index);
});

test("getCompanyNameIndex fails open on a kv.get failure (falls through to a live fetch, still succeeds)", async (t) => {
  const kv = {
    get: async () => { throw new Error("kv unreachable"); },
    put: async () => {},
  };
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, json: async () => mockDirectoryJson() }));

  const index = await getCompanyNameIndex(BASE_CONFIG, kv);
  assert.ok(index.some((e) => e.ticker === "AAPL"));
});

test("getCompanyNameIndex fails open on a kv.put failure (still returns the live-built index)", async (t) => {
  const kv = { get: async () => null, put: async () => { throw new Error("kv unreachable"); } };
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, json: async () => mockDirectoryJson() }));

  const index = await getCompanyNameIndex(BASE_CONFIG, kv);
  assert.ok(index.some((e) => e.ticker === "AAPL"));
});

test("getCompanyNameIndex propagates a real error (e.g. missing edgarUserAgent) when there's no kv to fall back through", async (t) => {
  await assert.rejects(() => getCompanyNameIndex({ ...BASE_CONFIG, edgarUserAgent: "" }, undefined));
});

// ---------------------------------------------------------------------------
// resolveTickers -- backward compatibility + nameIndex merging
// ---------------------------------------------------------------------------

test("resolveTickers with no nameIndex behaves exactly as before this session (hintTicker + COMPANY_DOMAIN_MAP only)", () => {
  assert.deepEqual(resolveTickers({ title: "Apple unveils new product", domain: "apple.com", hintTicker: "MSFT" }), ["MSFT", "AAPL"]);
  assert.deepEqual(resolveTickers({ title: "Some story", domain: "unknown.com", hintTicker: "TSLA" }), ["TSLA"]);
  assert.deepEqual(resolveTickers(), []);
});

test("resolveTickers merges hintTicker, domain map, and nameIndex matches, deduped", () => {
  const result = resolveTickers({
    title: "Microsoft and NVIDIA unveil new AI chips",
    domain: "unknown.com",
    hintTicker: "MSFT", // already present via nameIndex too -- must not duplicate
    nameIndex: SAMPLE_INDEX,
  });
  assert.deepEqual(new Set(result), new Set(["MSFT", "NVDA"]));
});

test("resolveTickers ignores nameIndex when it's an empty array (the opt-in-disabled default every adapter passes)", () => {
  assert.deepEqual(resolveTickers({ title: "Apple news", domain: "unknown.com", hintTicker: "TSLA", nameIndex: [] }), ["TSLA"]);
});
