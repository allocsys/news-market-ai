// The dashboard's backtest result table after plan.md step D: metrics are over
// daily portfolio returns, so the old per-trade "Win rate" is now "Up days" and
// the note says what each side is and how much of the time the signal was
// invested. A run saved before that change (no `portfolio`) still renders.

import test from "node:test";
import assert from "node:assert/strict";
import { backtestResultTable } from "../src/dashboard/helpers.js";

const side = (cumulativeReturn) => ({ n: 5, cumulativeReturn, meanReturn: 0, sharpeRatio: 1.5, maxDrawdown: 0.02, winRate: 0.4 });
const overall = { on: side(0.004), off: side(0.21), delta: { cumulativeReturn: -0.206, sharpeRatio: 0, winRate: 0, maxDrawdown: 0 } };

test("backtestResultTable explains the daily-equity scoring, labels up days, and shows exposure and universe", () => {
  const html = backtestResultTable({
    overall, perWindow: [{}],
    portfolio: { days: 5, from: "2026-01-01", to: "2026-01-06", tickers: ["AAPL", "A<B>"], on: { avgExposure: 0.008, positionsTraded: 1, positionsIgnored: 0 }, off: { avgExposure: 1, holdings: 2 } },
  });
  assert.match(html, /Up days/);
  assert.doesNotMatch(html, /Win rate/);
  assert.match(html, /Scored on 5 daily portfolio returns \(2026-01-01 to 2026-01-06\)/);
  assert.match(html, /average 0\.8% invested, 1 position\b/);
  assert.match(html, /equal-weight buy &amp; hold/);
  assert.ok(html.includes("A&lt;B&gt;"), "tickers are HTML-escaped");
  assert.doesNotMatch(html, /could not be replayed/);
});

test("backtestResultTable says how many positions could not be replayed, and still renders a run saved before the change", () => {
  const withIgnored = backtestResultTable({
    overall, perWindow: [{}, {}],
    portfolio: { days: 1, from: "2026-01-01", to: "2026-01-02", tickers: ["AAPL"], on: { avgExposure: 0, positionsTraded: 0, positionsIgnored: 2 }, off: { avgExposure: 1, holdings: 1 } },
  });
  assert.match(withIgnored, /Scored on 1 daily portfolio return \(/);
  assert.match(withIgnored, /2 could not be replayed/);

  const old = backtestResultTable({ overall, perWindow: [{}] });
  assert.match(old, /Win rate/);
  assert.doesNotMatch(old, /Scored on/);
  assert.equal(backtestResultTable(null), "");
});
