// Covers the M4b environment selector's VIEW layer (src/dashboard/views/env_selector.js):
// the pure link-building/label/render functions. Backend plumbing (parseEnvParam,
// resolveEnv, the D1-backed anchoring) is covered separately in test/dashboard_env.test.js;
// this file never touches D1 -- every case here is a plain function call on hand-built
// run/param objects, same style as test/dashboard_llm.test.js's view-layer tests.

import test from "node:test";
import assert from "node:assert/strict";
import { renderEnvSelector, envSwitchHref, runLabel } from "../src/dashboard/views/env_selector.js";

// ---------------------------------------------------------------------------
// envSwitchHref
// ---------------------------------------------------------------------------

test("envSwitchHref: switching to a backtest id sets ?env= and keeps other params", () => {
  const href = envSwitchHref("/dashboard/decisions", "decisionStatus=approved&decisionLimit=50", "backtest-1-abc");
  assert.equal(href, "/dashboard/decisions?decisionStatus=approved&decisionLimit=50&env=backtest-1-abc");
});

test("envSwitchHref: switching to 'live' removes ?env= entirely rather than writing env=live", () => {
  const href = envSwitchHref("/dashboard/decisions", "env=backtest-1-abc&decisionStatus=approved", "live");
  assert.equal(href, "/dashboard/decisions?decisionStatus=approved");
});

test("envSwitchHref: always drops llmBefore, since a paging cursor into one environment's call log means nothing in another", () => {
  const href = envSwitchHref("/dashboard/llm", "llmBefore=42&llmSource=backtest", "backtest-2-xyz");
  assert.equal(href, "/dashboard/llm?llmSource=backtest&env=backtest-2-xyz");
});

test("envSwitchHref: no search params and target 'live' yields a bare pathname, no trailing '?'", () => {
  assert.equal(envSwitchHref("/dashboard/snapshot", "", "live"), "/dashboard/snapshot");
  assert.equal(envSwitchHref("/dashboard/snapshot", undefined, "live"), "/dashboard/snapshot");
});

test("envSwitchHref: accepts a search string with or without a leading '?'", () => {
  assert.equal(envSwitchHref("/dashboard/snapshot", "?decisionLimit=50", "backtest-1-abc"), "/dashboard/snapshot?decisionLimit=50&env=backtest-1-abc");
});

// ---------------------------------------------------------------------------
// runLabel
// ---------------------------------------------------------------------------

test("runLabel: tickers joined, date truncated to YYYY-MM-DD", () => {
  const run = { id: "backtest-1-abc", tickers: ["AAPL", "MSFT"], testStart: "2024-01-15T00:00:00.000Z", status: "complete" };
  assert.equal(runLabel(run), "AAPL, MSFT \u00b7 2024-01-15");
});

test("runLabel: caps at 3 tickers shown, with a '+N' suffix for the rest", () => {
  const run = { id: "backtest-1-abc", tickers: ["AAPL", "MSFT", "GOOG", "AMZN", "TSLA"], testStart: "2024-01-15T00:00:00.000Z", status: "complete" };
  assert.equal(runLabel(run), "AAPL, MSFT, GOOG +2 \u00b7 2024-01-15");
});

test("runLabel: a non-complete status is appended in parens; 'complete' itself is not", () => {
  const running = { id: "backtest-1-abc", tickers: ["AAPL"], testStart: "2024-01-15T00:00:00.000Z", status: "running" };
  assert.equal(runLabel(running), "AAPL \u00b7 2024-01-15 (running)");
  const failed = { id: "backtest-1-abc", tickers: ["AAPL"], testStart: "2024-01-15T00:00:00.000Z", status: "failed" };
  assert.equal(runLabel(failed), "AAPL \u00b7 2024-01-15 (failed)");
  const complete = { id: "backtest-1-abc", tickers: ["AAPL"], testStart: "2024-01-15T00:00:00.000Z", status: "complete" };
  assert.equal(runLabel(complete), "AAPL \u00b7 2024-01-15");
});

test("runLabel: falls back to the run id when there are no tickers", () => {
  const run = { id: "backtest-1-abc", tickers: [], testStart: "2024-01-15T00:00:00.000Z", status: "running" };
  assert.equal(runLabel(run), "backtest-1-abc \u00b7 2024-01-15 (running)");
});

test("runLabel: missing/non-string testStart is dropped rather than rendered as garbage", () => {
  const run = { id: "backtest-1-abc", tickers: ["AAPL"], testStart: null, status: "complete" };
  assert.equal(runLabel(run), "AAPL");
});

test("runLabel: tolerates a missing tickers array entirely", () => {
  const run = { id: "backtest-1-abc", testStart: "2024-01-15T00:00:00.000Z", status: "complete" };
  assert.equal(runLabel(run), "backtest-1-abc \u00b7 2024-01-15");
});

// ---------------------------------------------------------------------------
// renderEnvSelector
// ---------------------------------------------------------------------------

test("renderEnvSelector: default (live, no runs) shows only an active Live pill and no notes", () => {
  const html = renderEnvSelector({ pathname: "/dashboard/snapshot", search: "" });
  assert.match(html, /id="env-selector"/);
  assert.match(html, /class="pill pill-active"[^>]*>Live<\/a>/);
  assert.ok(!html.includes("note"), "no envError, no non-live banner -- no note markup at all");
});

test("renderEnvSelector: one pill per run, each linking to its own ?env=, Live still first", () => {
  const runs = [
    { id: "backtest-2-def", tickers: ["MSFT"], testStart: "2024-02-01T00:00:00.000Z", status: "complete" },
    { id: "backtest-1-abc", tickers: ["AAPL"], testStart: "2024-01-01T00:00:00.000Z", status: "running" },
  ];
  const html = renderEnvSelector({ runs, resolvedEnv: "live", pathname: "/dashboard/decisions", search: "?decisionLimit=50" });
  const liveIdx = html.indexOf(">Live<");
  const firstRunIdx = html.indexOf("MSFT");
  assert.ok(liveIdx > -1 && liveIdx < firstRunIdx, "Live pill comes before the run pills");
  assert.ok(html.includes('href="/dashboard/decisions?decisionLimit=50&amp;env=backtest-2-def"'));
  assert.ok(html.includes('href="/dashboard/decisions?decisionLimit=50&amp;env=backtest-1-abc"'));
  assert.match(html, /MSFT \u00b7 2024-02-01/);
  assert.match(html, /AAPL \u00b7 2024-01-01 \(running\)/);
});

test("renderEnvSelector: highlights whichever pill matches resolvedEnv, not any particular position", () => {
  const runs = [{ id: "backtest-1-abc", tickers: ["AAPL"], testStart: "2024-01-01T00:00:00.000Z", status: "complete" }];
  const html = renderEnvSelector({ runs, resolvedEnv: "backtest-1-abc", pathname: "/dashboard/snapshot", search: "" });
  assert.match(html, /class="pill"[^>]*>Live<\/a>/, "Live is present but NOT active");
  assert.ok(!/class="pill pill-active"[^>]*>Live<\/a>/.test(html));
  assert.match(html, /class="pill pill-active"[^>]*>AAPL/, "the matching run pill is active instead");
});

test("renderEnvSelector: resolvedEnv not present in the (capped) runs list still gets its own pill, so the active env is never invisible", () => {
  const html = renderEnvSelector({ runs: [], resolvedEnv: "backtest-9-old", pathname: "/dashboard/snapshot", search: "" });
  assert.match(html, /class="pill pill-active"[^>]*>backtest-9-old<\/a>/);
});

test("renderEnvSelector: does NOT duplicate a pill for resolvedEnv when it's already in the runs list", () => {
  const runs = [{ id: "backtest-1-abc", tickers: ["AAPL"], testStart: "2024-01-01T00:00:00.000Z", status: "complete" }];
  const html = renderEnvSelector({ runs, resolvedEnv: "backtest-1-abc", pathname: "/dashboard/snapshot", search: "" });
  assert.equal((html.match(/class="pill/g) || []).length, 2, "exactly Live + the one run pill, no extra");
});

test("renderEnvSelector: envError renders as its own note, independent of the resolvedEnv banner", () => {
  const html = renderEnvSelector({ resolvedEnv: "live", envError: "environment 'backtest-9-old' not found", pathname: "/dashboard/snapshot", search: "" });
  assert.match(html, /<p class="note">environment &#39;backtest-9-old&#39; not found<\/p>/);
  assert.ok(!html.includes("simulated results"), "resolvedEnv is live here, so no simulated-data banner");
});

test("renderEnvSelector: viewing a non-live env shows the 'simulated, not live' note with the env id", () => {
  const html = renderEnvSelector({ resolvedEnv: "backtest-1-abc", pathname: "/dashboard/snapshot", search: "" });
  assert.match(html, /Viewing backtest <code>backtest-1-abc<\/code> &mdash; simulated results, not live trading\./);
});

test("renderEnvSelector: a null envError never renders as the literal string 'null'", () => {
  const html = renderEnvSelector({ resolvedEnv: "backtest-1-abc", envError: null, pathname: "/dashboard/snapshot", search: "" });
  assert.ok(!html.includes('<p class="note">null</p>'), "a null envError must not render as the literal string 'null'");
  assert.match(html, /simulated results/);
});

test("renderEnvSelector: HTML-escapes untrusted-ish fields (pathname/search from the URL, run id/tickers from the registry)", () => {
  const runs = [{ id: 'backtest-1-"><script>', tickers: ['<img onerror=alert(1)>'], testStart: "2024-01-01T00:00:00.000Z", status: "complete" }];
  const html = renderEnvSelector({ runs, pathname: "/dashboard/snapshot", search: '?x="><script>alert(1)</script>' });
  assert.ok(!html.includes("<script>"), "no raw <script> anywhere in the output");
  assert.ok(!html.includes("<img onerror"));
});
