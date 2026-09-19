// Typed errors used across the codebase. Prefer these over throwing plain
// Error/string so callers can branch on `instanceof` / `.transient` /
// `.status` instead of parsing messages.

/**
 * A failure from an external data or LLM vendor (Gemini, GDELT, EDGAR, ...).
 * `transient: true` means a retry/resume is plausibly worth it (rate limit,
 * timeout, overload); `transient: false` (default) means it's a real
 * failure (bad key, malformed request, 4xx that isn't a rate limit).
 */
export class VendorError extends Error {
  constructor(vendor, message, { status, transient = false } = {}) {
    super(message);
    this.name = "VendorError";
    this.vendor = vendor;
    this.status = status;
    this.transient = transient;
  }
}

/**
 * Thrown when a data-access call is missing the required point-in-time
 * cutoff, or when a leak-check assertion finds a row timestamped after the
 * simulated `asOf`. See plan.md "Backtesting Integrity" -- this exists so a
 * look-ahead bug is a thrown, catchable error, not a silently wrong backtest.
 */
export class LookaheadViolationError extends Error {
  constructor(message) {
    super(message);
    this.name = "LookaheadViolationError";
  }
}

/**
 * Thrown by the per-run LLM-call budget (llm/budget.js) when a backtest tries
 * to make a call past its cap. It is a deliberate hard stop, not a transient
 * failure: nothing may swallow it or retry it (graph/settle.js re-throws it),
 * so the run is recorded 'failed' with this message.
 */
export class LlmBudgetExceededError extends Error {
  constructor(limit) {
    super(`LLM call budget exceeded: this run is capped at ${limit} calls (BACKTEST_MAX_LLM_CALLS)`);
    this.name = "LlmBudgetExceededError";
    this.limit = limit;
  }
}
