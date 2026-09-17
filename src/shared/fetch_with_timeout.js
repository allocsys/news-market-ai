// Wraps `fetch` with a hard timeout via AbortController.
//
// WHY THIS EXISTS: every ingestion adapter (gdelt.js, html_scrape.js,
// yfinance.js, rss.js, edgar_fundamentals.js, edgar_cik_lookup.js) fetches
// arbitrary third-party URLs -- news article pages, unofficial vendor
// APIs -- with no guarantee any of them respond in a bounded time. A plain
// `fetch()` with no timeout can hang indefinitely on a slow/unresponsive
// server. On a scheduled Worker invocation that means the WHOLE invocation
// blocks until Cloudflare kills it outright once it exceeds the
// platform's CPU/wall-time limits -- and that kill is NOT a catchable JS
// error, so none of the try/catch blocks throughout the ingestion layer
// (which otherwise carefully log every VendorError) ever get a chance to
// run. This is exactly what a live incident looked like: a scheduled run's
// log showed "EDGAR error" and then nothing after -- no "completed", no
// "failed" -- because the next step (gdelt.js#enrichWithFullText, fetching
// up to ~150 article URLs serially with no timeout) hung on one of them.
//
// FIX: every raw `fetch(url)` / `fetch(url, opts)` call site in the
// ingestion layer now goes through this wrapper instead, passing
// `config.fetchTimeoutMs` (see config.js). On timeout this rejects with a
// DOMException whose `.name` is "AbortError" -- every call site already
// wraps its fetch in a try/catch that builds a `VendorError({transient:
// true}, ...)` from `err.message` on ANY thrown error, so a timeout lands
// in that exact same existing path with zero call-site error-handling
// changes needed.
export async function fetchWithTimeout(url, { timeoutMs = 10000, ...options } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
