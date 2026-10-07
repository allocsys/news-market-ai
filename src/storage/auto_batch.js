// autoBatch -- coalesces D1 statements issued in the same tick into ONE
// db.batch() call (one Worker subrequest / one D1 round trip) without
// changing any call site: `autoBatch(db).prepare(sql).bind(...).all()` still
// returns a promise of the normal result, it just resolves after the batch.
//
// Why: the dashboard Overview fans out ~13 independent reads through
// Promise.all. Each .all()/.first() is its own round trip and its own
// subrequest. Wrapping the handle lets every read that is started in the same
// synchronous pass share one batch, and the store methods stay untouched.
//
// READ PATH ONLY. Layer it UNDER readOnly() (`readOnly(autoBatch(db))`):
// readOnly() validates each statement's SQL at prepare() time and keeps
// blocking batch()/exec() for callers, while autoBatch calls the raw db.batch()
// itself with statements that already passed that check.
//
// Failure isolation: D1 batches are all-or-nothing, so one failing statement
// rejects the whole batch. Rather than losing the per-panel isolation the
// dashboard's safe() wrapper provides, a failed batch is retried statement by
// statement, so each caller gets its own result or its own error.
//
// Timing: statements are collected until two microtask hops after the first
// one is enqueued, then flushed together. Callers should start their reads in
// one synchronous pass (no `await` between them); a read that arrives after the
// flush simply goes into the next batch -- still correct, just not coalesced.
//
// Supported statement methods: bind, all, first, run, raw. A db without
// batch() (some test doubles) is returned unchanged.

export function autoBatch(db) {
  if (typeof db?.batch !== "function") return db;

  let queue = [];
  let scheduled = false;

  async function settleEach(items) {
    await Promise.all(
      items.map(async (item) => {
        try {
          item.resolve(await item.direct());
        } catch (err) {
          item.reject(err);
        }
      })
    );
  }

  async function flush() {
    scheduled = false;
    const items = queue;
    queue = [];
    if (items.length === 0) return;
    // Nothing to coalesce: run it as the plain statement it is.
    if (items.length === 1) return settleEach(items);

    let results;
    try {
      results = await db.batch(items.map((item) => item.stmt));
    } catch (err) {
      console.warn("autoBatch: batch failed, retrying statements individually", { size: items.length, message: err?.message });
      return settleEach(items);
    }
    items.forEach((item, i) => {
      try {
        item.resolve(item.shape(results[i]));
      } catch (err) {
        item.reject(err);
      }
    });
  }

  function enqueue(stmt, shape, direct) {
    return new Promise((resolve, reject) => {
      queue.push({ stmt, shape, direct, resolve, reject });
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(() => queueMicrotask(flush));
      }
    });
  }

  function wrap(stmt) {
    return {
      bind: (...args) => wrap(stmt.bind(...args)),
      all: () => enqueue(stmt, (result) => result, () => stmt.all()),
      first: (column) =>
        enqueue(
          stmt,
          (result) => {
            const row = result?.results?.[0] ?? null;
            return column === undefined ? row : (row?.[column] ?? null);
          },
          () => (column === undefined ? stmt.first() : stmt.first(column))
        ),
      run: () => enqueue(stmt, (result) => result, () => stmt.run()),
      // raw() has no batch-result equivalent worth emulating: always direct.
      raw: (...args) => stmt.raw(...args),
    };
  }

  return {
    prepare: (sql) => wrap(db.prepare(sql)),
  };
}
