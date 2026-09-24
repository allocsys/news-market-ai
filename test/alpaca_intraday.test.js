// Covers ingestion/sources/alpaca.js#fetchIntradayBars (plan.md finding G
// step 2): request shape (path, params, key/secret in HEADERS never the URL),
// next_page_token pagination, the runaway-pagination guard, the per-ticker
// failure isolation shared with tiingo.js (429/5xx/network retried, 401/403
// not), skipped/invalid bars, and the alpaca* settings in config.js.
// Everything is mocked at global fetch: nothing here has touched the real
// Alpaca API (see alpaca.js's header for what still needs a live check).

import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { fetchIntradayBars } from "../src/ingestion/sources/alpaca.js";

const KEY_ID = "test-alpaca-key-id";
const SECRET = "test-alpaca-secret-key";
// retryBaseDelayMs is 1 and pacing is 0 so nothing here sleeps for real.
const config = { ...loadConfig({ ALPACA_API_KEY_ID: KEY_ID, ALPACA_API_SECRET_KEY: SECRET }), retryBaseDelayMs: 1, alpacaMinRequestIntervalMs: 0 };
const FROM = "2025-09-02T13:30:00Z";
const TO = "2025-09-02T20:00:00Z";

/** One internally consistent Alpaca bar (validatePriceBarIntraday passes). */
function bar(t, base = 100) {
  return { t, o: base, h: base + 2, l: base - 1, c: base + 1, v: 1500, n: 10, vw: base };
}

/**
 * Alpaca as the adapter sees it. `byTicker[TICKER]` is one of:
 *   - a number: that HTTP status, with a JSON error body;
 *   - an Error: thrown by fetch (network failure);
 *   - `{ badJson: true }`: a 200 whose body is not JSON;
 *   - any other object: a 200 with that JSON body;
 *   - an ARRAY of the above: consumed in call order per ticker, the last one repeating.
 * Unlisted tickers get an empty 200 ({bars: []}). Returns the recorded calls.
 */
function mockAlpaca(t, byTicker) {
  const calls = [];
  const seen = {};
  t.mock.method(global, "fetch", async (url, options) => {
    const u = new URL(String(url));
    calls.push({ url: u, headers: options?.headers ?? {} });
    const ticker = decodeURIComponent(u.pathname.split("/")[3]).toUpperCase(); // /v2/stocks/{symbol}/bars
    let spec = byTicker[ticker];
    if (Array.isArray(spec)) {
      const i = seen[ticker] ?? 0;
      seen[ticker] = i + 1;
      spec = spec[Math.min(i, spec.length - 1)];
    }
    if (spec instanceof Error) throw spec;
    if (typeof spec === "number") {
      return { ok: false, status: spec, text: async () => JSON.stringify({ message: `simulated ${spec} for ${ticker}` }), json: async () => ({}) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => {
        if (spec?.badJson) throw new Error("Unexpected token < in JSON");
        return spec ?? { bars: [], next_page_token: null };
      },
    };
  });
  return calls;
}

// ---------------------------------------------------------------------------
// request shape and parsing
// ---------------------------------------------------------------------------

test("a ticker goes to /v2/stocks/{symbol}/bars with timeframe, range, feed and limit, key and secret in HEADERS (never the URL), and bars come back as PriceBarIntraday rows", async (t) => {
  const calls = mockAlpaca(t, { AAPL: { bars: [bar("2025-09-02T13:30:00Z"), bar("2025-09-02T13:35:00Z", 101)], next_page_token: null } });

  const { bars, errors, requests } = await fetchIntradayBars(config, { tickers: ["AAPL"], from: FROM, to: TO });

  assert.equal(requests, 1);
  assert.equal(errors.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.hostname, "data.alpaca.markets");
  assert.equal(calls[0].url.pathname, "/v2/stocks/AAPL/bars");
  assert.equal(calls[0].url.searchParams.get("timeframe"), "5Min");
  assert.equal(calls[0].url.searchParams.get("start"), FROM);
  assert.equal(calls[0].url.searchParams.get("end"), TO);
  assert.equal(calls[0].url.searchParams.get("feed"), "iex", "the free tier only serves IEX");
  assert.equal(calls[0].url.searchParams.get("limit"), "10000");
  assert.equal(calls[0].url.searchParams.get("page_token"), null, "no page_token on the first request");
  assert.equal(calls[0].headers["APCA-API-KEY-ID"], KEY_ID);
  assert.equal(calls[0].headers["APCA-API-SECRET-KEY"], SECRET);
  assert.ok(!calls[0].url.href.includes(KEY_ID) && !calls[0].url.href.includes(SECRET), "credentials never appear in the URL");

  assert.deepEqual(bars[0], { ticker: "AAPL", ts: "2025-09-02T13:30:00Z", open: 100, high: 102, low: 99, close: 101, volume: 1500, source: "alpaca" });
  assert.deepEqual(bars.map((b) => b.ts), ["2025-09-02T13:30:00Z", "2025-09-02T13:35:00Z"]);
  assert.equal(bars[1].open, 101);
});

test("every ticker gets its own request, in order, and all four watchlist equities/ETFs (incl. USO) go through the same stocks endpoint", async (t) => {
  const calls = mockAlpaca(t, {});
  await fetchIntradayBars(config, { tickers: ["AAPL", "MSFT", "TSLA", "USO"], from: FROM, to: TO });
  assert.deepEqual(calls.map((c) => c.url.pathname), ["/v2/stocks/AAPL/bars", "/v2/stocks/MSFT/bars", "/v2/stocks/TSLA/bars", "/v2/stocks/USO/bars"]);
});

test("config.alpacaFeed, alpacaIntradayTimeframe and alpacaApiBase are honored", async (t) => {
  const calls = mockAlpaca(t, {});
  await fetchIntradayBars({ ...config, alpacaFeed: "sip", alpacaIntradayTimeframe: "5min", alpacaApiBase: "https://example.test/" }, { tickers: ["AAPL"], from: FROM, to: TO });
  assert.equal(calls[0].url.origin, "https://example.test");
  assert.equal(calls[0].url.searchParams.get("feed"), "sip");
  assert.equal(calls[0].url.searchParams.get("timeframe"), "5min");
});

test("a timeframe other than 5 minutes is refused before any request: the point-in-time reader assumes every stored bar is 5 minutes long, so a longer bar would be shown before it closed", async (t) => {
  const calls = mockAlpaca(t, {});
  for (const timeframe of ["1Min", "15Min", "1Hour", "1Day", "garbage"]) {
    const { bars, errors } = await fetchIntradayBars({ ...config, alpacaIntradayTimeframe: timeframe }, { tickers: ["AAPL"], from: FROM, to: TO });
    assert.equal(bars.length, 0, timeframe);
    assert.match(errors[0].error.message, /unsupported alpacaIntradayTimeframe/, timeframe);
  }
  assert.equal(calls.length, 0);
});

test("bar timestamps are stored in the one canonical form (UTC, whole seconds, Z) whatever form the vendor sends, because the reader compares ts as strings", async (t) => {
  mockAlpaca(t, {
    AAPL: {
      bars: [bar("2025-09-02T13:30:00.000Z"), bar("2025-09-02T13:35:00Z", 101), bar("2025-09-02T09:40:00-04:00", 102)],
      next_page_token: null,
    },
  });

  const { bars, errors } = await fetchIntradayBars(config, { tickers: ["AAPL"], from: FROM, to: TO });

  assert.equal(errors.length, 0);
  assert.deepEqual(bars.map((b) => b.ts), ["2025-09-02T13:30:00Z", "2025-09-02T13:35:00Z", "2025-09-02T13:40:00Z"]);
});

test("an empty range is not an error: no bars, no errors", async (t) => {
  mockAlpaca(t, { AAPL: { bars: [], next_page_token: null } });
  const { bars, errors } = await fetchIntradayBars(config, { tickers: ["AAPL"], from: FROM, to: TO });
  assert.equal(bars.length, 0);
  assert.equal(errors.length, 0);
});

test("a bar with a null OHLC field, or no timestamp, is skipped rather than stored; a missing volume becomes 0", async (t) => {
  mockAlpaca(t, {
    AAPL: {
      bars: [
        bar("2025-09-02T13:30:00Z"),
        { ...bar("2025-09-02T13:35:00Z"), o: null },
        { ...bar("2025-09-02T13:40:00Z"), c: undefined },
        { ...bar(""), t: "" },
        { o: 100, h: 102, l: 99, c: 101 },
        { ...bar("2025-09-02T13:45:00Z"), v: undefined },
      ],
      next_page_token: null,
    },
  });

  const { bars, errors } = await fetchIntradayBars(config, { tickers: ["AAPL"], from: FROM, to: TO });

  assert.equal(errors.length, 0);
  assert.deepEqual(bars.map((b) => b.ts), ["2025-09-02T13:30:00Z", "2025-09-02T13:45:00Z"]);
  assert.equal(bars[1].volume, 0);
});

// ---------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------

test("a next_page_token is followed: the same start/end are repeated with page_token added, and the pages are concatenated", async (t) => {
  const calls = mockAlpaca(t, {
    AAPL: [
      { bars: [bar("2025-09-02T13:30:00Z"), bar("2025-09-02T13:35:00Z")], next_page_token: "tok-1" },
      { bars: [bar("2025-09-02T13:40:00Z")], next_page_token: "tok-2" },
      { bars: [bar("2025-09-02T13:45:00Z")], next_page_token: null },
    ],
  });

  const { bars, errors } = await fetchIntradayBars(config, { tickers: ["AAPL"], from: FROM, to: TO });

  assert.equal(errors.length, 0);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url.searchParams.get("page_token"), null);
  assert.equal(calls[1].url.searchParams.get("page_token"), "tok-1");
  assert.equal(calls[2].url.searchParams.get("page_token"), "tok-2");
  for (const c of calls) {
    assert.equal(c.url.searchParams.get("start"), FROM);
    assert.equal(c.url.searchParams.get("end"), TO);
  }
  assert.deepEqual(bars.map((b) => b.ts), ["2025-09-02T13:30:00Z", "2025-09-02T13:35:00Z", "2025-09-02T13:40:00Z", "2025-09-02T13:45:00Z"]);
});

test("a vendor that returns a next_page_token forever is stopped after 50 pages and reported against the ticker, not looped on", async (t) => {
  const calls = mockAlpaca(t, { AAPL: [{ bars: [bar("2025-09-02T13:30:00Z")], next_page_token: "again" }], MSFT: { bars: [bar("2025-09-02T13:30:00Z")], next_page_token: null } });

  const { bars, errors } = await fetchIntradayBars(config, { tickers: ["AAPL", "MSFT"], from: FROM, to: TO });

  assert.equal(calls.filter((c) => c.url.pathname.includes("/AAPL/")).length, 50);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].ticker, "AAPL");
  assert.match(errors[0].error.message, /more than 50 pages for AAPL/);
  assert.deepEqual(bars.map((b) => b.ticker), ["MSFT"], "the runaway ticker's partial bars are not stored, the other ticker still runs");
});

// ---------------------------------------------------------------------------
// failure isolation and retries
// ---------------------------------------------------------------------------

test("a 403 is NOT retried, is collected against that ticker (with the vendor's detail and a credentials hint, never the credentials), and the other tickers still run", async (t) => {
  const calls = mockAlpaca(t, { AAPL: 403, MSFT: { bars: [bar("2025-09-02T13:30:00Z")], next_page_token: null } });

  const { bars, errors } = await fetchIntradayBars(config, { tickers: ["AAPL", "MSFT"], from: FROM, to: TO });

  assert.equal(calls.length, 2, "one request for AAPL (no retry), one for MSFT");
  assert.deepEqual(bars.map((b) => b.ticker), ["MSFT"]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].ticker, "AAPL");
  assert.equal(errors[0].error.status, 403);
  assert.match(errors[0].error.message, /alpaca returned 403 for AAPL: .*simulated 403/);
  assert.match(errors[0].error.message, /check ALPACA_API_KEY_ID\/ALPACA_API_SECRET_KEY/);
  assert.ok(!errors[0].error.message.includes(KEY_ID) && !errors[0].error.message.includes(SECRET));
});

test("a 401 points at the credentials and is not retried", async (t) => {
  const calls = mockAlpaca(t, { AAPL: 401 });
  const { errors } = await fetchIntradayBars(config, { tickers: ["AAPL"], from: FROM, to: TO });
  assert.equal(calls.length, 1);
  assert.equal(errors[0].error.status, 401);
  assert.match(errors[0].error.message, /check ALPACA_API_KEY_ID/);
});

test("a 404 or other 4xx is a per-ticker failure, not retried and not a crash", async (t) => {
  const calls = mockAlpaca(t, { NOPE: 404, AAPL: { bars: [bar("2025-09-02T13:30:00Z")], next_page_token: null } });
  const { bars, errors } = await fetchIntradayBars(config, { tickers: ["NOPE", "AAPL"], from: FROM, to: TO });
  assert.equal(calls.filter((c) => c.url.pathname.includes("/NOPE/")).length, 1);
  assert.deepEqual(bars.map((b) => b.ticker), ["AAPL"]);
  assert.deepEqual(errors.map((e) => e.ticker), ["NOPE"]);
  assert.equal(errors[0].error.status, 404);
});

test("a 429 is retried (Alpaca's per-minute limit clears) and then succeeds", async (t) => {
  const calls = mockAlpaca(t, { AAPL: [429, { bars: [bar("2025-09-02T13:30:00Z")], next_page_token: null }] });
  const { bars, errors } = await fetchIntradayBars(config, { tickers: ["AAPL"], from: FROM, to: TO });
  assert.equal(calls.length, 2);
  assert.equal(errors.length, 0);
  assert.equal(bars.length, 1);
});

test("a 5xx that never clears is retried up to retryMaxAttempts, then collected against the ticker", async (t) => {
  const calls = mockAlpaca(t, { AAPL: 503 });
  const { bars, errors } = await fetchIntradayBars(config, { tickers: ["AAPL"], from: FROM, to: TO });
  assert.equal(calls.length, config.retryMaxAttempts);
  assert.equal(bars.length, 0);
  assert.equal(errors[0].error.status, 503);
});

test("a network failure is retried up to retryMaxAttempts, then collected against the ticker", async (t) => {
  const calls = mockAlpaca(t, { AAPL: new Error("boom") });
  const { bars, errors } = await fetchIntradayBars(config, { tickers: ["AAPL"], from: FROM, to: TO });
  assert.equal(calls.length, config.retryMaxAttempts);
  assert.equal(bars.length, 0);
  assert.match(errors[0].error.message, /network failure fetching alpaca for AAPL: boom/);
});

test("an unparseable body and an unexpected shape are per-ticker failures, and the other tickers still run", async (t) => {
  mockAlpaca(t, { AAPL: { badJson: true }, TSLA: { detail: "nope" }, MSFT: { bars: [bar("2025-09-02T13:30:00Z")], next_page_token: null } });
  const { bars, errors } = await fetchIntradayBars(config, { tickers: ["AAPL", "TSLA", "MSFT"], from: FROM, to: TO });
  assert.deepEqual(bars.map((b) => b.ticker), ["MSFT"]);
  assert.deepEqual(errors.map((e) => e.ticker), ["AAPL", "TSLA"]);
  assert.match(errors[0].error.message, /unparseable JSON/);
  assert.match(errors[1].error.message, /unexpected response shape/);
});

test("an internally inconsistent bar (high below low) fails that ticker, and the others still run", async (t) => {
  mockAlpaca(t, {
    AAPL: { bars: [{ ...bar("2025-09-02T13:30:00Z"), h: 90 }], next_page_token: null },
    MSFT: { bars: [bar("2025-09-02T13:30:00Z")], next_page_token: null },
  });
  const { bars, errors } = await fetchIntradayBars(config, { tickers: ["AAPL", "MSFT"], from: FROM, to: TO });
  assert.deepEqual(bars.map((b) => b.ticker), ["MSFT"]);
  assert.equal(errors[0].ticker, "AAPL");
  assert.match(errors[0].error.message, /high/);
});

test("a bar timestamped in the future is rejected, not stored", async (t) => {
  const future = new Date(Date.now() + 3 * 86400000).toISOString();
  mockAlpaca(t, { AAPL: { bars: [bar(future)], next_page_token: null } });
  const { bars, errors } = await fetchIntradayBars(config, { tickers: ["AAPL"], from: FROM, to: TO });
  assert.equal(bars.length, 0);
  assert.match(errors[0].error.message, /in the future/);
});

// ---------------------------------------------------------------------------
// argument and credential checks
// ---------------------------------------------------------------------------

test("missing key or secret (either one) throws before any request, naming both env vars", async (t) => {
  const calls = mockAlpaca(t, {});
  const args = { tickers: ["AAPL"], from: FROM, to: TO };
  await assert.rejects(() => fetchIntradayBars({ ...config, alpacaApiKey: "" }, args), /ALPACA_API_KEY_ID\/ALPACA_API_SECRET_KEY/);
  await assert.rejects(() => fetchIntradayBars({ ...config, alpacaApiSecret: "" }, args), /ALPACA_API_KEY_ID\/ALPACA_API_SECRET_KEY/);
  assert.equal(calls.length, 0);
});

test("a non-empty tickers array and an explicit valid {from, to} are required", async (t) => {
  mockAlpaca(t, {});
  await assert.rejects(() => fetchIntradayBars(config, {}), /non-empty tickers array/);
  await assert.rejects(() => fetchIntradayBars(config, { tickers: [], from: FROM, to: TO }), /non-empty tickers array/);
  await assert.rejects(() => fetchIntradayBars(config, { tickers: ["AAPL"], from: FROM }), /requires an explicit/);
  await assert.rejects(() => fetchIntradayBars(config, { tickers: ["AAPL"], from: "yesterday", to: TO }), /invalid from\/to/);
});

// ---------------------------------------------------------------------------
// config.js
// ---------------------------------------------------------------------------

test("config.js alpaca settings: no default credentials, IEX/5Min/data.alpaca.markets defaults, 350ms pacing, all overridable", () => {
  const d = loadConfig({});
  assert.equal(d.alpacaApiKey, "");
  assert.equal(d.alpacaApiSecret, "");
  assert.equal(d.alpacaApiBase, "https://data.alpaca.markets");
  assert.equal(d.alpacaFeed, "iex");
  assert.equal(d.alpacaIntradayTimeframe, "5Min");
  assert.equal(d.alpacaMinRequestIntervalMs, 350);

  const o = loadConfig({
    ALPACA_API_KEY_ID: "k",
    ALPACA_API_SECRET_KEY: "s",
    ALPACA_API_BASE: "https://x.test",
    ALPACA_FEED: "sip",
    ALPACA_INTRADAY_TIMEFRAME: "1Min",
    ALPACA_MIN_REQUEST_INTERVAL_MS: "500",
  });
  assert.equal(o.alpacaApiKey, "k");
  assert.equal(o.alpacaApiSecret, "s");
  assert.equal(o.alpacaApiBase, "https://x.test");
  assert.equal(o.alpacaFeed, "sip");
  assert.equal(o.alpacaIntradayTimeframe, "1Min");
  assert.equal(o.alpacaMinRequestIntervalMs, 500);
});
