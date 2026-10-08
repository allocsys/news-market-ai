// Covers the XAUUSD macro adapters (ingestion/sources/fred.js and
// ingestion/sources/cftc_cot.js): request shape, point-in-time availability
// stamps, skip rules (missing / non-numeric / malformed rows are dropped, never
// zero-filled), error classification, per-series failure isolation, and that the
// FRED api key never leaks into an error message.
//
// Everything is mocked at global fetch: nothing here has touched the real FRED
// or CFTC APIs (egress from the sandbox is blocked). The first live tick must be
// checked in observability -- see the adapter headers.

import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { VendorError } from "../src/shared/errors.js";
import { fetchSeries, fetchLatest as fredFetchLatest, fredAvailableAt, realtimeWindows, DEFAULT_FRED_SERIES } from "../src/ingestion/sources/fred.js";
import { fetchLatest as cotFetchLatest, cotAvailableAt, COT_SERIES, GOLD_COT_CODE } from "../src/ingestion/sources/cftc_cot.js";

const KEY = "test-fred-key-abc123";
const config = {
  ...loadConfig({}),
  fredApiKey: KEY,
  fredApiBase: "https://fred.example/series/observations",
  fredMinRequestIntervalMs: 0,
  cotApiBase: "https://cot.example/resource/72hh-3qpy.json",
  cotAppToken: "",
};

/**
 * `script`: array of specs consumed in call order (last repeats) or (n, url) => spec.
 * A spec is an Error (thrown by fetch) or `{ status?, body? }`. Returns the recorded calls.
 */
function mockFetch(t, script) {
  const calls = [];
  t.mock.method(global, "fetch", async (url, init) => {
    const u = new URL(String(url));
    calls.push({ url: u, headers: init?.headers });
    const spec = typeof script === "function" ? script(calls.length, u) : script[Math.min(calls.length - 1, script.length - 1)];
    if (spec instanceof Error) throw spec;
    const { status = 200, body = {} } = spec;
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
  });
  return calls;
}

// ---------------------------------------------------------------- FRED

test("fredAvailableAt: start of the UTC day AFTER realtime_start; null when malformed", () => {
  assert.equal(fredAvailableAt("2026-10-01"), "2026-10-02T00:00:00.000Z");
  assert.equal(fredAvailableAt("2026-12-31"), "2027-01-01T00:00:00.000Z");
  assert.equal(fredAvailableAt("2026-10-1"), null);
  assert.equal(fredAvailableAt(""), null);
  assert.equal(fredAvailableAt(undefined), null);
  assert.equal(fredAvailableAt("2026-13-45"), null);
});

test("fred.fetchSeries: asks for every vintage from observationStart on and maps rows to point-in-time observations", async (t) => {
  const calls = mockFetch(t, [
    {
      body: {
        observations: [
          { realtime_start: "2026-09-30", realtime_end: "9999-12-31", date: "2026-09-29", value: "1.85" },
          { realtime_start: "2026-10-01", realtime_end: "9999-12-31", date: "2026-09-30", value: "1.9" },
        ],
      },
    },
  ]);
  const rows = await fetchSeries(config, { series: "DFII10", observationStart: "2026-06-01" });

  assert.equal(calls.length, 1);
  const p = calls[0].url.searchParams;
  assert.equal(calls[0].url.origin + calls[0].url.pathname, config.fredApiBase);
  assert.equal(p.get("series_id"), "DFII10");
  assert.equal(p.get("api_key"), KEY);
  assert.equal(p.get("file_type"), "json");
  assert.equal(p.get("observation_start"), "2026-06-01");
  assert.equal(p.get("realtime_start"), "2026-06-01", "not 1776: FRED 400s above 2000 vintage dates, which a daily series exceeds");
  assert.equal(p.get("realtime_end"), "9999-12-31");

  assert.deepEqual(rows, [
    { series: "DFII10", obsDate: "2026-09-29", availableAt: "2026-10-01T00:00:00.000Z", val: 1.85, source: "fred" },
    { series: "DFII10", obsDate: "2026-09-30", availableAt: "2026-10-02T00:00:00.000Z", val: 1.9, source: "fred" },
  ]);
});

test("fred.fetchSeries: a revised observation comes back as a second row with a LATER availableAt", async (t) => {
  mockFetch(t, [
    {
      body: {
        observations: [
          { realtime_start: "2026-09-15", date: "2026-08-01", value: "320.5" },
          { realtime_start: "2026-10-14", date: "2026-08-01", value: "320.9" },
        ],
      },
    },
  ]);
  const rows = await fetchSeries(config, { series: "CPIAUCSL", observationStart: "2026-06-01" });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].obsDate, rows[1].obsDate);
  assert.ok(rows[1].availableAt > rows[0].availableAt);
  assert.deepEqual(rows.map((r) => r.val), [320.5, 320.9]);
});

const NEXT_DAY = (d) => new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);

test("fred.realtimeWindows: one open-ended window for a recent start; contiguous 5-year windows, last open-ended, for a long one", () => {
  const now = new Date("2026-10-08T12:00:00Z");
  assert.deepEqual(realtimeWindows("2026-06-01", now), [{ start: "2026-06-01", end: "9999-12-31" }]);
  assert.deepEqual(realtimeWindows("2020-10-08", now), [{ start: "2020-10-08", end: "9999-12-31" }], "6 years is still one request");

  const w = realtimeWindows("2010-01-01", now);
  assert.ok(w.length >= 3);
  assert.equal(w[0].start, "2010-01-01");
  assert.equal(w.at(-1).end, "9999-12-31");
  for (let i = 1; i < w.length; i++) assert.equal(w[i].start, NEXT_DAY(w[i - 1].end), "windows are contiguous");
  for (const x of w.slice(0, -1)) assert.equal((Date.parse(x.end) - Date.parse(x.start)) / 86400000, 5 * 365 - 1);

  assert.deepEqual(realtimeWindows("2026-13-45", now), [{ start: "2026-13-45", end: "9999-12-31" }], "an unparseable date falls back to one window");
});

test("fred.fetchSeries: a long range is fetched in real-time windows; a clamped continuation row is dropped, a real revision is kept", async (t) => {
  const now = new Date("2016-03-01T00:00:00Z"); // > 6 years after 2010-01-01: two windows
  const calls = mockFetch(t, (n, u) => {
    if (n === 1) {
      return {
        body: {
          observations: [
            { realtime_start: "2012-05-02", date: "2012-05-01", value: "1.0" },
            { realtime_start: "2014-12-16", date: "2014-12-15", value: "2.0" },
          ],
        },
      };
    }
    const windowStart = u.searchParams.get("realtime_start");
    return {
      body: {
        observations: [
          { realtime_start: windowStart, date: "2014-12-15", value: "2.0" }, // still current at the boundary: clamped, same vintage
          { realtime_start: "2015-02-01", date: "2014-12-15", value: "2.5" }, // a genuine revision
          { realtime_start: "2015-03-02", date: "2015-03-01", value: "3" },
        ],
      },
    };
  });
  const rows = await fetchSeries(config, { series: "DFF", observationStart: "2010-01-01", now });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.searchParams.get("realtime_start"), "2010-01-01");
  assert.equal(calls[1].url.searchParams.get("realtime_start"), NEXT_DAY(calls[0].url.searchParams.get("realtime_end")));
  assert.equal(calls[1].url.searchParams.get("realtime_end"), "9999-12-31");
  assert.equal(calls[0].url.searchParams.get("observation_start"), "2010-01-01");
  assert.deepEqual(rows.map((r) => [r.obsDate, r.val, r.availableAt]), [
    ["2012-05-01", 1, "2012-05-03T00:00:00.000Z"],
    ["2014-12-15", 2, "2014-12-17T00:00:00.000Z"],
    ["2014-12-15", 2.5, "2015-02-02T00:00:00.000Z"],
    ["2015-03-01", 3, "2015-03-03T00:00:00.000Z"],
  ]);
});

test("fred.fetchSeries: skips '.', null, empty, non-numeric values and malformed dates (never zero-fills)", async (t) => {
  mockFetch(t, [
    {
      body: {
        observations: [
          { realtime_start: "2026-10-01", date: "2026-09-26", value: "." },
          { realtime_start: "2026-10-01", date: "2026-09-27", value: null },
          { realtime_start: "2026-10-01", date: "2026-09-28", value: "" },
          { realtime_start: "2026-10-01", date: "2026-09-29", value: "abc" },
          { realtime_start: "2026-10-01", date: "09/30/2026", value: "1.5" },
          { realtime_start: "bad", date: "2026-09-30", value: "1.5" },
          { realtime_start: "2026-10-01", date: "2026-10-01", value: "0" },
        ],
      },
    },
  ]);
  const rows = await fetchSeries(config, { series: "DFF", observationStart: "2026-06-01" });
  assert.deepEqual(rows.map((r) => [r.obsDate, r.val]), [["2026-10-01", 0]]); // a real zero is kept
});

test("fred.fetchSeries: missing/odd body shape yields no rows", async (t) => {
  mockFetch(t, [{ body: {} }]);
  assert.deepEqual(await fetchSeries(config, { series: "DFF", observationStart: "2026-06-01" }), []);
});

test("fred.fetchSeries: a missing key is a non-transient VendorError thrown before any request", async (t) => {
  const calls = mockFetch(t, [{ body: {} }]);
  await assert.rejects(
    () => fetchSeries({ ...config, fredApiKey: "" }, { series: "DFF", observationStart: "2026-06-01" }),
    (err) => err instanceof VendorError && !err.transient && /FRED_API_KEY/.test(err.message)
  );
  assert.equal(calls.length, 0);
});

test("fred.fetchSeries: observationStart must be YYYY-MM-DD", async (t) => {
  const calls = mockFetch(t, [{ body: {} }]);
  await assert.rejects(() => fetchSeries(config, { series: "DFF", observationStart: "2026-6-1" }), /YYYY-MM-DD/);
  await assert.rejects(() => fetchSeries(config, { series: "DFF" }), /YYYY-MM-DD/);
  assert.equal(calls.length, 0);
});

test("fred.fetchSeries: 429 and 5xx are transient, 4xx is not; messages never contain the api key", async (t) => {
  for (const [status, transient] of [[429, true], [500, true], [503, true], [400, false], [403, false]]) {
    mockFetch(t, [{ status }]);
    await assert.rejects(
      () => fetchSeries(config, { series: "DFF", observationStart: "2026-06-01" }),
      (err) => err instanceof VendorError && err.transient === transient && !err.message.includes(KEY)
    );
    t.mock.restoreAll();
  }
});

test("fred.fetchSeries: a non-OK error carries FRED's error_message; key/api_key scrubbed, capped, empty body adds nothing", async (t) => {
  mockFetch(t, [{ status: 400, body: { error_code: 400, error_message: "Bad Request.  The series does not exist." } }]);
  await assert.rejects(
    () => fetchSeries(config, { series: "DFF", observationStart: "2026-06-01" }),
    (err) => err.message === "FRED returned 400 for series DFF: Bad Request. The series does not exist."
  );
  t.mock.restoreAll();

  // a body that echoes the key (raw or as a query string) never reaches the message
  mockFetch(t, [{ status: 400, body: { error_message: `bad url ?api_key=${KEY}&x=1 and ${KEY}` } }]);
  await assert.rejects(
    () => fetchSeries(config, { series: "DFF", observationStart: "2026-06-01" }),
    (err) => !err.message.includes(KEY) && err.message.includes("api_key=***")
  );
  t.mock.restoreAll();

  mockFetch(t, [{ status: 400, body: { error_message: "x".repeat(1000) } }]);
  await assert.rejects(
    () => fetchSeries(config, { series: "DFF", observationStart: "2026-06-01" }),
    (err) => err.message.length < 300
  );
  t.mock.restoreAll();

  mockFetch(t, [{ status: 500 }]); // empty `{}` body: message unchanged
  await assert.rejects(
    () => fetchSeries(config, { series: "DFF", observationStart: "2026-06-01" }),
    (err) => err.message === "FRED returned 500 for series DFF" && err.transient === true
  );
});

test("fred.fetchSeries: a network failure is a transient VendorError that does not echo the URL/key", async (t) => {
  mockFetch(t, [new Error(`connect ECONNRESET ${config.fredApiBase}?api_key=${KEY}`)]);
  await assert.rejects(
    () => fetchSeries(config, { series: "DFF", observationStart: "2026-06-01" }),
    (err) => err instanceof VendorError && err.transient === true && !err.message.includes(KEY)
  );
});

test("fred.fetchLatest: runs every default series, in order, one request each", async (t) => {
  const calls = mockFetch(t, (n, u) => ({
    body: { observations: [{ realtime_start: "2026-10-01", date: "2026-09-30", value: String(n) }] },
  }));
  const { observations, errors } = await fredFetchLatest(config, { observationStart: "2026-06-01" });
  assert.deepEqual(errors, []);
  assert.deepEqual(calls.map((c) => c.url.searchParams.get("series_id")), [...DEFAULT_FRED_SERIES]);
  assert.deepEqual(observations.map((o) => o.series), [...DEFAULT_FRED_SERIES]);
});

test("fred.fetchLatest: config.fredSeries overrides the defaults; an explicit `series` arg overrides both", async (t) => {
  const calls = mockFetch(t, [{ body: { observations: [] } }]);
  await fredFetchLatest({ ...config, fredSeries: ["AAA", "BBB"] }, { observationStart: "2026-06-01" });
  assert.deepEqual(calls.map((c) => c.url.searchParams.get("series_id")), ["AAA", "BBB"]);
  calls.length = 0;
  await fredFetchLatest({ ...config, fredSeries: ["AAA", "BBB"] }, { series: ["ZZZ"], observationStart: "2026-06-01" });
  assert.deepEqual(calls.map((c) => c.url.searchParams.get("series_id")), ["ZZZ"]);
});

test("fred.fetchLatest: a VendorError on one series is collected and the others still run", async (t) => {
  mockFetch(t, (n, u) =>
    u.searchParams.get("series_id") === "DFF"
      ? { status: 500 }
      : { body: { observations: [{ realtime_start: "2026-10-01", date: "2026-09-30", value: "1" }] } }
  );
  const { observations, errors } = await fredFetchLatest(config, { series: ["DFII10", "DFF", "T10YIE"], observationStart: "2026-06-01" });
  assert.deepEqual(observations.map((o) => o.series), ["DFII10", "T10YIE"]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].series, "DFF");
  assert.ok(errors[0].error instanceof VendorError);
});

test("fred.fetchLatest: a non-VendorError (a bug / bad argument) propagates instead of being swallowed", async (t) => {
  mockFetch(t, [{ body: { observations: [] } }]);
  await assert.rejects(() => fredFetchLatest(config, { series: ["DFF"], observationStart: "nope" }), /YYYY-MM-DD/);
});

// ---------------------------------------------------------------- CFTC COT

test("cotAvailableAt: Tuesday obs_date + 4 days (Saturday 00:00Z) when never seen late", () => {
  assert.equal(cotAvailableAt("2026-09-29"), "2026-10-03T00:00:00.000Z"); // Tue -> Sat
  assert.equal(new Date("2026-10-03T00:00:00.000Z").getUTCDay(), 6);
  assert.equal(cotAvailableAt("2026-09-29", undefined), "2026-10-03T00:00:00.000Z");
  assert.equal(cotAvailableAt("2026-09-29", "not-a-date"), "2026-10-03T00:00:00.000Z");
});

test("cotAvailableAt: firstSeenAt after the release pushes availability to the next UTC day (never back-dated)", () => {
  assert.equal(cotAvailableAt("2026-09-29", "2026-10-06T13:45:00Z"), "2026-10-07T00:00:00.000Z");
  // seen BEFORE the nominal release: the release time still wins
  assert.equal(cotAvailableAt("2026-09-29", "2026-10-01T10:00:00Z"), "2026-10-03T00:00:00.000Z");
});

test("cotAvailableAt: null when obsDate is malformed", () => {
  assert.equal(cotAvailableAt("2026-9-29"), null);
  assert.equal(cotAvailableAt(undefined), null);
});

function cotRow(date, { long = 100000, short = 20000, oi = 500000, ...rest } = {}) {
  return {
    cftc_contract_market_code: GOLD_COT_CODE,
    report_date_as_yyyy_mm_dd: `${date}T00:00:00.000`,
    m_money_positions_long_all: String(long),
    m_money_positions_short_all: String(short),
    open_interest_all: String(oi),
    ...rest,
  };
}

test("cot.fetchLatest: Socrata request shape (gold code filter, from date, ASC order, limit, optional app token)", async (t) => {
  const calls = mockFetch(t, [{ body: [] }]);
  await cotFetchLatest(config, { from: "2026-06-01" });
  const p = calls[0].url.searchParams;
  assert.equal(calls[0].url.origin + calls[0].url.pathname, config.cotApiBase);
  assert.match(p.get("$where"), new RegExp(`cftc_contract_market_code='${GOLD_COT_CODE}'`));
  assert.match(p.get("$where"), /report_date_as_yyyy_mm_dd >= '2026-06-01T00:00:00\.000'/);
  assert.equal(p.get("$order"), "report_date_as_yyyy_mm_dd ASC");
  assert.equal(p.get("$limit"), "5000");
  assert.equal(calls[0].headers["X-App-Token"], undefined);

  await cotFetchLatest({ ...config, cotAppToken: "tok-1" }, { from: "2026-06-01" });
  assert.equal(calls[1].headers["X-App-Token"], "tok-1");
});

test("cot.fetchLatest: three series rows per report week with numeric values and the cftc source", async (t) => {
  mockFetch(t, [{ body: [cotRow("2026-09-29", { long: 150000, short: 25000, oi: 480000 })] }]);
  const rows = await cotFetchLatest(config, { from: "2026-06-01" });
  assert.deepEqual(rows, [
    { series: COT_SERIES.MM_LONG, obsDate: "2026-09-29", availableAt: "2026-10-03T00:00:00.000Z", val: 150000, source: "cftc" },
    { series: COT_SERIES.MM_SHORT, obsDate: "2026-09-29", availableAt: "2026-10-03T00:00:00.000Z", val: 25000, source: "cftc" },
    { series: COT_SERIES.OPEN_INTEREST, obsDate: "2026-09-29", availableAt: "2026-10-03T00:00:00.000Z", val: 480000, source: "cftc" },
  ]);
});

test("cot.fetchLatest: firstSeenAt stamps a late pickup no earlier than the next UTC day", async (t) => {
  mockFetch(t, [{ body: [cotRow("2026-09-29")] }]);
  const rows = await cotFetchLatest(config, { from: "2026-06-01", firstSeenAt: "2026-10-06T13:45:00Z" });
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.availableAt === "2026-10-07T00:00:00.000Z"));
});

test("cot.fetchLatest: skipObsDates drops weeks already stored", async (t) => {
  mockFetch(t, [{ body: [cotRow("2026-09-22"), cotRow("2026-09-29")] }]);
  const rows = await cotFetchLatest(config, { from: "2026-06-01", skipObsDates: new Set(["2026-09-22"]) });
  assert.deepEqual([...new Set(rows.map((r) => r.obsDate))], ["2026-09-29"]);
});

test("cot.fetchLatest: a row missing any required field (or with a non-numeric one) is skipped whole, never zero-filled", async (t) => {
  mockFetch(t, [
    {
      body: [
        { ...cotRow("2026-09-01"), m_money_positions_long_all: undefined },
        { ...cotRow("2026-09-08"), m_money_positions_short_all: undefined },
        { ...cotRow("2026-09-15"), open_interest_all: "" },
        cotRow("2026-09-22", { oi: "n/a" }),
        { ...cotRow("2026-09-29"), report_date_as_yyyy_mm_dd: "garbage" },
        cotRow("2026-10-06", { short: 0 }), // a real zero is kept
      ],
    },
  ]);
  const rows = await cotFetchLatest(config, { from: "2026-06-01" });
  assert.deepEqual([...new Set(rows.map((r) => r.obsDate))], ["2026-10-06"]);
  assert.equal(rows.find((r) => r.series === COT_SERIES.MM_SHORT).val, 0);
});

test("cot.fetchLatest: non-array body yields no rows; `from` must be YYYY-MM-DD", async (t) => {
  const calls = mockFetch(t, [{ body: { error: "x" } }]);
  assert.deepEqual(await cotFetchLatest(config, { from: "2026-06-01" }), []);
  await assert.rejects(() => cotFetchLatest(config, { from: "June" }), /YYYY-MM-DD/);
  await assert.rejects(() => cotFetchLatest(config, {}), /YYYY-MM-DD/);
  assert.equal(calls.length, 1);
});

test("cot.fetchLatest: 429/5xx transient, 4xx not; network failure transient", async (t) => {
  for (const [status, transient] of [[429, true], [502, true], [404, false]]) {
    mockFetch(t, [{ status }]);
    await assert.rejects(
      () => cotFetchLatest(config, { from: "2026-06-01" }),
      (err) => err instanceof VendorError && err.transient === transient
    );
    t.mock.restoreAll();
  }
  mockFetch(t, [new Error("socket hang up")]);
  await assert.rejects(
    () => cotFetchLatest(config, { from: "2026-06-01" }),
    (err) => err instanceof VendorError && err.transient === true
  );
});
