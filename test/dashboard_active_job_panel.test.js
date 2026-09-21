// Covers src/dashboard/views/status.js's describeJob and renderActiveJobPanel
// -- the two new exports behind the "job submitted earlier" progress panel
// (see that file's own "JOBS SUBMITTED EARLIER" header comment). Pure
// functions, no DB/env needed: renderRunAcceptedPage's own share of this
// same module (the pulse style + poll script it also builds through) has
// no dedicated test either, so this file also acts as the first coverage
// of the panel/script markup shape in general, via the active-job path.

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { describeJob, renderActiveJobPanel, renderJobProgressPanel, renderRunAcceptedPage } from "../src/dashboard/views/status.js";

// --------------------------------------------------------------------
// describeJob
// --------------------------------------------------------------------

test("describeJob describes a backfill job with a date range", () => {
  const job = { type: "backfill", params: { from: "2024-01-01", to: "2024-01-31" } };
  assert.equal(describeJob(job), "Backfilling historical news from 2024-01-01 to 2024-01-31.");
});

test("describeJob describes a backfill job with no params (or a partial range) without crashing", () => {
  assert.equal(describeJob({ type: "backfill", params: {} }), "Backfilling historical news.");
  assert.equal(describeJob({ type: "backfill", params: { from: "2024-01-01" } }), "Backfilling historical news.");
  assert.equal(describeJob({ type: "backfill" }), "Backfilling historical news.");
});

test("describeJob lists a backtest job's tickers when there are few, with the date range appended", () => {
  const job = { type: "backtest", params: { tickers: ["AAPL", "MSFT"], testStart: "2024-01-01", testEnd: "2024-03-31" } };
  assert.equal(describeJob(job), "Running a backtest for AAPL, MSFT from 2024-01-01 to 2024-03-31.");
});

test("describeJob names the count instead of listing tickers above the display cap", () => {
  const job = { type: "backtest", params: { tickers: ["A", "B", "C", "D", "E", "F"] } };
  assert.equal(describeJob(job), "Running a backtest for 6 tickers.");
});

test("describeJob falls back to 'the full watchlist' when a backtest job has no tickers param", () => {
  assert.equal(describeJob({ type: "backtest", params: {} }), "Running a backtest for the full watchlist.");
  assert.equal(describeJob({ type: "backtest" }), "Running a backtest for the full watchlist.");
});

test("describeJob tolerates a non-array tickers value (e.g. a raw string param)", () => {
  const job = { type: "backtest", params: { tickers: "AAPL" } };
  assert.equal(describeJob(job), "Running a backtest for AAPL.");
});

test("describeJob omits the date range when only one of testStart/testEnd is present", () => {
  const job = { type: "backtest", params: { tickers: ["AAPL"], testStart: "2024-01-01" } };
  assert.equal(describeJob(job), "Running a backtest for AAPL.");
});

// --------------------------------------------------------------------
// renderActiveJobPanel
// --------------------------------------------------------------------

test("renderActiveJobPanel renders nothing for a null/undefined job or a job with no id", () => {
  assert.equal(renderActiveJobPanel(null), "");
  assert.equal(renderActiveJobPanel(undefined), "");
  assert.equal(renderActiveJobPanel({ type: "backfill" }), "");
});

test("renderActiveJobPanel renders a 'Backfill in progress' panel with the poller wired to this job's id", () => {
  const job = { id: "backfill-123-abc", type: "backfill", status: "running", percent: 40, params: { from: "2024-01-01", to: "2024-01-31" } };
  const html = renderActiveJobPanel(job);

  assert.match(html, /<section id="active-job" data-job-id="backfill-123-abc">/);
  assert.match(html, /<h2 id="run-status-title">Backfill in progress<\/h2>/);
  assert.match(html, /Backfilling historical news from 2024-01-01 to 2024-01-31\./);
  assert.match(html, /var pollUrl = "\/dashboard\/jobs\/backfill-123-abc";/);
  // A pollUrl is always set here (unlike renderRunAcceptedPage's no-jobId
  // fallback), so the progress bar markup is always present too.
  assert.match(html, /id="run-progress-bar"/);
  // Completion UX (part 2): a hidden next-steps container and the poller's
  // own label/backLink closure vars, ready to reveal a "Back to Backfill"
  // link once the job leaves queued/running -- see status.js's showNextSteps.
  assert.match(html, /id="run-next-steps" style="display:none/);
  assert.match(html, /var label = "Backfill";/);
  assert.match(html, /var backLink = "\/dashboard\/backfill";/);
});

test("renderActiveJobPanel renders a 'Backtest in progress' panel for a backtest job", () => {
  const job = { id: "backtest-456-def", type: "backtest", status: "queued", params: { tickers: ["AAPL"] } };
  const html = renderActiveJobPanel(job);

  assert.match(html, /<h2 id="run-status-title">Backtest in progress<\/h2>/);
  assert.match(html, /Running a backtest for AAPL\./);
  // A backtest's job_progress row lives under its OWN id as run_id (SIM_DB),
  // never under 'live', so the poll URL must carry ?env=<jobId> or it 404s forever.
  assert.match(html, /var pollUrl = "\/dashboard\/jobs\/backtest-456-def\?env=backtest-456-def";/);
  assert.match(html, /var backLink = "\/dashboard\/backtest";/);
});

test("renderActiveJobPanel HTML-escapes and URI-encodes the job id everywhere it appears", () => {
  const job = { id: 'weird"id&<1>', type: "backfill", params: {} };
  const html = renderActiveJobPanel(job);

  assert.match(html, /data-job-id="weird&quot;id&amp;&lt;1&gt;"/);
  assert.match(html, /\/dashboard\/jobs\/weird%22id%26%3C1%3E/);
  // The raw id must never appear unescaped/unencoded in the markup.
  assert.doesNotMatch(html, /data-job-id="weird"id&<1>"/);
});

test("renderActiveJobPanel includes the shared pulse keyframes style once", () => {
  const html = renderActiveJobPanel({ id: "backfill-1", type: "backfill", params: {} });
  const matches = html.match(/@keyframes runPulse/g) || [];
  assert.equal(matches.length, 1);
});

// --------------------------------------------------------------------
// renderJobProgressPanel -- the variant embedded in the single-run backtest
// detail page (/dashboard/backtest/:id). Same panel + poller as
// renderActiveJobPanel, minus the heading/section wrapper, and it reloads
// the page on a terminal status instead of showing a "Back to X" link.
// --------------------------------------------------------------------

const BACKTEST_JOB = { id: "backtest-1-abc", type: "backtest", status: "running", params: { tickers: ["AAPL", "MSFT"], testStart: "2026-09-14", testEnd: "2026-09-21" } };

/** Extracts the inline poller <script> body from rendered markup. */
function scriptOf(html) {
  return html.match(/<script>([\s\S]*)<\/script>/)[1];
}

/**
 * Runs a rendered poller script against a stubbed DOM/fetch/timer, feeding it
 * `responses` one per poll (the last repeats), and returns what it did. Timers
 * are captured and fired in order rather than waited on.
 */
async function runPoller(html, responses) {
  const els = {};
  const getEl = (id) => (els[id] ??= { style: {}, textContent: "", innerHTML: "" });
  const timers = [];
  let reloads = 0;
  let polled = 0;
  const urls = [];
  const ctx = {
    document: { getElementById: getEl },
    fetch: (url) => {
      urls.push(url);
      return Promise.resolve({ ok: true, json: async () => responses[Math.min(polled++, responses.length - 1)] });
    },
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
    clearTimeout() {},
    window: { location: { reload: () => { reloads += 1; } } },
  };
  vm.runInNewContext(scriptOf(html), ctx);
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  await settle();
  const delays = [];
  for (let i = 0; i < 20 && timers.length; i++) {
    const { fn, ms } = timers.shift();
    delays.push(ms);
    fn();
    await settle();
  }
  return { reloads, delays, urls, phase: els["run-phase-detail"]?.textContent, nextStepsShown: els["run-next-steps"]?.style?.display === "block" };
}

const RUNNING_THEN = (status) => [
  { status: "running", percent: 40, done: 4, total: 10, detail: "walking" },
  { status, percent: 100, done: 10, total: 10, detail: "Backtest complete", error: "boom" },
];

test("renderJobProgressPanel renders nothing for a null/undefined job or a job with no id", () => {
  assert.equal(renderJobProgressPanel(null), "");
  assert.equal(renderJobProgressPanel(undefined), "");
  assert.equal(renderJobProgressPanel({ type: "backtest" }), "");
});

test("renderJobProgressPanel draws the bar with no heading/section wrapper and describes the job", () => {
  const html = renderJobProgressPanel(BACKTEST_JOB);
  assert.match(html, /id="run-progress-bar"/);
  assert.match(html, /Running a backtest for AAPL, MSFT from 2026-09-14 to 2026-09-21\./);
  assert.doesNotMatch(html, /<h2/, "no heading -- it sits inside the detail page's own panel");
  assert.doesNotMatch(html, /id="active-job"/, "no section wrapper");
  assert.doesNotMatch(html, /id="run-status-title"/);
});

test("renderJobProgressPanel polls with the run's own env, and defaults a missing type to backtest", () => {
  const withType = renderJobProgressPanel(BACKTEST_JOB);
  assert.ok(withType.includes('var pollUrl = "/dashboard/jobs/backtest-1-abc?env=backtest-1-abc";'));
  const noType = renderJobProgressPanel({ id: "backtest-1-abc" });
  assert.ok(noType.includes("?env=backtest-1-abc"), "a job row with no type still polls the run's SIM_DB env");
});

test("renderJobProgressPanel's script sets reloadOnComplete; the pre-existing callers' scripts do not", () => {
  assert.match(renderJobProgressPanel(BACKTEST_JOB), /var reloadOnComplete = true;/);
  assert.match(renderActiveJobPanel(BACKTEST_JOB), /var reloadOnComplete = false;/);
  const accepted = renderRunAcceptedPage({ title: "Backtest", detail: "d", backLink: "/dashboard/backtest", backLabel: "Backtest", jobId: "backtest-1-abc", type: "backtest" });
  assert.match(accepted, /var reloadOnComplete = false;/);
});

test("renderJobProgressPanel's poller reloads the page once, ~800ms after the job completes, without a 'Back to' link", async () => {
  const out = await runPoller(renderJobProgressPanel(BACKTEST_JOB), RUNNING_THEN("complete"));
  assert.equal(out.reloads, 1);
  assert.ok(out.delays.includes(800), "the reload is deferred so the final status text is visible first");
  assert.equal(out.phase, "Backtest complete");
  assert.equal(out.nextStepsShown, false);
  assert.deepEqual([...new Set(out.urls)], ["/dashboard/jobs/backtest-1-abc?env=backtest-1-abc"]);
});

test("renderJobProgressPanel's poller also reloads on failure, after showing the error", async () => {
  const out = await runPoller(renderJobProgressPanel(BACKTEST_JOB), RUNNING_THEN("failed"));
  assert.equal(out.reloads, 1);
  assert.equal(out.phase, "Failed: boom");
  assert.equal(out.nextStepsShown, false);
});

test("renderJobProgressPanel's poller does not reload while the job is still running", async () => {
  const out = await runPoller(renderJobProgressPanel(BACKTEST_JOB), [{ status: "running", percent: 10, done: 1, total: 10 }]);
  assert.equal(out.reloads, 0);
});

test("renderActiveJobPanel's poller is unchanged: shows the 'Back to' link on completion and never reloads", async () => {
  const out = await runPoller(renderActiveJobPanel(BACKTEST_JOB), RUNNING_THEN("complete"));
  assert.equal(out.reloads, 0);
  assert.equal(out.nextStepsShown, true);
  assert.ok(!out.delays.includes(800));
});

