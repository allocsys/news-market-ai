// Direct tests of test/helpers/sqlite_d1.js's own D1-shaped contract --
// separate from run_store.test.js so a break in the adapter itself (as
// opposed to in RunStore's SQL) fails here first.

import test from "node:test";
import assert from "node:assert/strict";
import { createTestD1FromSql, createTestD1 } from "./helpers/sqlite_d1.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SCHEMA = `CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT UNIQUE, n INTEGER);`;

test(".prepare().bind().run() returns D1-shaped meta.changes/last_row_id", async () => {
  const db = createTestD1FromSql([SCHEMA]);
  const result = await db.prepare(`INSERT INTO t (name, n) VALUES (?, ?)`).bind("a", 1).run();
  assert.equal(result.success, true);
  assert.equal(result.meta.changes, 1);
  assert.equal(result.meta.last_row_id, 1);
});

test(".all() returns { results } as plain objects, not node:sqlite's null-prototype rows", async () => {
  const db = createTestD1FromSql([SCHEMA]);
  await db.prepare(`INSERT INTO t (name, n) VALUES (?, ?)`).bind("a", 1).run();
  const { results } = await db.prepare(`SELECT * FROM t`).all();
  assert.equal(results.length, 1);
  assert.equal(Object.getPrototypeOf(results[0]), Object.prototype);
  assert.equal(JSON.stringify(results[0]), JSON.stringify({ id: 1, name: "a", n: 1 }));
});

test(".first() returns null (not undefined) when no row matches", async () => {
  const db = createTestD1FromSql([SCHEMA]);
  const row = await db.prepare(`SELECT * FROM t WHERE id = ?`).bind(999).first();
  assert.equal(row, null);
});

test("prepare() with no bind() still works for parameterless statements", async () => {
  const db = createTestD1FromSql([SCHEMA]);
  await db.prepare(`INSERT INTO t (name, n) VALUES ('x', 1)`).run();
  const row = await db.prepare(`SELECT COUNT(*) AS c FROM t`).first();
  assert.equal(row.c, 1);
});

test("batch() runs statements as one all-or-nothing transaction", async () => {
  const db = createTestD1FromSql([SCHEMA]);
  await db.prepare(`INSERT INTO t (name, n) VALUES (?, ?)`).bind("a", 1).run();

  await assert.rejects(
    db.batch([
      db.prepare(`UPDATE t SET n = 100 WHERE name = ?`).bind("a"),
      db.prepare(`INSERT INTO t (name, n) VALUES (?, ?)`).bind("a", 2), // UNIQUE violation -- must roll back the UPDATE too
    ]),
    /UNIQUE constraint/
  );

  const row = await db.prepare(`SELECT n FROM t WHERE name = 'a'`).first();
  assert.equal(row.n, 1, "the UPDATE from the failed batch must have rolled back");
});

test("batch() returns one D1-shaped result per statement on success", async () => {
  const db = createTestD1FromSql([SCHEMA]);
  const results = await db.batch([
    db.prepare(`INSERT INTO t (name, n) VALUES (?, ?)`).bind("a", 1),
    db.prepare(`INSERT INTO t (name, n) VALUES (?, ?)`).bind("b", 2),
  ]);
  assert.equal(results.length, 2);
  assert.equal(results[0].meta.changes, 1);
  assert.equal(results[1].meta.changes, 1);
});

test("createTestD1 applies multiple migration directories in order", async () => {
  const stateDir = path.join(__dirname, "..", "migrations", "state");
  const simDir = path.join(__dirname, "..", "migrations", "sim");
  const db = createTestD1([stateDir, simDir]);
  const tables = await db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all();
  const names = tables.results.map((r) => r.name);
  assert.ok(names.includes("positions"));
  assert.ok(names.includes("backtest_runs"));
});

test("a WHERE-guarded UPDATE/INSERT matching zero rows is not an error (matches D1's documented batch semantics)", async () => {
  const db = createTestD1FromSql([SCHEMA]);
  const results = await db.batch([db.prepare(`UPDATE t SET n = 1 WHERE name = 'does-not-exist'`)]);
  assert.equal(results[0].success, true);
  assert.equal(results[0].meta.changes, 0);
});
