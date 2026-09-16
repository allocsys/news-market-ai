// Yahoo Finance chart API adapter (unofficial, per plan.md ingestion
// section) -- price/volume data for the technical analyst and backtesting.
//
// HONEST SCOPE / KNOWN RISK, read before relying on this in production:
// This endpoint (query1.finance.yahoo.com/v8/finance/chart) is undocumented
// and Yahoo has, as of recent yfinance library issue reports (2025), started
// requiring a cookie+crumb handshake for at least some request patterns --
// a plain unauthenticated fetch() like the one below can come back 401/429
// even for a request that would have worked fine before that change. This
// adapter deliberately does NOT implement the cookie/crumb dance (it's a
// stateful two-request flow needing a cookie jar, real infra beyond a
// single stateless fetch) -- same "flag it, don't fake it" approach as
// gdelt.js's empty-body gap. TREAT THIS AS UNVERIFIED until spot-checked
// against a live request from wherever the Worker actually runs; see
// gdelt.js's own header for the same caveat pattern (that one confirmed a
// 429 from the sandbox environment specifically -- this one hasn't even
// gotten that far).
//
// Every returned bar is run through market_data_validator.js#validatePriceBar
// before being handed back, matching gdelt.js's validate-before-return
// convention. A vendor failure surfaces as a typed VendorError (Adopted
// Pattern #11), never a silent empty/partial result.

import { PriceBar } from "../../schemas/index.js";
import { validatePriceBar } from "../market_data_validator.js";
import { VendorError } from "../../shared/errors.js";

/** Yahoo's chart timestamps are Unix seconds -- convert to YYYY-MM-DD (UTC). */
function timestampToDate(unixSeconds) {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * Fetches recent daily bars for each ticker in `tickers` (defaults to
 * config.watchlist's tickers). One request per ticker, since the chart
 * endpoint is single-symbol only -- there is no batch mode.
 */
export async function fetchDailyBars(config, { tickers = config.watchlist.map((w) => w.ticker) } = {}) {
  const bars = [];

  for (const ticker of tickers) {
    const url = `${config.yfinanceApiBase}/${encodeURIComponent(ticker)}?interval=${config.yfinanceInterval}&range=${config.yfinanceRange}`;

    let response;
    try {
      response = await fetch(url);
    } catch (err) {
      throw new VendorError("yfinance", `network failure fetching yfinance chart API: ${err.message}`, { transient: true });
    }

    if (!response.ok) {
      throw new VendorError("yfinance", `yfinance chart API returned ${response.status} for ${ticker}`, {
        status: response.status,
        transient: response.status === 429 || response.status >= 500,
      });
    }

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
  }

  return bars;
}
