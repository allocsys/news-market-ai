// Twelve Data adapter -- intraday bars for XAUUSD (spot gold), the one
// ticker wired to this vendor per plan.md finding G's vendor decision
// (2026-09-23): Alpaca (free) for AAPL/MSFT/TSLA/USO, Twelve Data free Basic
// (800 requests/day, 8/minute) for XAUUSD only. Same contract shape as
// alpaca.js#fetchIntradayBars/tiingo.js#fetchHistoricalBars so ingest.js/the
// step-6 backfill job can treat this like any other price source, but
// returns PriceBarIntraday rows (schemas/index.js), not PriceBar.
//
// API: Twelve Data REST, GET {base}/time_series
//   ?symbol=XAU/USD&interval=5min&start_date=<YYYY-MM-DD HH:MM:SS>
//   &end_date=<YYYY-MM-DD HH:MM:SS>&outputsize=5000&order=ASC&timezone=UTC
//   &apikey=<key>
// Confirmed from Twelve Data's own published docs (support.twelvedata.com,
// twelvedata.com/docs/llms, read 2026-09-23):
//   * symbol uses "BASE/QUOTE" for forex/spot-metal pairs (e.g. "XAU/USD"),
//     NOT the bare "XAUUSD" ticker this codebase stores rows under -- see
//     TWELVE_DATA_SYMBOL_MAP below.
//   * start_date/end_date accept "YYYY-MM-DD HH:MM:SS"; timezone=UTC makes
//     that string (and the response's own `datetime` field) UTC, avoiding
//     any dependency on Twelve Data's default "Exchange" timezone.
//   * outputsize caps rows returned (max 5000) and CAN be combined with
//     start_date+end_date -- doing so restricts/truncates the range rather
//     than erroring (the docs' own wording), which is exactly the pagination
//     signal this adapter relies on: order=ASC + outputsize=5000 returns the
//     oldest 5000 bars in [start_date, end_date]; a full page means more
//     data may remain, so the next page's start_date becomes the last
//     returned bar's timestamp plus one interval (see cursorFrom below).
//   * error shape is a JSON body {code, message, status:"error"} whose `code`
//     matches the HTTP status (400/401/403/404/429/500 -- Twelve Data's own
//     documented table); this adapter still guards on payload.status==="error"
//     even when res.ok, in case a future/legacy response carries a soft
//     error at HTTP 200 (several vendors' APIs have done this historically;
//     unconfirmed either way for Twelve Data today, cheap to guard against).
//   * free Basic plan: 800 requests/day AND 8 requests/minute (both
//     published, support.twelvedata.com/en/articles/5194820-api-call-limits)
//     -- the per-minute figure is paced by throttle.js
//     (twelveDataMinRequestIntervalMs), the per-day figure by the SHARED,
//     D1-persisted shared/d1_rate_limiter.js (`db` is therefore a REQUIRED
//     argument here, unlike alpaca.js -- see this file's own header on
//     why Alpaca doesn't need one).
//
// UNVERIFIED (no adapter has called Twelve Data's API from this codebase
// yet -- confirm after the first real run against a free-Basic key):
//   1. that free Basic actually serves XAU/USD intraday bars at all (some
//      vendors gate spot-metal/forex intraday behind a paid tier even when
//      daily/EOD is free -- the pricing page material read this session
//      didn't call this out specifically for gold);
//   2. the exact "1-2 years intraday history" free-tier depth claimed by a
//      third-party summary (not Twelve Data's own docs) -- how far back a
//      backfill can actually reach is unconfirmed;
//   3. whether a genuinely empty range (e.g. a weekend within [from, to])
//      comes back as HTTP 200 with `values: []` or as the documented 404
//      "Requested data could not be found" -- this adapter treats a 404
//      as "no bars for this window" (returns an empty page, not a
//      VendorError) since gold trades ~23/5 and a backfill walking day by
//      day will hit real weekend gaps, but this is inferred from the
//      general shape of the docs, not a live-confirmed response.
//
// Failure shape matches alpaca.js/tiingo.js: a per-ticker VendorError
// (network, non-2xx, bad payload, daily-cap reached) is collected into
// `errors`, never aborts the other tickers. A missing key or missing `db`
// throws once, up front (can never work for any ticker), same as
// alpaca.js's missing-key-pair case.

import { PriceBarIntraday } from "../../schemas/index.js";
import { validatePriceBarIntraday } from "../market_data_validator.js";
import { VendorError } from "../../shared/errors.js";
import { createThrottle } from "../../shared/throttle.js";
import { fetchWithTimeout } from "../../shared/fetch_with_timeout.js";
import { withRetry } from "../../shared/retry.js";
import { reserve } from "../../shared/d1_rate_limiter.js";
import { INTRADAY_BAR_MS } from "../../shared/intraday_availability.js";

const VENDOR = "twelvedata";
const DEFAULT_API_BASE = "https://api.twelvedata.com";
const DEFAULT_DAILY_LIMIT = 800; // free Basic plan, published (support.twelvedata.com/en/articles/5194820-api-call-limits)
const MAX_PAGES_PER_TICKER = 50; // guardrail against an infinite pagination loop on a malformed/adversarial response, same convention as alpaca.js

/**
 * Ticker -> Twelve Data "BASE/QUOTE" symbol. Only XAUUSD is wired today
 * (plan.md finding G vendor decision, 2026-09-23) -- add an entry here only
 * after confirming Twelve Data's exact symbol for that ticker, same
 * "known set, not guessed" convention as tiingo.js's TIINGO_FX_TICKERS.
 */
export const TWELVE_DATA_SYMBOL_MAP = { XAUUSD: "XAU/USD" };

/** Milliseconds per supported Twelve Data interval string, for advancing a page cursor. Only intervals this adapter might realistically use are listed; an unlisted interval fails fast rather than silently mis-paginating. */
const INTERVAL_MS = {
  "1min": 60_000,
  "5min": 5 * 60_000,
  "15min": 15 * 60_000,
  "30min": 30 * 60_000,
  "45min": 45 * 60_000,
  "1h": 60 * 60_000,
  "2h": 2 * 60 * 60_000,
  "4h": 4 * 60 * 60_000,
};

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/** A Twelve Data price field (a numeric string) as a number, or NaN when it is missing: Number(null) and Number("") are 0, which must never pass for a real price. */
function priceField(value) {
  if (value === null || value === undefined || value === "") return NaN;
  return Number(value);
}

function toTwelveDataSymbol(ticker) {
  const symbol = TWELVE_DATA_SYMBOL_MAP[String(ticker).toUpperCase()];
  if (!symbol) {
    throw new VendorError(VENDOR, `no Twelve Data symbol mapping for ticker ${ticker} -- add one to TWELVE_DATA_SYMBOL_MAP after confirming Twelve Data's exact symbol for it`);
  }
  return symbol;
}

/** ISO8601 UTC instant -> Twelve Data's "YYYY-MM-DD HH:MM:SS" (paired with timezone=UTC on the request, see header). */
function toTwelveDataDateTime(iso) {
  return new Date(iso).toISOString().slice(0, 19).replace("T", " ");
}

/** Twelve Data's "YYYY-MM-DD HH:MM:SS" (UTC, given timezone=UTC on the request) -> ISO8601 UTC instant string. */
function fromTwelveDataDateTime(value) {
  return `${String(value).replace(" ", "T")}Z`;
}

/** First 200 characters of an error response body, or "" -- never throws, never includes the request (so never the key). */
async function readErrorDetail(res) {
  try {
    const text = await res.text();
    return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  } catch {
    return "";
  }
}

/** Fetches and parses ALL pages of ONE ticker's bars for [from, to] (ISO8601 UTC instants). Throws a VendorError on any failure. Reserves one daily-cap unit (shared/d1_rate_limiter.js) before every page request (retries of the same page are not separately reserved). */
async function fetchTickerBars(config, ticker, { from, to }, { throttle, db } = {}) {
  const base = String(config.twelveDataApiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
  const interval = config.twelveDataIntradayInterval || "5min";
  const intervalMs = INTERVAL_MS[interval];
  if (!intervalMs) {
    throw new VendorError(VENDOR, `unsupported twelveDataIntradayInterval "${interval}" -- add it to INTERVAL_MS after confirming Twelve Data supports it, so pagination can advance correctly`);
  }
  // getIntradayPriceAsOf treats every stored bar as INTRADAY_BAR_MS long (shared/intraday_availability.js); a longer bar would be read as closed before it was.
  if (intervalMs !== INTRADAY_BAR_MS) {
    throw new VendorError(VENDOR, `unsupported twelveDataIntradayInterval "${interval}" -- stored intraday bars must be exactly ${INTRADAY_BAR_MS / 60_000} minutes (shared/intraday_availability.js), or the point-in-time reader would show them before they close`);
  }
  const symbol = toTwelveDataSymbol(ticker);
  const dailyLimit = Number.isFinite(Number(config.twelveDataDailyRequestLimit)) ? Number(config.twelveDataDailyRequestLimit) : DEFAULT_DAILY_LIMIT;

  const bars = [];
  let cursorFrom = from;
  let pages = 0;

  for (;;) {
    pages += 1;
    if (pages > MAX_PAGES_PER_TICKER) {
      throw new VendorError(VENDOR, `twelvedata pagination exceeded ${MAX_PAGES_PER_TICKER} pages for ${ticker} in [${from}, ${to}] -- aborting rather than looping indefinitely`);
    }

    const reservation = await reserve(db, { vendor: VENDOR, limit: dailyLimit });
    if (!reservation.allowed) {
      throw new VendorError(VENDOR, `twelvedata daily request cap reached (${reservation.count}/${dailyLimit}) -- ${ticker}'s fetch for [${from}, ${to}] stopped after ${bars.length} bar(s) from ${pages - 1} page(s); resumes automatically tomorrow (UTC)`, { transient: false });
    }

    const params = new URLSearchParams({
      symbol,
      interval,
      start_date: toTwelveDataDateTime(cursorFrom),
      end_date: toTwelveDataDateTime(to),
      outputsize: "5000",
      order: "ASC",
      timezone: "UTC",
      apikey: config.twelveDataApiKey,
    });
    const url = `${base}/time_series?${params}`;

    await throttle?.wait();

    const response = await withRetry(
      async () => {
        let res;
        try {
          res = await fetchWithTimeout(url, { timeoutMs: config.fetchTimeoutMs });
        } catch (err) {
          // The key rides in the query string, so scrub it in case the runtime echoes the URL in the error message.
          const safeMessage = String(err.message).split(config.twelveDataApiKey).join("[redacted]");
          throw new VendorError(VENDOR, `network failure fetching twelvedata for ${ticker}: ${safeMessage}`, { transient: true });
        }

        // A genuinely empty range (e.g. a weekend inside [cursorFrom, to])
        // is expected, not a failure -- see header's UNVERIFIED note 3.
        // Returned as a sentinel below rather than thrown, so the caller can
        // treat it as "no more bars" and stop paginating cleanly.
        if (res.status === 404) return null;

        if (!res.ok) {
          const detail = await readErrorDetail(res);
          const hint = res.status === 401 ? " -- check TWELVE_DATA_API_KEY" : res.status === 403 ? " -- this endpoint/symbol may require a paid Twelve Data plan" : "";
          // 5xx and 429 (per-minute cap, distinct from the daily cap reserve() already checked above) are worth a retry; other 4xx are not.
          throw new VendorError(VENDOR, `twelvedata returned ${res.status} for ${ticker}${detail ? `: ${detail}` : ""}${hint}`, { status: res.status, transient: res.status >= 500 || res.status === 429 });
        }
        return res;
      },
      { maxAttempts: config.retryMaxAttempts, baseDelayMs: config.retryBaseDelayMs },
    );

    if (response === null) break; // 404 sentinel -- no data in the remaining range, stop paginating

    let payload;
    try {
      payload = await response.json();
    } catch (err) {
      throw new VendorError(VENDOR, `twelvedata returned unparseable JSON for ${ticker}: ${err.message}`);
    }
    // Twelve Data's documented error shape (see header) -- guarded here too
    // in case a soft error ever rides along with an HTTP 200.
    if (payload && payload.status === "error") {
      // The documented "Requested data could not be found" 404 is an empty window (see the 404 branch above and header note 3); if it ever rides along with an HTTP 200 it must not be a failure, or the backfill would re-claim that day forever.
      if (Number(payload.code) === 404) break;
      throw new VendorError(VENDOR, `twelvedata returned an error for ${ticker}: ${payload.message ?? JSON.stringify(payload).slice(0, 200)}`, { status: payload.code });
    }
    if (!payload || !Array.isArray(payload.values)) {
      throw new VendorError(VENDOR, `twelvedata returned an unexpected response shape for ${ticker} (expected {values: [...]}): ${JSON.stringify(payload).slice(0, 200)}`);
    }

    let lastTs;
    for (const row of payload.values) {
      const ts = row?.datetime ? fromTwelveDataDateTime(row.datetime) : "";
      if (!ts) continue;

      const open = priceField(row.open);
      const high = priceField(row.high);
      const low = priceField(row.low);
      const close = priceField(row.close);
      // Twelve Data returns OHLCV as strings; a null/unparseable field means
      // the vendor could not compute the bar: skip it rather than store
      // made-up numbers (same convention as alpaca.js/tiingo.js).
      if (![open, high, low, close].every(isFiniteNumber)) continue;

      const bar = PriceBarIntraday.parse({
        ticker,
        ts,
        open,
        high,
        low,
        close,
        volume: isFiniteNumber(Number(row.volume)) ? Number(row.volume) : 0,
        source: VENDOR,
      });
      validatePriceBarIntraday(bar, { source: VENDOR });
      bars.push(bar);
      lastTs = ts;
    }

    // Fewer than a full page means this was the last page in range.
    if (payload.values.length < 5000 || !lastTs) break;
    cursorFrom = new Date(new Date(lastTs).getTime() + intervalMs).toISOString();
    if (new Date(cursorFrom).getTime() > new Date(to).getTime()) break;
  }

  return bars;
}

/**
 * Intraday bars for `tickers` over [from, to] (ISO8601 UTC instants,
 * inclusive), one or more requests per ticker (paginated). Same
 * `{ bars, errors: [{ ticker, error }], requests }` contract as
 * alpaca.js#fetchIntradayBars, so ingest.js/the step-6 backfill job can use
 * either vendor the same way, but `bars` are PriceBarIntraday rows.
 *
 * `config.twelveDataApiKey` (TWELVE_DATA_API_KEY, a secret on the `ingest`
 * Worker) is required; without it this throws before making any request,
 * same "can never work for any ticker, fail once up front" convention as
 * tiingo.js's missing TIINGO_API_KEY / alpaca.js's missing key pair.
 *
 * `db` (env.INPUTS_DB, the D1 handle shared/d1_rate_limiter.js writes to)
 * is ALSO required, unlike alpaca.js -- Twelve Data's 800/day free-Basic cap
 * (unlike Alpaca's per-minute-only limit) must be tracked across
 * invocations or a backfill tick and a live-candle tick could each start
 * counting from zero and jointly blow the daily budget (see
 * d1_rate_limiter.js's own header). Passed as a third-argument options
 * object, `{ db }`, so this signature stays call-compatible with the
 * existing `fetchBars(config, {...}, { kv })` shape ingest.js's
 * resolvePriceLiveSource/resolvePriceBackfillSource already use for
 * tiingo.js/yfinance.js (kv there, db here -- same slot, different payload).
 */
export async function fetchIntradayBars(config, { tickers, from, to } = {}, { db } = {}) {
  if (!Array.isArray(tickers) || tickers.length === 0) {
    throw new Error("fetchIntradayBars requires a non-empty tickers array");
  }
  if (!from || !to) {
    throw new Error("fetchIntradayBars requires an explicit {from, to} range (ISO8601 UTC instants)");
  }
  if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
    throw new Error(`fetchIntradayBars: invalid from/to (${from}, ${to}) -- expected ISO8601`);
  }
  if (!config.twelveDataApiKey) {
    throw new VendorError(VENDOR, "TWELVE_DATA_API_KEY is not set on the ingest Worker -- add it as a repo secret (the ingest deploy pushes it)");
  }
  if (!db) {
    throw new VendorError(VENDOR, "fetchIntradayBars requires a D1 db handle (env.INPUTS_DB) to check/reserve twelvedata's shared daily request cap -- see shared/d1_rate_limiter.js");
  }

  const bars = [];
  const errors = [];
  let requests = 0;
  // 8/minute published free-Basic limit = one call every 7500ms; 7600ms
  // (100ms padding) is the same "real vendor-published number, small safety
  // margin" treatment as config.js's edgarMinRequestIntervalMs (110ms over
  // SEC's 10/sec).
  const throttle = createThrottle({ minIntervalMs: config.twelveDataMinRequestIntervalMs ?? 7600 });

  for (const ticker of tickers) {
    try {
      bars.push(...(await fetchTickerBars(config, ticker, { from, to }, { throttle, db })));
      requests += 1; // pagination detail (possibly >1 request) intentionally not surfaced per-ticker here, same coarse-count convention as alpaca.js/tiingo.js
    } catch (err) {
      if (err instanceof VendorError) {
        errors.push({ ticker, error: err });
      } else {
        throw err;
      }
    }
  }

  return { bars, errors, requests };
}
