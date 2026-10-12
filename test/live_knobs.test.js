// Live-tunable break-even / trailing knobs (storage/live_knobs.js): validation, the single shared
// system_flags read, SNAPSHOT at open, per-position resolution, and the backend routes.
// Real SQL through the sqlite D1 adapter, so migration 0011 is exercised.

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { RunStore } from "../src/storage/run_store.js";
import { getPauseFlags, setPauseFlags } from "../src/storage/pause_flags.js";
import {
  applyLiveKnobs,
  applyLiveSwitches,
  clearLiveKnobs,
  parseLiveKnobRows,
  parseLiveSwitchRows,
  snapshotSwitches,
  parseTrailKnobs,
  positionTrailConfig,
  serializeTrailKnobs,
  setLiveKnobs,
  validateLiveKnob,
} from "../src/storage/live_knobs.js";
import backend from "../src/index.js";

const STATE_DIR = fileURLToPath(new URL("../migrations/state", import.meta.url));

test("validateLiveKnob: same bounds and integer rule as the backtest overrides", () => {
  assert.deepEqual(validateLiveKnob("breakEvenTriggerR", "0.4"), { value: 0.4 });
  assert.deepEqual(validateLiveKnob("trailRemovesTarget", "1"), { value: 1 });
  assert.match(validateLiveKnob("trailRemovesTarget", "0.5").error, /whole number/);
  assert.match(validateLiveKnob("trailDistanceR", "11").error, /between/);
  assert.match(validateLiveKnob("trailDistanceR", "-1").error, /between/);
  assert.match(validateLiveKnob("trailActivationR", "abc").error, /number/);
  assert.match(validateLiveKnob("trailActivationR", "").error, /needs a value/);
  assert.match(validateLiveKnob("maxPositionHoldDays", "3").error, /unknown knob/);
});

test("parseLiveKnobRows ignores non-knob rows and skips paused / valueless / out-of-bounds knob rows", () => {
  const { values, meta } = parseLiveKnobRows([
    { key: "trading", paused: 1, value: null },
    { key: "knob:breakEvenTriggerR", paused: 0, value: 0.4, updated_at: "t", updated_by: "op" },
    { key: "knob:trailActivationR", paused: 0, value: null },
    { key: "knob:trailDistanceR", paused: 0, value: 99 },
    { key: "knob:trailRemovesTarget", paused: 1, value: 1 },
    { key: "knob:bogus", paused: 0, value: 1 },
  ]);
  assert.deepEqual(values, { breakEvenTriggerR: 0.4 });
  assert.deepEqual(meta.breakEvenTriggerR, { updatedAt: "t", updatedBy: "op" });
});

test("applyLiveKnobs: new object only when something applies; snapshot round-trips", () => {
  const cfg = { breakEvenTriggerR: 0, trailActivationR: 0, trailDistanceR: 0, trailRemovesTarget: 0, other: 1 };
  assert.equal(applyLiveKnobs(cfg, {}), cfg);
  assert.equal(applyLiveKnobs(cfg, undefined), cfg);
  const next = applyLiveKnobs(cfg, { breakEvenTriggerR: 0.4 });
  assert.notEqual(next, cfg);
  assert.equal(next.breakEvenTriggerR, 0.4);
  assert.equal(next.other, 1);
  assert.deepEqual(parseTrailKnobs(serializeTrailKnobs(next)), { breakEvenTriggerR: 0.4, trailActivationR: 0, trailDistanceR: 0, trailRemovesTarget: 0 });
  assert.equal(parseTrailKnobs(null), null);
  assert.equal(parseTrailKnobs("not json"), null);
});

test("positionTrailConfig: a snapshot (zeros included) wins over the config; no snapshot uses the config", () => {
  const cfg = { breakEvenTriggerR: 0.4, trailActivationR: 0.5, trailDistanceR: 0.25, trailRemovesTarget: 0 };
  assert.equal(positionTrailConfig(cfg, { trailKnobs: null }), cfg);
  const off = positionTrailConfig(cfg, { trailKnobs: { breakEvenTriggerR: 0, trailActivationR: 0, trailDistanceR: 0, trailRemovesTarget: 0 } });
  assert.equal(off.breakEvenTriggerR, 0, "opened with the feature OFF stays OFF after a knob is switched on");
});

test("getPauseFlags returns knobs from the same single statement; set/clear round-trip", async () => {
  const db = createTestD1([STATE_DIR]);
  let statements = 0;
  const counting = { prepare: (sql) => { statements++; return db.prepare(sql); }, batch: (s) => db.batch(s) };

  await setPauseFlags(db, ["llm"], true);
  await setLiveKnobs(db, { breakEvenTriggerR: 0.4, trailActivationR: 0.5 }, { by: "op", now: "2026-10-12T00:00:00.000Z" });
  statements = 0;
  const res = await getPauseFlags(counting);
  assert.equal(statements, 1, "knobs ride the pause-flag read: no extra statement");
  assert.equal(res.flags.llm, true);
  assert.deepEqual(res.knobs.values, { breakEvenTriggerR: 0.4, trailActivationR: 0.5 });
  assert.equal(res.knobs.meta.breakEvenTriggerR.updatedBy, "op");
  assert.equal(res.meta["knob:breakEvenTriggerR"], undefined, "knob rows are not pause keys");

  await clearLiveKnobs(db, ["breakEvenTriggerR"]);
  assert.deepEqual((await getPauseFlags(db)).knobs.values, { trailActivationR: 0.5 });
  await assert.rejects(() => setLiveKnobs(db, { trailDistanceR: 50 }), /between/);
  await assert.rejects(() => clearLiveKnobs(db, ["nope"]), /unknown knob/);
});

test("getPauseFlags falls back to the old SELECT (pause flags intact, no knobs) when system_flags.value is missing", async (t) => {
  t.mock.method(console, "warn", () => {});
  const db = createTestD1([STATE_DIR]);
  await setPauseFlags(db, ["trading"], true);
  const legacy = {
    prepare(sql) {
      if (/\bvalue\b/.test(sql)) throw new Error("no such column: value");
      return db.prepare(sql);
    },
  };
  const res = await getPauseFlags(legacy);
  assert.equal(res.error, null);
  assert.equal(res.flags.trading, true);
  assert.deepEqual(res.knobs.values, {});
});

test("RunStore: knob snapshot is stored on open and returned as position.trailKnobs; old rows are null", async () => {
  const store = new RunStore(createTestD1([STATE_DIR]), "live");
  const snap = serializeTrailKnobs({ breakEvenTriggerR: 0.4, trailActivationR: 0.5, trailDistanceR: 0.25, trailRemovesTarget: 0 });
  await store.openPosition({ id: "A|1", ticker: "A", tradeThesisId: "A|1", positionSizePct: 0.05, direction: "long", entryPrice: 100, stopLossPct: 0.05, takeProfitPct: 0.1, openedAt: "2026-01-20T00:00:00.000Z", trailKnobs: snap });
  await store.openPosition({ id: "B|1", ticker: "B", tradeThesisId: "B|1", positionSizePct: 0.05, direction: "long", entryPrice: 100, stopLossPct: 0.05, takeProfitPct: 0.1, openedAt: "2026-01-20T00:00:00.000Z" });
  const rows = await store.getOpenPositionsAsOf({ asOf: "2026-02-01T00:00:00.000Z" });
  assert.deepEqual(rows.find((p) => p.id === "A|1").trailKnobs, { breakEvenTriggerR: 0.4, trailActivationR: 0.5, trailDistanceR: 0.25, trailRemovesTarget: 0 });
  assert.equal(rows.find((p) => p.id === "B|1").trailKnobs, null);
});

async function call(env, path, method = "GET") {
  const res = await backend.fetch(new Request(`https://backend${path}`, { method }), env, {});
  return { status: res.status, body: await res.json() };
}

test("GET /api/knobs and POST /controls/knobs: set, validate, clear", async () => {
  const env = { WATCHLIST_TICKERS: "AAPL", LIVE_DB: createTestD1([STATE_DIR]) };
  let res = await call(env, "/api/knobs");
  assert.deepEqual(res.body.live, {});
  assert.deepEqual(res.body.effective, res.body.defaults);

  res = await call(env, "/controls/knobs?breakEvenTriggerR=0.4&trailActivationR=0.5&trailDistanceR=0.25&by=alice", "POST");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.live, { breakEvenTriggerR: 0.4, trailActivationR: 0.5, trailDistanceR: 0.25 });
  assert.equal(res.body.effective.trailDistanceR, 0.25);
  assert.equal(res.body.meta.breakEvenTriggerR.updatedBy, "alice");

  assert.equal((await call(env, "/controls/knobs?trailDistanceR=99", "POST")).status, 400);
  assert.equal((await call(env, "/controls/knobs?trailRemovesTarget=0.5", "POST")).status, 400);
  assert.equal((await call(env, "/controls/knobs", "POST")).status, 400);
  assert.equal((await call(env, "/controls/knobs?clear=bogus", "POST")).status, 400);
  assert.equal((await call(env, "/controls/knobs?trailDistanceR=1&clear=trailDistanceR", "POST")).status, 400);
  assert.deepEqual((await call(env, "/api/knobs")).body.live, { breakEvenTriggerR: 0.4, trailActivationR: 0.5, trailDistanceR: 0.25 }, "rejected calls write nothing");

  res = await call(env, "/controls/knobs?clear=breakEvenTriggerR", "POST");
  assert.deepEqual(res.body.live, { trailActivationR: 0.5, trailDistanceR: 0.25 });
  res = await call(env, "/controls/knobs?clear=all", "POST");
  assert.deepEqual(res.body.live, {});
});

test("live switches: validated 0/1, parsed apart from the trail knobs, applied as booleans", () => {
  assert.deepEqual(validateLiveKnob("intradayTechnical", "1"), { value: 1 });
  assert.match(validateLiveKnob("independenceNote", "2").error, /between/);
  assert.match(validateLiveKnob("independenceNote", "0.5").error, /whole number/);
  const rows = [
    { key: "knob:intradayTechnical", paused: 0, value: 1, updated_at: "t", updated_by: "op" },
    { key: "knob:independenceNote", paused: 0, value: 7 },
    { key: "knob:trailDistanceR", paused: 0, value: 0.25 },
  ];
  assert.deepEqual(parseLiveSwitchRows(rows).values, { intradayTechnical: 1 }, "a trail knob row and a bad switch row are skipped");
  assert.deepEqual(parseLiveKnobRows(rows).values, { trailDistanceR: 0.25 }, "switch rows never leak into the trail knobs");
  const base = { intradayTechnical: false, independenceNote: true };
  assert.equal(applyLiveSwitches(base, {}), base, "nothing to apply = the same object");
  assert.deepEqual(applyLiveSwitches(base, { intradayTechnical: 1, independenceNote: 0 }), { intradayTechnical: true, independenceNote: false });
  assert.deepEqual(snapshotSwitches({ intradayTechnical: true }), { intradayTechnical: 1, independenceNote: 0 });
});

test("getPauseFlags returns switches next to knobs; set/clear round-trip through the shared setters", async () => {
  const db = createTestD1([STATE_DIR]);
  await setLiveKnobs(db, { intradayTechnical: 1, trailDistanceR: 0.25 }, { by: "op" });
  const res = await getPauseFlags(db);
  assert.deepEqual(res.switches.values, { intradayTechnical: 1 });
  assert.deepEqual(res.knobs.values, { trailDistanceR: 0.25 });
  await clearLiveKnobs(db, ["intradayTechnical"]);
  assert.deepEqual((await getPauseFlags(db)).switches.values, {});
});

test("GET /api/switches and POST /controls/switches: default off, set, validate, clear; /controls/knobs does not touch them", async () => {
  const env = { WATCHLIST_TICKERS: "AAPL", LIVE_DB: createTestD1([STATE_DIR]) };
  let res = await call(env, "/api/switches");
  assert.deepEqual(res.body.defaults, { intradayTechnical: 0, independenceNote: 0 });
  assert.deepEqual(res.body.live, {});
  assert.deepEqual(res.body.effective, { intradayTechnical: 0, independenceNote: 0 });

  res = await call(env, "/controls/switches?intradayTechnical=1&by=alice", "POST");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.live, { intradayTechnical: 1 });
  assert.deepEqual(res.body.effective, { intradayTechnical: 1, independenceNote: 0 });
  assert.equal(res.body.meta.intradayTechnical.updatedBy, "alice");

  assert.equal((await call(env, "/controls/switches?independenceNote=2", "POST")).status, 400);
  assert.equal((await call(env, "/controls/switches", "POST")).status, 400);
  assert.equal((await call(env, "/controls/switches?clear=bogus", "POST")).status, 400);
  assert.equal((await call(env, "/controls/switches?independenceNote=1&clear=independenceNote", "POST")).status, 400);
  assert.equal((await call(env, "/controls/knobs?intradayTechnical=1", "POST")).status, 400, "the knobs route does not accept switch names");
  assert.deepEqual((await call(env, "/api/knobs")).body.live, {}, "the Exit knobs card never sees a switch row");

  res = await call(env, "/controls/switches?independenceNote=1", "POST");
  assert.deepEqual(res.body.live, { intradayTechnical: 1, independenceNote: 1 });
  res = await call(env, "/controls/switches?clear=all", "POST");
  assert.deepEqual(res.body.live, {});
  assert.deepEqual(res.body.effective, { intradayTechnical: 0, independenceNote: 0 });
});
