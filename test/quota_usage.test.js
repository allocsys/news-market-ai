// Covers src/storage/quota_usage.js -- the per-UTC-day quota ledger (migrations/sim/0003).
// Real sqlite SIM_DB so the UPSERT's ON CONFLICT arithmetic is exercised for real.

import test from "node:test";
import assert from "node:assert/strict";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { STATE_DIR, SIM_DIR } from "./helpers/engine_ctx.js";
import { utcDay, nextUtcMidnightIso, getQuotaUsage, mergeGeminiCounts, quotaUsageUpsertStatement } from "../src/storage/quota_usage.js";

const simDb = () => createTestD1([STATE_DIR, SIM_DIR]);

test("utcDay is the UTC calendar day, not the local one", () => {
  assert.equal(utcDay(new Date("2026-05-10T23:59:59.999Z")), "2026-05-10");
  assert.equal(utcDay(new Date("2026-05-11T00:00:00.000Z")), "2026-05-11");
});

test("nextUtcMidnightIso is the next UTC midnight, including across month and year ends", () => {
  assert.equal(nextUtcMidnightIso(new Date("2026-05-10T12:34:56.000Z")), "2026-05-11T00:00:00.000Z");
  assert.equal(nextUtcMidnightIso(new Date("2026-05-10T00:00:00.000Z")), "2026-05-11T00:00:00.000Z", "exactly at midnight -> the following midnight");
  assert.equal(nextUtcMidnightIso(new Date("2026-05-31T23:00:00.000Z")), "2026-06-01T00:00:00.000Z");
  assert.equal(nextUtcMidnightIso(new Date("2026-12-31T12:00:00.000Z")), "2027-01-01T00:00:00.000Z");
});

test("mergeGeminiCounts adds per-key counts without mutating either input", () => {
  const a = { "lite|0": 2, "lite|1": 1 };
  const b = { "lite|0": 3, "pro|0": 4 };
  assert.deepEqual(mergeGeminiCounts(a, b), { "lite|0": 5, "lite|1": 1, "pro|0": 4 });
  assert.deepEqual(a, { "lite|0": 2, "lite|1": 1 });
  assert.deepEqual(b, { "lite|0": 3, "pro|0": 4 });
  assert.deepEqual(mergeGeminiCounts(undefined, undefined), {});
});

test("getQuotaUsage returns zeros (and a fresh gemini object each time) when the day has no row", async () => {
  const db = simDb();
  const first = await getQuotaUsage(db, "2026-05-10");
  assert.deepEqual(first, { d1Written: 0, d1Read: 0, kvReads: 0, kvWrites: 0, gemini: {} });
  first.gemini["x|0"] = 1;
  assert.deepEqual((await getQuotaUsage(db, "2026-05-10")).gemini, {}, "the empty default is not shared between calls");
});

test("the UPSERT creates the day's row, then ADDS the integer counters and replaces gemini with the merged object", async () => {
  const db = simDb();
  const day = "2026-05-10";
  await quotaUsageUpsertStatement(db, { day, d1Written: 100, d1Read: 200, kvReads: 30, kvWrites: 4, gemini: { "lite|0": 5 } }).run();
  assert.deepEqual(await getQuotaUsage(db, day), { d1Written: 100, d1Read: 200, kvReads: 30, kvWrites: 4, gemini: { "lite|0": 5 } });

  const before = await getQuotaUsage(db, day);
  await quotaUsageUpsertStatement(db, { day, d1Written: 10, d1Read: 20, kvReads: 3, kvWrites: 1, gemini: mergeGeminiCounts(before.gemini, { "lite|0": 2, "lite|1": 1 }) }).run();
  assert.deepEqual(await getQuotaUsage(db, day), { d1Written: 110, d1Read: 220, kvReads: 33, kvWrites: 5, gemini: { "lite|0": 7, "lite|1": 1 } });
});

test("each UTC day is its own row", async () => {
  const db = simDb();
  await quotaUsageUpsertStatement(db, { day: "2026-05-10", d1Written: 1 }).run();
  await quotaUsageUpsertStatement(db, { day: "2026-05-11", d1Written: 7 }).run();
  assert.equal((await getQuotaUsage(db, "2026-05-10")).d1Written, 1);
  assert.equal((await getQuotaUsage(db, "2026-05-11")).d1Written, 7);
  const { results } = await db.prepare("SELECT day FROM quota_usage ORDER BY day").all();
  assert.deepEqual(results.map((r) => r.day), ["2026-05-10", "2026-05-11"]);
});

test("the UPSERT can ride along in a db.batch with other statements (the worker's one-subrequest path)", async () => {
  const db = simDb();
  const results = await db.batch([quotaUsageUpsertStatement(db, { day: "2026-05-10", d1Written: 5 }), db.prepare("SELECT 1 AS one")]);
  assert.equal(results.length, 2);
  assert.equal((await getQuotaUsage(db, "2026-05-10")).d1Written, 5);
});

test("a corrupt gemini JSON value reads back as an empty object instead of throwing", async () => {
  const db = simDb();
  await db.prepare("INSERT INTO quota_usage (day, d1_written, gemini) VALUES ('2026-05-10', 3, 'not json')").run();
  assert.deepEqual(await getQuotaUsage(db, "2026-05-10"), { d1Written: 3, d1Read: 0, kvReads: 0, kvWrites: 0, gemini: {} });
});
