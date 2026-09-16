// throttle test (plan.md open item: shared rate-limit pacer for the
// ingestion adapters, starting with edgar_fundamentals.js's documented
// ~10 req/sec fair-use limit). Covers shared/throttle.js#createThrottle in
// isolation via injected fake now()/sleep() (no real timers, no
// node:test mock.timers dependency -- keeps this fast and deterministic),
// plus edgar_fundamentals.js#fetchLatest's wiring of it.

import test from "node:test";
import assert from "node:assert/strict";
import { createThrottle } from "../src/shared/throttle.js";
import { fetchLatest as fetchEdgarLatest } from "../src/ingestion/sources/edgar_fundamentals.js";

/** A controllable fake clock + a sleep() that advances it by the requested amount and records every call, instead of actually waiting. */
function fakeClock(startAt = 0) {
  let current = startAt;
  const sleeps = [];
  return {
    now: () => current,
    sleep: async (ms) => {
      sleeps.push(ms);
      current += ms;
    },
    advance(ms) {
      current += ms;
    },
    sleeps,
  };
}

// ---------------------------------------------------------------------------
// createThrottle
// ---------------------------------------------------------------------------

test("createThrottle throws on a negative minIntervalMs", () => {
  assert.throws(() => createThrottle({ minIntervalMs: -1 }), /non-negative/);
});

test("createThrottle throws on a non-finite minIntervalMs", () => {
  assert.throws(() => createThrottle({ minIntervalMs: NaN }), /non-negative/);
  assert.throws(() => createThrottle({ minIntervalMs: Infinity }), /non-negative/);
});

test("minIntervalMs: 0 (default) never sleeps, even on back-to-back calls", async () => {
  const clock = fakeClock();
  const throttle = createThrottle({ now: clock.now, sleep: clock.sleep }); // minIntervalMs defaults to 0
  await throttle.wait();
  await throttle.wait();
  await throttle.wait();
  assert.deepEqual(clock.sleeps, []);
});

test("the first wait() on a fresh throttler never sleeps, regardless of minIntervalMs", async () => {
  const clock = fakeClock();
  const throttle = createThrottle({ minIntervalMs: 500, now: clock.now, sleep: clock.sleep });
  await throttle.wait();
  assert.deepEqual(clock.sleeps, []);
});

test("a second wait() called too soon sleeps exactly the remaining time", async () => {
  const clock = fakeClock();
  const throttle = createThrottle({ minIntervalMs: 200, now: clock.now, sleep: clock.sleep });
  await throttle.wait(); // t=0, no sleep
  clock.advance(50); // only 50ms of "real work" elapsed before the next call
  await throttle.wait(); // needs 150ms more to reach the 200ms floor
  assert.deepEqual(clock.sleeps, [150]);
});

test("a second wait() called after minIntervalMs has already elapsed does not sleep", async () => {
  const clock = fakeClock();
  const throttle = createThrottle({ minIntervalMs: 200, now: clock.now, sleep: clock.sleep });
  await throttle.wait(); // t=0
  clock.advance(250); // plenty of time passed
  await throttle.wait();
  assert.deepEqual(clock.sleeps, []);
});

test("three calls in a tight loop each pace off the PREVIOUS call, not the first", async () => {
  const clock = fakeClock();
  const throttle = createThrottle({ minIntervalMs: 100, now: clock.now, sleep: clock.sleep });
  await throttle.wait(); // t=0 -> no sleep
  await throttle.wait(); // t=0 still (no advance) -> sleeps 100, clock now t=100
  await throttle.wait(); // t=100, elapsed since last call is 0 -> sleeps 100 again, clock now t=200
  assert.deepEqual(clock.sleeps, [100, 100]);
});

test("a throttler shared across calls paces them; a fresh throttler per call would not (documents why callers must share one instance)", async () => {
  const clock = fakeClock();
  const shared = createThrottle({ minIntervalMs: 100, now: clock.now, sleep: clock.sleep });
  await shared.wait();
  await shared.wait();
  assert.deepEqual(clock.sleeps, [100]); // second call paced against the first

  clock.sleeps.length = 0;
  await createThrottle({ minIntervalMs: 100, now: clock.now, sleep: clock.sleep }).wait();
  await createThrottle({ minIntervalMs: 100, now: clock.now, sleep: clock.sleep }).wait();
  assert.deepEqual(clock.sleeps, []); // each fresh instance has no memory of the other -- no pacing happens
});

// ---------------------------------------------------------------------------
// edgar_fundamentals.js#fetchLatest wiring
// ---------------------------------------------------------------------------

function mockCompanyFactsJson() {
  return { facts: { "us-gaap": { Revenues: { units: { USD: [{ fy: 2026, fp: "Q2", form: "10-Q", filed: "2026-07-25", val: 1, end: "2026-06-30" }] } } } } };
}

test("fetchLatest is a no-op (no sleeps) when edgarMinRequestIntervalMs is unset -- unconfigured stays fast, same convention as edgarUserAgent/rssFeeds", async (t) => {
  const config = { edgarUserAgent: "test-suite contact@example.com", edgarApiBase: "https://fake.test/companyfacts", edgarCikMap: { AAPL: "1" } };
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, json: async () => mockCompanyFactsJson() }));

  const start = Date.now();
  await fetchEdgarLatest(config, { tags: ["Revenues"] });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 50, `expected no real throttling delay, took ${elapsed}ms`);
});

test("fetchLatest paces successive fetchFacts calls at config.edgarMinRequestIntervalMs apart when it IS configured", async (t) => {
  const config = {
    edgarUserAgent: "test-suite contact@example.com",
    edgarApiBase: "https://fake.test/companyfacts",
    edgarCikMap: { AAPL: "1", MSFT: "2" },
    edgarMinRequestIntervalMs: 150, // small enough to keep the suite fast, large enough to clearly separate from scheduling noise
  };

  const callTimes = [];
  t.mock.method(global, "fetch", async () => {
    callTimes.push(Date.now());
    return { ok: true, status: 200, json: async () => mockCompanyFactsJson() };
  });

  await fetchEdgarLatest(config, { tags: ["Revenues"] }); // 2 tickers x 1 tag = 2 calls, 1 wait of ~150ms expected between them

  assert.equal(callTimes.length, 2);
  const gap = callTimes[1] - callTimes[0];
  assert.ok(gap >= 130, `expected the second call to be paced ~150ms after the first, actual gap was ${gap}ms`);
});
