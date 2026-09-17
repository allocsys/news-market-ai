// retry test -- covers shared/retry.js#withRetry in isolation via an
// injected fake sleep() (no real timers, same convention as
// throttle.test.js's fakeClock -- keeps this fast and deterministic).

import test from "node:test";
import assert from "node:assert/strict";
import { withRetry } from "../src/shared/retry.js";

/** Records every requested delay instead of actually waiting. */
function fakeSleep() {
  const delays = [];
  const sleep = async (ms) => {
    delays.push(ms);
  };
  return { sleep, delays };
}

test("withRetry returns fn's result on the first try, no sleep, when fn succeeds immediately", async () => {
  const { sleep, delays } = fakeSleep();
  const result = await withRetry(async () => "ok", { sleep });
  assert.equal(result, "ok");
  assert.deepEqual(delays, []);
});

test("withRetry retries a transient failure and returns the eventual success", async () => {
  const { sleep, delays } = fakeSleep();
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      if (calls < 3) throw Object.assign(new Error("rate limited"), { transient: true });
      return "ok";
    },
    { sleep, maxAttempts: 5, baseDelayMs: 100 },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(delays, [100, 200]); // exponential: 100, then 200 before the 3rd attempt
});

test("withRetry does NOT retry a non-transient failure -- fails fast on the first attempt", async () => {
  const { sleep, delays } = fakeSleep();
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw Object.assign(new Error("bad request"), { transient: false });
      },
      { sleep },
    ),
    /bad request/,
  );
  assert.equal(calls, 1);
  assert.deepEqual(delays, []);
});

test("withRetry does not retry a plain Error with no .transient field (default shouldRetry)", async () => {
  const { sleep } = fakeSleep();
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls++;
      throw new Error("boom");
    }, { sleep }),
  );
  assert.equal(calls, 1);
});

test("withRetry stops after maxAttempts and rethrows the last error", async () => {
  const { sleep, delays } = fakeSleep();
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw Object.assign(new Error(`fail ${calls}`), { transient: true });
      },
      { sleep, maxAttempts: 3, baseDelayMs: 10 },
    ),
    /fail 3/, // the LAST attempt's error, not the first
  );
  assert.equal(calls, 3);
  assert.deepEqual(delays, [10, 20]); // 2 delays for 3 attempts (none after the last, exhausted attempt)
});

test("maxAttempts: 1 means exactly one attempt, no retries, even for a transient failure", async () => {
  const { sleep, delays } = fakeSleep();
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw Object.assign(new Error("rate limited"), { transient: true });
      },
      { sleep, maxAttempts: 1 },
    ),
  );
  assert.equal(calls, 1);
  assert.deepEqual(delays, []);
});

test("a custom shouldRetry overrides the default .transient check", async () => {
  const { sleep } = fakeSleep();
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      if (calls < 2) throw new Error("retry me anyway");
      return "ok";
    },
    { sleep, shouldRetry: (err) => err.message === "retry me anyway" },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 2);
});

test("withRetry rejects a non-positive-integer maxAttempts", async () => {
  // withRetry is an async function -- a validation "throw" inside it surfaces
  // as a REJECTED PROMISE, not a synchronous throw, so assert.rejects (not
  // assert.throws) is required here.
  await assert.rejects(withRetry(async () => {}, { maxAttempts: 0 }), /positive integer/);
  await assert.rejects(withRetry(async () => {}, { maxAttempts: -1 }), /positive integer/);
  await assert.rejects(withRetry(async () => {}, { maxAttempts: 1.5 }), /positive integer/);
});

test("withRetry rejects a negative baseDelayMs", async () => {
  await assert.rejects(withRetry(async () => {}, { baseDelayMs: -1 }), /non-negative/);
});
