// Dashboard gateway: the server side of the dashboard, running inside the
// Next.js Worker (news-market-ai-dashboard). It used to be its own Worker
// (src/dashboard-worker.js); since the single-Worker collapse the Next.js
// route handlers call it in-process.
//
// What it owns:
//   1. login()  -- the credential check, issuing the session cookie.
//   2. getSession() -- verifying that cookie.
//   3. handleGateway(request, env) -- the session gate in front of the private
//      `backend` Worker (env.BACKEND, a service binding):
//        GET /api/*, GET /backtest/replay/news   read-only JSON passthrough
//        POST /backfill, /backfill-prices, /backtest/*, /controls/*
//                                                body validated, then forwarded
//
// `backend` is private (no public route, see wrangler.toml) and holds no login
// secrets, so an unconfigured login means this Worker -- the only public one --
// fails closed (503) rather than backend quietly serving an open API.
//
// Pure Web APIs only (Request/Response/crypto.subtle), and a plain .mjs file
// with no imports outside this folder: the Next.js build bundles it, and the
// root `node --test` suite (test/dashboard_gateway*.test.js) imports it as is.
//
// PAUSE_KEYS and BACKTEST_ID_RE are copies of the backend's own constants
// (src/storage/pause_flags.js, src/dashboard/helpers.js);
// test/dashboard_gateway_parity.test.js fails if they drift.

import { getSessionUsername, createSessionCookie } from "./session.mjs";

export const PAUSE_KEYS = Object.freeze(["ingestion", "trading", "llm", "backtests"]);
export const BACKTEST_ID_RE = /^backtest-\d+-[a-z0-9]+$/;

/** The auth-related settings, read from the Worker env (secrets) on every call. */
export function loadAuthConfig(env) {
  return {
    dashboardUsername: env.DASHBOARD_USERNAME || "",
    dashboardPassword: env.DASHBOARD_PASSWORD || "",
    jwtSecret: env.JWT_SECRET || "",
    sessionTtlSeconds: Number(env.SESSION_TTL_SECONDS) || 86400,
  };
}

/** The "no partial config" gate: all three secrets must be set together or the login stays disabled. */
export function isDashboardAuthConfigured(config) {
  return Boolean(config.dashboardUsername && config.dashboardPassword && config.jwtSecret);
}

/**
 * Checks the operator credentials. 503 when the login isn't configured (no
 * credential check happens at all), 401 on a mismatch, 200 with the Set-Cookie
 * value on success.
 * @returns {Promise<{ status: number, error: string | null, cookie: string | null }>}
 */
export async function login(env, username, password, { secure = true } = {}) {
  const config = loadAuthConfig(env);
  if (!isDashboardAuthConfigured(config)) {
    return { status: 503, error: "dashboard login is not configured", cookie: null };
  }
  if (String(username ?? "") !== config.dashboardUsername || String(password ?? "") !== config.dashboardPassword) {
    return { status: 401, error: "Invalid username or password.", cookie: null };
  }
  return { status: 200, error: null, cookie: await createSessionCookie(config.dashboardUsername, config, { secure }) };
}

/**
 * The session on this request. `configured: false` means the login isn't set up
 * at all, which callers must tell apart from "configured, but not logged in".
 * @returns {Promise<{ configured: boolean, username: string | null }>}
 */
export async function getSession(request, env) {
  const config = loadAuthConfig(env);
  if (!isDashboardAuthConfigured(config)) return { configured: false, username: null };
  return { configured: true, username: await getSessionUsername(request, config) };
}

// ---------------------------------------------------------------------------
// Path mapping
// ---------------------------------------------------------------------------

// The browser calls /api/<x> on this app. Reads keep that prefix on the backend
// (/api/<x>); these writes and the replay picker live at /<x> there instead.
const NON_API_ROUTES = new Set([
  "/backfill",
  "/backfill-prices",
  "/backtest/run",
  "/backtest/cleanup",
  "/backtest/purge",
  "/backtest/replay/run",
  "/backtest/replay/news",
  "/controls/set",
  "/controls/tickers",
  "/controls/macro",
]);
const BACKTEST_ACTION_RE = /^\/backtest\/[^/]+\/(cancel|pause|resume)$/;

/** Maps the path after `/api` in the browser's URL (e.g. "/overview") to the path handleGateway serves ("/api/overview"). */
export function toGatewayPath(path) {
  if (NON_API_ROUTES.has(path) || BACKTEST_ACTION_RE.test(path)) return path;
  return "/api" + path;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPlausibleDateString(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function jsonResponse(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A checkbox-style flag: present and not an explicit "off" value. Covers form checkboxes ("1"/"on"), query flags ("1") and JSON booleans (true -> "1", false -> "0"). */
function isChecked(value) {
  return value != null && value !== "" && value !== "0" && value !== "false";
}

function scalarOf(value) {
  if (value == null) return null;
  if (typeof value === "boolean") return value ? "1" : "0";
  if (Array.isArray(value)) return value.map(String).join(",");
  return String(value);
}

function valuesOf(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

/** Every value (repeated fields and/or comma lists) as a deduped, upper-cased array. */
function parseTickerList(values) {
  const out = [];
  for (const value of values ?? []) {
    for (const part of String(value ?? "").split(",")) {
      const ticker = part.trim().toUpperCase();
      if (ticker && !out.includes(ticker)) out.push(ticker);
    }
  }
  return out;
}

/**
 * Reads a request body as `{ get(key), getAll(key) }`, whichever way it was
 * sent: form fields (urlencoded/multipart, scripted callers) or a JSON object
 * (what the UI sends). `null` = no body of either kind, or an empty one (all
 * inputs then come from the query string); `{ invalid: true }` = a JSON body
 * that isn't an object. JSON booleans read back as "1"/"0" and arrays as comma
 * lists, so one buildQuery works for every caller.
 */
async function readBody(request) {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    return { get: (key) => form.get(key), getAll: (key) => form.getAll(key).map(String) };
  }
  if (contentType.includes("application/json")) {
    const text = await request.text();
    if (!text.trim()) return null;
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { invalid: true };
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) return { invalid: true };
    return { get: (key) => scalarOf(data[key]), getAll: (key) => valuesOf(data[key]) };
  }
  return null;
}

/**
 * Calls `backend`'s JSON API over the service binding. The URL's origin
 * ("https://backend") is never dialed: service bindings route in-process inside
 * the same Cloudflare account, so it is only a stable placeholder host.
 */
async function callBackend(env, path, init) {
  return env.BACKEND.fetch(`https://backend${path}`, init);
}

/**
 * Session gate for the GET reads. "__disabled__" means the login isn't
 * configured at all, which is distinct from "/login" (configured, but this
 * request has no valid session) so callers can answer 503 instead of acting as
 * if a login could ever succeed.
 */
async function requireSession(request, env) {
  const session = await getSession(request, env);
  if (!session.configured) return { redirect: "__disabled__" };
  if (!session.username) return { redirect: "/login" };
  return { sessionUsername: session.username };
}

/** Shared handler for every POST trigger route: check the session, validate, then forward to backend, which trusts any caller reaching it (only this Worker can, via the service binding). Always answers JSON: backend's own ack/error body and status, passed through. */
async function handleTriggerRoute(request, env, { backendPath, buildQuery }) {
  const session = await getSession(request, env);
  if (!session.username) {
    if (!session.configured) {
      return jsonResponse({ error: `${backendPath} is not configured (set up the dashboard login)` }, { status: 503 });
    }
    return jsonResponse({ error: "unauthorized" }, { status: 401 });
  }
  const sessionUsername = session.username;

  const url = new URL(request.url);
  const body = await readBody(request);
  if (body?.invalid) return jsonResponse({ error: "request body must be a JSON object or form fields" }, { status: 400 });
  const fromBody = (key) => (body ? body.get(key) : null);

  const built = buildQuery(url.searchParams, fromBody, sessionUsername, body);
  if (built.error) return jsonResponse({ error: built.error }, { status: 400 });

  // Backend always enqueues and returns an immediate `{accepted, id, ...}` ack;
  // it never runs the work itself.
  const qs = new URLSearchParams(built.params);

  try {
    const res = await callBackend(env, `${backendPath}?${qs.toString()}`, { method: "POST" });
    return jsonResponse(await res.json(), { status: res.status });
  } catch (err) {
    console.error(`${backendPath} forward failed`, { message: err.message });
    return jsonResponse({ error: `${backendPath} request failed`, message: err.message }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Serves one gateway request (paths as returned by toGatewayPath). `env` needs
 * BACKEND (the service binding) and the login secrets. Anything that isn't a
 * session-gated read or a known POST route answers a JSON 404.
 */
export async function handleGateway(request, env) {
  const url = new URL(request.url);
  const { pathname } = url;

  // GET /api/* -- read-only JSON passthrough, behind the session gate (401 JSON
  // without a session, 503 if login is unconfigured). GET only: every write
  // goes through the POST routes below.
  //
  // GET /backtest/replay/news is the one read that lives outside /api on the
  // backend (the news-replay picker's item list); it gets the same gate.
  if ((pathname.startsWith("/api/") || pathname === "/backtest/replay/news") && request.method === "GET") {
    const auth = await requireSession(request, env);
    if (auth.redirect === "__disabled__") return jsonResponse({ error: "dashboard is not configured" }, { status: 503 });
    if (auth.redirect) return jsonResponse({ error: "unauthorized" }, { status: 401 });
    try {
      const res = await callBackend(env, `${pathname}${url.search}`);
      return new Response(res.body, {
        status: res.status,
        headers: { "content-type": res.headers.get("content-type") || "application/json" },
      });
    } catch (err) {
      console.error("dashboard /api passthrough failed", { pathname, message: err.message });
      return jsonResponse({ error: "backend request failed", message: err.message }, { status: 502 });
    }
  }

  if (pathname === "/backfill" && request.method === "POST") {
    return handleTriggerRoute(request, env, {
      backendPath: "/backfill",
      buildQuery: (searchParams, fromBody) => {
        const from = searchParams.get("from") ?? fromBody("from");
        const to = searchParams.get("to") ?? fromBody("to");
        if (!isPlausibleDateString(from) || !isPlausibleDateString(to)) {
          return { error: "from/to are required, as YYYY-MM-DD" };
        }
        return { params: { from, to } };
      },
    });
  }

  // Price-bar backfill. Same shape as /backfill, plus an optional ticker list.
  if (pathname === "/backfill-prices" && request.method === "POST") {
    return handleTriggerRoute(request, env, {
      backendPath: "/backfill-prices",
      buildQuery: (searchParams, fromBody) => {
        const from = searchParams.get("from") ?? fromBody("from");
        const to = searchParams.get("to") ?? fromBody("to");
        const tickers = searchParams.get("tickers") ?? fromBody("tickers");
        if (!isPlausibleDateString(from) || !isPlausibleDateString(to)) {
          return { error: "from/to are required, as YYYY-MM-DD" };
        }
        const params = { from, to };
        if (tickers) params.tickers = tickers;
        return { params };
      },
    });
  }

  // POST /backtest/:id/cancel -- terminate a running backtest. The id in the URL IS the payload, so the backend path is built per request.
  if (pathname.startsWith("/backtest/") && pathname.endsWith("/cancel") && request.method === "POST") {
    const id = pathname.slice("/backtest/".length, pathname.length - "/cancel".length);
    if (!BACKTEST_ID_RE.test(id)) {
      return jsonResponse({ error: "backtest run id is malformed" }, { status: 400 });
    }
    return handleTriggerRoute(request, env, {
      backendPath: `/backtest/${encodeURIComponent(id)}/cancel`,
      buildQuery: () => ({ params: {} }),
    });
  }

  // POST /backtest/:id/pause and /backtest/:id/resume -- same shape as /cancel above.
  for (const action of ["pause", "resume"]) {
    if (pathname.startsWith("/backtest/") && pathname.endsWith(`/${action}`) && request.method === "POST") {
      const id = pathname.slice("/backtest/".length, pathname.length - `/${action}`.length);
      if (!BACKTEST_ID_RE.test(id)) {
        return jsonResponse({ error: "backtest run id is malformed" }, { status: 400 });
      }
      return handleTriggerRoute(request, env, {
        backendPath: `/backtest/${encodeURIComponent(id)}/${action}`,
        buildQuery: () => ({ params: {} }),
      });
    }
  }

  // POST /backtest/cleanup -- bulk-delete old terminal runs' trade-level data. `olderThanDays` is the only field; backend defaults it (and maxRuns) if omitted.
  if (pathname === "/backtest/cleanup" && request.method === "POST") {
    return handleTriggerRoute(request, env, {
      backendPath: "/backtest/cleanup",
      buildQuery: (searchParams, fromBody) => {
        const olderThanDays = searchParams.get("olderThanDays") ?? fromBody("olderThanDays");
        const params = {};
        if (olderThanDays) params.olderThanDays = olderThanDays;
        return { params };
      },
    });
  }

  // POST /backtest/purge -- delete failed and cancelled runs entirely, registry rows included. No fields: the backend picks every failed/cancelled run itself and bounds the batch.
  if (pathname === "/backtest/purge" && request.method === "POST") {
    return handleTriggerRoute(request, env, {
      backendPath: "/backtest/purge",
      buildQuery: () => ({ params: {} }),
    });
  }

  if (pathname === "/backtest/run" && request.method === "POST") {
    return handleTriggerRoute(request, env, {
      backendPath: "/backtest/run",
      buildQuery: (searchParams, fromBody) => {
        const testStart = searchParams.get("testStart") ?? fromBody("testStart");
        const testEnd = searchParams.get("testEnd") ?? fromBody("testEnd");
        const tickers = searchParams.get("tickers") ?? fromBody("tickers");
        const graceDays = searchParams.get("graceDays") ?? fromBody("graceDays");
        if (!isPlausibleDateString((testStart || "").slice(0, 10)) || !isPlausibleDateString((testEnd || "").slice(0, 10))) {
          return { error: "testStart/testEnd are required, as YYYY-MM-DD (or a full ISO timestamp)" };
        }
        const params = { testStart, testEnd };
        if (tickers) params.tickers = tickers;
        if (graceDays) params.graceDays = graceDays;
        // Flags: presence (and not an explicit "off") means on.
        if (isChecked(searchParams.get("enableLlmLog")) || isChecked(fromBody("enableLlmLog"))) params.enableLlmLog = "1";
        // "Disable price-impact gate": this run only goes out with the gate off (backend's skipNoPriceImpact=0 knob override). Absent sends nothing, so the Worker default (gate on) applies.
        if (isChecked(searchParams.get("disableGate")) || isChecked(fromBody("disableGate"))) params.skipNoPriceImpact = "0";
        return { params };
      },
    });
  }

  // POST /backtest/replay/run -- news-replay trigger. `newsItemIds` arrives as a repeated field, a comma list, or a JSON array; getAll collects all of them.
  if (pathname === "/backtest/replay/run" && request.method === "POST") {
    return handleTriggerRoute(request, env, {
      backendPath: "/backtest/replay/run",
      buildQuery: (searchParams, fromBody, sessionUsername, body) => {
        const ticker = searchParams.get("ticker") ?? fromBody("ticker");
        const fromQuery = searchParams.getAll("newsItemIds");
        const ids = (fromQuery.length > 0 ? fromQuery : body ? body.getAll("newsItemIds") : []).filter(Boolean);
        const asOf = searchParams.get("asOf") ?? fromBody("asOf");
        if (!ticker) return { error: "ticker is required" };
        if (ids.length === 0) return { error: "newsItemIds: pick at least one news item to replay" };
        const params = { ticker, newsItemIds: ids.join(",") };
        if (asOf) params.asOf = asOf;
        if (isChecked(searchParams.get("enableLlmLog")) || isChecked(fromBody("enableLlmLog"))) params.enableLlmLog = "1";
        return { params };
      },
    });
  }

  // POST /controls/set -- flip one pause switch (or all). Forwarded with the operator's username as `by` for the audit column.
  if (pathname === "/controls/set" && request.method === "POST") {
    return handleTriggerRoute(request, env, {
      backendPath: "/controls/set",
      buildQuery: (searchParams, fromBody, sessionUsername) => {
        const key = searchParams.get("key") ?? fromBody("key");
        const paused = searchParams.get("paused") ?? fromBody("paused");
        if (key !== "all" && !PAUSE_KEYS.includes(key)) return { error: `key must be one of: ${PAUSE_KEYS.join(", ")}, all` };
        if (paused !== "1" && paused !== "0") return { error: "paused must be 1 or 0 (or a boolean)" };
        const params = { key, paused };
        if (sessionUsername) params.by = sessionUsername;
        return { params };
      },
    });
  }

  // POST /controls/tickers -- choose which watchlist tickers the live pipeline runs for. Repeated fields, a comma list or a JSON array all work; "all" re-enables everything. The backend validates against the watchlist.
  if (pathname === "/controls/tickers" && request.method === "POST") {
    return handleTriggerRoute(request, env, {
      backendPath: "/controls/tickers",
      buildQuery: (searchParams, fromBody, sessionUsername, body) => {
        const fromQuery = parseTickerList(searchParams.getAll("tickers"));
        const tickers = fromQuery.length > 0 ? fromQuery : parseTickerList(body ? body.getAll("tickers") : []);
        if (tickers.length === 0) return { error: "select at least one ticker (use the pause switches to stop everything)" };
        const params = { tickers: tickers.join(",") };
        if (sessionUsername) params.by = sessionUsername;
        return { params };
      },
    });
  }

  // POST /controls/macro -- turn the live XAUUSD macro context (FRED + CFTC COT) on or off. `enabled` is 1/0 or a boolean; forwarded with the operator's username as `by`.
  if (pathname === "/controls/macro" && request.method === "POST") {
    return handleTriggerRoute(request, env, {
      backendPath: "/controls/macro",
      buildQuery: (searchParams, fromBody, sessionUsername) => {
        const enabled = searchParams.get("enabled") ?? fromBody("enabled");
        if (enabled !== "1" && enabled !== "0") return { error: "enabled must be 1 or 0 (or a boolean)" };
        const params = { enabled };
        if (sessionUsername) params.by = sessionUsername;
        return { params };
      },
    });
  }

  return jsonResponse({ error: "not found" }, { status: 404 });
}
