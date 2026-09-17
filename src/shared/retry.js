// Retry-with-backoff for transient vendor failures. Complements, not
// replaces, the other two shared/ modules:
//   - throttle.js is PROACTIVE and paces calls BEFORE a failure happens.
//   - cooldown.js is REACTIVE but cross-invocation (KV-backed), for
//     long-lived rate-limit windows (Gemini).
//   - retry.js (this file) is REACTIVE and single-invocation: it retries
//     ONE call, in-process, with exponential backoff, when that call
//     itself fails in a way that looks worth retrying.
//
// WHY THIS EXISTS: as of this session neither gdelt.js nor yfinance.js (nor
// any other ingestion adapter) retries anything -- a single failed vendor
// request is logged into that adapter's `errors` array and the item/ticker
// is simply skipped for the run, even for failures (429, 5xx, timeout)
// that a short wait would often clear. Cron runs every 15 minutes, so a
// permanently-skipped ticker/query isn't retried again for 15 minutes even
// when the underlying problem was a few seconds of vendor overload.
//
// Deliberately generic (no VendorError import, no vendor-specific
// knowledge) so it stays reusable outside ingestion -- callers decide what
// "worth retrying" means via `shouldRetry`.

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;

/** Default `shouldRetry`: retry anything with `transient === true` (the
 * shape VendorError -- shared/errors.js -- already puts on rate-limit/
 * timeout/5xx failures), and nothing else. A caller passing a plain Error
 * with no `.transient` field gets no retries by default -- retrying a
 * non-transient failure (bad request, malformed payload) would just waste
 * attempts reproducing the same failure.
 */
function defaultShouldRetry(err) {
  return err?.transient === true;
}

/**
 * Runs `fn` (a zero-arg async function), retrying on failure with
 * exponential backoff: delay before attempt N (N >= 2) is
 * `baseDelayMs * 2^(N-2)`, i.e. baseDelayMs, 2*baseDelayMs, 4*baseDelayMs, ...
 *
 * Only retries when `shouldRetry(err)` returns true (default: `err.transient
 * === true`) AND attempts remain. Any other failure -- shouldRetry says no,
 * or maxAttempts is exhausted -- rethrows immediately, so callers keep their
 * existing try/catch/VendorError handling unchanged; this only changes
 * WHEN that catch runs; a permanent failure still fails fast, on the first
 * attempt, same as today.
 *
 * `maxAttempts` counts the FIRST attempt, so `maxAttempts: 3` means "try
 * once, then up to 2 retries" -- 1 call minimum even if set to 1.
 *
 * `sleep` is injectable (default a real setTimeout-backed sleep) so tests
 * can supply a fake, same convention as throttle.js's `now`/`sleep`
 * injection -- no real timers, no node:test mock.timers dependency.
 */
export async function withRetry(fn, { maxAttempts = DEFAULT_MAX_ATTEMPTS, baseDelayMs = DEFAULT_BASE_DELAY_MS, shouldRetry = defaultShouldRetry, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("withRetry requires a positive integer maxAttempts");
  }
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
    throw new Error("withRetry requires a non-negative finite baseDelayMs");
  }

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition -- exits via return or throw below, never falls off the end
  while (true) {
    attempt++;
    try {
      return await fn();
    } catch (err) {
      const attemptsRemaining = attempt < maxAttempts;
      if (!attemptsRemaining || !shouldRetry(err)) {
        throw err; // permanent failure, or retries exhausted -- surface to caller unchanged
      }
      const delay = baseDelayMs * 2 ** (attempt - 1);
      await sleep(delay);
      // loop back around for the next attempt
    }
  }
}
