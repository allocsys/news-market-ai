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
// UPDATE (2026-09-21, plan.md Next Steps step A -- backtest audit finding
// 1, "no price history"): the 429s this file already isolates and cools
// down per-ticker are SUSTAINED, and they hit EVERY ticker, not just MSFT.
// Workers Observability for the `ingest` Worker (2026-09-20, 12:00-21:36
// UTC) has yfinance error lines in every 36-minute bucket; the 15 lines
// sampled from about 20:15-21:15 UTC show `yfinance chart API returned 429`
// for AAPL, MSFT and TSLA on each attempt, with the alternate ticks being
// cooldown skips (the cooldown below). price_bars therefore holds only 5
// bars each for AAPL/TSLA (TSLA last written 2026-09-20 18:15 UTC) and none
// for MSFT. Suspected cause (UNPROVEN): Yahoo rate-limits the shared
// Cloudflare egress IPs, the same suspicion documented for GDELT elsewhere
// in this repo. This is a real, currently-unresolved vendor-access risk that
// a historical-range call cannot route around: it may 429 too. What it CAN
// do is not be skipped by the cooldown -- see fetchHistoricalBars, which
// ignores the cooldown (one request per ticker, operator-triggered) but
// still records a fresh one when it gets a 429. If it 429s in practice, the
// fallback is a different daily-bar source or seeding bars by hand (see
// plan.md, "Historical price backfill").
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
 * Fetches and parses ONE ticker's chart data, with `extraParams` (e.g.
 * `{ range: "5d" }` for the live trailing window, or `{ period1, period2 }`
 * for an explicit historical range -- see fetchDailyBars/fetchHistoricalBars
 * below, the only two callers) appended to the query string alongside
 * `interval`. Factored out of what used to be fetchDailyBars's own per-ticker
 * loop body (2026-09-2x, plan.md Next Steps step A) so fetchHistoricalBars
 * can reuse the EXACT SAME cooldown-check / throttle / retry / parse /
 * validate behavior instead of a second, drifting copy of it -- the two
 * request shapes differ ONLY in which Yahoo query params they ask for, never
 * in how a response or a vendor failure is handled. Throws a VendorError on
 * any failure (including "already cooling down" and a non-2xx response,
 * recording a fresh cooldown itself on a 429) -- callers keep their own
 * per-ticker try/catch around this call, same isolation shape as before.
 */
async function fetchTickerChart(config, ticker, extraParams, { kv, throttle, ignoreCooldown = false } = {}) {
  // A prior call already got a 429 for this ticker and recorded a
  // cross-invocation cooldown (see below) -- skip the attempt entirely
  // rather than re-running a fetch (and, before this fix, a whole
  // exponential-backoff retry ladder) already known to be blocked. This
  // is what stops a sustained rate-limit from re-costing wall time on
  // every single 15-minute cron tick (see config.js#yfinanceCooldownSeconds).
  // `ignoreCooldown` is set only by fetchHistoricalBars: an operator-triggered
  // backfill is one request per ticker, and honouring a cooldown that a cron
  // tick set minutes ago would make it fail without ever asking Yahoo. A 429
  // it gets is still recorded as a cooldown below, so the live path backs off.
  if (!ignoreCooldown && (await isVendorCoolingDown(kv, "yfinance", ticker))) {
    throw new VendorError("yfinance", `yfinance cooling down for ${ticker} after a recent 429 -- skipping until cooldown expires`, { status: 429, transient: false });
  }

  await throttle?.wait();

  const qs = new URLSearchParams({ interval: config.yfinanceInterval, ...extraParams }).toString();
  const url = `${config.yfinanceApiBase}/${encodeURIComponent(ticker)}?${qs}`;

  // The fetch + status check (not JSON parsing/validation below) is
  // what withRetry wraps -- those are the failure modes retry.js's
  // default shouldRetry considers worth retrying (network error, 5xx),
  // via the transient: true VendorError already thrown here. A
  // malformed/unexpected payload is a permanent failure, not a vendor
  // hiccup -- retrying it would just reproduce the same bad response.
  //
  // 429 is deliberately EXCLUDED from shouldRetry here (unlike the
  // shared default, which retries any transient: true failure) -- live
  // traffic showed yfinance's 429 is a sustained block lasting hours (see
  // this file's header for how sustained), not a short burst retry.js's
  // backoff is meant to ride out. Retrying it in-process just burns
  // 500ms/1000ms/... of wall time per attempt for a call already known
  // to fail; failing fast here and recording a cooldown below (so the
  // NEXT call, live or backfill, skips it, see above) is what actually
  // stops the wall-time/CPU blowup, not a bigger backoff ladder.
  const response = await withRetry(
    async () => {
      let res;
      try {
        res = await fetchWithTimeout(url, { timeoutMs: config.fetchTimeoutMs });
      } catch (err) {
        throw new VendorError("yfinance", `network failure fetching yfinance chart API: ${err.message}`, { transient: true });
      }

      if (!res.ok) {
        if (res.status === 429) {
          await setVendorCooldown(kv, "yfinance", ticker, config.yfinanceCooldownSeconds);
        }
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

  const bars = [];
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

  return bars;
}

/**
 * Fetches recent daily bars for each ticker in `tickers` (defaults to
 * config.watchlist's tickers). One request per ticker, since the chart
 * endpoint is single-symbol only -- there is no batch mode. Live trailing-
 * window path (config.yfinanceRange, 5d default) -- see fetchHistoricalBars
 * below for an explicit historical range instead.
 */
export async function fetchDailyBars(config, { tickers = config.watchlist.map((w) => w.ticker) } = {}, { kv } = {}) {
  const bars = [];
  // Per-ticker failures (rate limit, timeout, malformed payload) are
  // isolated below -- collected here and returned alongside `bars` rather
  // than thrown, so one bad ticker never blocks the others in the same
  // run. See fetchTickerChart's own per-ticker try/catch for why.
  const errors = [];
  // No documented Yahoo rate limit (this is an unofficial endpoint to begin
  // with, see this file's header) -- config.yfinanceMinRequestIntervalMs
  // defaults to 0, a true no-op, same convention as gdelt.js/rss.js. Exists
  // so pacing can be dialed in via env var if live traffic starts getting
  // 429s, without a code change.
  const throttle = createThrottle({ minIntervalMs: config.yfinanceMinRequestIntervalMs ?? 0 });

  for (const ticker of tickers) {
    try {
      bars.push(...(await fetchTickerChart(config, ticker, { range: config.yfinanceRange }, { kv, throttle })));
    } catch (err) {
      // A single ticker's failure (rate limit, timeout, bad payload) does
      // NOT abort the rest of the watchlist -- see header comment on this
      // function. Only VendorError is swallowed here; anything else (a
      // real bug, e.g. a schema/validation throw) still propagates, same
      // convention as pipeline.js's collectNewsItems.
      if (err instanceof VendorError) {
        errors.push({ ticker, error: err });
      } else {
        throw err;
      }
    }
  }

  return { bars, errors };
}

/**
 * Historical daily bars for `tickers` over an explicit [from, to] range
 * (YYYY-MM-DD, inclusive), via Yahoo's chart endpoint's `period1`/`period2`
 * unix-second params instead of fetchDailyBars' live `range=Nd` default --
 * plan.md Next Steps step A (backtest audit finding 1: price_bars has almost
 * no history, so a backtest window can't open positions outside a handful
 * of days). Deliberately a SEPARATE function/call path, not an extra param
 * on fetchDailyBars: the 15-minute cron's ingestPriceBars -> fetchDailyBars call
 * must keep asking for exactly its 5d trailing default, unchanged.
 *
 * UNLIKE Finnhub's news backfill (ingestion/date_windows.js), this makes
 * exactly ONE request per ticker for the WHOLE range -- Yahoo's chart
 * endpoint returns the entire requested period's daily bars in one response;
 * no per-request article-style cap has ever been observed here, so there is
 * no window-splitting/continuation to do. A caller backfilling a year of
 * daily bars for the 3-ticker watchlist costs 3 HTTP requests total.
 *
 * Same throttle/retry/parse/validate path as fetchDailyBars (both go through
 * fetchTickerChart), with ONE deliberate difference: this IGNORES the
 * cross-invocation 429 cooldown (`ignoreCooldown: true`). See this file's
 * header for how sustained the 429s are (every ticker): with the cooldown
 * honoured, a backfill would be skipped on most invocations without ever
 * reaching Yahoo. A 429 it does get fails fast (no in-process retry, same as
 * the live path) and still records the cooldown, so the live path backs off.
 *
 * `period2` is pushed to 23:59:59 of `to` so `to`'s own trading day is
 * included -- UNVERIFIED against a real response (no live network egress
 * from this sandbox, see ingestion/ingest.js's own header on that gap);
 * confirm after a real backfill run that `to`'s bar is actually present,
 * same "verify after a real run" caveat backfillHistoricalNews's own
 * inclusive/exclusive `to` assumption carries.
 */
export async function fetchHistoricalBars(config, { tickers = config.watchlist.map((w) => w.ticker), from, to } = {}, { kv } = {}) {
  if (!from || !to) {
    throw new Error("fetchHistoricalBars requires an explicit {from, to} range -- use fetchDailyBars for the live trailing-window path instead");
  }

  const period1 = Math.floor(Date.parse(`${from}T00:00:00.000Z`) / 1000);
  const period2 = Math.floor(Date.parse(`${to}T23:59:59.000Z`) / 1000);
  if (!Number.isFinite(period1) || !Number.isFinite(period2)) {
    throw new Error(`fetchHistoricalBars: invalid from/to (${from}, ${to})`);
  }

  const bars = [];
  const errors = [];
  const throttle = createThrottle({ minIntervalMs: config.yfinanceMinRequestIntervalMs ?? 0 });

  for (const ticker of tickers) {
    try {
      bars.push(...(await fetchTickerChart(config, ticker, { period1, period2 }, { kv, throttle, ignoreCooldown: true })));
    } catch (err) {
      if (err instanceof VendorError) {
        errors.push({ ticker, error: err });
      } else {
        throw err;
      }
    }
  }

  return { bars, errors, requests: tickers.length };
}
