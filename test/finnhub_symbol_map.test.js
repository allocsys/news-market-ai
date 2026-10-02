// Finnhub /company-news serves company/ETF symbols only, so XAUUSD (spot gold)
// is requested under a proxy symbol (config.finnhubSymbolMap, default
// XAUUSD -> GLD) while articles stay tagged with the watchlist ticker.

import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { fetchLatest, createWindowedFetcher } from "../src/ingestion/sources/finnhub.js";

function makeConfig(overrides = {}) {
  return loadConfig({
    WATCHLIST_TICKERS: "AAPL,XAUUSD",
    FINNHUB_API_KEY: "test-key",
    ENTITY_RESOLUTION_USE_NAME_INDEX: "false",
    FINNHUB_MIN_REQUEST_INTERVAL_MS: "1",
    RETRY_MAX_ATTEMPTS: "1",
    ...overrides,
  });
}

/** Records every symbol requested and answers each with one distinct article. */
function mockFinnhub(t) {
  const symbols = [];
  t.mock.method(global, "fetch", async (url) => {
    const u = new URL(String(url));
    const symbol = u.searchParams.get("symbol");
    symbols.push(symbol);
    const body = [{ url: `https://finnhub.example.com/${symbol}/1`, datetime: Date.parse("2025-09-02T12:00:00Z") / 1000, headline: `Story one for ${symbol.toLowerCase()}`, summary: "" }];
    return { ok: true, status: 200, json: async () => body };
  });
  return symbols;
}

test("default map: XAUUSD is requested as GLD but tagged XAUUSD (fetchLatest)", async (t) => {
  const symbols = mockFinnhub(t);
  const { items, errors } = await fetchLatest(makeConfig(), {}, {});

  assert.deepEqual(errors, []);
  assert.deepEqual(symbols, ["AAPL", "GLD"], "other tickers are requested unchanged");
  const gold = items.find((i) => i.url.includes("/GLD/"));
  assert.ok(gold, "the GLD response became an item");
  assert.ok(gold.tickers.includes("XAUUSD"), "tagged with the watchlist ticker");
  assert.ok(!gold.tickers.includes("GLD"), "the proxy symbol is never used as a tag");
});

test("default map applies to the windowed historical fetcher too", async (t) => {
  const symbols = mockFinnhub(t);
  const fetcher = await createWindowedFetcher(makeConfig());
  const { items, errors } = await fetcher.fetchWindow("XAUUSD", { from: "2025-09-01", to: "2025-09-03" });

  assert.deepEqual(errors, []);
  assert.deepEqual(symbols, ["GLD"]);
  assert.equal(items.length, 1);
  assert.ok(items[0].tickers.includes("XAUUSD"));
});

test("FINNHUB_SYMBOL_MAP overrides the default; empty string means no mapping", async (t) => {
  let symbols = mockFinnhub(t);
  await fetchLatest(makeConfig({ FINNHUB_SYMBOL_MAP: "XAUUSD:IAU,bad,:X,Y:" }), {}, {});
  assert.deepEqual(symbols, ["AAPL", "IAU"], "custom entry used, malformed entries ignored");

  t.mock.restoreAll();
  symbols = mockFinnhub(t);
  await fetchLatest(makeConfig({ FINNHUB_SYMBOL_MAP: "" }), {}, {});
  assert.deepEqual(symbols, ["AAPL", "XAUUSD"], "empty string disables the default mapping");
});

test("a config with no finnhubSymbolMap (raw test config) requests the ticker as-is", async (t) => {
  const symbols = mockFinnhub(t);
  const config = { ...makeConfig(), finnhubSymbolMap: undefined };
  await fetchLatest(config, { queries: [{ ticker: "XAUUSD", query: "XAUUSD" }] }, {});
  assert.deepEqual(symbols, ["XAUUSD"]);
});
