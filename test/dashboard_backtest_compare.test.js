// Cross-run comparison table on /dashboard/backtest (helpers.js#backtestCompareTable).
// Render functions are called directly, same convention as the other dashboard tests.

import test from "node:test";
import assert from "node:assert/strict";
import { backtestCompareTable } from "../src/dashboard/helpers.js";
import { renderBacktestView } from "../src/dashboard/views/backtest.js";

function done(id, { on = 0.012, off = -0.03, sharpe = 0.8, exposure = 0.05, positions = 4, start = "2026-09-05", end = "2026-10-05", tickers = ["AAPL", "MSFT"], portfolio = true } = {}) {
  return {
    id,
    tickers,
    testStart: `${start}T00:00:00.000Z`,
    testEnd: `${end}T00:00:00.000Z`,
    status: "complete",
    error: null,
    startedAt: `${end}T01:00:00.000Z`,
    result: {
      overall: {
        on: { cumulativeReturn: on, sharpeRatio: sharpe, winRate: 0.5, maxDrawdown: -0.01 },
        off: { cumulativeReturn: off, sharpeRatio: 0.1, winRate: 0.5, maxDrawdown: -0.1 },
        delta: { cumulativeReturn: on - off },
      },
      perWindow: [],
      ...(portfolio ? { portfolio: { method: "daily-equity-curve-v3", days: 20, from: start, to: end, tickers, on: { avgExposure: exposure, positionsTraded: positions, positionsIgnored: 0, openAtSpanEnd: 0 } } } : {}),
    },
  };
}

test("backtestCompareTable renders nothing for fewer than two finished runs", () => {
  assert.equal(backtestCompareTable([]), "");
  assert.equal(backtestCompareTable(undefined), "");
  assert.equal(backtestCompareTable([done("a")]), "");
  assert.equal(backtestCompareTable([done("a"), { ...done("b"), status: "running", result: null }]), "");
});

test("backtestCompareTable shows one row per finished run with the headline numbers", () => {
  const html = backtestCompareTable([done("a"), done("b", { on: -0.002, off: 0.01, start: "2026-08-05", end: "2026-09-05" })]);
  assert.match(html, /Compare finished runs \(2\)/);
  assert.equal((html.match(/<tr class="rt-tiles">/g) || []).length, 2);
  assert.match(html, /2026-09-05 &rarr; 2026-10-05/);
  assert.match(html, /\+1\.2%/);
  assert.match(html, /-3\.0%/);
  assert.match(html, /-0\.2%/);
  assert.match(html, /5\.0%/);
  assert.match(html, /data-label="Positions">4</);
  assert.match(html, /2 tickers/);
});

test("backtestCompareTable colours the delta and skips failed runs", () => {
  const html = backtestCompareTable([done("a"), done("b", { on: -0.05, off: 0.01 }), { ...done("c"), status: "failed", result: null, error: "x" }]);
  assert.match(html, /\(2\)/);
  assert.match(html, /status-approved" data-label="Delta"/);
  assert.match(html, /status-rejected" data-label="Delta"/);
});

test("backtestCompareTable tolerates runs saved before the portfolio scoring (no exposure/positions)", () => {
  const html = backtestCompareTable([done("a", { portfolio: false }), done("b", { portfolio: false })]);
  assert.match(html, /data-label="Invested">\u2014</);
  assert.match(html, /data-label="Positions">\u2014</);
});

test("backtestCompareTable escapes ticker names", () => {
  const html = backtestCompareTable([done("a", { tickers: ['<img src=x>'] }), done("b")]);
  assert.ok(!html.includes("<img src=x>"));
});

test("backtest page includes the comparison above Recent runs, and omits it on error", () => {
  const ok = renderBacktestView({ backtestRuns: [done("a"), done("b")], error: null, replayJobs: [], replayError: null });
  assert.match(ok, /Compare finished runs \(2\)/);
  const bad = renderBacktestView({ backtestRuns: [], error: "boom", replayJobs: [], replayError: null });
  assert.ok(!bad.includes("Compare finished runs"));
});
