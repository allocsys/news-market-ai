// Per-invocation SUBREQUEST budget for the backtest Worker.
//
// WHY: a backtest run used to be ONE Worker invocation walking every
// (ticker, day, news item). On the Workers Free plan an invocation may make
// only a small number of subrequests, and the first real run died on its first
// simulated day with "Too many subrequests by single Worker invocation" --
// each news item costs ~27 (about 11 D1 state ops, 2 D1 input reads, 7 Gemini
// fetches and ~7 KV cooldown reads). The fix (plan.md "Free-plan budgets"):
// count every subrequest, stop cleanly at an item boundary BEFORE the limit,
// persist a cursor, and continue in a fresh invocation via a re-enqueued queue
// message (backtest-worker.js), the same pattern the backfill uses.
//
// WHAT COUNTS. Everything the walk sends out of the isolate:
//   - Gemini `fetch`es                       -> chargeExternal()  (external + total)
//   - D1 statements / batches (SIM + INPUTS) -> countedD1()       (total)
//   - KV get/put/delete/list                 -> countedKv()       (total)
// Cloudflare's docs conflict on which of these share one limit (Free: 50
// external fetches AND 1000 to Cloudflare services, but the D1 page still says
// 50 D1 queries per invocation), so the two are tracked SEPARATELY:
// `externalLimit` caps fetches, `totalLimit` caps everything. The strict
// default (both 40, i.e. 10 under Free's 50 for the few uncounted extras: the
// queue send, the job-progress writes) is safe under either reading; raise
// `totalLimit` only after a per-part log shows D1/KV really are in the 1000
// bucket.
//
// ENFORCEMENT is charge-before-send: an operation over the limit is refused
// (SubrequestBudgetExhaustedError) BEFORE it happens and is not counted, so the
// counters never exceed the limits except inside `unenforced()` regions, which
// count but never throw (used for work that must not be cut in half: the daily
// exit check, scoring, progress writes).
//
// PROGRESS GUARANTEE. `canStart(kind)` decides whether another unit of work
// (a news item, an exit check, the scoring) fits in what's left, using the most
// expensive unit of that kind seen so far in THIS invocation (defaults until
// one is seen). It is always true before the first unit of an invocation has
// completed, so an invocation always does at least one unit and a run cannot
// spin in place yielding without progress. A single unit whose stages cannot
// even fit in a whole invocation still fails the run, via the parts cap.

import { SubrequestBudgetExhaustedError } from "../shared/errors.js";

// What one unit is assumed to cost before one has been observed.
// item/exits totals include Finding G step 4's resolveCurrentPrice (price_resolution.js), which adds one
// extra D1 read (the intraday lookup) ahead of the pre-existing daily-close read on both call sites.
// item.external is sized for the WORST case, not the happy path: ~7 Gemini
// calls per item, each now capped at MAX_ATTEMPTS_UNDER_BUDGET (3) cascade
// attempts (gemini/client.js) during a vendor outage, so 7*3=21 rounded up
// with headroom. Before this cap existed a single call could retry unboundedly
// and blow the whole invocation's budget by itself; canStart() using the old
// flat 8 here understated that risk for the SECOND item of an invocation onward.
const DEFAULT_ESTIMATES = {
  item: { external: 21, total: 41 },
  exits: { external: 2, total: 13 },
  score: { external: 0, total: 25 },
};

export class SubrequestBudget {
  constructor({ externalLimit = 40, totalLimit = 40 } = {}) {
    for (const [name, value] of [["externalLimit", externalLimit], ["totalLimit", totalLimit]]) {
      if (!Number.isInteger(value) || value < 1) throw new Error(`SubrequestBudget: ${name} must be a positive integer, got ${JSON.stringify(value)}`);
    }
    this.externalLimit = externalLimit;
    this.totalLimit = totalLimit;
    this.external = 0;
    this.total = 0;
    this.kv = 0;
    this.d1 = 0;
    // Cumulative D1 rows actually written this invocation (SUM of every
    // write statement's meta.changes -- run()/batch() only, never first()/
    // all()/raw()), tracked here but NOT enforced by this class: it feeds
    // BACKTEST_DAILY_WRITE_BUDGET (config.js), a cross-invocation, cross-run
    // DAILY cap checked once per part by backtest-worker.js against
    // storage/sim_registry.js#getBacktestRowsWrittenToday, not a per-
    // invocation limit this budget itself refuses against.
    this.rowsWritten = 0;
    this.halted = false;
    this.suspendDepth = 0;
    this.unitsCompleted = 0;
    this.unitCounts = {};
    this.estimates = structuredClone(DEFAULT_ESTIMATES);
    this.observed = {};
  }

  /** True inside an `unenforced()` region: charges are counted but never refused. */
  get suspended() {
    return this.suspendDepth > 0;
  }

  #refuse(detail) {
    this.halted = true;
    throw new SubrequestBudgetExhaustedError(`${detail}; used external ${this.external}/${this.externalLimit}, total ${this.total}/${this.totalLimit}`);
  }

  /**
   * One outbound `fetch`. Once anything has been refused (`halted`), external
   * charges are refused even inside an unenforced region: after a mid-item
   * pause, stragglers (e.g. the other analysts of a Promise.all) must not start
   * new vendor calls while the Worker wraps up.
   */
  chargeExternal() {
    if (this.halted) this.#refuse("halted");
    if (!this.suspended) {
      if (this.external + 1 > this.externalLimit) this.#refuse("external fetch limit reached");
      if (this.total + 1 > this.totalLimit) this.#refuse("total subrequest limit reached");
    }
    this.external++;
    this.total++;
  }

  /** One D1 / KV operation (`kind` is only for the breakdown in logs). */
  chargeInternal(kind = "d1") {
    if (!this.suspended && this.total + 1 > this.totalLimit) this.#refuse(`total subrequest limit reached (${kind})`);
    this.total++;
    if (kind === "kv") this.kv++;
    else if (kind === "d1") this.d1++;
  }

  /**
   * Adds `changes` (a write statement's meta.changes, may be 0) to this
   * invocation's running rowsWritten total. Never refuses/throws -- see the
   * rowsWritten field comment for why this counter isn't enforced here.
   */
  chargeRowsWritten(changes) {
    if (Number.isFinite(changes) && changes > 0) this.rowsWritten += changes;
  }

  suspend() {
    this.suspendDepth++;
  }

  resume() {
    this.suspendDepth = Math.max(0, this.suspendDepth - 1);
  }

  /** Runs `fn` with enforcement suspended (counting continues). For work that must not be cut in half. */
  async unenforced(fn) {
    this.suspend();
    try {
      return await fn();
    } finally {
      this.resume();
    }
  }

  remaining() {
    return { external: Math.max(0, this.externalLimit - this.external), total: Math.max(0, this.totalLimit - this.total) };
  }

  /** Override a default unit estimate (e.g. scoring scales with the ticker count). Ignored once a real cost was observed. */
  setEstimate(kind, { external = 0, total }) {
    this.estimates[kind] = { external, total };
  }

  /** The counter values now, to hand back to recordUnit() when the unit completes. */
  mark() {
    return { external: this.external, total: this.total };
  }

  /** A unit of `kind` finished; remember its real cost (the max seen becomes the estimate for the next one). */
  recordUnit(kind, before) {
    const cost = { external: this.external - before.external, total: this.total - before.total };
    const seen = this.observed[kind];
    this.observed[kind] = seen ? { external: Math.max(seen.external, cost.external), total: Math.max(seen.total, cost.total) } : cost;
    this.unitsCompleted++;
    this.unitCounts[kind] = (this.unitCounts[kind] ?? 0) + 1;
  }

  /** Whether another unit of `kind` fits in what's left. Always true until this invocation has completed one unit (progress guarantee). */
  canStart(kind) {
    if (this.halted) return false;
    if (this.unitsCompleted === 0) return true;
    const estimate = this.observed[kind] ?? this.estimates[kind] ?? { external: 0, total: 0 };
    const left = this.remaining();
    return left.external >= estimate.external && left.total >= estimate.total;
  }

  /** Counters + limits for the per-part log line (lets the owner see which limit is real). */
  snapshot() {
    return {
      external: this.external,
      total: this.total,
      kv: this.kv,
      d1: this.d1,
      externalLimit: this.externalLimit,
      totalLimit: this.totalLimit,
      units: { ...this.unitCounts },
    };
  }
}

// ---------------------------------------------------------------------------
// D1 wrapper
// ---------------------------------------------------------------------------

/**
 * Wraps a D1 database so every statement execution / batch / exec charges the
 * budget. Statements are wrapped lazily (prepare -> bind -> first/all/run/raw);
 * db.batch() charges ONCE (it is one subrequest) and is handed the ORIGINAL
 * statements, because the real D1 rejects anything but its own statement
 * objects.
 */
export function countedD1(db, budget) {
  const inner = new WeakMap();

  const wrapStatement = (stmt) => {
    const wrapped = {
      bind: (...args) => wrapStatement(stmt.bind(...args)),
      first: (...args) => {
        budget.chargeInternal("d1");
        return stmt.first(...args);
      },
      all: (...args) => {
        budget.chargeInternal("d1");
        return stmt.all(...args);
      },
      run: (...args) => {
        budget.chargeInternal("d1");
        return Promise.resolve(stmt.run(...args)).then((result) => {
          budget.chargeRowsWritten(result?.meta?.changes ?? 0);
          return result;
        });
      },
      raw: (...args) => {
        budget.chargeInternal("d1");
        return stmt.raw(...args);
      },
    };
    inner.set(wrapped, stmt);
    return wrapped;
  };

  return {
    prepare: (sql) => wrapStatement(db.prepare(sql)),
    batch: (statements) => {
      budget.chargeInternal("d1");
      return Promise.resolve(db.batch(statements.map((s) => inner.get(s) ?? s))).then((results) => {
        for (const r of results) budget.chargeRowsWritten(r?.meta?.changes ?? 0);
        return results;
      });
    },
    exec: (sql) => {
      budget.chargeInternal("d1");
      return db.exec(sql);
    },
  };
}

// ---------------------------------------------------------------------------
// KV wrappers
// ---------------------------------------------------------------------------

/** Wraps a KV namespace so every get/put/delete/list charges the budget. */
export function countedKv(kv, budget) {
  return {
    get: (...args) => {
      budget.chargeInternal("kv");
      return kv.get(...args);
    },
    put: (...args) => {
      budget.chargeInternal("kv");
      return kv.put(...args);
    },
    delete: (...args) => {
      budget.chargeInternal("kv");
      return kv.delete(...args);
    },
    list: (...args) => {
      budget.chargeInternal("kv");
      return kv.list(...args);
    },
  };
}

const COOLDOWN_PREFIX = "gemini:cooldown:";
// A positive cooldown read is trusted for this long at most: its real expiry is unknown from a get().
const POSITIVE_READ_TTL_MS = 15000;

/**
 * An in-invocation memo in FRONT of a (counting) KV wrapper for the Gemini
 * cooldown keys only -- every LLM attempt reads one, ~7 per news item, and they
 * almost always come back empty. Cache hits never reach the counting wrapper, so
 * they cost no subrequest.
 *   - a NEGATIVE read (no cooldown) is remembered for the whole invocation: the
 *     backtest KV namespace is written only by the backtest Worker, one run at
 *     a time (max_concurrency = 1), so the only writer is this invocation, and
 *     its own put() below updates the memo.
 *   - a POSITIVE read is remembered for at most 15s.
 *   - put() records the exact expiry (now + expirationTtl), so a cooldown this
 *     invocation just set is honored -- and stops being honored on time --
 *     without a KV read.
 * Any other key, and any get() with a type argument, passes straight through.
 */
export function cooldownMemoKv(kv, { now = () => Date.now() } = {}) {
  const memo = new Map(); // key -> { value: string | null, expiresAt: number | null (ms, null = never) }
  const isCooldownKey = (key) => typeof key === "string" && key.startsWith(COOLDOWN_PREFIX);

  return {
    async get(key, ...rest) {
      if (!isCooldownKey(key) || rest.length > 0) return kv.get(key, ...rest);
      const hit = memo.get(key);
      if (hit && (hit.expiresAt === null || now() < hit.expiresAt)) return hit.value;
      const value = await kv.get(key);
      memo.set(key, value == null ? { value: null, expiresAt: null } : { value, expiresAt: now() + POSITIVE_READ_TTL_MS });
      return value;
    },
    async put(key, value, options) {
      const result = await kv.put(key, value, options);
      if (isCooldownKey(key)) {
        const ttl = options?.expirationTtl;
        memo.set(key, { value: String(value), expiresAt: Number.isFinite(ttl) ? now() + ttl * 1000 : null });
      }
      return result;
    },
    async delete(key) {
      const result = await kv.delete(key);
      if (isCooldownKey(key)) memo.set(key, { value: null, expiresAt: null });
      return result;
    },
    list: (...args) => kv.list(...args),
  };
}
