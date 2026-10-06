// /dashboard/backtest/:id -- one backtest run's trade timeline: an equity-curve
// chart with a marker per position, headline numbers, and a table of every
// position with the news that triggered it and an expandable "why" (analyst
// opinions, bull/bear debate, trader rationale -- helpers.js#llmAnswerDetails).
// Props are exactly what backend's GET /api/backtest-runs/:id returns.
import {
  escapeHtml, fmtTime, errorState, emptyState, miniStats, statusBadge, BACKTEST_STATUS_LABEL, llmAnswerDetails, llmQuery, pausedNote, pauseResumeForm, terminateRunForm,
  tradeTimelineChart, tradeTimelineDataTable, tradeTimelineSummary, newsBasis, signedPct, outcomeColor, fmtExcursion, directionPill, closeReasonPill,
} from "../helpers.js";
import { renderJobProgressPanel } from "./status.js";

const NEWS_PREVIEW_CHARS = 160;
const DASH = "\u2014";

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}\u2026` : text;
}

const price = (v) => (v != null && Number.isFinite(Number(v)) ? `$${Number(v).toFixed(2)}` : DASH);
const tone = (v) => (v > 0 ? "pos" : v < 0 ? "neg" : "flat");
const MAE_TITLE = "Worst gross return seen while open (sampled at exit checks)";
const MFE_TITLE = "Best gross return seen while open (sampled at exit checks)";

function stat(label, valueHtml, { title = "", cls = "" } = {}) {
  return `<div class="pos-stat"><dt${title ? ` title="${escapeHtml(title)}"` : ""}>${label}</dt><dd class="${cls}">${valueHtml}</dd></div>`;
}

export function tradeTimelineTable(positions) {
  if (positions.length === 0) return emptyState("This run has no positions.", { href: "/dashboard/backtest", label: "Back to backtest runs" });
  // Phone-first (redesign step 5): one card per position, same pos-card markup as the Book page.
  const cards = positions
    .map((p) => {
      const pnl = p.realizedReturn != null ? signedPct(p.realizedReturn) : p.closedAt ? "unknown" : "open";
      const news = newsBasis(p.decision);
      const reason = p.closeReason ? closeReasonPill(p.closeReason) : `<span>${p.closedAt ? DASH : "still open"}</span>`;
      const size = p.positionSizePct != null ? `${(p.positionSizePct * 100).toFixed(1)}%` : DASH;
      return `<article class="pos-card">
        <header class="pos-card-head">
          <span class="ticker pos-card-ticker">${escapeHtml(p.ticker)}</span>
          ${p.direction ? directionPill(p.direction) : ""}
          <span class="pos-card-main pos-${tone(p.realizedReturn)}" title="Realized return">${escapeHtml(pnl)}</span>
        </header>
        <dl class="pos-card-stats">
          ${stat("Entry", price(p.entryPrice))}
          ${stat("Exit", price(p.exitPrice))}
          ${stat("Size", size)}
        </dl>
        <dl class="pos-card-stats">
          ${stat("MAE", fmtExcursion(p.maePct), { title: MAE_TITLE, cls: `pos-${tone(p.maePct)}` })}
          ${stat("MFE", fmtExcursion(p.mfePct), { title: MFE_TITLE, cls: `pos-${tone(p.mfePct)}` })}
        </dl>
        <p class="pos-card-foot">${reason} <span>Opened ${fmtTime(p.openedAt)}</span> <span>${p.closedAt ? `Closed ${fmtTime(p.closedAt)}` : "still open"}</span></p>
        <p class="note">${news ? escapeHtml(clip(news, NEWS_PREVIEW_CHARS)) : `<span class="empty">News not recorded</span>`}</p>
        ${llmAnswerDetails(p.decision ?? {})}
      </article>`;
    })
    .join("\n");
  return `<div class="pos-cards">${cards}</div>`;
}

export function renderBacktestDetailView({ run = null, positions = [], positionsError = null, truncated = false, error = null, activeJob = null } = {}) {
  const back = `<p class="note"><a href="/dashboard/backtest">&larr; All backtest runs</a></p>`;
  const head = `<h2>Trade timeline</h2>`;
  if (error) return `<section id="backtest-detail">${back}${head}${errorState(error)}</section>`;
  if (!run) return `<section id="backtest-detail">${back}${head}<p class="empty">Backtest run not found.</p></section>`;

  const semantic = run.status === "complete" ? "approved" : run.status === "failed" || run.status === "cancelled" ? "rejected" : "neutral";
  const series = run.result?.portfolio?.series;
  const s = tradeTimelineSummary(series, positions);
  const llmHref = `/dashboard/llm${llmQuery({ env: run.id }, { llmJob: run.id })}`;

  const intro = `<p class="note"><a href="/dashboard/backtest">&larr; Runs</a> &middot; <span class="ticker">${escapeHtml(run.tickers.join(", "))}</span> &middot; ${fmtTime(run.testStart)} &rarr; ${fmtTime(run.testEnd)} &middot; ${statusBadge(semantic, BACKTEST_STATUS_LABEL[run.status] ?? run.status)}
    &middot; <a href="${escapeHtml(llmHref)}">LLM calls &rarr;</a></p>`;

  let chartBody;
  if (run.status === "failed") chartBody = `<p class="empty">${escapeHtml(run.error ?? "failed with no recorded error message")}</p>`;
  else if (run.status === "cancelled") {
    // Cancelled by POST /backtest/:id/cancel -- its trade-level data was
    // deleted by that route's own cleanup (backtest/cleanup.js#
    // cleanupCancelledRun), so there is nothing left to chart, same as a
    // failed run. `positions` below will be empty for the same reason.
    chartBody = `<p class="empty">${escapeHtml(run.error ?? "cancelled by operator")} -- data deleted, no equity curve.</p>`;
  }
  else if (run.status === "paused") {
    // Parked (operator pause or a quota pause): a progress bar would look stuck, so show why it
    // stopped and the manual Resume button. Its data is kept, so the positions below are real.
    chartBody = `${pausedNote(run)}<div style="display:flex;gap:0.75rem;flex-wrap:wrap">${pauseResumeForm(run.id, "resume")}${terminateRunForm(run.id)}</div>`;
  }
  else if (run.status !== "complete") {
    // renderJobProgressPanel returns "" for a job with no id, so fall back to
    // the static text on that too -- not just when there is no job at all --
    // rather than leaving the chart area blank.
    chartBody = (activeJob && renderJobProgressPanel(activeJob)) || `<p class="empty">Still running -- the equity curve appears when scoring finishes. Reload to update.</p>`;
  }
  else chartBody = tradeTimelineChart(series, positions) + tradeTimelineDataTable(series, positions);

  const stats = run.status === "complete"
    ? miniStats(
        [
          { value: String(s.opened), label: "Positions opened" },
          { value: `${s.closed} / ${s.stillOpen}`, label: "Closed / still open" },
          { value: s.winRate != null ? `${(s.winRate * 100).toFixed(0)}%` : DASH, label: `Win rate (${s.wins}W ${s.losses}L)` },
          { value: signedPct(s.onReturn), label: "Strategy return", color: outcomeColor(s.onReturn) },
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
    ${head}
    ${intro}
    ${headline}
    <div class="panel" style="margin-bottom:1.5rem">
      <div class="panel-header"><span class="panel-title">Equity curve &amp; positions opened</span></div>
      <div class="panel-body">${stats}${chartBody}</div>
    </div>
    <h2>Positions${positionsError ? "" : ` <span class="h2-count">${positions.length}</span>`}</h2>
    ${truncated ? `<p class="note">Showing the first ${positions.length} positions only.</p>` : ""}
    ${positionsError ? errorState(positionsError) : tradeTimelineTable(positions)}
  </section>`;
}
