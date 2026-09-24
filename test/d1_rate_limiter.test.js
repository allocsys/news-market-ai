// Covers shared/d1_rate_limiter.js (plan.md finding G step 2) against a REAL
// sqlite vendor_request_counters table built from migrations/inputs/ (see
// test/helpers/sqlite_d1.js): the per-vendor, per-UTC-day counter that stops
// the Twelve Data free-Basic daily cap being spent twice by two separate
// Worker invocations (backfill tick + live candle tick).

import test from "node:test";
import assert from "node:assert/strict";
import { reserve, currentCount, todayUtc } from "../src/shared/d1_rate_limiter.js";
import { VendorError } from "../src/shared/errors.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { INPUTS_DIR } from "./helpers/engine_ctx.js";

const newDb = () => createTestD1([INPUTS_DIR]);

test("todayUtc formats the given instant as a UTC YYYY-MM-DD day, not the local day", () => {
  assert.equal(todayUtc(Date.parse("2025-09-02T23:59:59Z")), "2025-09-02");
  assert.equal(todayUtc(Date.parse("2025-09-03T00:00:00Z")), "2025-09-03");
  assert.match(todayUtc(), /^\d{4}-\d{2}-\d{2}$/);
});

test("reserve counts up one request at a time and reports the count AFTER the reservation", async () => {
  const db = newDb();
  assert.deepEqual(await reserve(db, { vendor: "twelvedata", limit: 3 }), { allowed: true, count: 1 });
  assert.deepEqual(await reserve(db, { vendor: "twelvedata", limit: 3 }), { allowed: true, count: 2 });
  assert.deepEqual(await reserve(db, { vendor: "twelvedata", limit: 3 }), { allowed: true, count: 3 });
});

test("once the limit is reached reserve returns allowed:false with the unchanged count and reserves nothing", async () => {
  const db = newDb();
  await reserve(db, { vendor: "twelvedata", limit: 2 });
  await reserve(db, { vendor: "twelvedata", limit: 2 });

  assert.deepEqual(await reserve(db, { vendor: "twelvedata", limit: 2 }), { allowed: false, count: 2 });
  assert.deepEqual(await reserve(db, { vendor: "twelvedata", limit: 2 }), { allowed: false, count: 2 });
  assert.equal(await currentCount(db, { vendor: "twelvedata" }), 2, "denied calls never bump the counter");
});

test("reserve(n) is all-or-nothing: a request that would overshoot the limit reserves none of it", async () => {
  const db = newDb();
  assert.deepEqual(await reserve(db, { vendor: "twelvedata", limit: 5, n: 3 }), { allowed: true, count: 3 });
  assert.deepEqual(await reserve(db, { vendor: "twelvedata", limit: 5, n: 3 }), { allowed: false, count: 3 });
  assert.deepEqual(await reserve(db, { vendor: "twelvedata", limit: 5, n: 2 }), { allowed: true, count: 5 });
});

test("a limit of 0 allows nothing", async () => {
  const db = newDb();
  assert.deepEqual(await reserve(db, { vendor: "twelvedata", limit: 0 }), { allowed: false, count: 0 });
});

test("vendors are counted independently", async () => {
  const db = newDb();
  await reserve(db, { vendor: "twelvedata", limit: 1 });
  assert.deepEqual(await reserve(db, { vendor: "twelvedata", limit: 1 }), { allowed: false, count: 1 });
  assert.deepEqual(await reserve(db, { vendor: "other", limit: 1 }), { allowed: true, count: 1 });
});

test("days are counted independently: a new UTC day starts from zero", async () => {
  const db = newDb();
  await reserve(db, { vendor: "twelvedata", limit: 1, day: "2025-09-02" });
  assert.deepEqual(await reserve(db, { vendor: "twelvedata", limit: 1, day: "2025-09-02" }), { allowed: false, count: 1 });
  assert.deepEqual(await reserve(db, { vendor: "twelvedata", limit: 1, day: "2025-09-03" }), { allowed: true, count: 1 });
  assert.equal(await currentCount(db, { vendor: "twelvedata", day: "2025-09-02" }), 1);
  assert.equal(await currentCount(db, { vendor: "twelvedata", day: "2025-09-03" }), 1);
});

test("the counter is persisted in the database, so a second caller sharing the same db sees the first caller's spend", async () => {
  const db = newDb();
  // Two "invocations" (e.g. the backfill tick and a live candle fetch) share one D1.
  for (let i = 0; i < 3; i++) await reserve(db, { vendor: "twelvedata", limit: 4 });
  const other = await reserve(db, { vendor: "twelvedata", limit: 4 });
  assert.deepEqual(other, { allowed: true, count: 4 });
  assert.equal((await reserve(db, { vendor: "twelvedata", limit: 4 })).allowed, false);

  const row = await db.prepare("SELECT vendor, day, count FROM vendor_request_counters").first();
  assert.deepEqual(row, { vendor: "twelvedata", day: todayUtc(), count: 4 });
});

test("currentCount is 0 with no row yet, tracks reservations, and never reserves anything itself", async () => {
  const db = newDb();
  assert.equal(await currentCount(db, { vendor: "twelvedata" }), 0);
  assert.equal(await currentCount(db, { vendor: "twelvedata" }), 0, "reading twice still reads 0");
  await reserve(db, { vendor: "twelvedata", limit: 10 });
  await reserve(db, { vendor: "twelvedata", limit: 10 });
  assert.equal(await currentCount(db, { vendor: "twelvedata" }), 2);
});

test("reserve rejects a missing vendor, a negative or non-finite limit, and a non-positive n", async () => {
  const db = newDb();
  await assert.rejects(() => reserve(db, { limit: 5 }), /requires a vendor name/);
  await assert.rejects(() => reserve(db, { vendor: "twelvedata", limit: -1 }), /non-negative finite limit/);
  await assert.rejects(() => reserve(db, { vendor: "twelvedata", limit: Infinity }), /non-negative finite limit/);
  await assert.rejects(() => reserve(db, { vendor: "twelvedata" }), /non-negative finite limit/);
  await assert.rejects(() => reserve(db, { vendor: "twelvedata", limit: 5, n: 0 }), /positive finite n/);
  await assert.rejects(() => reserve(db, { vendor: "twelvedata", limit: 5, n: -2 }), /positive finite n/);
});

test("a failing database is a VendorError naming the vendor, not a silent allow", async () => {
  const broken = {
    prepare() {
      throw new Error("D1 is down");
    },
  };

  await assert.rejects(
    () => reserve(broken, { vendor: "twelvedata", limit: 5 }),
    (err) => err instanceof VendorError && /rate limiter read failed: D1 is down/.test(err.message),
  );
  await assert.rejects(
    () => currentCount(broken, { vendor: "twelvedata" }),
    (err) => err instanceof VendorError && /rate limiter read failed/.test(err.message),
  );
});

test("a failed WRITE (read fine, increment throws) is also a VendorError", async () => {
  const halfBroken = {
    prepare(sql) {
      if (/^\s*select/i.test(sql)) return { bind: () => ({ first: async () => null }) };
      return {
        bind: () => ({
          run: async () => {
            throw new Error("disk full");
          },
        }),
      };
    },
  };

  await assert.rejects(
    () => reserve(halfBroken, { vendor: "twelvedata", limit: 5 }),
    (err) => err instanceof VendorError && /rate limiter write failed: disk full/.test(err.message),
  );
});
