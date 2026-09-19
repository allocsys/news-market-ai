// Covers src/dashboard/views/status.js's describeJob and renderActiveJobPanel
// -- the two new exports behind the "job submitted earlier" progress panel
// (see that file's own "JOBS SUBMITTED EARLIER" header comment). Pure
// functions, no DB/env needed: renderRunAcceptedPage's own share of this
// same module (the pulse style + poll script it also builds through) has
// no dedicated test either, so this file also acts as the first coverage
// of the panel/script markup shape in general, via the active-job path.

import test from "node:test";
import assert from "node:assert/strict";
import { describeJob, renderActiveJobPanel } from "../src/dashboard/views/status.js";

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
  assert.match(html, /<h2>Backfill in progress<\/h2>/);
  assert.match(html, /Backfilling historical news from 2024-01-01 to 2024-01-31\./);
  assert.match(html, /var pollUrl = "\/dashboard\/jobs\/backfill-123-abc";/);
  // A pollUrl is always set here (unlike renderRunAcceptedPage's no-jobId
  // fallback), so the progress bar markup is always present too.
  assert.match(html, /id="run-progress-bar"/);
});

test("renderActiveJobPanel renders a 'Backtest in progress' panel for a backtest job", () => {
  const job = { id: "backtest-456-def", type: "backtest", status: "queued", params: { tickers: ["AAPL"] } };
  const html = renderActiveJobPanel(job);

  assert.match(html, /<h2>Backtest in progress<\/h2>/);
  assert.match(html, /Running a backtest for AAPL\./);
  assert.match(html, /var pollUrl = "\/dashboard\/jobs\/backtest-456-def";/);
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
