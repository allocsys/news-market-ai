// Lightweight in-process request pacer -- enforces a minimum interval
// between successive requests made through the same throttler instance, so
// a tight per-item loop (e.g. edgar_fundamentals.js's per-ticker/per-tag
// loop) doesn't fire faster than a vendor's documented fair-use rate limit.
//
// DELIBERATELY A DIFFERENT CONCERN FROM shared/cooldown.js:
// cooldown.js is REACTIVE -- it records + checks a backoff *after* a 429
// actually happens, backed by Cloudflare KV so the cooldown survives across
// separate Worker invocations. That fits Gemini, where rate-limit windows
// are long-lived and worth remembering between calls.
// throttle.js is PROACTIVE -- it just paces calls at least `minIntervalMs`
// apart *within one run's loop*, with no persistence and no awareness of
// vendor responses at all. It never inspects a 429, never remembers
// anything across separate throttle instances/runs -- it only guarantees
// spacing between calls made through the ONE instance you hold.
//
// Share ONE throttle instance across a whole loop of requests to the same
// vendor; creating a fresh instance per call defeats the pacing entirely
// (each one would start with no "last call" memory).

/**
 * Creates a throttler. `minIntervalMs: 0` (the default) means "no pacing" --
 * `wait()` never sleeps, just records the call time; this keeps an
 * unconfigured throttle a true no-op, same "no default without an
 * explicit reason" convention as config.js's other honest-narrow-scope
 * fields (rssFeeds, edgarUserAgent, ...).
 *
 * `now`/`sleep` are injectable (default real Date.now / real setTimeout)
 * so callers -- typically tests -- can supply a fake clock/sleep without
 * this module needing to know anything about a test framework's timer
 * mocking.
 */
export function createThrottle({ minIntervalMs = 0, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0) {
    throw new Error("createThrottle requires a non-negative finite minIntervalMs");
  }

  let lastCallAt = null;

  return {
    /**
     * Waits (if needed) so at least `minIntervalMs` has passed since the
     * previous `wait()` call on THIS throttler resolved, then records the
     * new "last call" time. The very first call on a fresh throttler never
     * waits -- there's nothing to pace against yet.
     */
    async wait() {
      if (minIntervalMs === 0) {
        lastCallAt = now();
        return; // fast path -- no timing math, no sleep, ever
      }

      if (lastCallAt !== null) {
        const elapsed = now() - lastCallAt;
        const remaining = minIntervalMs - elapsed;
        if (remaining > 0) {
          await sleep(remaining);
        }
      }

      lastCallAt = now();
    },
  };
}
