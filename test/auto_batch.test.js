// autoBatch (src/storage/auto_batch.js): same-tick D1 reads share ONE db.batch(),
// each caller still gets its own result/error. Uses a hand-rolled D1 double so the
// number of batch() vs direct statement calls can be counted exactly.

import test from "node:test";
import assert from "node:assert/strict";
import { autoBatch } from "../src/storage/auto_batch.js";
import { readOnly } from "../src/storage/run_store.js";

// rowsFor(sql) -> rows that statement "returns". A statement whose sql contains "BOOM" throws.
function fakeD1({ rowsFor = (sql) => [{ sql }] } = {}) {
  const calls = { batch: [], direct: [] };
  function makeStmt(sql, args = []) {
    const run = () => {
      if (sql.includes("BOOM")) throw new Error(`boom: ${sql}`);
      return { results: rowsFor(sql, args), meta: {} };
    };
    return {
      sql,
      args,
      bind: (...a) => makeStmt(sql, a),
      all: async () => (calls.direct.push(sql), run()),
      first: async (column) => {
        calls.direct.push(sql);
        const row = run().results[0] ?? null;
        return column === undefined ? row : (row?.[column] ?? null);
      },
      run: async () => (calls.direct.push(sql), run()),
      raw: async () => (calls.direct.push(sql), run().results.map((r) => Object.values(r))),
    };
  }
  return {
    calls,
    prepare: (sql) => makeStmt(sql),
    batch: async (stmts) => {
      calls.batch.push(stmts.map((s) => s.sql));
      return stmts.map((s) => {
        if (s.sql.includes("BOOM")) throw new Error(`boom: ${s.sql}`);
        return { results: rowsFor(s.sql, s.args), meta: {} };
      });
    },
  };
}

test("reads started in the same tick go out as ONE batch; each caller gets its own result", async () => {
  const db = fakeD1();
  const b = autoBatch(db);
  const [a, c, d] = await Promise.all([
    b.prepare("SELECT 1 AS a").all(),
    b.prepare("SELECT 2 AS c").bind(7).all(),
    b.prepare("SELECT 3 AS d").all(),
  ]);
  assert.deepEqual(db.calls.batch, [["SELECT 1 AS a", "SELECT 2 AS c", "SELECT 3 AS d"]]);
  assert.deepEqual(db.calls.direct, [], "nothing ran as a plain statement");
  assert.deepEqual(a.results, [{ sql: "SELECT 1 AS a" }]);
  assert.deepEqual(c.results, [{ sql: "SELECT 2 AS c" }]);
  assert.deepEqual(d.results, [{ sql: "SELECT 3 AS d" }]);
});

test("a lone statement runs directly, not as a one-element batch", async () => {
  const db = fakeD1();
  const res = await autoBatch(db).prepare("SELECT 1").all();
  assert.deepEqual(db.calls.batch, []);
  assert.deepEqual(db.calls.direct, ["SELECT 1"]);
  assert.deepEqual(res.results, [{ sql: "SELECT 1" }]);
});

test("first() shapes a batched result like D1: row, one column, or null", async () => {
  const db = fakeD1({ rowsFor: (sql) => (sql.includes("EMPTY") ? [] : [{ n: 42, s: "x" }]) });
  const b = autoBatch(db);
  const [row, col, missingCol, none, noneCol] = await Promise.all([
    b.prepare("SELECT row").first(),
    b.prepare("SELECT col").first("n"),
    b.prepare("SELECT col").first("nope"),
    b.prepare("SELECT EMPTY").first(),
    b.prepare("SELECT EMPTY").first("n"),
  ]);
  assert.equal(db.calls.batch.length, 1);
  assert.deepEqual(row, { n: 42, s: "x" });
  assert.equal(col, 42);
  assert.equal(missingCol, null);
  assert.equal(none, null);
  assert.equal(noneCol, null);
});

test("a failing statement fails the batch, then each caller gets its OWN result or error", async () => {
  const db = fakeD1();
  const b = autoBatch(db);
  const origWarn = console.warn;
  console.warn = () => {};
  let settled;
  try {
    settled = await Promise.allSettled([b.prepare("SELECT ok1").all(), b.prepare("SELECT BOOM").all(), b.prepare("SELECT ok2").first("sql")]);
  } finally {
    console.warn = origWarn;
  }
  assert.equal(db.calls.batch.length, 1, "one batch attempt");
  assert.deepEqual(db.calls.direct.sort(), ["SELECT BOOM", "SELECT ok1", "SELECT ok2"], "then every statement retried individually");
  assert.equal(settled[0].status, "fulfilled");
  assert.deepEqual(settled[0].value.results, [{ sql: "SELECT ok1" }]);
  assert.equal(settled[1].status, "rejected");
  assert.match(settled[1].reason.message, /boom/);
  assert.equal(settled[2].status, "fulfilled");
  assert.equal(settled[2].value, "SELECT ok2");
});

test("a read that arrives after the flush goes into the NEXT batch (correct, just not coalesced)", async () => {
  const db = fakeD1();
  const b = autoBatch(db);
  await Promise.all([b.prepare("SELECT a1").all(), b.prepare("SELECT a2").all()]);
  await Promise.all([b.prepare("SELECT b1").all(), b.prepare("SELECT b2").all()]);
  assert.deepEqual(db.calls.batch, [["SELECT a1", "SELECT a2"], ["SELECT b1", "SELECT b2"]]);
});

test("raw() is never batched", async () => {
  const db = fakeD1();
  const b = autoBatch(db);
  const [raw] = await Promise.all([b.prepare("SELECT 1 AS x").raw(), b.prepare("SELECT 2").all(), b.prepare("SELECT 3").all()]);
  assert.deepEqual(raw, [["SELECT 1 AS x"]]);
  assert.deepEqual(db.calls.batch, [["SELECT 2", "SELECT 3"]]);
  assert.deepEqual(db.calls.direct, ["SELECT 1 AS x"]);
});

test("a db without batch() is returned unchanged", () => {
  const db = { prepare: () => ({}) };
  assert.equal(autoBatch(db), db);
  assert.equal(autoBatch(undefined), undefined);
});

test("layered UNDER readOnly(): reads still coalesce, writes and batch() are still refused", async () => {
  const db = fakeD1();
  const ro = readOnly(autoBatch(db));
  await Promise.all([ro.prepare("SELECT 1").all(), ro.prepare("select 2").all(), ro.prepare("WITH x AS (SELECT 3) SELECT * FROM x").all()]);
  assert.equal(db.calls.batch.length, 1);
  assert.equal(db.calls.batch[0].length, 3);
  assert.throws(() => ro.prepare("INSERT INTO t VALUES (1)"), /refusing non-SELECT/);
  assert.throws(() => ro.batch([]), /batch\(\) is not permitted/);
  assert.throws(() => ro.exec("SELECT 1"), /exec\(\) is not permitted/);
});
