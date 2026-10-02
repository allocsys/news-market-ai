// Dashboard rendering of PAUSED backtest runs (helpers.js#pauseResumeForm / pausedNote /
// backtestRunsList, views/backtest_detail.js). Render functions are called directly, same
// convention as the other dashboard tests.

import test from "node:test";
import assert from "node:assert/strict";
import { BACKTEST_STATUS_LABEL, pauseResumeForm, pausedNote, backtestRunsList, terminateRunForm } from "../src/dashboard/helpers.js";
import { renderBacktestDetailView } from "../src/dashboard/views/backtest_detail.js";

const ID = "backtest-1760000000000-abc123";

function run(overrides = {}) {
  return {
    id: ID,
    tickers: ["AAPL", "MSFT"],
    testStart: "2026-01-01T00:00:00.000Z",
    testEnd: "2026-01-09T00:00:00.000Z",
    trainDays: 0,
    testDays: 8,
    graceDays: 1,
    status: "running",
    result: null,
    error: null,
    startedAt: "2026-05-10T00:00:00.000Z",
    finishedAt: null,
    pausedReason: null,
    pausedAt: null,
    resumeAfter: null,
    ...overrides,
  };
}

const paused = (overrides = {}) => run({ status: "paused", pausedReason: "d1_write_budget", pausedAt: "2026-05-10T10:00:00.000Z", resumeAfter: "2026-05-11T00:00:00.000Z", ...overrides });

test("BACKTEST_STATUS_LABEL has a 'paused' label", () => {
  assert.equal(BACKTEST_STATUS_LABEL.paused, "paused");
});

test("pauseResumeForm posts to /backtest/:id/pause or /resume with the right button label", () => {
  const pause = pauseResumeForm(ID, "pause");
  assert.match(pause, new RegExp(`method="post" action="/backtest/${ID}/pause"`));
  assert.match(pause, /Pause run/);
  const resume = pauseResumeForm(ID, "resume");
  assert.match(resume, new RegExp(`action="/backtest/${ID}/resume"`));
  assert.match(resume, /Resume run/);
});

test("pauseResumeForm escapes/encodes a hostile id and never emits an unknown action", () => {
  const html = pauseResumeForm(`x"><script>alert(1)</script>`, "resume");
  assert.ok(!html.includes("<script>"));
  assert.ok(!/action="[^"]*"[^>]*>[^<]*<script/.test(html));
  assert.match(pauseResumeForm(ID, "whatever"), /\/pause"/, "anything but 'resume' falls back to pause");
});

test("pausedNote explains why, since when, that data is kept, and the suggested resume time", () => {
  const html = pausedNote(paused());
  assert.match(html, /daily D1 write budget reached/);
  assert.match(html, /since 2026-05-10 10:00:00 UTC/);
  assert.match(html, /All data is kept/);
  assert.match(html, /only continues when you press Resume/);
  assert.match(html, /Suggested resume time: 2026-05-11 00:00:00 UTC/);
});

test("pausedNote has a plain-language label for every reason and omits the suggested time when there is none", () => {
  const labels = {
    operator: /paused by you/,
    d1_write_budget: /D1 write budget/,
    gemini_daily_cap: /Gemini key is at its daily limit/,
    platform_limit: /Cloudflare platform limit/,
    quota_threshold: /daily quota threshold/,
  };
  for (const [reason, re] of Object.entries(labels)) assert.match(pausedNote(paused({ pausedReason: reason })), re, reason);
  const operator = pausedNote(paused({ pausedReason: "operator", resumeAfter: null }));
  assert.ok(!/Suggested resume time/.test(operator));
});

test("pausedNote falls back to the raw reason (escaped) for an unknown one, and to 'paused' for none", () => {
  assert.match(pausedNote(paused({ pausedReason: "<b>new</b>" })), /&lt;b&gt;new&lt;\/b&gt;/);
  assert.match(pausedNote(paused({ pausedReason: null, pausedAt: null, resumeAfter: null })), /Paused \(paused\)\./);
});

test("backtestRunsList: a paused run shows a paused badge, the note, Resume + Terminate (no Pause), and is open", () => {
  const html = backtestRunsList([paused()]);
  assert.match(html, /paused/);
  assert.match(html, /Paused \(daily D1 write budget reached\)/);
  assert.ok(html.includes(pauseResumeForm(ID, "resume")));
  assert.ok(html.includes(terminateRunForm(ID)));
  assert.ok(!html.includes(pauseResumeForm(ID, "pause")), "no Pause button on an already-paused run");
  assert.match(html, /<details class="llm-answer" open>/);
  assert.ok(!/Still running as of last page load/.test(html), "not described as running");
});

test("backtestRunsList: a running run shows Pause + Terminate (no Resume)", () => {
  const html = backtestRunsList([run()]);
  assert.ok(html.includes(pauseResumeForm(ID, "pause")));
  assert.ok(html.includes(terminateRunForm(ID)));
  assert.ok(!html.includes(pauseResumeForm(ID, "resume")));
  assert.match(html, /Still running as of last page load/);
});

test("backtestRunsList: finished runs get neither Pause, Resume nor Terminate", () => {
  for (const status of ["complete", "failed", "cancelled"]) {
    const html = backtestRunsList([run({ status, error: status === "complete" ? null : "x", result: null })].map((r) => (status === "complete" ? { ...r, result: { overall: { on: { cumulativeReturn: 0, sharpeRatio: 0, winRate: 0, maxDrawdown: 0 }, off: { cumulativeReturn: 0, sharpeRatio: 0, winRate: 0, maxDrawdown: 0 }, delta: { cumulativeReturn: 0, sharpeRatio: 0, winRate: 0, maxDrawdown: 0 } }, perWindow: [] } } : r)));
    assert.ok(!/\/pause"|\/resume"|\/cancel"/.test(html), status);
  }
});

test("backtest detail: a paused run shows the pause note with Resume + Terminate instead of a progress bar", () => {
  const html = renderBacktestDetailView({ run: paused(), positions: [], activeJob: { id: ID, status: "running", percent: 40, phase: "walk" } });
  assert.match(html, /Paused \(daily D1 write budget reached\)/);
  assert.ok(html.includes(pauseResumeForm(ID, "resume")));
  assert.ok(html.includes(terminateRunForm(ID)));
  assert.ok(!/progress/i.test(html.replace(/pausedNote/g, "")) || !/40%/.test(html), "the (still 'running') job's progress bar is not drawn for a paused run");
  assert.ok(!/Still running -- the equity curve/.test(html));
});

test("backtest detail: a running run does not get the paused UI", () => {
  const html = renderBacktestDetailView({ run: run(), positions: [] });
  assert.ok(!/Resume run/.test(html));
  assert.match(html, /Still running/);
});
