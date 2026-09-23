// Daily PORTFOLIO equity curves for the signal on/off comparison (plan.md
// "Next steps", step D, audit finding 4). Pure functions, no I/O: bars and
// positions come in as plain data (backtest/priceGrid.js loads them).
//
// WHY: the old comparison scored "on" as one realized return per CLOSED TRADE
// (every ticker pooled, compounded as if the trades ran one after another,
// ignoring position size, concurrency and idle cash) and "off" as one
// buy-and-hold return per ticker per window, then ran a sqrt(252) Sharpe over
// those unlike series. That is not one comparison. Both sides are now the same
// thing: a daily portfolio return series over the SAME dates and the SAME
// tickers, so cumulative return, max drawdown and Sharpe mean the same on both.
//
//   off  Equal-weight buy-and-hold of every ticker, fully invested from the
//        start, never rebalanced. The bar the signal has to beat.
//   on   The positions the pipeline actually opened, each sized at its
//        position_size_pct of the portfolio's equity when it opened, the rest
//        in cash earning nothing. Marked to market every day; a position still
//        open at the end of the span stays in the curve (it is not dropped or
//        force-closed).
//
// PRICES follow the same rule as everything else (shared/price_availability.js):
// a decision made during day D is priced at the previous day's close. So a
// position opened during day D (entry price = the prior close) earns day D's
// close-to-close move, and one closed during day E (exit price = the prior
// close) stops earning at day E-1's close. That is why a position is "active" on
// grid date g exactly when  openDate <= g < closeDate  (UTC dates), with no
// need to look up the entry or exit bar. The equal-weight baseline is bought at
// the prior close of the first day too, so both sides earn every day's move.
//
// Returned series are FRACTIONAL daily returns (0.01 = +1%), aligned with
// `grid.dates`; metrics.js#summarizeReturns turns them into cumulative return,
// max drawdown, Sharpe (sqrt(252) is right for daily returns) and up-day rate.

import { utcDateOf } from "../shared/price_availability.js";

/** The longest run of calendar days without a bar we accept before calling a ticker's data unfit (a long weekend or a holiday is 4). */
export const DEFAULT_MAX_PRICE_GAP_DAYS = 5;

const DAY_MS = 86400000;

/** Whole calendar days from `a` to `b` (both `YYYY-MM-DD`); negative if b is before a. */
export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

/** `date` (`YYYY-MM-DD`) shifted by `days` calendar days. */
export function addDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Builds the shared price grid for a test span, and decides which tickers have
 * price data good enough to score. `from`/`to` are `YYYY-MM-DD`, `to` exclusive
 * (a bar dated on `to` is not visible at the span's end, see price_availability.js).
 *
 * `barsByTicker[ticker]` = `[{date, close}]`, oldest first, ideally starting a
 * few days before `from` so the last bar before the span can serve as the entry
 * price. A ticker is INELIGIBLE (listed in `problems` with the reason, never
 * silently patched over) when:
 *   - it has no bar inside [from, to);
 *   - it has no bar within `maxGapDays` of `from` (nothing to buy at the start);
 *   - its last bar is more than `maxGapDays` before `to` (the data stops early);
 *   - two consecutive bars are more than `maxGapDays` apart (a hole, not a holiday).
 * Ordinary weekends and holidays pass, and their missing days are filled by
 * carrying the last close forward (no invented move).
 *
 * Returns { tickers (eligible, in request order), problems, dates, closes, basis }:
 * `dates` is the sorted union of the eligible tickers' bar dates inside the span;
 * `closes[ticker][k]` is that ticker's close on `dates[k]` (forward-filled);
 * `basis[ticker]` is the entry price the buy-and-hold side pays (the last bar
 * before `from` when it is recent enough, else the ticker's first bar in the span).
 */
export function buildPriceGrid({ barsByTicker, tickers, from, to, maxGapDays = DEFAULT_MAX_PRICE_GAP_DAYS }) {
  const eligible = [];
  const problems = [];
  const prepared = new Map();

  for (const ticker of tickers) {
    // Never look at or past the span's end, whatever the caller loaded.
    const bars = (barsByTicker[ticker] ?? []).filter((b) => b.date < to);
    const inSpan = bars.filter((b) => b.date >= from);
    const before = [...bars].reverse().find((b) => b.date < from) ?? null;

    const reason = coverageProblem({ bars, inSpan, before, from, to, maxGapDays });
    if (reason.problem) {
      problems.push({ ticker, reason: reason.problem });
      continue;
    }
    eligible.push(ticker);
    prepared.set(ticker, { inSpan, basis: reason.basis });
  }

  const dateSet = new Set();
  for (const { inSpan } of prepared.values()) for (const b of inSpan) dateSet.add(b.date);
  const dates = [...dateSet].sort();

  const closes = {};
  const basis = {};
  for (const ticker of eligible) {
    const { inSpan, basis: basisBar } = prepared.get(ticker);
    const byDate = new Map(inSpan.map((b) => [b.date, b.close]));
    let last = basisBar.close;
    closes[ticker] = dates.map((d) => {
      if (byDate.has(d)) last = byDate.get(d);
      return last;
    });
    basis[ticker] = basisBar.close;
  }

  return { tickers: eligible, problems, dates, closes, basis, from, to, maxGapDays };
}

/** Returns { problem } (a human-readable reason) or { basis } (the entry bar). */
function coverageProblem({ bars, inSpan, before, from, to, maxGapDays }) {
  if (inSpan.length === 0) {
    const last = bars.at(-1);
    return { problem: last ? `no price bars in [${from}, ${to}); the latest bar is ${last.date}` : `no price bars at or before ${to}` };
  }

  let basis = null;
  if (before && daysBetween(before.date, from) <= maxGapDays) basis = before;
  else if (daysBetween(from, inSpan[0].date) <= maxGapDays) basis = inSpan[0];
  else {
    const gap = daysBetween(from, inSpan[0].date);
    return {
      problem: `first price bar is ${inSpan[0].date}, ${gap} days after the window start ${from} (max ${maxGapDays})${before ? `; the last earlier bar is ${before.date}` : ""}`,
    };
  }

  const last = inSpan.at(-1);
  const tail = daysBetween(last.date, to);
  if (tail > maxGapDays) {
    return { problem: `price data ends ${last.date}, ${tail} days before the window end ${to} (max ${maxGapDays})` };
  }

  const sequence = basis === before ? [before, ...inSpan] : inSpan;
  for (let i = 1; i < sequence.length; i++) {
    const gap = daysBetween(sequence[i - 1].date, sequence[i].date);
    if (gap > maxGapDays) {
      return { problem: `no price bars for ${gap} days between ${sequence[i - 1].date} and ${sequence[i].date} (max ${maxGapDays})` };
    }
  }

  return { basis };
}

/**
 * Equal-weight buy-and-hold over the grid's eligible tickers: every ticker gets
 * 1/N of the starting equity at its entry price (`grid.basis`) and is never
 * rebalanced. Returns { returns, exposure } aligned with `grid.dates`;
 * exposure is 1 every day (fully invested). Empty grid -> empty series.
 */
export function offEquityReturns(grid) {
  const n = grid.tickers.length;
  if (n === 0 || grid.dates.length === 0) return { returns: [], exposure: [] };

  const returns = [];
  let previous = 1;
  for (let k = 0; k < grid.dates.length; k++) {
    let value = 0;
    for (const ticker of grid.tickers) value += grid.closes[ticker][k] / grid.basis[ticker];
    value /= n;
    returns.push(value / previous - 1);
    previous = value;
  }
  return { returns, exposure: grid.dates.map(() => 1) };
}

/**
 * The signal side: replays `positions` (RunStore#getPositionsInRange rows) on the
 * grid. Each position is sized at `positionSizePct` of the portfolio's equity at
 * the close before it opened, is worth `allocation * (price / entryPrice)` (long)
 * or `allocation * (2 - price / entryPrice)` (short, floored at 0), and the rest
 * of the equity sits in cash at 0%. Equity starts at 1.
 *
 * A position is active on grid date g iff  openDate <= g  and  (still open or
 * g < closeDate)  in UTC dates -- see the header for why that is exactly right.
 * A position that opened and closed within one UTC day is never active (it is
 * priced at the same prior close both times, a 0% round trip).
 *
 * Positions on a ticker outside the scored universe, or without a usable
 * entry price, direction or size, cannot be replayed and are COUNTED in
 * `positionsIgnored`, never guessed at.
 *
 * Returns { returns, exposure, positionsTraded, positionsIgnored } with `returns`
 * and `exposure` (fraction of equity invested at the start of each day) aligned
 * with `grid.dates`.
 */
export function onEquityReturns(grid, positions) {
  if (grid.tickers.length === 0 || grid.dates.length === 0) {
    return { returns: [], exposure: [], positionsTraded: 0, positionsIgnored: positions.length };
  }

  const universe = new Set(grid.tickers);
  const replayable = [];
  let positionsIgnored = 0;
  for (const p of positions) {
    const usable =
      universe.has(p.ticker) &&
      (p.direction === "long" || p.direction === "short") &&
      Number.isFinite(p.entryPrice) && p.entryPrice > 0 &&
      Number.isFinite(p.positionSizePct) && p.positionSizePct > 0;
    if (!usable) {
      positionsIgnored++;
      continue;
    }
    replayable.push({
      ...p,
      openDate: utcDateOf(p.openedAt),
      closeDate: p.closedAt ? utcDateOf(p.closedAt) : null,
      allocation: null,
      previousValue: null,
    });
  }

  const returns = [];
  const exposure = [];
  const traded = new Set();
  let equity = 1;

  for (let k = 0; k < grid.dates.length; k++) {
    const date = grid.dates[k];
    let pnl = 0;
    let invested = 0;

    for (const pos of replayable) {
      if (pos.openDate > date) continue;
      // A position opened and closed (e.g. replaced) within the same UTC day
      // has openDate === closeDate; the plain `date >= closeDate` check below
      // would then exclude it on its only active day, silently dropping every
      // same-day round trip from the curve. Let it be active for exactly that
      // one day (never any day after), consistent with the header's own
      // "priced at the same prior close both times, a 0% round trip" intent.
      if (pos.closeDate !== null && date >= pos.closeDate && pos.closeDate !== pos.openDate) continue;
      if (pos.closeDate !== null && pos.closeDate === pos.openDate && date !== pos.openDate) continue;

      if (pos.allocation === null) {
        pos.allocation = pos.positionSizePct * equity;
        pos.previousValue = pos.allocation;
        traded.add(pos.id);
      }

      const move = grid.closes[pos.ticker][k] / pos.entryPrice;
      const value = pos.allocation * (pos.direction === "long" ? move : Math.max(0, 2 - move));
      invested += pos.previousValue;
      pnl += value - pos.previousValue;
      pos.previousValue = value;
    }

    returns.push(pnl / equity);
    exposure.push(invested / equity);
    equity += pnl;
  }

  return { returns, exposure, positionsTraded: traded.size, positionsIgnored };
}

/** The values of a grid-aligned series whose date falls in [utcDate(testStart), utcDate(testEnd)). */
export function sliceSeriesByWindow(dates, values, { testStart, testEnd }) {
  const from = utcDateOf(testStart);
  const to = utcDateOf(testEnd);
  return values.filter((_, i) => dates[i] >= from && dates[i] < to);
}

/** Mean of a series; 0 for an empty one. */
export function meanOf(values) {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}
