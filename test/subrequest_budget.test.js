// Covers src/backtest/subrequestBudget.js -- the Free-plan per-invocation
// subrequest budget: the counter/gate class, the counting D1 + KV wrappers, and
// the cooldown memo that keeps repeat KV reads free.

import test from "node:test";
import assert from "node:assert/strict";
import { SubrequestBudget, countedD1, countedKv, cooldownMemoKv } from "../src/backtest/subrequestBudget.js";
import { SubrequestBudgetExhaustedError } from "../src/shared/errors.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { STATE_DIR } from "./helpers/engine_ctx.js";

// ---------------------------------------------------------------------------
// SubrequestBudget
// ---------------------------------------------------------------------------

test("SubrequestBudget refuses the op that would pass a limit, does not count it, and halts", () => {
  const b = new SubrequestBudget({ externalLimit: 2, totalLimit: 3 });
  b.chargeExternal();
  b.chargeInternal("d1");
  b.chargeExternal(); // external 2/2, total 3/3
  assert.throws(() => b.chargeInternal("kv"), SubrequestBudgetExhaustedError);
  assert.equal(b.total, 3, "the refused op was not counted");
  assert.equal(b.kv, 0);
  assert.equal(b.halted, true);
});

test("SubrequestBudget: the external limit and the total limit are separate gates", () => {
  const b = new SubrequestBudget({ externalLimit: 1, totalLimit: 10 });
  b.chargeExternal();
  assert.throws(() => b.chargeExternal(), SubrequestBudgetExhaustedError);
  const c = new SubrequestBudget({ externalLimit: 10, totalLimit: 1 });
  c.chargeInternal("d1");
  assert.throws(() => c.chargeExternal(), /total subrequest limit/);
});

test("SubrequestBudget rejects a non-positive or non-integer limit", () => {
  assert.throws(() => new SubrequestBudget({ externalLimit: 0 }), /positive integer/);
  assert.throws(() => new SubrequestBudget({ totalLimit: 1.5 }), /positive integer/);
});

test("unenforced() counts everything but never refuses, and enforcement resumes afterwards (even after a throw)", async () => {
  const b = new SubrequestBudget({ externalLimit: 2, totalLimit: 2 });
  await b.unenforced(async () => {
    for (let i = 0; i < 5; i++) b.chargeInternal("d1");
    b.chargeExternal();
  });
  assert.equal(b.total, 6);
  assert.equal(b.halted, false);
  assert.throws(() => b.chargeInternal("d1"), SubrequestBudgetExhaustedError, "enforcement is back");

  const c = new SubrequestBudget({ externalLimit: 5, totalLimit: 5 });
  await assert.rejects(c.unenforced(async () => { throw new Error("boom"); }), /boom/);
  assert.equal(c.suspended, false, "a throwing region still resumes enforcement");
});

test("once halted, external charges are refused even inside unenforced() (stragglers cannot start vendor calls)", async () => {
  const b = new SubrequestBudget({ externalLimit: 1, totalLimit: 50 });
  b.chargeExternal();
  assert.throws(() => b.chargeExternal(), SubrequestBudgetExhaustedError);
  await b.unenforced(async () => {
    assert.throws(() => b.chargeExternal(), SubrequestBudgetExhaustedError);
    b.chargeInternal("d1"); // internal bookkeeping still goes through
  });
  assert.equal(b.d1, 1);
});

test("canStart: the first unit is always allowed (progress guarantee); later ones need the observed/estimated cost", () => {
  const b = new SubrequestBudget({ externalLimit: 40, totalLimit: 40 });
  assert.equal(b.canStart("item"), true, "nothing completed yet -> allowed even if a default estimate would not fit");
  const tiny = new SubrequestBudget({ externalLimit: 1, totalLimit: 1 });
  assert.equal(tiny.canStart("item"), true, "progress guarantee beats the default 27-op estimate");

  // Complete one unit that cost 30 total / 5 external; the next needs >=30/5 left.
  const before = b.mark();
  for (let i = 0; i < 25; i++) b.chargeInternal("d1");
  for (let i = 0; i < 5; i++) b.chargeExternal();
  b.recordUnit("item", before);
  assert.deepEqual(b.remaining(), { external: 35, total: 10 });
  assert.equal(b.canStart("item"), false, "10 total left < the 30 just observed");
  assert.equal(b.canStart("exits"), false, "10 total left < the default exits estimate (12)");
  assert.equal(b.canStart("score"), false, "10 total left < the default score estimate (25)");
});

test("canStart uses the MAX observed cost of a kind, and setEstimate only matters until one is observed", () => {
  const b = new SubrequestBudget({ externalLimit: 100, totalLimit: 100 });
  const run = (cost) => {
    const before = b.mark();
    for (let i = 0; i < cost; i++) b.chargeInternal("d1");
    b.recordUnit("item", before);
  };
  run(10);
  run(40);
  run(5);
  assert.equal(b.observed.item.total, 40, "the max wins");
  assert.equal(b.remaining().total, 45);
  assert.equal(b.canStart("item"), true); // 45 >= 40
  for (let i = 0; i < 6; i++) b.chargeInternal("d1"); // 39 left
  assert.equal(b.canStart("item"), false, "fewer than 40 left");

  const s = new SubrequestBudget({ externalLimit: 100, totalLimit: 100 });
  s.recordUnit("item", s.mark()); // a unit completed, so the guarantee is over; 'score' still unobserved
  s.setEstimate("score", { external: 0, total: 30 });
  for (let i = 0; i < 75; i++) s.chargeInternal("d1");
  assert.equal(s.canStart("score"), false, "25 left < the set estimate of 30");
});

test("canStart is false once halted, whatever the counters say", () => {
  const b = new SubrequestBudget({ externalLimit: 1, totalLimit: 100 });
  b.chargeExternal();
  assert.throws(() => b.chargeExternal());
  assert.equal(b.canStart("exits"), false);
});

test("snapshot reports counters, the d1/kv split, limits and per-kind unit counts", () => {
  const b = new SubrequestBudget({ externalLimit: 40, totalLimit: 60 });
  const before = b.mark();
  b.chargeInternal("d1");
  b.chargeInternal("kv");
  b.chargeExternal();
  b.recordUnit("item", before);
  assert.deepEqual(b.snapshot(), { external: 1, total: 3, kv: 1, d1: 1, rowsWritten: 0, externalLimit: 40, totalLimit: 60, units: { item: 1 } });
});

// ---------------------------------------------------------------------------
// countedD1
// ---------------------------------------------------------------------------

test("countedD1 charges once per executed statement (first/all/run/raw), not per prepare/bind", async () => {
  const db = createTestD1([STATE_DIR]);
  const b = new SubrequestBudget({ externalLimit: 40, totalLimit: 40 });
  const counted = countedD1(db, b);

  const stmt = counted.prepare("SELECT 1 AS one").bind();
  assert.equal(b.total, 0, "prepare + bind are free");
  assert.deepEqual(await stmt.first(), { one: 1 });
  assert.equal(b.total, 1);
  await counted.prepare("SELECT 1 AS one").all();
  await counted.prepare("SELECT 1 AS one").run();
  assert.equal(b.total, 3);
  assert.equal(b.d1, 3);
});

test("countedD1 charges ONE subrequest for a whole batch and hands the real D1 its own statement objects", async () => {
  const db = createTestD1([STATE_DIR]);
  const b = new SubrequestBudget({ externalLimit: 40, totalLimit: 40 });
  const counted = countedD1(db, b);

  const results = await counted.batch([counted.prepare("SELECT 1 AS a").bind(), counted.prepare("SELECT 2 AS b").bind(), counted.prepare("SELECT 3 AS c").bind()]);
  assert.equal(results.length, 3);
  assert.equal(b.total, 1, "one batch = one subrequest, regardless of statement count");
});

test("countedD1 refuses (throws the pause signal) once the budget is spent, and the real DB is not called", async () => {
  const db = createTestD1([STATE_DIR]);
  const b = new SubrequestBudget({ externalLimit: 40, totalLimit: 1 });
  const counted = countedD1(db, b);
  await counted.prepare("SELECT 1").first();
  let reached = false;
  const spy = { prepare: () => ({ bind() { return this; }, first() { reached = true; } }) };
  await assert.rejects(async () => countedD1(spy, b).prepare("SELECT 1").first(), SubrequestBudgetExhaustedError);
  assert.equal(reached, false);
});

test("countedD1 counts exec as one subrequest", async () => {
  const seen = [];
  const b = new SubrequestBudget({ externalLimit: 40, totalLimit: 40 });
  const counted = countedD1({ prepare() {}, batch() {}, exec: (sql) => seen.push(sql) }, b);
  counted.exec("SELECT 1");
  assert.equal(b.total, 1);
  assert.deepEqual(seen, ["SELECT 1"]);
});

// ---------------------------------------------------------------------------
// countedKv + cooldownMemoKv
// ---------------------------------------------------------------------------

function fakeKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  const calls = [];
  return {
    calls,
    async get(key, ...rest) { calls.push(["get", key, ...rest]); return store.has(key) ? store.get(key) : null; },
    async put(key, value, options) { calls.push(["put", key, value, options]); store.set(key, value); },
    async delete(key) { calls.push(["delete", key]); store.delete(key); },
    async list(options) { calls.push(["list", options]); return { keys: [...store.keys()].map((name) => ({ name })) }; },
  };
}

test("countedKv charges one subrequest for each get/put/delete/list", async () => {
  const b = new SubrequestBudget({ externalLimit: 40, totalLimit: 40 });
  const kv = countedKv(fakeKv({ a: "1" }), b);
  assert.equal(await kv.get("a"), "1");
  await kv.put("b", "2");
  await kv.delete("b");
  await kv.list({ prefix: "a" });
  assert.equal(b.total, 4);
  assert.equal(b.kv, 4);
});

test("cooldownMemoKv: a negative cooldown read is cached for the whole invocation (one KV read, however many gets)", async () => {
  const raw = fakeKv();
  const b = new SubrequestBudget({ externalLimit: 40, totalLimit: 40 });
  const kv = cooldownMemoKv(countedKv(raw, b), { now: () => 0 });
  for (let i = 0; i < 20; i++) assert.equal(await kv.get("gemini:cooldown:quick:k1"), null);
  assert.equal(raw.calls.length, 1);
  assert.equal(b.total, 1, "hits are not charged");
  await kv.get("gemini:cooldown:quick:k2");
  assert.equal(b.total, 2, "a different key is a different read");
});

test("cooldownMemoKv: a positive read is trusted for at most 15s, then re-read", async () => {
  const raw = fakeKv({ "gemini:cooldown:quick:k1": "1" });
  let t = 1000;
  const kv = cooldownMemoKv(raw, { now: () => t });
  assert.equal(await kv.get("gemini:cooldown:quick:k1"), "1");
  t += 14999;
  assert.equal(await kv.get("gemini:cooldown:quick:k1"), "1");
  assert.equal(raw.calls.length, 1);
  t += 2; // 15001ms after the read
  await kv.get("gemini:cooldown:quick:k1");
  assert.equal(raw.calls.length, 2);
});

test("cooldownMemoKv: put records the exact expiry (now + ttl) so this invocation's own cooldown is honored, then lapses on time", async () => {
  const raw = fakeKv();
  let t = 0;
  const kv = cooldownMemoKv(raw, { now: () => t });
  assert.equal(await kv.get("gemini:cooldown:quick:k1"), null); // negative cached
  await kv.put("gemini:cooldown:quick:k1", "1", { expirationTtl: 60 });
  const readsAfterPut = raw.calls.filter((c) => c[0] === "get").length;
  assert.equal(await kv.get("gemini:cooldown:quick:k1"), "1", "sees its own put without a KV read");
  t = 59999;
  assert.equal(await kv.get("gemini:cooldown:quick:k1"), "1");
  assert.equal(raw.calls.filter((c) => c[0] === "get").length, readsAfterPut);
  t = 60001;
  await kv.get("gemini:cooldown:quick:k1");
  assert.equal(raw.calls.filter((c) => c[0] === "get").length, readsAfterPut + 1, "expired -> real read again");
});

test("cooldownMemoKv: delete makes the key read as absent without a KV read", async () => {
  const raw = fakeKv({ "gemini:cooldown:quick:k1": "1" });
  const kv = cooldownMemoKv(raw, { now: () => 0 });
  await kv.delete("gemini:cooldown:quick:k1");
  assert.equal(await kv.get("gemini:cooldown:quick:k1"), null);
  assert.equal(raw.calls.filter((c) => c[0] === "get").length, 0);
});

test("cooldownMemoKv passes non-cooldown keys and typed gets straight through (no caching)", async () => {
  const raw = fakeKv({ other: "x", "gemini:cooldown:quick:k1": "{\"a\":1}" });
  const kv = cooldownMemoKv(raw, { now: () => 0 });
  await kv.get("other");
  await kv.get("other");
  assert.equal(raw.calls.filter((c) => c[1] === "other").length, 2);
  await kv.get("gemini:cooldown:quick:k1", "json");
  await kv.get("gemini:cooldown:quick:k1", "json");
  assert.equal(raw.calls.filter((c) => c[2] === "json").length, 2);
});
