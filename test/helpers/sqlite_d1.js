// A REAL-SQL stand-in for D1, built on node:sqlite (unflagged in Node
// 22.22, ExperimentalWarning only -- run with --no-warnings). Unlike the
// hand-written regex-based fakes this replaced, it
// actually executes the project's migration SQL and runs real queries
// through node:sqlite, so it can prove things a fake can't: the
// partial-unique-index backstop actually rejects a double-open, an
// out-of-order asOf read actually gets filtered by the WHERE clause, a
// concurrent-commit test actually serializes through one transaction.
//
// Mirrors the subset of the D1 client API this codebase uses:
//   db.prepare(sql).bind(...args).run()/.all()/.first()
//   db.prepare(sql).run()/.all()/.first()   (no binds)
//   db.batch([boundStmt, boundStmt, ...])   -- one transaction, all-or-
//     nothing, matching the semantics plan.md verified against Cloudflare's
//     docs (sequential, rolls back whole batch on any error, no BEGIN/
//     COMMIT visible to the caller, no reading a result mid-batch).
// Not implemented (not used anywhere in this codebase): D1's .raw(),
// .dump(), named (:foo) parameters, or batch() mixing SELECTs with writes
// in a way that reads its own writes mid-batch.

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function toPlainRow(row) {
  // node:sqlite returns Object.create(null) rows. JSON.stringify handles
  // those fine, but spreading into a plain object keeps every other
  // assumption (instanceof Object, {...row}, structuredClone) true too,
  // matching what a real D1 row actually is.
  return row ? { ...row } : row;
}

const isReadQuery = (sql) => /^\s*(select|pragma|with)\b/i.test(sql);

class BoundStatement {
  constructor(rawDb, sql, params) {
    this._rawDb = rawDb;
    this._sql = sql;
    this._params = params;
  }

  // Internal: run the statement once, D1-Result-shaped. Used by both the
  // single-statement methods below and by SqliteD1#batch.
  _execute() {
    const stmt = this._rawDb.prepare(this._sql);
    if (isReadQuery(this._sql)) {
      const results = stmt.all(...this._params).map(toPlainRow);
      return { results, success: true, meta: { changes: 0 } };
    }
    const info = stmt.run(...this._params);
    return {
      results: [],
      success: true,
      meta: { changes: info.changes, last_row_id: info.lastInsertRowid },
    };
  }

  async run() {
    return this._execute();
  }

  async all() {
    return this._execute();
  }

  async first() {
    const stmt = this._rawDb.prepare(this._sql);
    const row = stmt.get(...this._params);
    return row ? toPlainRow(row) : null;
  }
}

class PreparedStatement {
  constructor(rawDb, sql) {
    this._rawDb = rawDb;
    this._sql = sql;
  }

  bind(...params) {
    return new BoundStatement(this._rawDb, this._sql, params);
  }

  run() {
    return new BoundStatement(this._rawDb, this._sql, []).run();
  }

  all() {
    return new BoundStatement(this._rawDb, this._sql, []).all();
  }

  first() {
    return new BoundStatement(this._rawDb, this._sql, []).first();
  }

  // Lets an un-bound (no-param) PreparedStatement be passed straight into
  // db.batch() alongside BoundStatements, same as D1 allows.
  _execute() {
    return new BoundStatement(this._rawDb, this._sql, [])._execute();
  }
}

export class SqliteD1 {
  constructor(rawDb) {
    this._raw = rawDb;
  }

  prepare(sql) {
    return new PreparedStatement(this._raw, sql);
  }

  /**
   * D1's db.batch(): one transaction, sequential, all-or-nothing. A
   * statement whose guarded WHERE matches zero rows is NOT an error (same
   * as real D1) -- it just returns changes: 0 and the batch continues; only
   * a thrown error (e.g. a UNIQUE violation) rolls the whole batch back.
   */
  async batch(boundStatements) {
    this._raw.exec("BEGIN IMMEDIATE");
    try {
      const results = boundStatements.map((bs) => bs._execute());
      this._raw.exec("COMMIT");
      return results;
    } catch (err) {
      this._raw.exec("ROLLBACK");
      throw err;
    }
  }

  /** Not part of the D1 client API -- test-only escape hatch for setup/assertions. */
  exec(sql) {
    this._raw.exec(sql);
  }

  close() {
    this._raw.close();
  }
}

/** Reads every *.sql file in `dir`, sorted by filename, concatenated in order. */
function readMigrationsDir(dir) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
}

/**
 * Builds an in-memory SqliteD1 with the given migration directories applied
 * in order -- e.g. `createTestD1([stateDir])` for a `live`-shaped DB, or
 * `createTestD1([stateDir, simDir])` for a `sim`-shaped one (matching how
 * plan.md says sim = state schema + backtest_runs).
 */
export function createTestD1(migrationDirs) {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = OFF;"); // no cross-table FKs left in the new split; matches D1 (FKs off by default)
  for (const dir of migrationDirs) {
    raw.exec(readMigrationsDir(dir));
  }
  return new SqliteD1(raw);
}

/** Same as createTestD1, but from raw SQL strings instead of directories (unit-testing the adapter itself). */
export function createTestD1FromSql(sqlStrings) {
  const raw = new DatabaseSync(":memory:");
  for (const sql of sqlStrings) {
    raw.exec(sql);
  }
  return new SqliteD1(raw);
}
