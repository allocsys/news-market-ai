import { escapeHtml, rangePresetButtons, DATE_INPUT_STYLE, backtestRunsList } from "../helpers.js";

export function backtestTriggerForm() {
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  return `<form method="get" action="/dashboard/backtest/confirm" class="filter-bar">
    <div class="filter-group">
      <span class="filter-label">Tickers (comma-separated, blank = watchlist)</span>
      <input class="filter-form" type="text" name="tickers" placeholder="AAPL,MSFT" style="background:#0d1118;color:#d9d4c4;border:1px solid #2c3644;padding:0.34rem 0.5rem;font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:0.8rem;width:100%;box-sizing:border-box;">
    </div>
    ${rangePresetButtons("backtestStart", "backtestEnd")}
    <div class="filter-group">
      <span class="filter-label">Test start</span>
      <input class="filter-form" id="backtestStart" type="date" name="testStart" value="${monthAgo}" style="${DATE_INPUT_STYLE}">
    </div>
    <div class="filter-group">
      <span class="filter-label">Test end</span>
      <input class="filter-form" id="backtestEnd" type="date" name="testEnd" value="${today}" style="${DATE_INPUT_STYLE}">
    </div>
    <div class="filter-group">
      <span class="filter-label">&nbsp;</span>
      <button type="submit">Review &amp; run backtest</button>
    </div>
  </form>`;
}

export function renderBacktestView({ backtestRuns }) {
  return `<section id="backtest">
    <h2>Backtest results</h2>
    <p class="note">Signal ON (real pipeline over already-backfilled news) vs. signal OFF (naive buy &amp; hold), manually triggered -- never automatic. Requires a logged-in dashboard session -- log in from the dashboard's login page to use this. A window with no backfilled news for it (see <code>POST /backfill</code>) will show a thin/empty "on" side, not an error.</p>
    ${backtestTriggerForm()}
    ${backtestRunsList(backtestRuns)}
  </section>`;
}

export function renderBacktestConfirmPage({ testStart, testEnd, tickers, graceDays }) {
  return `<section id="backtest-confirm">
    <h2>Confirm manual backtest</h2>
    <p class="note">You are about to run a manual backtest with the following parameters:</p>
    <div class="llm-answer-body" style="max-width:none; margin-bottom: 1.5rem;">
      <div class="llm-block"><span class="llm-agent">Tickers</span> <span class="ticker">${escapeHtml(tickers ?? "Watchlist")}</span></div>
      <div class="llm-block"><span class="llm-agent">Test Start</span> <span class="num">${escapeHtml(testStart)}</span></div>
      <div class="llm-block"><span class="llm-agent">Test End</span> <span class="num">${escapeHtml(testEnd)}</span></div>
      ${graceDays ? `<div class="llm-block"><span class="llm-agent">Grace Days</span> <span class="num">${escapeHtml(graceDays)}</span></div>` : ""}
    </div>
    <p class="note" style="color: #c1502e; font-weight: 600;">Cost warning: This action makes real Gemini API calls and spends model quota.</p>
    <form method="post" action="/backtest/run" class="filter-bar">
      <input type="hidden" name="testStart" value="${escapeHtml(testStart)}">
      <input type="hidden" name="testEnd" value="${escapeHtml(testEnd)}">
      ${tickers ? `<input type="hidden" name="tickers" value="${escapeHtml(tickers)}">` : ""}
      ${graceDays ? `<input type="hidden" name="graceDays" value="${escapeHtml(graceDays)}">` : ""}
      <div class="filter-group">
        <button type="submit">Confirm and run backtest</button>
      </div>
    </form>
  </section>`;
}
