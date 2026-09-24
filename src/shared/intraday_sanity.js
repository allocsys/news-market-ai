// Write-time sanity gate for intraday bars (plan.md finding G, step 3 of the
// XAUUSD follow-up). ONE choke point for every vendor:
// storage/inputs_view.js#insertPriceBarsIntraday runs every batch through
// gateIntradayBars before anything reaches price_bars_intraday, so a new or
// swapped vendor (Twelve Data -> Tiingo FX already happened once) cannot
// write a bar this module would refuse. The adapters keep their own
// per-bar OHLC-consistency check (market_data_validator.js); this adds the
// checks that need market context, which no single-bar validator can make.
//
// WHAT IT CHECKS (each rejection carries a `code` and a human reason):
//   unparseable_ts     -- ts does not parse
//   non_positive_price -- open/high/low/close missing, non-finite or <= 0
//   range              -- (high - low) / low above MAX_BAR_RANGE_PCT: no
//                         5-minute bar of any watchlist instrument does that
//                         on real data, so it is a vendor/unit error
//   spike              -- close differs from BOTH neighbours' closes (same
//                         ticker, ts order, within the batch) by more than
//                         MAX_SPIKE_PCT. Requiring both neighbours means a
//                         real gap that price then stays at is NOT flagged,
//                         and one bad bar can't poison the bars after it.
//                         First/last bar of a batch have one neighbour, so
//                         they are never spike-checked.
//   closed_window      -- ts falls in a window where the market is closed in
//                         every DST regime (see isInClosedWindow)
//
// It also CANONICALISES ts (canonicalIntradayTs). Reads compare ts as strings
// in SQL, and "...:00.000Z" sorts before "...:00Z", so a writer that skips the
// canonical form silently misplaces the boundary bar (caught in CI on the
// Tiingo adapter, PR #115). Doing it here as well makes that class of bug
// impossible to ship through any writer.
//
// REJECT, DON'T THROW: a bad bar is dropped and reported to the caller, which
// logs it loudly (Adopted Pattern #11 -- never silently serve thinner data).
// Throwing would fail the whole claimed day, and a 'failed' day is re-claimed
// every tick, burning the vendor's free-tier quota on a day that will keep
// failing.
//
// KNOWN GAPS (placeholders, untuned, same status as MAX_PORTFOLIO_RISK_PCT):
//   - no exchange holiday calendar: a bar on a US market holiday passes
//   - closed windows are the INTERSECTION of the winter/summer schedules, so
//     they never reject a real bar but can admit a flat one near the edges
//   - the thresholds below have not been checked against live data

import { canonicalIntradayTs } from "./intraday_availability.js";

/** Largest plausible (high - low) / low for one 5-minute bar. */
export const MAX_BAR_RANGE_PCT = 0.10;

/** Largest plausible close-to-close move away from BOTH neighbouring bars. */
export const MAX_SPIKE_PCT = 0.15;

/**
 * Instruments that trade ~24h Sun evening -> Fri evening (spot FX/metals)
 * instead of on an equity session. MUST match
 * ingestion/sources/tiingo_fx_intraday.js#TIINGO_FX_INTRADAY_TICKERS -- kept
 * here (shared/ cannot import from ingestion/) and pinned equal by
 * test/intraday_sanity_gate.test.js so the two can't drift silently.
 */
export const FX_24X5_TICKERS = new Set(["XAUUSD"]);

/**
 * Is `ts` inside a window where `ticker`'s market is closed regardless of
 * DST? (UTC throughout.)
 *   - 24x5 spot (XAUUSD): closed Fri 22:00Z <= ts < Sun 22:00Z. Real close is
 *     Fri 21:00Z (US summer) / 22:00Z (winter); real open Sun 22:00Z / 23:00Z.
 *   - everything else (US equities/ETFs): closed Sat 01:00Z <= ts < Mon 08:00Z,
 *     i.e. after Friday's post-market ends (00:00Z/01:00Z Sat) and before
 *     Monday's pre-market starts (08:00Z/09:00Z). Extended-hours bars on
 *     weekdays are deliberately NOT rejected.
 * An unparseable ts returns false; the unparseable_ts check owns that case.
 */
export function isInClosedWindow(ticker, ts) {
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) return false;
  const d = new Date(ms);
  const dow = d.getUTCDay(); // 0 = Sunday ... 6 = Saturday
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();

  if (FX_24X5_TICKERS.has(String(ticker).toUpperCase())) {
    if (dow === 5) return minutes >= 22 * 60;
    if (dow === 6) return true;
    if (dow === 0) return minutes < 22 * 60;
    return false;
  }

  if (dow === 6) return minutes >= 60;
  if (dow === 0) return true;
  if (dow === 1) return minutes < 8 * 60;
  return false;
}

/** The reason a single bar fails on its own (no neighbours needed), or null. `ts` is already canonical. */
function standaloneRejection(bar, ts, maxRangePct) {
  if (Number.isNaN(Date.parse(ts))) {
    return { code: "unparseable_ts", reason: `unparseable ts: ${JSON.stringify(bar.ts)}` };
  }
  for (const field of ["open", "high", "low", "close"]) {
    const v = bar[field];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      return { code: "non_positive_price", reason: `${field} is not a positive finite number: ${JSON.stringify(v)}` };
    }
  }
  const range = (bar.high - bar.low) / bar.low;
  if (range > maxRangePct) {
    return { code: "range", reason: `bar range ${(range * 100).toFixed(1)}% (high ${bar.high}, low ${bar.low}) exceeds ${(maxRangePct * 100).toFixed(0)}%` };
  }
  if (isInClosedWindow(bar.ticker, ts)) {
    return { code: "closed_window", reason: `ts ${ts} is inside ${bar.ticker}'s closed-market window` };
  }
  return null;
}

/**
 * Runs `bars` (any mix of tickers) through every check above.
 * Returns `{ accepted, rejected }`: `accepted` are the bars to write, each with
 * a canonical `ts`; `rejected` is `[{ticker, ts, code, reason}]`. Input order is
 * not preserved in `accepted` (writes are upserts keyed on (ticker, ts), so it
 * doesn't matter).
 */
export function gateIntradayBars(bars, { maxRangePct = MAX_BAR_RANGE_PCT, maxSpikePct = MAX_SPIKE_PCT } = {}) {
  const rejected = [];
  const byTicker = new Map();

  for (const bar of bars) {
    const ts = canonicalIntradayTs(bar.ts);
    const problem = standaloneRejection(bar, ts, maxRangePct);
    if (problem) {
      rejected.push({ ticker: bar.ticker, ts: bar.ts, ...problem });
      continue;
    }
    if (!byTicker.has(bar.ticker)) byTicker.set(bar.ticker, []);
    byTicker.get(bar.ticker).push({ ...bar, ts });
  }

  const accepted = [];
  for (const list of byTicker.values()) {
    list.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    for (let i = 0; i < list.length; i++) {
      const bar = list[i];
      const prev = list[i - 1];
      const next = list[i + 1];
      if (prev && next) {
        const fromPrev = Math.abs(bar.close - prev.close) / prev.close;
        const fromNext = Math.abs(bar.close - next.close) / next.close;
        if (fromPrev > maxSpikePct && fromNext > maxSpikePct) {
          rejected.push({
            ticker: bar.ticker,
            ts: bar.ts,
            code: "spike",
            reason: `close ${bar.close} is ${(fromPrev * 100).toFixed(1)}% from the previous close and ${(fromNext * 100).toFixed(1)}% from the next (max ${(maxSpikePct * 100).toFixed(0)}%)`,
          });
          continue;
        }
      }
      accepted.push(bar);
    }
  }

  return { accepted, rejected };
}

/** `{code: count}` over a `rejected` list, for a one-line log/status note. */
export function summarizeIntradayRejections(rejected) {
  const counts = {};
  for (const r of rejected) counts[r.code] = (counts[r.code] ?? 0) + 1;
  return counts;
}
