// The llm Worker's mapping of the live macro switch (storage/macro_flag.js, key `feature:macro`) onto
// config.macroEnabled for an `analyze` message (src/llm-worker.js).
//
// WHAT IS OBSERVED: the pipeline only builds the macro block when config.macroEnabled === true AND the ticker
// is covered (agents/analysts/macroContext.js), and building it costs exactly one read of `macro_observations`
// on INPUTS_DB. So "was macroEnabled mapped to true?" is "did that read happen?". The flag read itself is
// counted on LIVE_DB. loadConfig(env) cannot supply config.fakeModel, so after the macro step the real Gemini
// cascade runs against a mocked globalThis.fetch that answers 503 (same approach as
// backtest_worker_gemini_daily_cap.test.js); the run then fails and the message is retried (the deliberate
// analyze behavior, see llm_worker.test.js). Nothing here depends on that failure beyond it ending the run.
//
// CONTRACT UNDER TEST (see the comments in llm-worker.js#queue):
//   - covered ticker (XAUUSD) + flag ON  -> macro block is built (one macro read);
//   - covered ticker + no row / flag OFF -> no macro read (fails closed: no row means OFF);
//   - uncovered ticker (AAPL) + flag ON  -> no macro read AND the flag is not even read (no extra D1 read);
//   - the flag is read lazily and at most once per batch, however many XAUUSD messages it holds.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/llm-worker.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { STATE_DIR, INPUTS_DIR } from "./helpers/engine_ctx.js";
import { setMacroEnabled } from "../src/storage/macro_flag.js";

const ASOF = "2026-10-04T00:00:00.000Z";

// The exact statement getMacroFlag runs (storage/macro_flag.js); pause flags and ticker selection use other SQL.
const FLAG_READ = /SELECT paused, updated_at, updated_by FROM system_flags WHERE key = \?/;
const MACRO_READ = /FROM macro_observations/;

class FakeMessage {
  constructor(body) {
    this.body = body;
    this.acked = false;
    this.retried = false;
  }
  ack() {
    this.acked = true;
  }
  retry() {
    this.retried = true;
  }
}

/** Counts the prepared statements matching each regex, then forwards to the real db. */
function spied(real, matchers) {
  const counts = Object.fromEntries(Object.keys(matchers).map((name) => [name, 0]));
  const db = {
    prepare(sql) {
      for (const [name, re] of Object.entries(matchers)) if (re.test(sql)) counts[name] += 1;
      return real.prepare(sql);
    },
    batch: (...args) => real.batch(...args),
    exec: (...args) => real.exec(...args),
  };
  return { db, counts };
}

/** Minimal in-memory KV: the Gemini cooldown-map wrapper only needs get/put/delete/list. */
function memoryKv() {
  const store = new Map();
  return {
    get: async (key) => (store.has(key) ? store.get(key) : null),
    put: async (key, value) => { store.set(key, String(value)); },
    delete: async (key) => { store.delete(key); },
    list: async () => ({ keys: [...store.keys()].map((name) => ({ name })) }),
  };
}

/** Every Gemini call fails with a plain 503; the original fetch is restored when the test ends. */
function mockGemini(t) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "high demand" } }), { status: 503, headers: { "content-type": "application/json" } });
  t.after(() => { globalThis.fetch = original; });
}

const analyze = (id, ticker) =>
  new FakeMessage({
    type: "analyze",
    runId: id,
    ticker,
    newsItem: { id, title: "Gold moves", body: "Gold moved.", tickers: [ticker], publishedAt: "2026-10-03T12:00:00.000Z" },
    asOf: ASOF,
  });

/**
 * Runs one batch of analyze messages (one per entry of `tickers`) with the macro flag in the given state
 * (`true` = ON row, `false` = OFF row, `undefined` = no row at all). Returns the messages and the read counts.
 */
async function runBatch(t, { flag, tickers }) {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  mockGemini(t);

  const liveReal = createTestD1([STATE_DIR]);
  if (flag !== undefined) await setMacroEnabled(liveReal, flag, { by: "test" });
  const live = spied(liveReal, { flagReads: FLAG_READ });
  const inputs = spied(createTestD1([INPUTS_DIR]), { macroReads: MACRO_READ });
  const env = {
    LIVE_DB: live.db,
    INPUTS_DB: inputs.db,
    CACHE_KV: memoryKv(),
    GEMINI_API_KEYS: "key-a",
    GEMINI_QUICK_MODEL: "m-quick",
    GEMINI_DEEP_MODEL: "m-deep",
  };

  const messages = tickers.map((ticker, i) => analyze(`news-${i + 1}`, ticker));
  await worker.queue({ messages }, env);
  return { messages, flagReads: live.counts.flagReads, macroReads: inputs.counts.macroReads };
}

test("analyze for XAUUSD with the macro flag ON builds the macro block (config.macroEnabled mapped to true)", async (t) => {
  const { messages, flagReads, macroReads } = await runBatch(t, { flag: true, tickers: ["XAUUSD"] });
  assert.equal(macroReads, 1, "exactly one macro_observations read");
  assert.equal(flagReads, 1);
  assert.equal(messages[0].retried, true, "the run ended in the mocked Gemini outage and is retried, not acked");
});

test("analyze for XAUUSD with NO macro flag row reads as OFF: no macro read", async (t) => {
  const { messages, flagReads, macroReads } = await runBatch(t, { flag: undefined, tickers: ["XAUUSD"] });
  assert.equal(flagReads, 1, "the flag was consulted");
  assert.equal(macroReads, 0, "no row means OFF, so config.macroEnabled stays unset");
  assert.equal(messages[0].retried, true);
});

test("analyze for XAUUSD with the macro flag explicitly OFF: no macro read", async (t) => {
  const { flagReads, macroReads } = await runBatch(t, { flag: false, tickers: ["XAUUSD"] });
  assert.equal(flagReads, 1);
  assert.equal(macroReads, 0);
});

test("analyze for an uncovered ticker (AAPL) with the flag ON: no macro read, and the flag is not even read", async (t) => {
  const { messages, flagReads, macroReads } = await runBatch(t, { flag: true, tickers: ["AAPL"] });
  assert.equal(macroReads, 0, "only XAUUSD is covered by the macro feature");
  assert.equal(flagReads, 0, "other tickers cost no extra D1 read");
  assert.equal(messages[0].retried, true);
});

test("the flag is read lazily and at most once per batch: two XAUUSD messages and an AAPL one cost ONE flag read, two macro reads", async (t) => {
  const { messages, flagReads, macroReads } = await runBatch(t, { flag: true, tickers: ["XAUUSD", "AAPL", "XAUUSD"] });
  assert.equal(flagReads, 1);
  assert.equal(macroReads, 2, "one per XAUUSD message, none for AAPL");
  assert.ok(messages.every((m) => m.retried && !m.acked));
});
