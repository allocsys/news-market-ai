// Covers ingestion/sources/twelvedata.js#fetchIntradayBars (plan.md finding G
// step 2): the XAUUSD -> "XAU/USD" request shape, string-OHLCV parsing,
// order=ASC/outputsize=5000 pagination by advancing start_date, the SHARED
// D1 daily cap (one unit reserved per request, no request once it is
// spent), 404-as-empty-window, the soft-error-at-200 guard, the same
// per-ticker failure isolation as alpaca.js/tiingo.js, and the twelveData*
// settings in config.js.
// Everything is mocked at global fetch and runs against a REAL sqlite
// vendor_request_counters table: nothing here has touched the real Twelve
// Data API (see twelvedata.js's header for what still needs a live check).

import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { fetchIntradayBars, TWELVE_DATA_SYMBOL_MAP } from "../src/ingestion/sources/twelvedata.js";
import { reserve, currentCount } from "../src/shared/d1_rate_limiter.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { INPUTS_DIR } from "./helpers/engine_ctx.js";

const KEY = "test-twelvedata-key-123";
// retryBaseDelayMs is 1 and pacing is 0 so nothing here sleeps for real.
const config = { ...loadConfig({ TWELVE_DATA_API_KEY: KEY }), retryBaseDelayMs: 1, twelveDataMinRequestIntervalMs: 0 };
const FROM = "2025-09-02T00:00:00Z";
const TO = "2025-09-02T23:59:59Z";
const FIVE_MIN_MS = 5 * 60_000;

const newDb = () => createTestD1([INPUTS_DIR]);

/** Twelve Data's "YYYY-MM-DD HH:MM:SS" (UTC) for an epoch-ms instant. */
const fmt = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

/** `count` consecutive 5-minute rows starting at `startIso`; OHLCV as STRINGS, the way Twelve Data returns them. */
function tdRows(startIso, count, base = 3500) {
  const start = Date.parse(startIso);
  return Array.from({ length: count }, (_, i) => ({
    datetime: fmt(start + i * FIVE_MIN_MS),
    open: String(base),
    high: String(base + 1),
    low: String(base - 1),
    close: String(base + 0.5),
    volume: "0",
  }));
}

/** A 200 response carrying a `values` page. */
const page = (values) => ({ body: { meta: { symbol: "XAU/USD", interval: "5min" }, values, status: "ok" } });

/**
 * Twelve Data as the adapter sees it. `script` is either an array of response
 * specs consumed in call order (the last one repeating) or a function
 * (callNumber, url) => spec. A spec is:
 *   - an Error: thrown by fetch (network failure);
 *   - `{ status?, body?, badJson? }`: an HTTP response (status defaults to 200).
 * Returns the recorded calls.
 */
function mockTwelveData(t, script) {
  const calls = [];
  t.mock.method(global, "fetch", async (url) => {
    const u = new URL(String(url));
    calls.push({ url: u });
    const spec = typeof script === "function" ? script(calls.length, u) : script[Math.min(calls.length - 1, script.length - 1)];
    if (spec instanceof Error) throw spec;
    const { status = 200, body = {}, badJson = false } = spec;
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
  const db = overrides.db ?? newDb();
  const result = await fetchIntradayBars(overrides.config ?? config, { tickers: ["XAUUSD"], from: FROM, to: TO, ...args }, { db });
  return { ...result, db };
}

// ---------------------------------------------------------------------------
// request shape and parsing
// ---------------------------------------------------------------------------

test("XAUUSD goes to /time_series as XAU/USD with UTC start/end, ASC order, outputsize 5000 and the key in the query, and string OHLCV becomes numbers", async (t) => {
  const calls = mockTwelveData(t, [
    { body: { values: [{ datetime: "2025-09-02 13:30:00", open: "3500.10", high: "3501.25", low: "3499.50", close: "3500.80", volume: "12" }], status: "ok" } },
  ]);

  const { bars, errors, requests } = await run();

  assert.equal(requests, 1);
  assert.equal(errors.length, 0);
  assert.equal(calls.length, 1);
  const q = calls[0].url.searchParams;
  assert.equal(calls[0].url.hostname, "api.twelvedata.com");
  assert.equal(calls[0].url.pathname, "/time_series");
  assert.equal(q.get("symbol"), "XAU/USD", 'not the bare "XAUUSD" ticker this codebase stores rows under');
  assert.equal(q.get("interval"), "5min");
  assert.equal(q.get("start_date"), "2025-09-02 00:00:00");
  assert.equal(q.get("end_date"), "2025-09-02 23:59:59");
  assert.equal(q.get("outputsize"), "5000");
  assert.equal(q.get("order"), "ASC");
  assert.equal(q.get("timezone"), "UTC");
  assert.equal(q.get("apikey"), KEY);

  assert.deepEqual(bars, [{ ticker: "XAUUSD", ts: "2025-09-02T13:30:00Z", open: 3500.1, high: 3501.25, low: 3499.5, close: 3500.8, volume: 12, source: "twelvedata" }]);
});

test("the symbol map wires XAUUSD only", () => {
  assert.deepEqual(TWELVE_DATA_SYMBOL_MAP, { XAUUSD: "XAU/USD" });
});

test("config.twelveDataApiBase and twelveDataIntradayInterval are honored", async (t) => {
  const calls = mockTwelveData(t, [page([])]);
  await run({ config: { ...config, twelveDataApiBase: "https://example.test/", twelveDataIntradayInterval: "5min" } });
  assert.equal(calls[0].url.origin, "https://example.test");
  assert.equal(calls[0].url.searchParams.get("interval"), "5min");
});

test("an interval other than 5 minutes is refused before any request or reservation: the point-in-time reader assumes every stored bar is 5 minutes long, so a longer bar would be shown before it closed", async (t) => {
  const calls = mockTwelveData(t, [page([])]);
  for (const interval of ["1min", "15min", "1h"]) {
    const { bars, errors, db } = await run({ config: { ...config, twelveDataIntradayInterval: interval } });
    assert.equal(bars.length, 0, interval);
    assert.match(errors[0].error.message, /unsupported twelveDataIntradayInterval/, interval);
    assert.equal(await currentCount(db, { vendor: "twelvedata" }), 0, interval);
  }
  assert.equal(calls.length, 0);
});

test("a row with a null/unparseable price, or no datetime, is skipped rather than stored; a missing volume becomes 0", async (t) => {
  const [good] = tdRows("2025-09-02T13:30:00Z", 1);
  mockTwelveData(t, [
    page([
      good,
      { ...good, datetime: "2025-09-02 13:35:00", open: null },
      { ...good, datetime: "2025-09-02 13:40:00", close: "abc" },
      { ...good, datetime: undefined },
      { ...good, datetime: "2025-09-02 13:45:00", volume: undefined },
    ]),
  ]);

  const { bars, errors } = await run();

  assert.equal(errors.length, 0);
  assert.deepEqual(bars.map((b) => b.ts), ["2025-09-02T13:30:00Z", "2025-09-02T13:45:00Z"]);
  assert.equal(bars[1].volume, 0);
});

test("an internally inconsistent bar (high below low) fails the ticker", async (t) => {
  mockTwelveData(t, [page([{ ...tdRows("2025-09-02T13:30:00Z", 1)[0], high: "3400" }])]);
  const { bars, errors } = await run();
  assert.equal(bars.length, 0);
  assert.equal(errors[0].ticker, "XAUUSD");
  assert.match(errors[0].error.message, /high/);
});

// ---------------------------------------------------------------------------
// the shared D1 daily cap
// ---------------------------------------------------------------------------

test("each request reserves one unit of the shared daily cap in D1", async (t) => {
  mockTwelveData(t, [page(tdRows("2025-09-02T13:30:00Z", 2))]);
  const { db } = await run();
  assert.equal(await currentCount(db, { vendor: "twelvedata" }), 1);

  await run({ db });
  assert.equal(await currentCount(db, { vendor: "twelvedata" }), 2, "a second invocation on the same D1 adds to, not restarts, the day's count");
});

test("with the daily cap already spent, no request is made and the ticker reports the cap", async (t) => {
  const calls = mockTwelveData(t, [page(tdRows("2025-09-02T13:30:00Z", 2))]);
  const db = newDb();
  await reserve(db, { vendor: "twelvedata", limit: 3, n: 3 });

  const { bars, errors } = await run({ db, config: { ...config, twelveDataDailyRequestLimit: 3 } });

  assert.equal(calls.length, 0, "a spent cap means the vendor is never called");
  assert.equal(bars.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].ticker, "XAUUSD");
  assert.match(errors[0].error.message, /daily request cap reached \(3\/3\)/);
  assert.equal(await currentCount(db, { vendor: "twelvedata" }), 3, "a denied reservation costs nothing");
});

test("the cap defaults to 800/day: request 800 fits, request 801 does not", async (t) => {
  const calls = mockTwelveData(t, [page([])]);
  const db = newDb();
  await reserve(db, { vendor: "twelvedata", limit: 800, n: 799 });

  await run({ db });
  assert.equal(calls.length, 1, "request 800 fits");
  const again = await run({ db });
  assert.equal(calls.length, 1, "request 801 does not");
  assert.match(again.errors[0].error.message, /\(800\/800\)/);
});

// ---------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------

test("a full page (5000 rows) is followed: the next start_date is the last bar plus one interval, end_date is unchanged, and pages are concatenated", async (t) => {
  const start = "2025-09-01T00:00:00Z";
  const startMs = Date.parse(start);
  const secondStart = new Date(startMs + 5000 * FIVE_MIN_MS).toISOString();
  const calls = mockTwelveData(t, [page(tdRows(start, 5000)), page(tdRows(secondStart, 3))]);

  const { bars, errors, db } = await run({}, { from: start, to: "2025-10-01T00:00:00Z" });

  assert.equal(errors.length, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.searchParams.get("start_date"), "2025-09-01 00:00:00");
  assert.equal(calls[1].url.searchParams.get("start_date"), fmt(startMs + 5000 * FIVE_MIN_MS), "last bar (index 4999) + one 5-minute interval");
  assert.equal(calls[1].url.searchParams.get("end_date"), calls[0].url.searchParams.get("end_date"));
  assert.equal(bars.length, 5003);
  assert.equal(bars[4999].ts, `${fmt(startMs + 4999 * FIVE_MIN_MS).replace(" ", "T")}Z`);
  assert.equal(bars[5000].ts, `${fmt(startMs + 5000 * FIVE_MIN_MS).replace(" ", "T")}Z`);
  assert.equal(await currentCount(db, { vendor: "twelvedata" }), 2, "one cap unit per page");
});

test("a page shorter than 5000 rows ends the walk without asking for another", async (t) => {
  const calls = mockTwelveData(t, [page(tdRows("2025-09-02T13:30:00Z", 4999))]);
  const { bars } = await run();
  assert.equal(calls.length, 1);
  assert.equal(bars.length, 4999);
});

test("a full page whose next cursor would pass `to` stops instead of requesting an empty tail", async (t) => {
  const start = "2025-09-01T00:00:00Z";
  const lastMs = Date.parse(start) + 4999 * FIVE_MIN_MS;
  const calls = mockTwelveData(t, [page(tdRows(start, 5000))]);

  const { bars, errors } = await run({}, { from: start, to: new Date(lastMs).toISOString() });

  assert.equal(errors.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(bars.length, 5000);
});

test("a vendor that keeps returning full pages is stopped after 50 pages and reported, not looped on", async (t) => {
  const calls = mockTwelveData(t, [page(tdRows("2025-09-01T00:00:00Z", 5000))]);

  const { bars, errors } = await run({}, { from: "2025-09-01T00:00:00Z", to: "2025-12-01T00:00:00Z" });

  assert.equal(calls.length, 50);
  assert.equal(bars.length, 0, "the runaway ticker's partial bars are not stored");
  assert.equal(errors.length, 1);
  assert.match(errors[0].error.message, /exceeded 50 pages for XAUUSD/);
});

// ---------------------------------------------------------------------------
// empty ranges, soft errors, HTTP failures
// ---------------------------------------------------------------------------

test("a 404 (no data in the window, e.g. a weekend) is an empty result, not an error, and still costs its cap unit", async (t) => {
  const calls = mockTwelveData(t, [{ status: 404, body: { code: 404, message: "Requested data could not be found.", status: "error" } }]);

  const { bars, errors, db } = await run();

  assert.equal(calls.length, 1, "not retried");
  assert.equal(bars.length, 0);
  assert.equal(errors.length, 0);
  assert.equal(await currentCount(db, { vendor: "twelvedata" }), 1);
});

test("an empty `values` array with a 200 is also just an empty result", async (t) => {
  mockTwelveData(t, [page([])]);
  const { bars, errors } = await run();
  assert.equal(bars.length, 0);
  assert.equal(errors.length, 0);
});

test('an error body riding along with an HTTP 200 ({status:"error"}) is a per-ticker failure carrying the vendor message and code', async (t) => {
  mockTwelveData(t, [{ body: { code: 400, message: "**symbol** not found: XAU/USD", status: "error" } }]);
  const { bars, errors } = await run();
  assert.equal(bars.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].error.status, 400);
  assert.match(errors[0].error.message, /twelvedata returned an error for XAUUSD: \*\*symbol\*\* not found/);
});

test("a 401 points at the API key and is not retried; the key never appears in the message", async (t) => {
  const calls = mockTwelveData(t, [{ status: 401, body: { code: 401, message: "apikey is invalid or incorrect", status: "error" } }]);
  const { errors } = await run();
  assert.equal(calls.length, 1);
  assert.equal(errors[0].error.status, 401);
  assert.match(errors[0].error.message, /twelvedata returned 401 for XAUUSD: .*apikey is invalid/);
  assert.match(errors[0].error.message, /check TWELVE_DATA_API_KEY/);
  assert.ok(!errors[0].error.message.includes(KEY));
});

test("a 403 says the endpoint/symbol may need a paid plan and is not retried", async (t) => {
  const calls = mockTwelveData(t, [{ status: 403, body: { code: 403, message: "plan required", status: "error" } }]);
  const { errors } = await run();
  assert.equal(calls.length, 1);
  assert.equal(errors[0].error.status, 403);
  assert.match(errors[0].error.message, /may require a paid Twelve Data plan/);
});

test("a 429 (per-minute cap) is retried and then succeeds", async (t) => {
  const calls = mockTwelveData(t, [{ status: 429, body: { code: 429, message: "too many requests", status: "error" } }, page(tdRows("2025-09-02T13:30:00Z", 1))]);
  const { bars, errors } = await run();
  assert.equal(calls.length, 2);
  assert.equal(errors.length, 0);
  assert.equal(bars.length, 1);
});

test("a 5xx that never clears is retried up to retryMaxAttempts, then collected against the ticker", async (t) => {
  const calls = mockTwelveData(t, [{ status: 503, body: { code: 503, message: "unavailable", status: "error" } }]);
  const { bars, errors } = await run();
  assert.equal(calls.length, config.retryMaxAttempts);
  assert.equal(bars.length, 0);
  assert.equal(errors[0].error.status, 503);
});

test("a network failure is retried up to retryMaxAttempts, and the API key is scrubbed from the message even if the runtime echoes the URL", async (t) => {
  const calls = mockTwelveData(t, [new Error(`fetch failed: GET https://api.twelvedata.com/time_series?symbol=XAU%2FUSD&apikey=${KEY}`)]);
  const { bars, errors } = await run();
  assert.equal(calls.length, config.retryMaxAttempts);
  assert.equal(bars.length, 0);
  assert.match(errors[0].error.message, /network failure fetching twelvedata for XAUUSD/);
  assert.match(errors[0].error.message, /apikey=\[redacted\]/);
  assert.ok(!errors[0].error.message.includes(KEY));
});

test("an unparseable body is a per-ticker failure", async (t) => {
  mockTwelveData(t, [{ badJson: true }]);
  const { bars, errors } = await run();
  assert.equal(bars.length, 0);
  assert.match(errors[0].error.message, /unparseable JSON/);
});

test("an unexpected response shape (no `values` array) is a per-ticker failure", async (t) => {
  mockTwelveData(t, [{ body: { something: "else" } }]);
  const { bars, errors } = await run();
  assert.equal(bars.length, 0);
  assert.match(errors[0].error.message, /unexpected response shape/);
});

// ---------------------------------------------------------------------------
// per-ticker isolation, argument and credential checks
// ---------------------------------------------------------------------------

test("a ticker with no Twelve Data symbol is a per-ticker failure that makes no request, and XAUUSD still runs", async (t) => {
  const calls = mockTwelveData(t, [page(tdRows("2025-09-02T13:30:00Z", 1))]);

  const { bars, errors, db } = await run({}, { tickers: ["AAPL", "XAUUSD"] });

  assert.equal(calls.length, 1, "only XAUUSD hit the vendor");
  assert.deepEqual(bars.map((b) => b.ticker), ["XAUUSD"]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].ticker, "AAPL");
  assert.match(errors[0].error.message, /no Twelve Data symbol mapping for ticker AAPL/);
  assert.equal(await currentCount(db, { vendor: "twelvedata" }), 1, "the unmapped ticker reserved nothing");
});

test("an unsupported interval fails fast, before any request or reservation", async (t) => {
  const calls = mockTwelveData(t, [page([])]);
  const { errors, db } = await run({ config: { ...config, twelveDataIntradayInterval: "7min" } });
  assert.equal(calls.length, 0);
  assert.match(errors[0].error.message, /unsupported twelveDataIntradayInterval "7min"/);
  assert.equal(await currentCount(db, { vendor: "twelvedata" }), 0);
});

test("missing API key or missing db throws once, up front, before any request", async (t) => {
  const calls = mockTwelveData(t, [page([])]);
  const args = { tickers: ["XAUUSD"], from: FROM, to: TO };

  await assert.rejects(() => fetchIntradayBars({ ...config, twelveDataApiKey: "" }, args, { db: newDb() }), /TWELVE_DATA_API_KEY/);
  await assert.rejects(() => fetchIntradayBars(config, args, {}), /requires a D1 db handle/);
  await assert.rejects(() => fetchIntradayBars(config, args), /requires a D1 db handle/);
  assert.equal(calls.length, 0);
});

test("a non-empty tickers array and an explicit valid {from, to} are required", async (t) => {
  mockTwelveData(t, [page([])]);
  const db = newDb();
  await assert.rejects(() => fetchIntradayBars(config, {}, { db }), /non-empty tickers array/);
  await assert.rejects(() => fetchIntradayBars(config, { tickers: [], from: FROM, to: TO }, { db }), /non-empty tickers array/);
  await assert.rejects(() => fetchIntradayBars(config, { tickers: ["XAUUSD"], from: FROM }, { db }), /requires an explicit/);
  await assert.rejects(() => fetchIntradayBars(config, { tickers: ["XAUUSD"], from: "yesterday", to: TO }, { db }), /invalid from\/to/);
});

// ---------------------------------------------------------------------------
// config.js
// ---------------------------------------------------------------------------

test("config.js twelveData settings: no default key, api.twelvedata.com/5min defaults, 7600ms pacing (8/min + padding), 800/day cap, all overridable", () => {
  const d = loadConfig({});
  assert.equal(d.twelveDataApiKey, "");
  assert.equal(d.twelveDataApiBase, "https://api.twelvedata.com");
  assert.equal(d.twelveDataIntradayInterval, "5min");
  assert.equal(d.twelveDataMinRequestIntervalMs, 7600);
  assert.equal(d.twelveDataDailyRequestLimit, 800);

  const o = loadConfig({
    TWELVE_DATA_API_KEY: "k",
    TWELVE_DATA_API_BASE: "https://x.test",
    TWELVE_DATA_INTRADAY_INTERVAL: "15min",
    TWELVE_DATA_MIN_REQUEST_INTERVAL_MS: "9000",
    TWELVE_DATA_DAILY_REQUEST_LIMIT: "400",
  });
  assert.equal(o.twelveDataApiKey, "k");
  assert.equal(o.twelveDataApiBase, "https://x.test");
  assert.equal(o.twelveDataIntradayInterval, "15min");
  assert.equal(o.twelveDataMinRequestIntervalMs, 9000);
  assert.equal(o.twelveDataDailyRequestLimit, 400);
});
