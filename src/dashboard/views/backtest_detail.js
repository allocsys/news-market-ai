// /dashboard/backtest/:id -- one backtest run's trade timeline: an equity-curve
// chart with a marker per position, headline numbers, and a table of every
// position with the news that triggered it and an expandable "why" (analyst
// opinions, bull/bear debate, trader rationale -- helpers.js#llmAnswerDetails).
// Props are exactly what backend's GET /api/backtest-runs/:id returns.
import {
  escapeHtml, fmtTime, errorState, miniStats, statusBadge, BACKTEST_STATUS_LABEL, llmAnswerDetails, llmQuery,
  tradeTimelineChart, tradeTimelineSummary, newsBasis, signedPct, outcomeColor,
} from "../helpers.js";
import { renderJobProgressPanel } from "./status.js";

const NEWS_PREVIEW_CHARS = 160;
const DASH = "\u2014";

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}\u2026` : text;
}

const price = (v) => (v != null && Number.isFinite(Number(v)) ? `$${Number(v).toFixed(2)}` : DASH);

export function tradeTimelineTable(positions) {
  if (positions.length === 0) return `<p class="empty">This run has no positions.</p>`;
  const rows = positions
    .map((p) => {
      const pnlClass = p.realizedReturn > 0 ? "status-approved" : p.realizedReturn < 0 ? "status-rejected" : "status-neutral";
      const pnl = p.realizedReturn != null ? signedPct(p.realizedReturn) : p.closedAt ? "unknown" : "open";
      const news = newsBasis(p.decision);
      return `<tr>
        <td class="ticker cell-title">${escapeHtml(p.ticker)}</td>
        <td data-label="Direction">${escapeHtml(p.direction ?? DASH)}</td>
        <td class="num" data-label="Size">${p.positionSizePct != null ? (p.positionSizePct * 100).toFixed(1) + "%" : DASH}</td>
        <td class="num" data-label="Opened">${fmtTime(p.openedAt)}</td>
        <td class="num" data-label="Closed">${p.closedAt ? fmtTime(p.closedAt) : "still open"}</td>
        <td class="num" data-label="Entry &rarr; exit">${price(p.entryPrice)} &rarr; ${price(p.exitPrice)}</td>
        <td data-label="Close reason">${escapeHtml(p.closeReason ?? DASH)}</td>
        <td class="num ${pnlClass}" data-label="P&amp;L" style="color:${outcomeColor(p.realizedReturn)}">${escapeHtml(pnl)}</td>
        <td class="cell-wide" data-label="Based on">${news ? escapeHtml(clip(news, NEWS_PREVIEW_CHARS)) : `<span class="empty">not recorded</span>`}</td>
        <td class="cell-wide" data-label="Why">${llmAnswerDetails(p.decision ?? {})}</td>
      </tr>`;
    })
    .join("\n");
  return `<div class="table-wrap"><table>
    <thead><tr><th>Ticker</th><th>Direction</th><th>Size</th><th>Opened</th><th>Closed</th><th>Entry &rarr; exit</th><th>Close reason</th><th>P&amp;L</th><th>Based on</th><th>Why</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

export function renderBacktestDetailView({ run = null, positions = [], positionsError = null, truncated = false, error = null, activeJob = null } = {}) {
  const back = `<p class="note"><a href="/dashboard/backtest">&larr; All backtest runs</a></p>`;
  const head = `<h2>Trade timeline</h2>`;
  if (error) return `<section id="backtest-detail">${back}${head}${errorState(error)}</section>`;
  if (!run) return `<section id="backtest-detail">${back}${head}<p class="empty">Backtest run not found.</p></section>`;

  const semantic = run.status === "complete" ? "approved" : run.status === "failed" ? "rejected" : "neutral";
  const series = run.result?.portfolio?.series;
  const s = tradeTimelineSummary(series, positions);
  const llmHref = `/dashboard/llm${llmQuery({ env: run.id }, { llmJob: run.id })}`;

  const intro = `<p class="note"><span class="ticker">${escapeHtml(run.tickers.join(", "))}</span> &middot; ${fmtTime(run.testStart)} &rarr; ${fmtTime(run.testEnd)} &middot; ${statusBadge(semantic, BACKTEST_STATUS_LABEL[run.status] ?? run.status)}
    &middot; <a href="${escapeHtml(llmHref)}">View every LLM call this run made &rarr;</a></p>`;

  let chartBody;
  if (run.status === "failed") chartBody = `<p class="empty">${escapeHtml(run.error ?? "failed with no recorded error message")}</p>`;
  else if (run.status !== "complete") {
    // renderJobProgressPanel returns "" for a job with no id, so fall back to
    // the static text on that too -- not just when there is no job at all --
    // rather than leaving the chart area blank.
    chartBody = (activeJob && renderJobProgressPanel(activeJob)) || `<p class="empty">Still running -- the equity curve is drawn once scoring finishes. Positions opened so far are listed below; reload to update.</p>`;
  }
  else chartBody = tradeTimelineChart(series, positions);

  const stats = run.status === "complete"
    ? miniStats(
        [
          { value: String(s.opened), label: "Positions opened" },
          { value: `${s.closed} / ${s.stillOpen}`, label: "Closed / still open" },
          { value: s.winRate != null ? `${(s.winRate * 100).toFixed(0)}%` : DASH, label: `Win rate (${s.wins}W ${s.losses}L)` },
          { value: signedPct(s.onReturn), label: "Signal ON return", color: outcomeColor(s.onReturn) },
          { value: signedPct(s.offReturn), label: "Buy & hold return" },
        ],
        { cols: 2 }
      )
    : "";
  const period = s.from ? `In ${escapeHtml(s.from)} &rarr; ${escapeHtml(s.to)}, ` : "";
  const headline = run.status === "complete" && series
    ? `<p class="note">${period}${s.opened} position${s.opened === 1 ? "" : "s"} opened, ending with ${escapeHtml(signedPct(s.onReturn))} for the signal against ${escapeHtml(signedPct(s.offReturn))} for buy &amp; hold.</p>`
    : "";

  return `<section id="backtest-detail">
    ${back}
    ${head}
    ${intro}
    ${headline}
    <div class="panel" style="margin-bottom:1.5rem">
      <div class="panel-header"><span class="panel-title">Equity curve &amp; positions opened</span></div>
      <div class="panel-body">${stats}${chartBody}</div>
    </div>
    <h2>Positions${positionsError ? "" : ` <span class="h2-count">${positions.length}</span>`}</h2>
    ${truncated ? `<p class="note">Showing the first ${positions.length} positions only -- this run opened more.</p>` : ""}
    ${positionsError ? errorState(positionsError) : tradeTimelineTable(positions)}
  </section>`;
}
