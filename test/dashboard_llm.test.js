// Covers the dashboard's "LLM calls" page end to end: query-param parsing
// (helpers.js), the list and detail views (views/llm.js), backend's
// /api/llm-calls[/:id] routes (src/index.js -> dashboard/api.js), and the
// dashboard Worker's /dashboard/llm[/:id] routes with their session gate.
// The dashboard tests run the REAL backend Worker behind a fake service
// binding (same approach as dashboard_worker.test.js) over a REAL sqlite state
// DB bound as LIVE_DB (M2b: llm_calls lives in the state schema, read through
// a read-only RunStore), so the filter/paging query strings travel the whole
// way to SQL.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/dashboard-worker.js";
import backendWorker from "../src/index.js";
import { parseLlmParams, llmQuery, backtestRunsList } from "../src/dashboard/helpers.js";
import { renderLlmView, renderLlmCallView } from "../src/dashboard/views/llm.js";
import { renderShell } from "../src/dashboard/shell.js";
import { renderMoreView } from "../src/dashboard/views/more.js";
import { RunStore } from "../src/storage/run_store.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { STATE_DIR, SIM_DIR } from "./helpers/engine_ctx.js";
import { BrokenDb } from "./helpers/broken_db.js";
import { insertBacktestRun, completeBacktestRun } from "../src/storage/sim_registry.js";

const qs = (obj) => new URLSearchParams(obj);
const DEFAULT_PARAMS = parseLlmParams(qs({}));

// ---------------------------------------------------------------------------
// params + links
// ---------------------------------------------------------------------------

test("parseLlmParams defaults, and validates every param", () => {
  assert.deepEqual(parseLlmParams(qs({})), { llmSource: "all", llmStatus: "all", llmLimit: 50, llmTicker: "", llmJob: "", llmRun: "", llmBefore: null, env: "live" });
  assert.deepEqual(
    parseLlmParams(qs({ llmSource: "backtest", llmStatus: "error", llmLimit: "100", llmTicker: " aapl ", llmJob: "backtest-1", llmRun: "n|1", llmBefore: "42" })),
    { llmSource: "backtest", llmStatus: "error", llmLimit: 100, llmTicker: "AAPL", llmJob: "backtest-1", llmRun: "n|1", llmBefore: 42, env: "live" }
  );
  // junk falls back to defaults instead of reaching the query
  const junk = parseLlmParams(qs({ llmSource: "drop table", llmStatus: "x", llmLimit: "9999", llmTicker: "AA PL;--", llmBefore: "-3", llmJob: "j".repeat(500) }));
  assert.deepEqual(junk, DEFAULT_PARAMS);
  assert.equal(parseLlmParams(qs({ llmTicker: "BRK.B" })).llmTicker, "BRK.B");
  assert.equal(parseLlmParams(qs({ llmBefore: "1.5" })).llmBefore, null);
  assert.deepEqual(parseLlmParams(null), DEFAULT_PARAMS);
});

test("llmQuery omits defaults so links stay short, and drops the paging cursor whenever a filter changes", () => {
  assert.equal(llmQuery(DEFAULT_PARAMS), "");
  assert.equal(llmQuery(DEFAULT_PARAMS, { llmSource: "backtest" }), "?llmSource=backtest");
  assert.equal(llmQuery(DEFAULT_PARAMS, { llmSource: "all" }), "");

  const paged = { ...DEFAULT_PARAMS, llmSource: "backtest", llmBefore: 40 };
  assert.equal(llmQuery(paged, { llmStatus: "error" }), "?llmSource=backtest&llmStatus=error", "changing a filter must reset paging");
  assert.equal(llmQuery(paged, { llmBefore: 20 }), "?llmSource=backtest&llmBefore=20");
  assert.equal(llmQuery(paged, { llmBefore: null }), "?llmSource=backtest");
});

test("backtestRunsList links each run to its own LLM calls", () => {
  const html = backtestRunsList([{ id: "backtest-7-abc", tickers: ["AAPL"], testStart: "2024-01-01T00:00:00Z", testEnd: "2024-02-01T00:00:00Z", status: "failed", error: "boom", result: null }]);
  // Backtest calls are logged under the run's own environment, so the link must carry env too or it queries live and shows nothing.
  assert.ok(html.includes('href="/dashboard/llm?llmJob=backtest-7-abc&env=backtest-7-abc"'));
});

test("the LLM page is reachable: desktop nav, the mobile More menu, and the More cards", () => {
  const shell = renderShell({ activeSection: "llm", sessionUsername: "admin", bodyHtml: "<p>x</p>" });
  assert.ok(shell.includes('href="/dashboard/llm"'));
  assert.match(shell, /LLM Calls/);
  assert.ok(renderMoreView().includes('href="/dashboard/llm"'));
});

// ---------------------------------------------------------------------------
// list view
// ---------------------------------------------------------------------------

function summary(overrides = {}) {
  return {
    id: 7, createdAt: "2026-09-19T10:00:00.000Z", source: "pipeline", jobId: null, runId: "news-1", ticker: "AAPL", label: "analyst:news_event",
    requestedModel: "gemini-quick", modelUsed: "gemini-quick", keyIndex: 0, status: "ok", errorStage: null, error: null, durationMs: 1500,
    promptChars: 900, responseChars: 120, truncated: false, promptPreview: "You are a news analyst", responsePreview: '{"eventType":"earnings"}', ...overrides,
  };
}

test("renderLlmView lists calls with agent, source, status, model, timing and links to each call's detail page", () => {
  const html = renderLlmView({ calls: [summary()], nextBeforeId: null, params: DEFAULT_PARAMS, error: null });
  assert.ok(html.includes('href="/dashboard/llm/7"'));
  assert.match(html, /analyst:news_event/);
  assert.match(html, /live pipeline/);
  assert.match(html, /1\.5s/);
  assert.match(html, /You are a news analyst/);
  assert.match(html, /earnings/);
});

test("renderLlmView escapes prompt/response text (news bodies are untrusted HTML)", () => {
  const html = renderLlmView({
    calls: [summary({ promptPreview: "<script>alert(1)</script>", responsePreview: '<img src=x onerror="boom()">' })],
    nextBeforeId: null, params: DEFAULT_PARAMS, error: null,
  });
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(!html.includes("<img src=x"));
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
});

test("renderLlmView flags a fallback (cascade stepped down) and a call no model answered", () => {
  const fellBack = renderLlmView({ calls: [summary({ requestedModel: "deep", modelUsed: "lite" })], nextBeforeId: null, params: DEFAULT_PARAMS, error: null });
  assert.match(fellBack, /lite/);
  assert.match(fellBack, /fell back from deep/);

  const failed = renderLlmView({
    calls: [summary({ status: "error", errorStage: "vendor", error: "503 high demand", modelUsed: null, responsePreview: null })],
    nextBeforeId: null, params: DEFAULT_PARAMS, error: null,
  });
  assert.match(failed, /failed &middot; vendor|failed · vendor/);
  assert.match(failed, /no answer/);
  assert.match(failed, /503 high demand/, "a failed call with no response shows its error in the response column");
});

test("renderLlmView shows an empty state, an error state, and scope notes for a backtest/run filter", () => {
  assert.match(renderLlmView({ calls: [], nextBeforeId: null, params: DEFAULT_PARAMS, error: null }), /No LLM calls match/);
  assert.match(renderLlmView({ calls: [], nextBeforeId: null, params: DEFAULT_PARAMS, error: "no such table: llm_calls" }), /no such table: llm_calls/);

  const scoped = renderLlmView({ calls: [summary()], nextBeforeId: null, params: { ...DEFAULT_PARAMS, llmJob: "backtest-1" }, error: null });
  assert.match(scoped, /backtest <code>backtest-1<\/code>/);
  assert.ok(scoped.includes('href="/dashboard/llm"'), "Show all calls clears the scope");
});

test("renderLlmView explains that backtest runs aren't logged by default, rather than looking like a filter/timing issue", () => {
  const live = renderLlmView({ calls: [], nextBeforeId: null, params: DEFAULT_PARAMS, error: null });
  assert.doesNotMatch(live, /off by default for backtest runs/);

  const onBacktest = renderLlmView({ calls: [], nextBeforeId: null, params: { ...DEFAULT_PARAMS, env: "backtest-1" }, error: null });
  assert.match(onBacktest, /off by default for backtest runs/);
  assert.match(onBacktest, /<code>backtest-1<\/code>/);
});

test("renderLlmView paging: 'Older' only when another page exists, 'Newest' only when already paged in; filters survive the links", () => {
  const params = { ...DEFAULT_PARAMS, llmSource: "backtest" };
  const first = renderLlmView({ calls: [summary()], nextBeforeId: 5, params, error: null });
  assert.ok(first.includes('href="/dashboard/llm?llmSource=backtest&amp;llmBefore=5"') || first.includes('href="/dashboard/llm?llmSource=backtest&llmBefore=5"'));
  assert.ok(!first.includes("Newest"));

  const last = renderLlmView({ calls: [summary()], nextBeforeId: null, params: { ...params, llmBefore: 5 }, error: null });
  assert.match(last, /Newest/);
  assert.ok(!last.includes("Older"));
});

test("the ticker filter form keeps the other active filters as hidden inputs (and drops the paging cursor)", () => {
  const html = renderLlmView({ calls: [], nextBeforeId: null, params: { ...DEFAULT_PARAMS, llmSource: "backtest", llmStatus: "error", llmBefore: 9 }, error: null });
  assert.match(html, /type="hidden" name="llmSource" value="backtest"/);
  assert.match(html, /type="hidden" name="llmStatus" value="error"/);
  assert.ok(!html.includes('name="llmBefore"'));
});

// ---------------------------------------------------------------------------
// detail view
// ---------------------------------------------------------------------------

function fullCall(overrides = {}) {
  return {
    ...summary(), prompt: "You are a trader.\nVerdict: <b>long</b>", response: '```json\n{"instrument":"equity","rationale":"momentum"}\n```',
    attempts: [{ model: "deep", keyIndex: 0, outcome: "error", status: 503, detail: "high demand" }, { model: "lite", keyIndex: 0, outcome: "ok" }],
    ...overrides,
  };
}

test("renderLlmCallView shows the whole prompt (escaped), the response re-indented when it is JSON, and the cascade attempts", () => {
  const html = renderLlmCallView({ call: fullCall({ requestedModel: "deep", modelUsed: "lite" }) });
  assert.match(html, /Prompt sent/);
  assert.ok(html.includes("You are a trader.\nVerdict: &lt;b&gt;long&lt;/b&gt;"));
  assert.match(html, /Response received/);
  assert.ok(html.includes("{\n  &quot;instrument&quot;: &quot;equity&quot;"), "JSON is re-indented (and, like all text here, HTML-escaped)");
  assert.ok(!html.includes("```json"), "fences are stripped in the formatted view");
  assert.match(html, /Cascade attempts/);
  assert.match(html, /error 503/);
  assert.match(html, /high demand/);
  assert.match(html, /Answered by/);
});

test("renderLlmCallView shows a non-JSON response as raw text", () => {
  const html = renderLlmCallView({ call: fullCall({ response: "Sure! I think it's a long.", attempts: [] }) });
  assert.match(html, /Sure! I think it&#39;s a long\./);
  assert.match(html, /raw text/);
  assert.ok(!html.includes("Cascade attempts"));
});

test("renderLlmCallView explains a failed call that never got a response, and shows its error", () => {
  const html = renderLlmCallView({ call: fullCall({ status: "error", errorStage: "vendor", error: "Gemini cascade exceeded its budget", response: null, modelUsed: null, keyIndex: null }) });
  assert.match(html, /Nothing came back/);
  assert.match(html, /Gemini cascade exceeded its budget/);
  assert.match(html, /no model answered/);
});

test("renderLlmCallView links to the rest of the run / backtest, and notes truncation", () => {
  const html = renderLlmCallView({ call: fullCall({ runId: "w|AAPL|n1", jobId: "backtest-3", truncated: true, promptChars: 90000 }) });
  assert.ok(html.includes("llmRun=w%7CAAPL%7Cn1"));
  assert.ok(html.includes("llmJob=backtest-3"));
  assert.match(html, /clipped/);
  assert.match(html, /90,000 chars/);
});

test("renderLlmCallView handles a missing call and a backend error", () => {
  assert.match(renderLlmCallView({ call: null }), /Call not found/);
  assert.match(renderLlmCallView({ error: "backend exploded" }), /backend exploded/);
});

// ---------------------------------------------------------------------------
// backend API + dashboard worker
// ---------------------------------------------------------------------------

async function seededDb() {
  const db = createTestD1([STATE_DIR]);
  const store = new RunStore(db, "live");
  await store.insertLlmCall({ source: "pipeline", ticker: "AAPL", runId: "news-1", label: "trader", status: "ok", prompt: "PROMPT-ONE", response: '{"instrument":"equity"}' });
  await store.insertLlmCall({ source: "backtest", jobId: "backtest-1", ticker: "MSFT", runId: "w|MSFT|n2", label: "debate:judge", status: "error", errorStage: "parse", error: "not json", prompt: "PROMPT-TWO", response: "garbage" });
  return db;
}

const backendGet = (path, env) => backendWorker.fetch(new Request(`https://backend${path}`), env, { waitUntil() {} });

test("GET /api/llm-calls returns previews newest-first and honors the filter params", async () => {
  const env = { LIVE_DB: await seededDb() };

  const all = await (await backendGet("/api/llm-calls", env)).json();
  assert.deepEqual(all.calls.map((c) => c.id), [2, 1]);
  assert.equal(all.error, null);
  assert.equal("prompt" in all.calls[0], false);

  const backtestOnly = await (await backendGet("/api/llm-calls?llmSource=backtest", env)).json();
  assert.deepEqual(backtestOnly.calls.map((c) => c.id), [2]);
  assert.deepEqual((await (await backendGet("/api/llm-calls?llmJob=backtest-1", env)).json()).calls.map((c) => c.id), [2]);
  assert.deepEqual((await (await backendGet("/api/llm-calls?llmTicker=aapl", env)).json()).calls.map((c) => c.id), [1]);
  assert.deepEqual((await (await backendGet("/api/llm-calls?llmStatus=error", env)).json()).calls.map((c) => c.id), [2]);
});

test("GET /api/llm-calls reports a D1 failure in the body rather than a blank 200 (so the page can show it)", async (t) => {
  t.mock.method(console, "error", () => {});
  const body = await (await backendGet("/api/llm-calls", { LIVE_DB: new BrokenDb() })).json();
  assert.deepEqual(body.calls, []);
  assert.match(body.error, /D1 exploded/);
});

test("GET /api/llm-calls/:id returns the full call; 404 for an unknown id; 400 for a non-numeric one", async () => {
  const env = { LIVE_DB: await seededDb() };

  const res = await backendGet("/api/llm-calls/2", env);
  assert.equal(res.status, 200);
  const call = await res.json();
  assert.equal(call.prompt, "PROMPT-TWO");
  assert.equal(call.response, "garbage");
  assert.equal(call.errorStage, "parse");

  assert.equal((await backendGet("/api/llm-calls/999", env)).status, 404);
  assert.equal((await backendGet("/api/llm-calls/abc", env)).status, 400);
});

test("GET /api/llm-calls only shows the live environment (another run_id's rows in the same DB are invisible, including by id)", async () => {
  const db = await seededDb();
  await new RunStore(db, "bt-1").insertLlmCall({ source: "backtest", label: "trader", status: "ok", prompt: "OTHER-ENV", ticker: "AAPL" });
  const env = { LIVE_DB: db };

  const body = await (await backendGet("/api/llm-calls", env)).json();
  assert.deepEqual(body.calls.map((c) => c.id), [2, 1]);
  assert.equal((await backendGet("/api/llm-calls/3", env)).status, 404, "bt-1's row (id 3) is not visible through the live view");
});

test("the dashboard's LLM/job reads go through a read-only handle: a write method through it throws before reaching D1", async () => {
  const { liveReadStore } = await import("../src/dashboard/data.js");
  const store = liveReadStore({ LIVE_DB: createTestD1([STATE_DIR]) });
  await assert.rejects(store.insertLlmCall({ label: "x", status: "ok", prompt: "p" }), /refusing non-SELECT/);
  await assert.rejects(store.insertQueuedJob({ id: "j", type: "backfill" }), /refusing non-SELECT/);
  assert.deepEqual((await store.getRecentLlmCalls()).calls, [], "reads still work");
});

function makeBackend(backendEnv) {
  return { fetch: (input, init) => backendWorker.fetch(new Request(input, init), backendEnv, { waitUntil() {} }) };
}

async function dashboardEnv() {
  return {
    BACKEND: makeBackend({ LIVE_DB: await seededDb() }),
    DASHBOARD_USERNAME: "admin", DASHBOARD_PASSWORD: "correct-horse-battery-staple", JWT_SECRET: "test-jwt-signing-key",
  };
}

async function sessionCookie(env) {
  const res = await worker.fetch(
    new Request("https://dashboard.example/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "admin", password: "correct-horse-battery-staple" }).toString(),
    }),
    env
  );
  return res.headers.get("set-cookie").split(";")[0];
}

const dashGet = (path, env, cookie) => worker.fetch(new Request(`https://dashboard.example${path}`, { headers: cookie ? { cookie } : {} }), env);

test("GET /dashboard/llm redirects to /login without a session, and 503s when login isn't configured", async () => {
  const env = await dashboardEnv();
  const res = await dashGet("/dashboard/llm", env);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/login");

  const unconfigured = await dashGet("/dashboard/llm", { BACKEND: env.BACKEND });
  assert.equal(unconfigured.status, 503);
});

test("GET /dashboard/llm/:id also requires a session", async () => {
  const env = await dashboardEnv();
  const res = await dashGet("/dashboard/llm/1", env);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/login");
});

test("GET /dashboard/llm renders the list from backend, and the query string filters it", async () => {
  const env = await dashboardEnv();
  const cookie = await sessionCookie(env);

  const all = await (await dashGet("/dashboard/llm", env, cookie)).text();
  assert.ok(all.includes('href="/dashboard/llm/1"') && all.includes('href="/dashboard/llm/2"'));
  assert.match(all, /debate:judge/);
  assert.match(all, /PROMPT-ONE/);

  const filtered = await (await dashGet("/dashboard/llm?llmSource=backtest", env, cookie)).text();
  assert.ok(filtered.includes('href="/dashboard/llm/2"'));
  assert.ok(!filtered.includes('href="/dashboard/llm/1"'));
  assert.match(filtered, /pill pill-active">backtest</, "the active filter pill reflects the query string");
});

test("GET /dashboard/llm/:id renders the full prompt and response; unknown or non-numeric ids get a 404 page", async () => {
  const env = await dashboardEnv();
  const cookie = await sessionCookie(env);

  const res = await dashGet("/dashboard/llm/2", env, cookie);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Prompt sent/);
  assert.match(html, /PROMPT-TWO/);
  assert.match(html, /garbage/);
  assert.match(html, /not json/);

  const missing = await dashGet("/dashboard/llm/999", env, cookie);
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /Call not found/);
  assert.equal((await dashGet("/dashboard/llm/abc", env, cookie)).status, 404);
});

// ---------------------------------------------------------------------------
// M4b: the LLM call detail page's environment selector (owner's 3fd767d,
// which added resolvedEnv/envError to /api/llm-calls/:id, and 68bb093,
// which wired envSelectorFor into renderLlmCall -- neither had test
// coverage before this commit).
// ---------------------------------------------------------------------------

const BT = "backtest-1789000000000-abc123";

/** A SIM_DB with BT registered+complete, holding one LLM call under that run. */
async function seededSimDb() {
  const simDb = createTestD1([STATE_DIR, SIM_DIR]);
  await insertBacktestRun(simDb, { id: BT, tickers: ["AAPL"], testStart: "2024-01-01T00:00:00.000Z", testEnd: "2024-02-01T00:00:00.000Z", trainDays: 0, testDays: 30, startedAt: "2026-03-12T00:00:00.000Z" });
  await completeBacktestRun(simDb, { id: BT, result: { overall: {} }, finishedAt: "2026-03-12T01:00:00.000Z" });
  await new RunStore(simDb, BT).insertLlmCall({ source: "backtest", ticker: "AAPL", jobId: BT, runId: "w|AAPL|n1", label: "trader", status: "ok", prompt: "SIM-PROMPT", response: '{"instrument":"equity"}' });
  return simDb;
}

test("GET /api/llm-calls/:id?env=<registered backtest> returns the call scoped to that run, plus resolvedEnv and no envError", async () => {
  const env = { LIVE_DB: createTestD1([STATE_DIR]), SIM_DB: await seededSimDb() };
  const res = await backendGet(`/api/llm-calls/1?env=${BT}`, env);
  assert.equal(res.status, 200);
  const call = await res.json();
  assert.equal(call.prompt, "SIM-PROMPT");
  assert.equal(call.resolvedEnv, BT);
  assert.equal(call.envError, null);
});

test("GET /api/llm-calls/:id?env=<well-formed but unregistered> heals to live: returns live's call, resolvedEnv 'live', and an envError explaining why", async () => {
  const env = { LIVE_DB: await seededDb(), SIM_DB: createTestD1([STATE_DIR, SIM_DIR]) };
  const res = await backendGet(`/api/llm-calls/1?env=${BT}`, env);
  assert.equal(res.status, 200);
  const call = await res.json();
  assert.equal(call.prompt, "PROMPT-ONE");
  assert.equal(call.resolvedEnv, "live");
  assert.match(call.envError, /not found/);
});

test("GET /dashboard/llm/:id?env=<registered backtest> shows the selector with that run's pill active, and the scope + back links carry the env", async () => {
  const backendEnv = { LIVE_DB: createTestD1([STATE_DIR]), SIM_DB: await seededSimDb() };
  const env = { BACKEND: makeBackend(backendEnv), DASHBOARD_USERNAME: "admin", DASHBOARD_PASSWORD: "correct-horse-battery-staple", JWT_SECRET: "test-jwt-signing-key" };
  const cookie = await sessionCookie(env);
  const html = await (await dashGet(`/dashboard/llm/1?env=${BT}`, env, cookie)).text();

  assert.match(html, /id="env-selector"/);
  assert.match(html, /class="env-option active"[^>]*>[\s\S]*?AAPL/, "the backtest's own dropdown option is active, not Live");
  assert.match(html, /SIM-PROMPT/);

  assert.ok(html.includes(`href="/dashboard/llm?env=${BT}"`), "back link carries the env");
  const scopeMatch = html.match(/href="([^"]*)">All calls in this run<\/a>/);
  assert.ok(scopeMatch, "scope link found");
  assert.ok(scopeMatch[1].includes(`env=${BT}`) && scopeMatch[1].includes("llmRun=w%7CAAPL%7Cn1"), "scope link carries both the env and the run filter");
});

test("GET /dashboard/llm/:id?env=<unregistered> heals to live: Live pill active, envError note shown, and live's own call is displayed rather than a broken page", async () => {
  const backendEnv = { LIVE_DB: await seededDb(), SIM_DB: createTestD1([STATE_DIR, SIM_DIR]) };
  const env = { BACKEND: makeBackend(backendEnv), DASHBOARD_USERNAME: "admin", DASHBOARD_PASSWORD: "correct-horse-battery-staple", JWT_SECRET: "test-jwt-signing-key" };
  const cookie = await sessionCookie(env);
  const html = await (await dashGet(`/dashboard/llm/1?env=${BT}`, env, cookie)).text();

  assert.match(html, /class="env-option active"[\s\S]*?>Live<\/span>/);
  assert.match(html, /not found/);
  assert.match(html, /PROMPT-ONE/, "healed to live -- shows live's call 1, not a blank/error page");
});

test("renderLlmCallView: back/scope links carry a non-live env, and default to plain live links when env is omitted", () => {
  const call = fullCall({ runId: "w|AAPL|n1", jobId: "backtest-3" });

  const live = renderLlmCallView({ call });
  assert.ok(live.includes('href="/dashboard/llm"'), "no ?env= for the default live view");

  const scoped = renderLlmCallView({ call, env: "backtest-1-abc" });
  assert.ok(scoped.includes('href="/dashboard/llm?env=backtest-1-abc"'), "back link carries the env");

  // Two distinct scope links when a call has both a runId and a jobId: the
  // run-scoped link (finer-grained: one specific simulated run) carries
  // llmRun, and the backtest-scoped link (the whole job those runs belong
  // to) carries llmJob -- each independently, not both on either link.
  const runMatch = scoped.match(/href="([^"]*)">All calls in this run<\/a>/);
  assert.ok(runMatch, "run-scope link found");
  assert.ok(runMatch[1].includes("env=backtest-1-abc") && runMatch[1].includes("llmRun=w%7CAAPL%7Cn1"), "run-scope link carries env and llmRun");

  const jobMatch = scoped.match(/href="([^"]*)">All calls in this backtest<\/a>/);
  assert.ok(jobMatch, "backtest-scope link found");
  assert.ok(jobMatch[1].includes("env=backtest-1-abc") && jobMatch[1].includes("llmJob=backtest-3"), "backtest-scope link carries env and llmJob");
});
