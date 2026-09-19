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
// 1.5s. No `jobId` (shouldn't happen from the two callers in
// src/dashboard-worker.js, but kept as a safe fallback rather than crashing
// on a missing prop) falls back to the old static message with no polling.

import { escapeHtml } from "../helpers.js";

export function renderRunAcceptedPage({ title, detail, backLink, backLabel, jobId }) {
  const pollUrl = jobId ? `/dashboard/jobs/${encodeURIComponent(jobId)}` : null;

  return `<section id="run-accepted">
    <h2>${escapeHtml(title)} accepted</h2>
    <div class="panel" style="margin-bottom:1.5rem">
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
        </div>`
            : ""
        }
      </div>
    </div>
    <p class="note">${pollUrl ? "Progress updates automatically below -- no need to refresh." : "This page does not wait for the run to finish, so nothing further will happen here."}</p>
    <p class="note">Check back on <a href="${escapeHtml(backLink)}" style="color:var(--color-info-text);">${escapeHtml(backLabel)}</a> in a minute or two; results will appear there once the run completes.</p>
    <style>
      @keyframes runPulse {
        0%   { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.55); }
        70%  { box-shadow: 0 0 0 12px rgba(16, 185, 129, 0); }
        100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
      }
      @media (prefers-reduced-motion: reduce) {
        #run-status-dot { animation: none !important; }
      }
    </style>
    ${
      pollUrl
        ? `<script>
      (function () {
        var pollUrl = ${JSON.stringify(pollUrl)};
        var dot = document.getElementById("run-status-dot");
        var phaseEl = document.getElementById("run-phase-detail");
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

        // updated_at doubles as a liveness signal (see migrations/
        // 0011_job_progress.sql's header): if a 'running' job hasn't ticked
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
            return;
          }
          if (job.status === "failed") {
            stopped = true;
            if (staleTimer) clearTimeout(staleTimer);
            markTerminal("var(--color-danger-text)");
            if (bar) bar.style.background = "var(--color-danger-text)";
            if (phaseEl) phaseEl.textContent = "Failed: " + (job.error || "unknown error");
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
              if (!stopped) setTimeout(poll, 1500);
            })
            .catch(function () {
              // A transient fetch failure just retries on a longer interval --
              // never surface a scary error for a momentary network blip; the
              // job's own status/error field (once reachable again) is the
              // real source of truth.
              if (!stopped) setTimeout(poll, 3000);
            });
        }

        poll();
      })();
    </script>`
        : ""
    }
  </section>`;
}
