// Macro context for the analyst prompt (agents/analysts/macroContext.js + its wiring in analystTeam.js).
// The contract that matters most: OFF (or an uncovered ticker) = NO D1 read and a prompt identical to the
// pre-macro one, because budget-paced backtest walks hardcode per-stage D1 call counts.

import test from "node:test";
import assert from "node:assert/strict";
import { MACRO_TICKERS, formatMacroContext, loadMacroContext, macroAppliesTo } from "../src/agents/analysts/macroContext.js";
import { runAnalystTeam } from "../src/agents/analysts/analystTeam.js";
import { COT_SERIES } from "../src/ingestion/sources/cftc_cot.js";

const ASOF = "2026-03-10T12:00:00Z";

function obs(obsDate, val) {
  return { obsDate, availableAt: `${obsDate}T00:00:00Z`, val };
}

const SNAPSHOT = {
  DFII10: [obs("2026-03-09", 1.9), obs("2026-03-06", 1.95), obs("2026-02-09", 2.1)],
  DFF: [obs("2026-03-09", 4.33)],
  CPIAUCSL: [obs("2026-02-01", 320.4), obs("2025-02-01", 310.0)],
  [COT_SERIES.MM_LONG]: [obs("2026-03-03", 150000), obs("2026-02-24", 140000)],
  [COT_SERIES.MM_SHORT]: [obs("2026-03-03", 30000), obs("2026-02-24", 32000)],
  [COT_SERIES.OPEN_INTEREST]: [obs("2026-03-03", 500000)],
};

/** A db whose every read is counted; `results` is what the macro snapshot query returns. */
function countingDb(results = []) {
  const db = {
    reads: 0,
    prepare() {
      db.reads += 1;
      return { bind: () => ({ all: async () => ({ results }) }) };
    },
  };
  return db;
}

test("macroAppliesTo is true only for macroEnabled === true AND a covered ticker", () => {
  assert.deepEqual([...MACRO_TICKERS], ["XAUUSD"]);
  assert.equal(macroAppliesTo({ macroEnabled: true }, "XAUUSD"), true);
  assert.equal(macroAppliesTo({ macroEnabled: true }, "AAPL"), false);
  assert.equal(macroAppliesTo({ macroEnabled: false }, "XAUUSD"), false);
  assert.equal(macroAppliesTo({}, "XAUUSD"), false);
  assert.equal(macroAppliesTo({ macroEnabled: 1 }, "XAUUSD"), false, "only a real boolean true turns it on");
  assert.equal(macroAppliesTo(undefined, "XAUUSD"), false);
});

test("loadMacroContext: feature off or uncovered ticker returns null with ZERO D1 reads", async () => {
  const db = countingDb();
  assert.equal(await loadMacroContext({ macroEnabled: false }, db, { ticker: "XAUUSD", asOf: ASOF }), null);
  assert.equal(await loadMacroContext({}, db, { ticker: "XAUUSD", asOf: ASOF }), null);
  assert.equal(await loadMacroContext({ macroEnabled: true }, db, { ticker: "AAPL", asOf: ASOF }), null);
  assert.equal(db.reads, 0);
});

test("loadMacroContext: on + covered ticker does exactly one read and formats the rows", async () => {
  const rows = [
    { series: "DFII10", obs_date: "2026-03-09", available_at: "2026-03-10T00:00:00Z", val: 1.9 },
    { series: "DFF", obs_date: "2026-03-09", available_at: "2026-03-10T00:00:00Z", val: 4.33 },
  ];
  const db = countingDb(rows);
  const text = await loadMacroContext({ macroEnabled: true }, db, { ticker: "XAUUSD", asOf: ASOF });
  assert.equal(db.reads, 1);
  assert.match(text, /10y TIPS real yield \(DFII10\): 1\.90% as of 2026-03-09/);
  assert.match(text, /effective fed funds rate \(DFF\): 4\.33% as of 2026-03-09/);
});

test("loadMacroContext: nothing available yet returns null (no empty section in the prompt)", async () => {
  const db = countingDb([]);
  assert.equal(await loadMacroContext({ macroEnabled: true }, db, { ticker: "XAUUSD", asOf: ASOF }), null);
  assert.equal(db.reads, 1);
});

test("formatMacroContext: real-yield change, CPI year over year, and COT net positioning", () => {
  const text = formatMacroContext(SNAPSHOT);
  assert.match(text, /10y TIPS real yield \(DFII10\): 1\.90% as of 2026-03-09; about a month earlier 2\.10%, change -0\.20 pp/);
  assert.match(text, /US CPI, all items \(CPIAUCSL\): index 320\.4 for the month starting 2026-02-01, \+3\.4% year over year/);
  assert.match(text, /week of 2026-03-03: net 120,000 contracts \(long 150,000, short 30,000\); prior week net 108,000, change \+12,000; open interest 500,000/);
});

test("formatMacroContext: junk and empty input yields '' and never zero-fills", () => {
  assert.equal(formatMacroContext(null), "");
  assert.equal(formatMacroContext({}), "");
  assert.equal(formatMacroContext({ DFF: [{ obsDate: "2026-03-09", val: null }, { obsDate: "2026-03-08", val: "x" }] }), "");
});

test("formatMacroContext: an unknown series gets a plain line instead of being dropped", () => {
  assert.equal(formatMacroContext({ VIXCLS: [obs("2026-03-09", 17.25)] }), "- VIXCLS: 17.25 as of 2026-03-09");
});

// ---------------------------------------------------------------------------
// Prompt wiring (analystTeam.js)
// ---------------------------------------------------------------------------

const SECTIONS = {
  news_event: { eventType: "e", entities: [], summary: "s", justification: "j" },
  sentiment: { sentiment: "neutral", summary: "s", justification: "j" },
};

async function promptFor(extra) {
  let captured = null;
  const config = {
    geminiQuickModel: "test-model",
    fakeModel: async (prompt) => {
      captured = prompt;
      return JSON.stringify(SECTIONS);
    },
  };
  await runAnalystTeam({}, config, { ticker: "XAUUSD", newsItem: { id: "n1", title: "t", body: "b" }, bars: [], ...extra });
  return captured;
}

test("runAnalystTeam puts the macro block (and its grounding rule) in the prompt only when macroContext is given", async () => {
  const withMacro = await promptFor({ macroContext: "- 10y TIPS real yield (DFII10): 1.90% as of 2026-03-09" });
  assert.ok(withMacro.includes("MACRO CONTEXT for XAUUSD"));
  assert.ok(withMacro.includes("- 10y TIPS real yield (DFII10): 1.90% as of 2026-03-09"));
  assert.ok(withMacro.includes("never invent a macro number"));
});

test("runAnalystTeam's prompt is identical with macroContext absent, null or empty", async () => {
  const base = await promptFor({});
  assert.equal(await promptFor({ macroContext: null }), base);
  assert.equal(await promptFor({ macroContext: "" }), base);
  assert.equal(base.includes("MACRO CONTEXT"), false);
});
