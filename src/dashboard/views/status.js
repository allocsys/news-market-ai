// Post-confirmation "run accepted" status view: after the operator hits
// "Confirm and run", they land on a page that says the run was accepted and
// is in progress, not a bare redirect back to an unchanged page.
// Backfill/backtest runs are kicked off via a queue message (src/index.js /
// src/llm-worker.js) so this page can respond immediately rather than
// blocking on the full run (which can be long and would otherwise risk a
// request timeout on a large date range).
//
// LIVE PROGRESS (previously a static "Run is in progress in the background"
// message with a pulsing dot and nothing else -- see plan.md's job-progress
// work): when `jobId` is given, this renders a progress bar and phase/detail
// text that client-side JS keeps live by polling
// /dashboard/jobs/:id (src/dashboard-worker.js, which proxies backend's
// GET /api/jobs/:id -> src/storage/jobs.js's job_progress table) every
// 5s (backs off to 8s on a transient fetch failure) -- kept slow on purpose
// to bound D1 reads on the free tier for a job someone leaves the tab open
// on. No `jobId` (shouldn't happen from the two callers in
// src/dashboard-worker.js, but kept as a safe fallback rather than crashing
// on a missing prop) falls back to the old static message with no polling.
//
// JOBS SUBMITTED EARLIER: the run-accepted page only exists for the request
// that submitted the form, so navigating away lost the bar for good.
// renderActiveJobPanel (below) draws the SAME panel + poller for an
// already-running job, and the backfill/backtest pages call it when
// backend's GET /api/jobs/active reports one, so returning to those pages
// shows live progress again. Both callers share the helpers below.

import { escapeHtml, terminateRunForm } from "../helpers.js";

/**
 * `type` matters because of where the job_progress row actually lives:
 * a backfill job is always `RunStore(LIVE_DB, 'live')`, but a backtest job is
 * `RunStore(SIM_DB, <this backtest's own id>)` (src/index.js) -- the job's id
 * IS its environment, so polling it needs `?env=<jobId>` or the lookup misses
 * (backend defaults env to 'live', where a backtest job never lives).
 */
function jobPollUrl(jobId, type) {
  const base = `/dashboard/jobs/${encodeURIComponent(jobId)}`;
  return type === "backtest" ? `${base}?env=${encodeURIComponent(jobId)}` : base;
}

const PULSE_STYLE = `<style>
      @keyframes runPulse {
        0%   { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.55); }
        70%  { box-shadow: 0 0 0 12px rgba(16, 185, 129, 0); }
        100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
      }
      @media (prefers-reduced-motion: reduce) {
        #run-status-dot { animation: none !important; }
      }
    </style>`;

/** The panel itself: pulsing dot, headline, phase text and (when `pollUrl` is set) the bar. */
function renderProgressPanel({ detail, pollUrl }) {
  return `<div class="panel" style="margin-bottom:1.5rem">
      <div class="panel-body">
        <div style="display:flex;align-items:center;gap:0.85rem;${pollUrl ? "margin-bottom:0.9rem" : ""}">
          <span id="run-status-dot" style="width:10px;height:10px;border-radius:50%;background:var(--color-success-text);box-shadow:0 0 0 0 var(--color-success-strong);animation:runPulse 1.6s ease-out infinite;flex-shrink:0"></span>
          <div>
            <div style="font-weight:600;color:var(--text-main)">${escapeHtml(detail)}</div>
            <div id="run-phase-detail" style="font-size:0.75rem;color:var(--text-muted);margin-top:0.2rem">${pollUrl ? "Queued&hellip;" : "Run is in progress in the background."}</div>
          </div>
        </div>
        ${
          pollUrl
            ? `<div style="height:8px;border-radius:4px;background:var(--border-color, rgba(128,128,128,0.25));overflow:hidden">
          <div id="run-progress-bar" style="height:100%;width:0%;background:var(--color-success-text);transition:width 0.4s ease"></div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:0.72rem;color:var(--text-muted);margin-top:0.3rem">
          <span id="run-progress-pct">0%</span>
          <span id="run-progress-count"></span>
        </div>
        <div id="run-next-steps" style="display:none;margin-top:0.75rem;font-size:0.8rem"></div>`
            : ""
        }
      </div>
    </div>`;
}

/**
 * Client-side poller for `pollUrl`; drives the elements renderProgressPanel
 * emits. `label` ("Backfill"/"Backtest") and `backLink`/`backLabel` (where
 * "Back to X" should point once the job is done) let this same script
 * update the shared #run-status-title heading and reveal the
 * #run-next-steps link on completion/failure -- both callers
 * (renderRunAcceptedPage, renderActiveJobPanel) know these statically at
 * render time, so they're baked in here rather than re-derived client-side.
 * When `reloadOnComplete` is true, terminal status instead triggers a page reload
 * after ~800ms so the permalink page re-fetches and renders the final result.
 */
function renderProgressScript({ pollUrl, label, backLink, backLabel, reloadOnComplete }) {
  return `<script>
      (function () {
        var pollUrl = ${JSON.stringify(pollUrl)};
        var label = ${JSON.stringify(label || "")};
        var backLink = ${JSON.stringify(backLink || "")};
        var backLabel = ${JSON.stringify(backLabel || "")};
        var reloadOnComplete = ${Boolean(reloadOnComplete)};
        var dot = document.getElementById("run-status-dot");
        var phaseEl = document.getElementById("run-phase-detail");
        var titleEl = document.getElementById("run-status-title");
        var nextEl = document.getElementById("run-next-steps");
        var bar = document.getElementById("run-progress-bar");
        var pctEl = document.getElementById("run-progress-pct");
        var countEl = document.getElementById("run-progress-count");
        var stopped = false;
        var lastUpdatedAt = null;
        var staleTimer = null;

        function markTerminal(color) {
          if (!dot) return;
          dot.style.animation = "none";
          dot.style.boxShadow = "none";
          dot.style.background = color;
        }

        // Heading + "Back to <section>" link, shown once the job leaves
        // 'queued'/'running' -- the operator no longer needs to stay on this
        // panel, and (unlike the old copy) this is the only place that now
        // claims anything about where to look next.
        function showNextSteps(verb) {
          if (titleEl) titleEl.textContent = label + " " + verb;
          if (nextEl) {
            nextEl.style.display = "block";
            nextEl.innerHTML = '<a href="' + backLink + '" style="color:var(--color-info-text);">Back to ' + backLabel + "</a>";
          }
        }

        // updated_at doubles as a liveness signal (job_progress table,
        // migrations/state/): if a 'running' job hasn't ticked
        // in a while, its consumer probably died mid-run. Flag it rather
        // than polling forever in silence.
        function armStaleCheck(updatedAt) {
          lastUpdatedAt = updatedAt;
          if (staleTimer) clearTimeout(staleTimer);
          staleTimer = setTimeout(function () {
            if (stopped) return;
            if (phaseEl) phaseEl.textContent = "No update in a while -- the job may have stalled. Still checking...";
          }, 45000);
        }

        function render(job) {
          var pct = Math.max(0, Math.min(100, Number(job.percent) || 0));
          if (bar) bar.style.width = pct + "%";
          if (pctEl) pctEl.textContent = pct + "%";
          if (countEl) countEl.textContent = job.total ? (job.done || 0) + " / " + job.total : "";

          if (job.status === "complete") {
            stopped = true;
            if (staleTimer) clearTimeout(staleTimer);
            markTerminal("var(--color-success-text)");
            if (phaseEl) phaseEl.textContent = job.detail || "Complete.";
            if (reloadOnComplete) {
              setTimeout(function () {
                window.location.reload();
              }, 800);
            } else {
              showNextSteps("complete");
            }
            return;
          }
          if (job.status === "failed") {
            stopped = true;
            if (staleTimer) clearTimeout(staleTimer);
            markTerminal("var(--color-danger-text)");
            if (bar) bar.style.background = "var(--color-danger-text)";
            if (phaseEl) phaseEl.textContent = "Failed: " + (job.error || "unknown error");
            if (reloadOnComplete) {
              setTimeout(function () {
                window.location.reload();
              }, 800);
            } else {
              showNextSteps("failed");
            }
            return;
          }
          if (job.status === "cancelled") {
            stopped = true;
            if (staleTimer) clearTimeout(staleTimer);
            markTerminal("var(--text-muted)");
            if (bar) bar.style.background = "var(--text-muted)";
            if (phaseEl) phaseEl.textContent = "Cancelled by operator.";
            if (reloadOnComplete) {
              setTimeout(function () {
                window.location.reload();
              }, 800);
            } else {
              showNextSteps("cancelled");
            }
            return;
          }
          if (phaseEl) phaseEl.textContent = job.detail || (job.phase ? job.phase + "..." : job.status + "...");
          if (job.updatedAt !== lastUpdatedAt) armStaleCheck(job.updatedAt);
        }

        function poll() {
          if (stopped) return;
          fetch(pollUrl, { credentials: "same-origin" })
            .then(function (res) {
              if (!res.ok) throw new Error("status " + res.status);
              return res.json();
            })
            .then(function (job) {
              render(job);
              // 5s, not 1.5s (was tuned for snappy UX, but each tick is a D1
              // read against job_progress -- on the free tier's daily row-read
              // cap, a long-running backfill/backtest polled the whole time
              // adds up across many runs/operators). 5s is still responsive
              // enough for a progress bar; see status.js's header for context.
              if (!stopped) setTimeout(poll, 5000);
            })
            .catch(function () {
              // A transient fetch failure just retries on a longer interval --
              // never surface a scary error for a momentary network blip; the
              // job's own status/error field (once reachable again) is the
              // real source of truth.
              if (!stopped) setTimeout(poll, 8000);
            });
        }

        poll();
      })();
    </script>`;
}

export function renderRunAcceptedPage({ title, detail, backLink, backLabel, jobId, type }) {
  const pollUrl = jobId ? jobPollUrl(jobId, type) : null;

  return `<section id="run-accepted">
    <h2 id="run-status-title">${escapeHtml(title)} accepted</h2>
    ${renderProgressPanel({ detail, pollUrl })}
    <p class="note">${pollUrl ? "Progress updates automatically above." : "This page does not wait for the run to finish, so nothing further will happen here."}</p>
    <p class="note">You can also return to <a href="${escapeHtml(backLink)}" style="color:var(--color-info-text);">${escapeHtml(backLabel)}</a> at any time -- a live progress panel appears there too while this job is running${type !== "backtest" ? ", and the most recently finished run is always shown at the top of the page" : ""}.</p>
    ${PULSE_STYLE}
    ${pollUrl ? renderProgressScript({ pollUrl, label: title, backLink, backLabel }) : ""}
  </section>`;
}

/** Above this many tickers, name the count instead of listing them (a default backtest covers the whole watchlist). */
const MAX_TICKERS_LISTED = 5;

/** One-line human description of a job_progress row (RunStore#getJob/getActiveJob shape, storage/jobs.js#jobFromRow), built from the params it was enqueued with. Tolerates missing params. */
export function describeJob(job) {
  const p = job?.params || {};
  if (job?.type === "backtest") {
    const tickers = Array.isArray(p.tickers) ? (p.tickers.length > MAX_TICKERS_LISTED ? `${p.tickers.length} tickers` : p.tickers.join(", ")) : p.tickers;
    const range = p.testStart && p.testEnd ? ` from ${p.testStart} to ${p.testEnd}` : "";
    return `Running a backtest for ${tickers || "the full watchlist"}${range}.`;
  }
  const range = p.from && p.to ? ` from ${p.from} to ${p.to}` : "";
  if (job?.type === "backfill_prices") {
    const tickers = Array.isArray(p.tickers) && p.tickers.length > 0 ? ` for ${p.tickers.length > MAX_TICKERS_LISTED ? `${p.tickers.length} tickers` : p.tickers.join(", ")}` : " for the whole watchlist";
    return `Backfilling historical price bars${tickers}${range}.`;
  }
  return `Backfilling historical news${range}.`;
}

/**
 * Live progress panel for a job that's ALREADY in flight (submitted from an
 * earlier page load), for the top of the backfill/backtest pages. Empty
 * string when there is no job, so callers can prepend the result
 * unconditionally.
 */
export function renderActiveJobPanel(job) {
  if (!job || !job.id) return "";
  const pollUrl = jobPollUrl(job.id, job.type);
  const label = job.type === "backtest" ? "Backtest" : job.type === "backfill_prices" ? "Price backfill" : "Backfill";
  const backLink = job.type === "backtest" ? "/dashboard/backtest" : "/dashboard/backfill";
  // Only a backtest can be terminated this way (POST /backtest/:id/cancel) --
  // a backfill has no equivalent endpoint. job.id IS the backtest's run id
  // (see src/index.js's POST /backtest/run, which enqueues the job under its
  // own newly-generated id).
  const terminate = job.type === "backtest" ? `<div style="margin-top:0.9rem">${terminateRunForm(job.id)}</div>` : "";

  return `<section id="active-job" data-job-id="${escapeHtml(job.id)}">
    <h2 id="run-status-title">${label} in progress</h2>
    ${renderProgressPanel({ detail: describeJob(job), pollUrl })}
    ${terminate}
    ${PULSE_STYLE}
    ${renderProgressScript({ pollUrl, label, backLink, backLabel: label })}
  </section>`;
}

/**
 * Live progress panel variant for the single-run backtest detail page
 * (/dashboard/backtest/:id). Composes the existing internal helpers
 * (renderProgressPanel, renderProgressScript, jobPollUrl, describeJob) without
 * duplicating their logic. Unlike renderActiveJobPanel, it omits the outer
 * <h2> heading and <section id="active-job"> wrapper because it sits inside the
 * backtest detail page's existing "Equity curve & positions opened" panel body.
 * On completion or failure, it waits ~800ms for the final text to be visible
 * before calling window.location.reload() to re-fetch /api/backtest-runs/:id
 * and render the real equity-curve chart instead of the progress bar.
 */
export function renderJobProgressPanel(job) {
  if (!job || !job.id) return "";
  const pollUrl = jobPollUrl(job.id, job.type || "backtest");
  // This panel only ever appears inside the single-run backtest detail page
  // (see its own header), so a terminate control here is always for a
  // backtest, unlike renderActiveJobPanel above which also serves backfill.
  return `${renderProgressPanel({ detail: describeJob(job), pollUrl })}
    <div style="margin-top:0.9rem">${terminateRunForm(job.id)}</div>
    ${PULSE_STYLE}
    ${renderProgressScript({ pollUrl, reloadOnComplete: true })}`;
}
