// Covers the XAUUSD macro storage + wiring around the adapters tested in
// macro_adapters.test.js:
//   - storage/inputs_view.js: insertMacroObservations (idempotent, revisions are NEW
//     rows), getStoredMacroObsDates, getMacroSnapshotAsOf (required asOf, nothing
//     visible before its available_at, a revision only after ITS available_at),
//     getIngestionHealth().macro (counts; an inputs DB without migration 0005 still
//     reports health).
//   - storage/macro_flag.js: fail-closed (no row / no binding / any D1 error = OFF).
//   - ingestion/ingest.js#ingestMacro: FRED + COT end to end against real SQL with
//     global fetch mocked; per-half failure isolation; a missing key skips FRED only;
//     COT seeding vs later-run availability stamps; ingestTickerData's gate.
//
// Real SQL through the sqlite D1 adapter (the migration itself is exercised).
// Nothing here has touched the real FRED or CFTC APIs.

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { loadConfig } from "../src/config.js";
import { LookaheadViolationError } from "../src/shared/errors.js";
import {
  insertMacroObservations,
  getStoredMacroObsDates,
  getMacroSnapshotAsOf,
  getIngestionHealth,
} from "../src/storage/inputs_view.js";
import { MACRO_FLAG_KEY, getMacroFlag, isMacroEnabled, setMacroEnabled } from "../src/storage/macro_flag.js";
import { ingestMacro, ingestTickerData, MACRO_TICKER } from "../src/ingestion/ingest.js";
import { DEFAULT_FRED_SERIES } from "../src/ingestion/sources/fred.js";
import { COT_SERIES, GOLD_COT_CODE, cotAvailableAt } from "../src/ingestion/sources/cftc_cot.js";

const INPUTS_DIR = fileURLToPath(new URL("../migrations/inputs", import.meta.url));
const STATE_DIR = fileURLToPath(new URL("../migrations/state", import.meta.url));

const obs = (series, obsDate, availableAt, val, source = "fred") => ({ series, obsDate, availableAt, val, source });

async function allRows(db) {
  const { results } = await db
    .prepare(`SELECT series, obs_date, available_at, val, source FROM macro_observations ORDER BY series, obs_date, available_at`)
    .all();
  return results;
}

function silenceLogs(t) {
  for (const m of ["warn", "error", "log", "info"]) t.mock.method(console, m, () => {});
}

// ------------------------------------------------------------ storage

test("insertMacroObservations: no-op on empty, idempotent on a re-seen vintage, a revision is a NEW row", async () => {
  const db = createTestD1([INPUTS_DIR]);
  assert.equal(await insertMacroObservations(db, []), 0);
  assert.equal((await allRows(db)).length, 0);

  const first = obs("CPIAUCSL", "2026-08-01", "2026-09-16T00:00:00.000Z", 320.5);
  assert.equal(await insertMacroObservations(db, [first]), 1);
  await insertMacroObservations(db, [first]); // same vintage again
  assert.equal((await allRows(db)).length, 1);

  await insertMacroObservations(db, [obs("CPIAUCSL", "2026-08-01", "2026-10-15T00:00:00.000Z", 320.9)]); // revised
  const rows = await allRows(db);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.val), [320.5, 320.9]); // the original was NOT overwritten
});

test("insertMacroObservations: chunks large batches (>200 rows) without losing any", async () => {
  const db = createTestD1([INPUTS_DIR]);
  const many = Array.from({ length: 450 }, (_, i) => {
    const d = new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10);
    return obs("DFF", d, `${d}T00:00:00.000Z`, 4 + i / 1000);
  });
  assert.equal(await insertMacroObservations(db, many), 450);
  assert.equal((await allRows(db)).length, 450);
});

test("getStoredMacroObsDates: distinct obs_dates of one series on/after `from`", async () => {
  const db = createTestD1([INPUTS_DIR]);
  await insertMacroObservations(db, [
    obs(COT_SERIES.MM_LONG, "2026-09-15", "2026-09-19T00:00:00.000Z", 1, "cftc"),
    obs(COT_SERIES.MM_LONG, "2026-09-22", "2026-09-26T00:00:00.000Z", 2, "cftc"),
    obs(COT_SERIES.MM_LONG, "2026-09-22", "2026-09-30T00:00:00.000Z", 3, "cftc"), // second vintage, same date
    obs(COT_SERIES.MM_SHORT, "2026-09-29", "2026-10-03T00:00:00.000Z", 4, "cftc"), // other series
  ]);
  const dates = await getStoredMacroObsDates(db, { series: COT_SERIES.MM_LONG, from: "2026-09-20" });
  assert.deepEqual([...dates], ["2026-09-22"]);
  assert.equal((await getStoredMacroObsDates(db, { series: "NOPE", from: "2026-01-01" })).size, 0);
});

test("getMacroSnapshotAsOf: asOf is required and must parse (LookaheadViolationError)", async () => {
  const db = createTestD1([INPUTS_DIR]);
  await assert.rejects(() => getMacroSnapshotAsOf(db, {}), LookaheadViolationError);
  await assert.rejects(() => getMacroSnapshotAsOf(db, { asOf: "yesterday-ish" }), LookaheadViolationError);
});

test("getMacroSnapshotAsOf: an observation is invisible BEFORE its available_at and visible from it on", async () => {
  const db = createTestD1([INPUTS_DIR]);
  await insertMacroObservations(db, [obs("DFII10", "2026-09-30", "2026-10-02T00:00:00.000Z", 1.9)]);

  assert.deepEqual(await getMacroSnapshotAsOf(db, { asOf: "2026-10-01T23:59:59.999Z" }), {});
  const at = await getMacroSnapshotAsOf(db, { asOf: "2026-10-02T00:00:00.000Z" });
  assert.deepEqual(at, { DFII10: [{ obsDate: "2026-09-30", availableAt: "2026-10-02T00:00:00.000Z", val: 1.9 }] });
});

test("getMacroSnapshotAsOf: a revision only replaces the original once ITS available_at has passed (the point-in-time guarantee)", async () => {
  const db = createTestD1([INPUTS_DIR]);
  await insertMacroObservations(db, [
    obs("CPIAUCSL", "2026-08-01", "2026-09-16T00:00:00.000Z", 320.5),
    obs("CPIAUCSL", "2026-08-01", "2026-10-15T00:00:00.000Z", 320.9),
  ]);

  const before = await getMacroSnapshotAsOf(db, { asOf: "2026-10-01T00:00:00Z" });
  assert.equal(before.CPIAUCSL.length, 1);
  assert.equal(before.CPIAUCSL[0].val, 320.5); // the revision must not leak into the past

  const after = await getMacroSnapshotAsOf(db, { asOf: "2026-10-20T00:00:00Z" });
  assert.equal(after.CPIAUCSL.length, 1); // one row per obs_date, the newer vintage wins
  assert.equal(after.CPIAUCSL[0].val, 320.9);
  assert.equal(after.CPIAUCSL[0].availableAt, "2026-10-15T00:00:00.000Z");
});

test("getMacroSnapshotAsOf: newest obs first per series, perSeries caps each series, series without data are absent", async () => {
  const db = createTestD1([INPUTS_DIR]);
  await insertMacroObservations(db, [
    obs("DFF", "2026-09-28", "2026-09-29T00:00:00.000Z", 4.1),
    obs("DFF", "2026-09-29", "2026-09-30T00:00:00.000Z", 4.2),
    obs("DFF", "2026-09-30", "2026-10-01T00:00:00.000Z", 4.3),
    obs("T10YIE", "2026-09-30", "2026-10-01T00:00:00.000Z", 2.3),
    obs("DTWEXBGS", "2026-09-30", "2026-10-09T00:00:00.000Z", 120), // not available yet at asOf
  ]);
  const snap = await getMacroSnapshotAsOf(db, { asOf: "2026-10-05T00:00:00Z", perSeries: 2 });
  assert.deepEqual(Object.keys(snap).sort(), ["DFF", "T10YIE"]);
  assert.deepEqual(snap.DFF.map((r) => r.obsDate), ["2026-09-30", "2026-09-29"]);
  assert.equal(snap.T10YIE.length, 1);
});

test("getMacroSnapshotAsOf: windowDays bounds how far back obs_date may reach", async () => {
  const db = createTestD1([INPUTS_DIR]);
  await insertMacroObservations(db, [
    obs("DFF", "2025-01-01", "2025-01-02T00:00:00.000Z", 5.3), // ~21 months before asOf
    obs("DFF", "2026-09-30", "2026-10-01T00:00:00.000Z", 4.3),
  ]);
  const wide = await getMacroSnapshotAsOf(db, { asOf: "2026-10-05T00:00:00Z", windowDays: 800 });
  assert.equal(wide.DFF.length, 2);
  const narrow = await getMacroSnapshotAsOf(db, { asOf: "2026-10-05T00:00:00Z" }); // default 400 days
  assert.deepEqual(narrow.DFF.map((r) => r.obsDate), ["2026-09-30"]);
});

test("getIngestionHealth: reports macro count + last ingested; an inputs DB without macro_observations still reports health", async (t) => {
  const db = createTestD1([INPUTS_DIR]);
  assert.deepEqual((await getIngestionHealth(db)).macro, { count: 0, lastIngestedAt: null });
  await insertMacroObservations(db, [obs("DFF", "2026-09-30", "2026-10-01T00:00:00.000Z", 4.3)]);
  const health = await getIngestionHealth(db);
  assert.equal(health.macro.count, 1);
  assert.ok(health.macro.lastIngestedAt);

  t.mock.method(console, "warn", () => {});
  db.exec("DROP TABLE macro_observations");
  const old = await getIngestionHealth(db);
  assert.deepEqual(old.macro, { count: 0, lastIngestedAt: null });
  assert.equal(old.news.count, 0); // the other tables are unaffected
});

// ------------------------------------------------------------ flag (fail closed)

test("getMacroFlag: no binding, no row -> OFF without an error", async () => {
  assert.deepEqual(await getMacroFlag(undefined), { enabled: false, updatedAt: null, updatedBy: null, error: null });
  const db = createTestD1([STATE_DIR]);
  assert.deepEqual(await getMacroFlag(db), { enabled: false, updatedAt: null, updatedBy: null, error: null });
  assert.equal(await isMacroEnabled(db), false);
});

test("setMacroEnabled / getMacroFlag round trip: on, off; ON is stored as paused=0; one upserted row", async () => {
  const db = createTestD1([STATE_DIR]);
  const on = await setMacroEnabled(db, true, { by: "dashboard", now: "2026-10-07T10:00:00.000Z" });
  assert.deepEqual(on, { enabled: true, updatedAt: "2026-10-07T10:00:00.000Z", updatedBy: "dashboard" });
  const row = await db.prepare(`SELECT paused FROM system_flags WHERE key = ?`).bind(MACRO_FLAG_KEY).first();
  assert.equal(Number(row.paused), 0);
  assert.deepEqual(await getMacroFlag(db), { enabled: true, updatedAt: "2026-10-07T10:00:00.000Z", updatedBy: "dashboard", error: null });
  assert.equal(await isMacroEnabled(db), true);

  await setMacroEnabled(db, false, { by: "dashboard", now: "2026-10-07T11:00:00.000Z" });
  const off = await getMacroFlag(db);
  assert.equal(off.enabled, false);
  assert.equal(off.updatedAt, "2026-10-07T11:00:00.000Z");
  const count = await db.prepare(`SELECT COUNT(*) AS n FROM system_flags WHERE key = ?`).bind(MACRO_FLAG_KEY).first();
  assert.equal(count.n, 1);
});

test("setMacroEnabled: `by` is optional (null) and truncated to 64 chars", async () => {
  const db = createTestD1([STATE_DIR]);
  assert.equal((await setMacroEnabled(db, true)).updatedBy, null);
  assert.equal((await setMacroEnabled(db, true, { by: "x".repeat(200) })).updatedBy.length, 64);
});

test("getMacroFlag: any D1 error reads as OFF (logged, error surfaced), never throws", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const broken = {
    prepare() {
      throw new Error("D1 unavailable");
    },
  };
  const flag = await getMacroFlag(broken);
  assert.equal(flag.enabled, false);
  assert.equal(flag.error, "D1 unavailable");
  assert.equal(await isMacroEnabled(broken), false);
  assert.ok(warn.mock.callCount() >= 1);
});

test("getMacroFlag: a DB whose flag table is gone is OFF even if the feature was enabled before", async (t) => {
  t.mock.method(console, "warn", () => {});
  const db = createTestD1([STATE_DIR]);
  await setMacroEnabled(db, true);
  db.exec("DROP TABLE system_flags");
  assert.equal((await getMacroFlag(db)).enabled, false);
});

// ------------------------------------------------------------ ingestMacro wiring

const FRED_BASE = "https://fred.example/series/observations";
const COT_BASE = "https://cot.example/resource/72hh-3qpy.json";
const config = {
  ...loadConfig({}),
  fredApiKey: "test-fred-key",
  fredApiBase: FRED_BASE,
  fredMinRequestIntervalMs: 0,
  cotApiBase: COT_BASE,
  cotAppToken: "",
  macroLookbackDays: 120,
};

function cotRow(date, { long = 100000, short = 20000, oi = 500000 } = {}) {
  return {
    cftc_contract_market_code: GOLD_COT_CODE,
    report_date_as_yyyy_mm_dd: `${date}T00:00:00.000`,
    m_money_positions_long_all: String(long),
    m_money_positions_short_all: String(short),
    open_interest_all: String(oi),
  };
}

/** Routes global fetch by URL prefix. `fred`/`cot` are specs ({status, body}) or (url) => spec; calls are recorded per route. */
function mockVendors(t, { fred, cot, other = { status: 404, body: {} } }) {
  const calls = { fred: [], cot: [], other: [] };
  t.mock.method(global, "fetch", async (url, init) => {
    const u = new URL(String(url));
    const kind = String(url).startsWith(FRED_BASE) ? "fred" : String(url).startsWith(COT_BASE) ? "cot" : "other";
    calls[kind].push({ url: u, headers: init?.headers });
    const route = { fred, cot, other }[kind];
    const spec = typeof route === "function" ? route(u) : route;
    if (spec instanceof Error) throw spec;
    const { status = 200, body = {} } = spec ?? {};
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
  });
  return calls;
}

const okFred = () => ({ body: { observations: [{ realtime_start: "2026-10-01", date: "2026-09-30", value: "1.9" }] } });

test("ingestMacro: stores FRED (every default series) + COT (three series) with point-in-time stamps", async (t) => {
  silenceLogs(t);
  const db = createTestD1([INPUTS_DIR]);
  const calls = mockVendors(t, { fred: okFred, cot: { body: [cotRow("2026-09-29", { long: 150000, short: 25000, oi: 480000 })] } });

  const res = await ingestMacro(config, db, { asOf: "2026-10-07T12:00:00Z" });
  assert.deepEqual(res, { count: DEFAULT_FRED_SERIES.length + 3, fredCount: DEFAULT_FRED_SERIES.length, cotCount: 3 });

  // lookback: asOf - 120 days = 2026-06-09, sent to both vendors
  assert.ok(calls.fred.every((c) => c.url.searchParams.get("observation_start") === "2026-06-09"));
  assert.match(calls.cot[0].url.searchParams.get("$where"), /2026-06-09T00:00:00\.000/);

  const rows = await allRows(db);
  const fredRows = rows.filter((r) => r.source === "fred");
  assert.deepEqual(fredRows.map((r) => r.series).sort(), [...DEFAULT_FRED_SERIES].sort());
  assert.ok(fredRows.every((r) => r.available_at === "2026-10-02T00:00:00.000Z"));
  const cotRows = rows.filter((r) => r.source === "cftc");
  assert.equal(cotRows.length, 3);
  assert.ok(cotRows.every((r) => r.available_at === "2026-10-03T00:00:00.000Z")); // seeding run: release-derived

  // and the snapshot honours those stamps
  const early = await getMacroSnapshotAsOf(db, { asOf: "2026-10-02T12:00:00Z" });
  assert.deepEqual(Object.keys(early).sort(), [...DEFAULT_FRED_SERIES].sort()); // COT not yet released
  const later = await getMacroSnapshotAsOf(db, { asOf: "2026-10-04T00:00:00Z" });
  assert.equal(later[COT_SERIES.MM_LONG][0].val, 150000);
});

test("ingestMacro: running twice is idempotent (no duplicate rows)", async (t) => {
  silenceLogs(t);
  const db = createTestD1([INPUTS_DIR]);
  mockVendors(t, { fred: okFred, cot: { body: [cotRow("2026-09-29")] } });
  await ingestMacro(config, db, { asOf: "2026-10-07T12:00:00Z" });
  const n = (await allRows(db)).length;
  await ingestMacro(config, db, { asOf: "2026-10-07T12:00:00Z" });
  assert.equal((await allRows(db)).length, n);
});

test("ingestMacro: a missing FRED key skips FRED only (no FRED request, COT still stored, logged)", async (t) => {
  silenceLogs(t);
  const db = createTestD1([INPUTS_DIR]);
  const calls = mockVendors(t, { fred: okFred, cot: { body: [cotRow("2026-09-29")] } });
  const res = await ingestMacro({ ...config, fredApiKey: "" }, db, { asOf: "2026-10-07T12:00:00Z" });
  assert.deepEqual(res, { count: 3, fredCount: 0, cotCount: 3 });
  assert.equal(calls.fred.length, 0);
  assert.ok((await allRows(db)).every((r) => r.source === "cftc"));
});

test("ingestMacro: FRED failing (VendorError) does not stop COT", async (t) => {
  silenceLogs(t);
  const db = createTestD1([INPUTS_DIR]);
  mockVendors(t, { fred: { status: 403 }, cot: { body: [cotRow("2026-09-29")] } });
  const res = await ingestMacro(config, db, { asOf: "2026-10-07T12:00:00Z" });
  assert.equal(res.fredCount, 0);
  assert.equal(res.cotCount, 3);
});

test("ingestMacro: COT failing (VendorError) does not lose FRED", async (t) => {
  silenceLogs(t);
  const db = createTestD1([INPUTS_DIR]);
  mockVendors(t, { fred: okFred, cot: { status: 404 } });
  const res = await ingestMacro(config, db, { asOf: "2026-10-07T12:00:00Z" });
  assert.equal(res.fredCount, DEFAULT_FRED_SERIES.length);
  assert.equal(res.cotCount, 0);
});

test("ingestMacro: one FRED series failing keeps the others", async (t) => {
  silenceLogs(t);
  const db = createTestD1([INPUTS_DIR]);
  const bad = DEFAULT_FRED_SERIES[1];
  mockVendors(t, {
    fred: (u) => (u.searchParams.get("series_id") === bad ? { status: 400 } : okFred()),
    cot: { body: [] },
  });
  const res = await ingestMacro(config, db, { asOf: "2026-10-07T12:00:00Z" });
  assert.equal(res.fredCount, DEFAULT_FRED_SERIES.length - 1);
  assert.ok(!(await allRows(db)).some((r) => r.series === bad));
});

test("ingestMacro COT: seeding keeps release-derived availability; a LATER new week is stamped first-seen (never back-dated); stored weeks are not re-inserted", async (t) => {
  silenceLogs(t);
  const db = createTestD1([INPUTS_DIR]);
  const cfg = { ...config, fredApiKey: "" };

  // seeding run: nothing stored yet
  mockVendors(t, { cot: { body: [cotRow("2026-09-22"), cotRow("2026-09-29")] } });
  await ingestMacro(cfg, db, { asOf: "2026-10-07T12:00:00Z" });
  let rows = (await allRows(db)).filter((r) => r.series === COT_SERIES.MM_LONG);
  assert.deepEqual(
    rows.map((r) => [r.obs_date, r.available_at]),
    [
      ["2026-09-22", cotAvailableAt("2026-09-22")],
      ["2026-09-29", cotAvailableAt("2026-09-29")],
    ]
  );
  t.mock.method(global, "fetch").mock.restore(); // drop the seeding mock before installing the next one

  // later run: the 10-06 week shows up late (Wed 10-14 13:45Z, days after its nominal release)
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-14T13:45:00Z") });
  mockVendors(t, { cot: { body: [cotRow("2026-09-22"), cotRow("2026-09-29"), cotRow("2026-10-06")] } });
  const res = await ingestMacro(cfg, db, { asOf: "2026-10-14T13:45:00Z" });
  assert.equal(res.cotCount, 3); // only the new week's three series

  rows = (await allRows(db)).filter((r) => r.series === COT_SERIES.MM_LONG);
  assert.equal(rows.length, 3); // the two stored weeks were skipped, not duplicated under a later availability
  const added = rows.find((r) => r.obs_date === "2026-10-06");
  assert.equal(added.available_at, "2026-10-15T00:00:00.000Z"); // first seen 10-14 -> usable from the next UTC day
  assert.ok(added.available_at > cotAvailableAt("2026-10-06")); // later than the nominal release: not back-dated
});

// ------------------------------------------------------------ ingestTickerData gate

test("ingestTickerData: macroEnabled false (the default) makes NO macro fetches and writes no macro rows", async (t) => {
  silenceLogs(t);
  const db = createTestD1([INPUTS_DIR]);
  const calls = mockVendors(t, { fred: okFred, cot: { body: [cotRow("2026-09-29")] } });
  await ingestTickerData(config, db, undefined, { ticker: MACRO_TICKER, asOf: "2026-10-07T12:00:00Z" });
  await ingestTickerData(config, db, undefined, { ticker: MACRO_TICKER, asOf: "2026-10-07T12:00:00Z", macroEnabled: false });
  assert.equal(calls.fred.length, 0);
  assert.equal(calls.cot.length, 0);
  assert.equal((await allRows(db)).length, 0);
});

test("ingestTickerData: macroEnabled is ignored for any ticker other than XAUUSD", async (t) => {
  silenceLogs(t);
  const db = createTestD1([INPUTS_DIR]);
  const calls = mockVendors(t, { fred: okFred, cot: { body: [cotRow("2026-09-29")] } });
  await ingestTickerData(config, db, undefined, { ticker: "AAPL", asOf: "2026-10-07T12:00:00Z", macroEnabled: true });
  assert.equal(calls.fred.length, 0);
  assert.equal(calls.cot.length, 0);
});

test("ingestTickerData: XAUUSD + macroEnabled ingests macro", async (t) => {
  silenceLogs(t);
  const db = createTestD1([INPUTS_DIR]);
  mockVendors(t, { fred: okFred, cot: { body: [cotRow("2026-09-29")] } });
  const res = await ingestTickerData(config, db, undefined, { ticker: MACRO_TICKER, asOf: "2026-10-07T12:00:00Z", macroEnabled: true });
  assert.ok(Array.isArray(res.fresh));
  assert.ok((await allRows(db)).length > 0);
});

test("ingestTickerData: a macro failure never loses the tick's result", async (t) => {
  silenceLogs(t);
  const db = createTestD1([INPUTS_DIR]);
  db.exec("DROP TABLE macro_observations"); // makes the macro half throw a NON-vendor error
  mockVendors(t, { fred: okFred, cot: { body: [cotRow("2026-09-29")] } });
  const res = await ingestTickerData(config, db, undefined, { ticker: MACRO_TICKER, asOf: "2026-10-07T12:00:00Z", macroEnabled: true });
  assert.ok(Array.isArray(res.fresh)); // returned normally despite the macro failure
});
