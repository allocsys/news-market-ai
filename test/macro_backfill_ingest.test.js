// Covers the operator-triggered macro BACKFILL options of ingestion/ingest.js#ingestMacro
// ({ from, backfill }), the half of the macro-backfill feature that
// macro_storage_ingest.test.js (live ticks) does not touch:
//   - `from` (YYYY-MM-DD) overrides the lookback window as the observation start for
//     BOTH vendors; a malformed `from` falls back to the lookback window.
//   - `backfill: true` keeps COT availability release-derived even when live ticks
//     already stored recent weeks (otherwise old weeks would be stamped "first seen
//     today" and be unusable for historical backtests); without it, a later-seen
//     week is stamped first-seen (the contrast test pins why the flag exists).
//   - weeks already stored keep their stamps (skipObsDates); a rerun is idempotent;
//     a missing FRED key skips FRED only.
//
// Real SQL through the sqlite D1 adapter; global fetch mocked. Nothing here has
// touched the real FRED or CFTC APIs.

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { loadConfig } from "../src/config.js";
import { getMacroSnapshotAsOf } from "../src/storage/inputs_view.js";
import { ingestMacro } from "../src/ingestion/ingest.js";
import { DEFAULT_FRED_SERIES } from "../src/ingestion/sources/fred.js";
import { COT_SERIES, GOLD_COT_CODE, cotAvailableAt } from "../src/ingestion/sources/cftc_cot.js";

const INPUTS_DIR = fileURLToPath(new URL("../migrations/inputs", import.meta.url));

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

const AS_OF = "2026-10-07T12:00:00Z";
const LOOKBACK_START = "2026-06-09"; // AS_OF - 120 days

async function allRows(db) {
  const { results } = await db
    .prepare(`SELECT series, obs_date, available_at, val, source FROM macro_observations ORDER BY series, obs_date, available_at`)
    .all();
  return results;
}

function silenceLogs(t) {
  for (const m of ["warn", "error", "log", "info"]) t.mock.method(console, m, () => {});
}

function cotRow(date, { long = 100000, short = 20000, oi = 500000 } = {}) {
  return {
    cftc_contract_market_code: GOLD_COT_CODE,
    report_date_as_yyyy_mm_dd: `${date}T00:00:00.000`,
    m_money_positions_long_all: String(long),
    m_money_positions_short_all: String(short),
    open_interest_all: String(oi),
  };
}

const okFred = () => ({ body: { observations: [{ realtime_start: "2026-10-01", date: "2026-09-30", value: "1.9" }] } });

/** Routes global fetch by URL prefix; `fred`/`cot` are specs ({status, body}) or (url) => spec. Calls are recorded per route. */
function mockVendors(t, { fred, cot }) {
  const calls = { fred: [], cot: [] };
  t.mock.method(global, "fetch", async (url) => {
    const u = new URL(String(url));
    const kind = String(url).startsWith(FRED_BASE) ? "fred" : String(url).startsWith(COT_BASE) ? "cot" : null;
    if (!kind) return { ok: false, status: 404, json: async () => ({}), text: async () => "{}" };
    calls[kind].push({ url: u });
    const route = { fred, cot }[kind];
    const { status = 200, body = {} } = (typeof route === "function" ? route(u) : route) ?? {};
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
  });
  return calls;
}

const cotLong = (rows) => rows.filter((r) => r.series === COT_SERIES.MM_LONG);

// ------------------------------------------------------------ `from` override

test("ingestMacro: `from` overrides the lookback window as the observation start for BOTH vendors", async (t) => {
  silenceLogs(t);
  const db = createTestD1([INPUTS_DIR]);
  const calls = mockVendors(t, { fred: okFred, cot: { body: [cotRow("2024-01-02")] } });

  const res = await ingestMacro(config, db, { asOf: AS_OF, from: "2024-01-01" });
  assert.equal(res.fredCount, DEFAULT_FRED_SERIES.length);
  assert.equal(res.cotCount, 3);

  assert.equal(calls.fred.length, DEFAULT_FRED_SERIES.length);
  assert.ok(calls.fred.every((c) => c.url.searchParams.get("observation_start") === "2024-01-01"));
  assert.match(calls.cot[0].url.searchParams.get("$where"), /report_date_as_yyyy_mm_dd >= '2024-01-01T00:00:00\.000'/);
  assert.ok(!calls.cot[0].url.searchParams.get("$where").includes(LOOKBACK_START));
});

test("ingestMacro: a malformed `from` falls back to the lookback window (callers validate; this is only the safety net)", async (t) => {
  silenceLogs(t);
  const db = createTestD1([INPUTS_DIR]);
  const calls = mockVendors(t, { fred: okFred, cot: { body: [] } });

  for (const bad of ["2024-1-1", "garbage", "2024-01-01T00:00:00Z", "", 20240101, null, undefined]) {
    calls.fred.length = 0;
    calls.cot.length = 0;
    await ingestMacro(config, db, { asOf: AS_OF, from: bad });
    assert.ok(calls.fred.length > 0, `FRED called for from=${String(bad)}`);
    assert.ok(
      calls.fred.every((c) => c.url.searchParams.get("observation_start") === LOOKBACK_START),
      `FRED lookback start for from=${String(bad)}`
    );
    assert.match(calls.cot[0].url.searchParams.get("$where"), new RegExp(`'${LOOKBACK_START}T00:00:00\\.000'`), `COT lookback start for from=${String(bad)}`);
  }
});

// ------------------------------------------------------------ backfill availability

test("ingestMacro backfill into an empty DB: full history stored, COT availability is release-derived and the snapshot honours it", async (t) => {
  silenceLogs(t);
  const db = createTestD1([INPUTS_DIR]);
  const calls = mockVendors(t, { fred: okFred, cot: { body: [cotRow("2026-01-06"), cotRow("2026-01-13"), cotRow("2026-01-20")] } });

  const res = await ingestMacro(config, db, { asOf: AS_OF, from: "2026-01-01", backfill: true });
  assert.deepEqual(res, { count: DEFAULT_FRED_SERIES.length + 9, fredCount: DEFAULT_FRED_SERIES.length, cotCount: 9 });
  assert.ok(calls.fred.every((c) => c.url.searchParams.get("observation_start") === "2026-01-01"));

  const rows = cotLong(await allRows(db));
  assert.deepEqual(
    rows.map((r) => [r.obs_date, r.available_at]),
    [
      ["2026-01-06", "2026-01-10T00:00:00.000Z"],
      ["2026-01-13", "2026-01-17T00:00:00.000Z"],
      ["2026-01-20", "2026-01-24T00:00:00.000Z"],
    ]
  );

  // point in time: the 01-06 week is invisible just before its release, visible from it
  const before = await getMacroSnapshotAsOf(db, { asOf: "2026-01-09T23:59:59.999Z" });
  assert.equal(before[COT_SERIES.MM_LONG], undefined);
  const at = await getMacroSnapshotAsOf(db, { asOf: "2026-01-10T00:00:00.000Z" });
  assert.deepEqual(at[COT_SERIES.MM_LONG].map((r) => r.obsDate), ["2026-01-06"]);
});

test("ingestMacro backfill: with recent weeks already stored by live ticks, OLDER weeks still get release-derived availability and stored weeks keep their stamps", async (t) => {
  silenceLogs(t);
  const db = createTestD1([INPUTS_DIR]);
  const cfg = { ...config, fredApiKey: "" };
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-14T13:45:00Z") });
  let cotBody = [cotRow("2026-09-29")];
  mockVendors(t, { cot: () => ({ body: cotBody }) });

  // a live (seeding) tick stored the latest week
  await ingestMacro(cfg, db, { asOf: "2026-10-14T13:45:00Z" });
  assert.equal(cotLong(await allRows(db)).length, 1);

  // operator backfill from January: the old week arrives, the stored one is returned again
  cotBody = [cotRow("2026-01-06"), cotRow("2026-09-29")];
  const res = await ingestMacro(cfg, db, { asOf: "2026-10-14T13:45:00Z", from: "2026-01-01", backfill: true });
  assert.equal(res.cotCount, 3); // only the new week's three series

  const rows = cotLong(await allRows(db));
  assert.equal(rows.length, 2); // the stored week was skipped, not duplicated
  assert.deepEqual(
    rows.map((r) => [r.obs_date, r.available_at]),
    [
      ["2026-01-06", cotAvailableAt("2026-01-06")], // 2026-01-10 -- NOT first-seen-today
      ["2026-09-29", cotAvailableAt("2026-09-29")], // unchanged
    ]
  );
});

test("ingestMacro WITHOUT backfill (contrast): the same older week is stamped first-seen, which is why the flag exists", async (t) => {
  silenceLogs(t);
  const db = createTestD1([INPUTS_DIR]);
  const cfg = { ...config, fredApiKey: "" };
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-14T13:45:00Z") });
  let cotBody = [cotRow("2026-09-29")];
  mockVendors(t, { cot: () => ({ body: cotBody }) });

  await ingestMacro(cfg, db, { asOf: "2026-10-14T13:45:00Z" });
  cotBody = [cotRow("2026-01-06"), cotRow("2026-09-29")];
  await ingestMacro(cfg, db, { asOf: "2026-10-14T13:45:00Z", from: "2026-01-01" }); // from only, backfill left false

  const old = cotLong(await allRows(db)).find((r) => r.obs_date === "2026-01-06");
  assert.equal(old.available_at, "2026-10-15T00:00:00.000Z"); // first seen 10-14 -> next UTC day
});

// ------------------------------------------------------------ idempotence / isolation

test("ingestMacro backfill: rerunning the same backfill is idempotent (no duplicate rows, stamps unchanged)", async (t) => {
  silenceLogs(t);
  const db = createTestD1([INPUTS_DIR]);
  mockVendors(t, { fred: okFred, cot: { body: [cotRow("2026-01-06"), cotRow("2026-01-13")] } });

  await ingestMacro(config, db, { asOf: AS_OF, from: "2026-01-01", backfill: true });
  const first = await allRows(db);
  const again = await ingestMacro(config, db, { asOf: AS_OF, from: "2026-01-01", backfill: true });
  assert.equal(again.cotCount, 0); // every COT week is already stored
  assert.deepEqual(await allRows(db), first);
});

test("ingestMacro backfill: a missing FRED key skips FRED only (no FRED request) and still stores COT", async (t) => {
  silenceLogs(t);
  const db = createTestD1([INPUTS_DIR]);
  const calls = mockVendors(t, { fred: okFred, cot: { body: [cotRow("2026-01-06")] } });

  const res = await ingestMacro({ ...config, fredApiKey: "" }, db, { asOf: AS_OF, from: "2026-01-01", backfill: true });
  assert.deepEqual(res, { count: 3, fredCount: 0, cotCount: 3 });
  assert.equal(calls.fred.length, 0);
  assert.ok((await allRows(db)).every((r) => r.source === "cftc"));
});

test("ingestMacro backfill: a failing vendor half does not stop the other (COT 404 keeps FRED)", async (t) => {
  silenceLogs(t);
  const db = createTestD1([INPUTS_DIR]);
  mockVendors(t, { fred: okFred, cot: { status: 404 } });

  const res = await ingestMacro(config, db, { asOf: AS_OF, from: "2026-01-01", backfill: true });
  assert.equal(res.fredCount, DEFAULT_FRED_SERIES.length);
  assert.equal(res.cotCount, 0);
});
