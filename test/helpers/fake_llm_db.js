// In-memory stand-in for the D1 `llm_calls` table (migrations/0012), shared by
// the LLM-call-log tests. It interprets exactly the four statements
// storage/llm_calls.js issues -- INSERT, DELETE-by-age, the filtered list
// SELECT, and SELECT-by-id -- by reading the column list / WHERE clause out of
// the SQL text, so a change to those queries that this fake can't follow fails
// loudly ("unsupported ...") instead of silently passing.
//
// Lives in test/helpers/ (not *.test.js) so `npm test`'s `find test -name
// '*.test.js'` doesn't try to run it as a test file.

const PREVIEW = 240;

export class FakeLlmDb {
  constructor() {
    this.rows = [];
    this.nextId = 1;
    this.statements = []; // every SQL string prepared, in order
  }

  prepare(sql) {
    const db = this;
    db.statements.push(sql);
    return {
      bind(...args) {
        return {
          async run() {
            if (/^\s*INSERT INTO llm_calls/.test(sql)) {
              const columns = sql.match(/\(([^)]+)\)\s*VALUES/)[1].split(",").map((c) => c.trim());
              const row = { id: db.nextId++ };
              columns.forEach((column, i) => { row[column] = args[i]; });
              db.rows.push(row);
              return;
            }
            if (/^\s*DELETE FROM llm_calls WHERE created_at < \?/.test(sql)) {
              db.rows = db.rows.filter((r) => !(r.created_at < args[0]));
              return;
            }
            throw new Error(`FakeLlmDb: unsupported run() query: ${sql}`);
          },
          async all() {
            if (!/FROM llm_calls/.test(sql)) throw new Error(`FakeLlmDb: unsupported all() query: ${sql}`);
            const conditions = [...sql.matchAll(/(\w+) (=|<) \?/g)].map((m) => ({ column: m[1], op: m[2] }));
            const limit = args[args.length - 1];
            let results = db.rows.filter((r) =>
              conditions.every(({ column, op }, i) => (op === "=" ? r[column] === args[i] : r[column] < args[i]))
            );
            results = results.sort((a, b) => b.id - a.id).slice(0, limit);
            return {
              results: results.map((r) => ({
                ...r,
                prompt_preview: (r.prompt ?? "").slice(0, PREVIEW),
                response_preview: r.response === null || r.response === undefined ? null : r.response.slice(0, PREVIEW),
              })),
            };
          },
          async first() {
            if (/SELECT \* FROM llm_calls WHERE id = \?/.test(sql)) return db.rows.find((r) => r.id === args[0]);
            throw new Error(`FakeLlmDb: unsupported first() query: ${sql}`);
          },
        };
      },
    };
  }
}

/** A failing D1 whose every statement rejects -- for proving log writes are best-effort. */
export class BrokenDb {
  prepare() {
    return {
      bind() {
        return {
          async run() { throw new Error("D1 exploded"); },
          async all() { throw new Error("D1 exploded"); },
          async first() { throw new Error("D1 exploded"); },
        };
      },
    };
  }
}
