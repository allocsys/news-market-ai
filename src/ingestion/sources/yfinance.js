// Yahoo Finance chart API adapter (unofficial, per plan.md ingestion
// section) -- price/volume data for the technical analyst and backtesting.
//
// HONEST SCOPE / KNOWN RISK, read before relying on this in production:
// This endpoint (query1.finance.yahoo.com/v8/finance/chart) is undocumented,
// and some yfinance library issue reports (2025) describe Yahoo requiring a
// cookie+crumb handshake for at least some request patterns -- a plain
// unauthenticated fetch() like the one below could in principle come back
// 401/429 for a request that worked fine before such a change. This
// adapter deliberately does NOT implement the cookie/crumb dance (it's a
// stateful two-request flow needing a cookie jar, real infra beyond a
// single stateless fetch) -- same "flag it, don't fake it" approach as
// gdelt.js's empty-body gap.
// LIVE-VERIFIED 2026-09-17 (see plan.md's "Live-verify against real vendor
// traffic" checklist item): a plain fetch() against this exact endpoint/URL
// shape, no cookie/crumb, currently returns 200 with real, correctly-shaped
// data (chart.result[0].{meta,timestamp,indicators}, chart.error: null) --
// so the cookie+crumb requirement, if it exists at all right now, does NOT
// apply to this request pattern. Risk kept documented rather than deleted:
// Yahoo could tighten this at any time with no notice, since it's an
// unofficial endpoint -- re-verify periodically, don't treat this as a
// permanent guarantee.
// UPDATE (2026-09-17, later same day): fetch() now goes through
// shared/fetch_with_timeout.js#fetchWithTimeout (config.fetchTimeoutMs) --
// see gdelt.js's header for the live silent-scheduled-run-death incident
// that made a timeout on every ingestion fetch (not just this one) a hard
// requirement.
//
// Every returned bar is run through market_data_validator.js#validatePriceBar
// before being handed back, matching gdelt.js's validate-before-return
// convention. A vendor failure surfaces as a typed VendorError (Adopted
// Pattern #11), never a silent empty/partial result.

import { PriceBar } from "../../schemas/index.js";
import { validatePriceBar } from "../market_data_validator.js";
import { VendorError } from "../../shared/errors.js";
import { createThrottle } from "../../shared/throttle.js";
import { fetchWithTimeout } from "../../shared/fetch_with_timeout.js";
import { withRetry } from "../../shared/retry.js";
import { isVendorCoolingDown, setVendorCooldown } from "../../shared/cooldown.js";

/** Yahoo's chart timestamps are Unix seconds -- convert to YYYY-MM-DD (UTC). */
function timestampToDate(unixSeconds) {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * Fetches recent daily bars for each ticker in `tickers` (defaults to
 * config.watchlist's tickers). One request per ticker, since the chart
 * endpoint is single-symbol only -- there is no batch mode.
 */
export async function fetchDailyBars(config, { tickers = config.watchlist.map((w) => w.ticker) } = {}, { kv } = {}) {
  const bars = [];
  // Per-ticker failures (rate limit, timeout, malformed payload) are
  // isolated below -- collected here and returned alongside `bars` rather
  // than thrown, so one bad ticker never blocks the others in the same
  // run. See this function's own per-ticker try/catch for why.
  const errors = [];
  // No documented Yahoo rate limit (this is an unofficial endpoint to begin
  // with, see this file's header) -- config.yfinanceMinRequestIntervalMs
  // defaults to 0, a true no-op, same convention as gdelt.js/rss.js. Exists
  // so pacing can be dialed in via env var if live traffic starts getting
  // 429s, without a code change.
  const throttle = createThrottle({ minIntervalMs: config.yfinanceMinRequestIntervalMs ?? 0 });

  for (const ticker of tickers) {
    // A prior call already got a 429 for this ticker and recorded a
    // cross-invocation cooldown (see below) -- skip the attempt entirely
    // rather than re-running a fetch (and, before this fix, a whole
    // exponential-backoff retry ladder) already known to be blocked. This
    // is what stops a sustained rate-limit from re-costing wall time on
    // every single 15-minute cron tick (see config.js#yfinanceCooldownSeconds).
    if (await isVendorCoolingDown(kv, "yfinance", ticker)) {
      errors.push({
        ticker,
        error: new VendorError("yfinance", `yfinance cooling down for ${ticker} after a recent 429 -- skipping until cooldown expires`, { status: 429, transient: false }),
      });
      continue;
    }

    await throttle.wait();
    try {
      const url = `${config.yfinanceApiBase}/${encodeURIComponent(ticker)}?interval=${config.yfinanceInterval}&range=${config.yfinanceRange}`;

      // The fetch + status check (not JSON parsing/validation below) is
      // what withRetry wraps -- those are the failure modes retry.js's
      // default shouldRetry considers worth retrying (network error, 5xx),
      // via the transient: true VendorError already thrown here. A
      // malformed/unexpected payload is a permanent failure, not a vendor
      // hiccup -- retrying it would just reproduce the same bad response.
      //
      // 429 is deliberately EXCLUDED from shouldRetry here (unlike the
      // shared default, which retries any transient: true failure) -- live
      // traffic showed yfinance's 429 is a sustained block lasting hours,
      // not a short burst retry.js's backoff is meant to ride out. Retrying
      // it in-process just burns 500ms/1000ms/... of wall time per attempt
      // for a call already known to fail; failing fast here and recording a
      // cooldown below (so the NEXT invocation skips it, see above) is what
      // actually stops the wall-time/CPU blowup, not a bigger backoff ladder.
      const response = await withRetry(
        async () => {
          let res;
          try {
            res = await fetchWithTimeout(url, { timeoutMs: config.fetchTimeoutMs });
          } catch (err) {
            throw new VendorError("yfinance", `network failure fetching yfinance chart API: ${err.message}`, { transient: true });
          }

          if (!res.ok) {
            throw new VendorError("yfinance", `yfinance chart API returned ${res.status} for ${ticker}`, {
              status: res.status,
              transient: res.status >= 500, // 429 handled separately, see comment above
            });
          }

          return res;
        },
        { maxAttempts: config.retryMaxAttempts, baseDelayMs: config.retryBaseDelayMs },
      );

      const data = await response.json();
      const result = data?.chart?.result?.[0];
      const chartError = data?.chart?.error;
      if (chartError) {
        throw new VendorError("yfinance", `yfinance chart API returned an error payload for ${ticker}: ${JSON.stringify(chartError)}`);
      }
      if (!result) {
        throw new VendorError("yfinance", `yfinance chart API returned no result for ${ticker} -- unexpected response shape`);
      }

      const timestamps = result.timestamp ?? [];
      const quote = result.indicators?.quote?.[0] ?? {};

      for (let i = 0; i < timestamps.length; i++) {
        // Yahoo returns null for fields it couldn't compute (e.g. a halted
        // session) -- skip rather than insert a bar with fabricated numbers.
        if (quote.open?.[i] == null || quote.high?.[i] == null || quote.low?.[i] == null || quote.close?.[i] == null || quote.volume?.[i] == null) {
          continue;
        }

        const bar = PriceBar.parse({
          ticker,
          date: timestampToDate(timestamps[i]),
          open: quote.open[i],
          high: quote.high[i],
          low: quote.low[i],
          close: quote.close[i],
          volume: quote.volume[i],
          source: "yfinance",
        });

        validatePriceBar(bar, { source: "yfinance" });
        bars.push(bar);
      }
    } catch (err) {
      // A single ticker's failure (rate limit, timeout, bad payload) does
      // NOT abort the rest of the watchlist -- see header comment on this
      // function. Only VendorError is swallowed here; anything else (a
      // real bug, e.g. a schema/validation throw) still propagates, same
      // convention as pipeline.js's collectNewsItems.
      if (err instanceof VendorError) {
        if (err.status === 429) {
          await setVendorCooldown(kv, "yfinance", ticker, config.yfinanceCooldownSeconds);
        }
        errors.push({ ticker, error: err });
      } else {
        throw err;
      }
    }
  }

  return { bars, errors };
}
