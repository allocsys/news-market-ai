// Covers ingestion/sources/tiingo_fx_intraday.js#fetchIntradayBars (plan.md
// finding G follow-up, 2026-09-24): the XAUUSD-only ticker set, the
// GET /tiingo/fx/<ticker>/prices?startDate&endDate&resampleFreq request
// shape, numeric (not string) OHLC parsing, volume always 0 (no volume
// field from this vendor), the exactly-one-request-per-ticker contract (no
// pagination -- see the adapter's own header), the [from, to) window filter,
// and the same per-ticker failure isolation / retry / credential-scrubbing
// conventions as twelvedata.js/alpaca.js.
//
// Everything is mocked at global fetch: nothing here has touched the real
// Tiingo API (see the adapter's header for what the owner's one manual
// sample already verified, and what's still unverified about live traffic).

import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { fetchIntradayBars, TIINGO_FX_INTRADAY_TICKERS, isTiingoFxIntradayTicker } from "../src/ingestion/sources/tiingo_fx_intraday.js";

const KEY = "test-tiingo-key-123";
// retryBaseDelayMs is 1 and pacing is 0 so nothing here sleeps for real.
const config = { ...loadConfig({ TIINGO_API_KEY: KEY }), retryBaseDelayMs: 1, tiingoFxIntradayMinRequestIntervalMs: 0 };
const FROM = "2025-09-02T00:00:00Z";
const TO = "2025-09-02T23:59:59Z";
const FIVE_MIN_MS = 5 * 60_000;

/** `count` consecutive 5-minute rows starting at `startIso`; OHLC as NUMBERS, the way Tiingo's Forex API returns them (no volume field). */
function fxRows(startIso, count, base = 3500) {
  const start = Date.parse(startIso);
  return Array.from({ length: count }, (_, i) => ({
    date: new Date(start + i * FIVE_MIN_MS).toISOString(),
    open: base,
    high: base + 1,
    low: base - 1,
    close: base + 0.5,
  }));
}

/**
 * Tiingo as the adapter sees it. `script` is either an array of response
 * specs consumed in call order (the last one repeating) or a function
 * (callNumber, url) => spec. A spec is:
 *   - an Error: thrown by fetch (network failure);
 *   - `{ status?, body?, badJson? }`: an HTTP response (status defaults to 200).
 * Returns the recorded calls.
 */
function mockTiingoFx(t, script) {
  const calls = [];
  t.mock.method(global, "fetch", async (url, init) => {
    const u = new URL(String(url));
    calls.push({ url: u, headers: init?.headers });
    const spec = typeof script === "function" ? script(calls.length, u) : script[Math.min(calls.length - 1, script.length - 1)];
    if (spec instanceof Error) throw spec;
    const { status = 200, body = [], badJson = false } = spec;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
      json: async () => {
        if (badJson) throw new Error("Unexpected token < in JSON");
        return body;
      },
    };
  });
  return calls;
}

async function run(overrides = {}, args = {}) {
  return fetchIntradayBars(overrides.config ?? config, { tickers: ["XAUUSD"], from: FROM, to: TO, ...args });
}

// ---------------------------------------------------------------------------
// request shape and parsing
// ---------------------------------------------------------------------------

test("XAUUSD goes to /tiingo/fx/xauusd/prices with startDate/endDate, resampleFreq=5min, the token header, and numeric OHLC becomes numbers with volume 0", async (t) => {
  const calls = mockTiingoFx(t, [{ body: [{ date: "2025-09-02T13:30:00.000Z", open: 3500.1, high: 3501.25, low: 3499.5, close: 3500.8 }] }]);

  const { bars, errors, requests } = await run();

  assert.equal(requests, 1);
  assert.equal(errors.length, 0);
  assert.equal(calls.length, 1);
  const q = calls[0].url.searchParams;
  assert.equal(calls[0].url.hostname, "api.tiingo.com");
  assert.equal(calls[0].url.pathname, "/tiingo/fx/xauusd/prices");
  assert.equal(q.get("startDate"), FROM);
  assert.equal(q.get("endDate"), TO);
  assert.equal(q.get("resampleFreq"), "5min");
  assert.equal(calls[0].headers.Authorization, `Token ${KEY}`);

  assert.deepEqual(bars, [{ ticker: "XAUUSD", ts: "2025-09-02T13:30:00Z", open: 3500.1, high: 3501.25, low: 3499.5, close: 3500.8, volume: 0, source: "tiingo_fx_intraday" }]);
});

test("the intraday ticker set is XAUUSD only, case-insensitively", () => {
  assert.deepEqual([...TIINGO_FX_INTRADAY_TICKERS], ["XAUUSD"]);
  assert.equal(isTiingoFxIntradayTicker("XAUUSD"), true);
  assert.equal(isTiingoFxIntradayTicker("xauusd"), true);
  assert.equal(isTiingoFxIntradayTicker("AAPL"), false);
});

test("config.tiingoApiBase and tiingoFxIntradayResampleFreq are honored", async (t) => {
  const calls = mockTiingoFx(t, [{ body: [] }]);
  await run({ config: { ...config, tiingoApiBase: "https://example.test/", tiingoFxIntradayResampleFreq: "1min" } });
  assert.equal(calls[0].url.origin, "https://example.test");
  assert.equal(calls[0].url.searchParams.get("resampleFreq"), "1min");
});

test("a row with a null/unparseable price, or no date, is skipped rather than stored", async (t) => {
  const [good] = fxRows("2025-09-02T13:30:00Z", 1);
  mockTiingoFx(t, [
    {
      body: [
        good,
        { ...good, date: "2025-09-02T13:35:00.000Z", open: null },
        { ...good, date: "2025-09-02T13:40:00.000Z", close: "abc" },
        { ...good, date: undefined },
        { ...good, date: "2025-09-02T13:45:00.000Z" },
      ],
    },
  ]);

  const { bars, errors } = await run();

  assert.equal(errors.length, 0);
  assert.deepEqual(bars.map((b) => b.ts), ["2025-09-02T13:30:00Z", "2025-09-02T13:45:00Z"]);
  assert.equal(bars.every((b) => b.volume === 0), true);
});

test("a row outside [from, to) is filtered out even though the vendor returned it", async (t) => {
  mockTiingoFx(t, [{ body: [...fxRows("2025-09-01T23:55:00Z", 2), ...fxRows("2025-09-02T13:30:00Z", 1), ...fxRows("2025-09-03T00:00:00Z", 1)] }]);
  const { bars } = await run();
  assert.deepEqual(bars.map((b) => b.ts), ["2025-09-02T13:30:00Z"]);
});

test("an internally inconsistent bar (high below low) fails the ticker", async (t) => {
  mockTiingoFx(t, [{ body: [{ ...fxRows("2025-09-02T13:30:00Z", 1)[0], high: 3400 }] }]);
  const { bars, errors } = await run();
  assert.equal(bars.length, 0);
  assert.equal(errors[0].ticker, "XAUUSD");
  assert.match(errors[0].error.message, /high/);
});

// ---------------------------------------------------------------------------
// no pagination -- exactly one request per ticker
// ---------------------------------------------------------------------------

test("a large response (well beyond any vendor page-size cap seen elsewhere in this codebase) is still handled in exactly one request", async (t) => {
  const calls = mockTiingoFx(t, [{ body: fxRows("2025-09-01T00:00:00Z", 6000) }]);
  const { bars, requests } = await run({}, { from: "2025-09-01T00:00:00Z", to: "2025-09-22T00:00:00Z" });
  assert.equal(calls.length, 1);
  assert.equal(requests, 1);
  assert.equal(bars.length, 6000);
});

// ---------------------------------------------------------------------------
// empty ranges, HTTP failures
// ---------------------------------------------------------------------------

test("a 404 (no data in the window, e.g. a weekend) is an empty result, not an error", async (t) => {
  const calls = mockTiingoFx(t, [{ status: 404, body: { detail: "Not Found" } }]);
  const { bars, errors } = await run();
  assert.equal(calls.length, 1, "not retried");
  assert.equal(bars.length, 0);
  assert.equal(errors.length, 0);
});

test("an empty array with a 200 is also just an empty result", async (t) => {
  mockTiingoFx(t, [{ body: [] }]);
  const { bars, errors } = await run();
  assert.equal(bars.length, 0);
  assert.equal(errors.length, 0);
});

test("a 401 points at the API key and is not retried; the key never appears in the message", async (t) => {
  const calls = mockTiingoFx(t, [{ status: 401, body: { detail: "Invalid token" } }]);
  const { errors } = await run();
  assert.equal(calls.length, 1);
  assert.equal(errors[0].error.status, 401);
  assert.match(errors[0].error.message, /tiingo fx intraday returned 401 for XAUUSD/);
  assert.match(errors[0].error.message, /check TIINGO_API_KEY/);
  assert.ok(!errors[0].error.message.includes(KEY));
});

test("a 429 is not retried (a per-request-count cap, not a transient blip)", async (t) => {
  const calls = mockTiingoFx(t, [{ status: 429, body: { detail: "rate limited" } }]);
  const { errors } = await run();
  assert.equal(calls.length, 1);
  assert.equal(errors[0].error.status, 429);
});

test("a 5xx that never clears is retried up to retryMaxAttempts, then collected against the ticker", async (t) => {
  const calls = mockTiingoFx(t, [{ status: 503, body: { detail: "unavailable" } }]);
  const { bars, errors } = await run();
  assert.equal(calls.length, config.retryMaxAttempts);
  assert.equal(bars.length, 0);
  assert.equal(errors[0].error.status, 503);
});

test("a network failure is retried up to retryMaxAttempts", async (t) => {
  const calls = mockTiingoFx(t, [new Error("fetch failed: network down")]);
  const { bars, errors } = await run();
  assert.equal(calls.length, config.retryMaxAttempts);
  assert.equal(bars.length, 0);
  assert.match(errors[0].error.message, /network failure fetching tiingo fx intraday for XAUUSD/);
});

test("an unparseable body is a per-ticker failure", async (t) => {
  mockTiingoFx(t, [{ badJson: true }]);
  const { bars, errors } = await run();
  assert.equal(bars.length, 0);
  assert.match(errors[0].error.message, /unparseable JSON/);
});

test("an unexpected response shape (not an array) is a per-ticker failure", async (t) => {
  mockTiingoFx(t, [{ body: { something: "else" } }]);
  const { bars, errors } = await run();
  assert.equal(bars.length, 0);
  assert.match(errors[0].error.message, /unexpected response shape/);
});

// ---------------------------------------------------------------------------
// per-ticker isolation, argument and credential checks
// ---------------------------------------------------------------------------

test("a ticker outside TIINGO_FX_INTRADAY_TICKERS still gets a request made under its own symbol (this adapter has no allowlist check -- routing which tickers reach it is intraday_backfill.js's job, not this file's)", async (t) => {
  const calls = mockTiingoFx(t, [{ body: fxRows("2025-09-02T13:30:00Z", 1) }]);
  const { bars, errors } = await run({}, { tickers: ["EURUSD"] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, "/tiingo/fx/eurusd/prices");
  assert.equal(errors.length, 0);
  assert.deepEqual(bars.map((b) => b.ticker), ["EURUSD"]);
});

test("missing API key throws once, up front, before any request", async (t) => {
  const calls = mockTiingoFx(t, [{ body: [] }]);
  await assert.rejects(() => fetchIntradayBars({ ...config, tiingoApiKey: "" }, { tickers: ["XAUUSD"], from: FROM, to: TO }), /TIINGO_API_KEY/);
  assert.equal(calls.length, 0);
});

test("a non-empty tickers array and an explicit valid {from, to} are required", async (t) => {
  mockTiingoFx(t, [{ body: [] }]);
  await assert.rejects(() => fetchIntradayBars(config, {}), /non-empty tickers array/);
  await assert.rejects(() => fetchIntradayBars(config, { tickers: [], from: FROM, to: TO }), /non-empty tickers array/);
  await assert.rejects(() => fetchIntradayBars(config, { tickers: ["XAUUSD"], from: FROM }), /requires an explicit/);
  await assert.rejects(() => fetchIntradayBars(config, { tickers: ["XAUUSD"], from: "yesterday", to: TO }), /invalid from\/to/);
});

test("two tickers, one failing, are isolated: the other's bars still come back", async (t) => {
  const calls = mockTiingoFx(t, (callNumber) => (callNumber <= config.retryMaxAttempts ? { status: 500, body: {} } : { body: fxRows("2025-09-02T13:30:00Z", 1) }));

  const { bars, errors } = await run({}, { tickers: ["XAUUSD", "EURUSD"] });

  assert.equal(calls.length, config.retryMaxAttempts + 1, "XAUUSD's 500 is retried; EURUSD then succeeds on its own first try");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].ticker, "XAUUSD");
  assert.deepEqual(bars.map((b) => b.ticker), ["EURUSD"]);
});

// ---------------------------------------------------------------------------
// config.js
// ---------------------------------------------------------------------------

test("config.js tiingoFxIntraday settings: 5min resample default, 0ms pacing default, both overridable", () => {
  const d = loadConfig({});
  assert.equal(d.tiingoFxIntradayResampleFreq, "5min");
  assert.equal(d.tiingoFxIntradayMinRequestIntervalMs, 0);

  const o = loadConfig({
    TIINGO_FX_INTRADAY_RESAMPLE_FREQ: "1min",
    TIINGO_FX_INTRADAY_MIN_REQUEST_INTERVAL_MS: "2000",
  });
  assert.equal(o.tiingoFxIntradayResampleFreq, "1min");
  assert.equal(o.tiingoFxIntradayMinRequestIntervalMs, 2000);
});
