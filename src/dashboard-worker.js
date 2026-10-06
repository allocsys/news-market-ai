// Dashboard Worker entry point (plan.md "Step 2 -- Dashboard Worker"). Owns
// login and the session cookie, and is the only Worker the session JWT secret
// lives on. It serves NO HTML dashboard any more: the UI is the Next.js app
// in dashboard-next/ (its own Worker, bound to this one by the DASHBOARD
// service binding), which calls this Worker for exactly three things:
//
//   1. POST /login, GET /logout -- credential check + session cookie.
//   2. GET /api/*  -- read-only JSON passthrough to the private `backend`
//      Worker (env.BACKEND), behind the session gate.
//   3. POST /backfill, /backfill-prices, /backtest/*, /controls/* -- session
//      gate, then forwarded to backend's same-named route.
//
// `backend` is private (no public route, see wrangler.toml) and holds no
// login secrets: an unconfigured login means this Worker (the only public
// one) fails closed (503) rather than `backend` quietly serving an open,
// unauthenticated API.

import { loadConfig } from "./config.js";
import { renderLoginPage } from "./login.js";
import { PAUSE_KEYS } from "./storage/pause_flags.js";
import { BACKTEST_ID_RE } from "./dashboard/helpers.js";
import { getSessionUsername, createSessionCookie, clearSessionCookie } from "./auth/session.js";

/** Same "no partial config" gate backend used to run itself -- the ONLY place this check happens now. */
function isDashboardAuthConfigured(config) {
  return Boolean(config.dashboardUsername && config.dashboardPassword && config.jwtSecret);
}

function isPlausibleDateString(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function htmlResponse(html, { status = 200 } = {}) {
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}
function jsonResponse(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function redirect(location, extraHeaders = {}, status = 302) {
  return new Response(null, { status, headers: { Location: location, ...extraHeaders } });
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
 * sent: form fields (urlencoded/multipart, what scripted callers and the login
 * proxy send) or a JSON object (what the Next.js app sends). `null` = no body
 * of either kind, or an empty one (all inputs then come from the query string);
 * `{ invalid: true }` = a JSON body that isn't an object. JSON booleans read back as "1"/"0" and
 * arrays as comma lists, so one buildQuery works for every caller.
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
 * ("https://backend") is never actually dialed -- service bindings route
 * in-process inside the same Cloudflare account, so this is just a stable,
 * readable placeholder host.
 */
async function callBackend(env, path, init) {
  return env.BACKEND.fetch(`https://backend${path}`, init);
}

/**
 * Session gate shared by every /api/* read. `__disabled__` means the login
 * isn't configured at all -- distinct from `redirect: "/login"` (configured,
 * but this request has no valid session) so callers can 503 instead of
 * answering as if a login could ever succeed.
 */
async function requireSession(request, config) {
  if (!isDashboardAuthConfigured(config)) return { redirect: "__disabled__" };
  const sessionUsername = await getSessionUsername(request, config);
  if (!sessionUsername) return { redirect: "/login" };
  return { sessionUsername };
}

/** Shared handler shape for every POST trigger route: check the session here (this Worker is the only one that can), then forward to backend, which trusts any caller reaching it (only this Worker can, via the service binding). Always answers JSON -- backend's own ack/error body and status, passed through. */
async function handleTriggerRoute(request, env, config, { backendPath, buildQuery }) {
  const sessionUsername = await getSessionUsername(request, config);
  if (!sessionUsername) {
    if (!isDashboardAuthConfigured(config)) {
      return jsonResponse({ error: `${backendPath} is not configured (set up the dashboard login)` }, { status: 503 });
    }
    return jsonResponse({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const body = await readBody(request);
  if (body?.invalid) return jsonResponse({ error: "request body must be a JSON object or form fields" }, { status: 400 });
  const fromBody = (key) => (body ? body.get(key) : null);

  const built = buildQuery(url.searchParams, fromBody, sessionUsername, body);
  if (built.error) return jsonResponse({ error: built.error }, { status: 400 });

  // Since plan.md Step 3, backend always enqueues and returns an immediate
  // `{accepted, id, ...}` ack -- it never runs the work itself.
  const qs = new URLSearchParams(built.params);

  try {
    const res = await callBackend(env, `${backendPath}?${qs.toString()}`, { method: "POST" });
    return jsonResponse(await res.json(), { status: res.status });
  } catch (err) {
    console.error(`${backendPath} forward failed`, { message: err.message });
    return jsonResponse({ error: `${backendPath} request failed`, message: err.message }, { status: 500 });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const config = loadConfig(env);

    // GET /api/* -- read-only JSON passthrough for the Next.js dashboard. The
    // JSON API lives on the private `backend` Worker, so this forwards over
    // env.BACKEND after the session gate (401 JSON without a session, 503 if
    // login is unconfigured). GET only: every write goes through the POST
    // routes below.
    //
    // GET /backtest/replay/news is the one read that lives outside /api on the
    // backend (the news-replay picker's item list); it gets the same gate.
    if ((pathname.startsWith("/api/") || pathname === "/backtest/replay/news") && request.method === "GET") {
      const auth = await requireSession(request, config);
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

    if (pathname === "/login" && request.method === "GET") {
      if (!isDashboardAuthConfigured(config)) return htmlResponse(renderLoginPage({ disabled: true }), { status: 503 });
      const sessionUsername = await getSessionUsername(request, config);
      if (sessionUsername) return redirect("/");
      const error = url.searchParams.get("error") === "invalid" ? "Invalid username or password." : null;
      return htmlResponse(renderLoginPage({ error }));
    }

    // POST /login -- the Next.js app's /api/login proxies here with form-encoded credentials and reads only the status + Set-Cookie.
    if (pathname === "/login" && request.method === "POST") {
      if (!isDashboardAuthConfigured(config)) return htmlResponse(renderLoginPage({ disabled: true }), { status: 503 });
      const body = await readBody(request);
      const username = String(body?.get?.("username") ?? "");
      const password = String(body?.get?.("password") ?? "");
      if (username !== config.dashboardUsername || password !== config.dashboardPassword) {
        return htmlResponse(renderLoginPage({ error: "Invalid username or password." }), { status: 401 });
      }
      const cookie = await createSessionCookie(username, config);
      return redirect("/", { "Set-Cookie": cookie });
    }

    if (pathname === "/logout") {
      return redirect("/login", { "Set-Cookie": clearSessionCookie() });
    }

    if (pathname === "/backfill" && request.method === "POST") {
      return handleTriggerRoute(request, env, config, {
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

    // Price-bar backfill (plan.md Next Steps step A). Same shape as /backfill, plus an optional ticker list.
    if (pathname === "/backfill-prices" && request.method === "POST") {
      return handleTriggerRoute(request, env, config, {
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
      return handleTriggerRoute(request, env, config, {
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
        return handleTriggerRoute(request, env, config, {
          backendPath: `/backtest/${encodeURIComponent(id)}/${action}`,
          buildQuery: () => ({ params: {} }),
        });
      }
    }

    // POST /backtest/cleanup -- bulk-delete old terminal runs' trade-level data. `olderThanDays` is the only field; backend defaults it (and maxRuns) if omitted.
    if (pathname === "/backtest/cleanup" && request.method === "POST") {
      return handleTriggerRoute(request, env, config, {
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
      return handleTriggerRoute(request, env, config, {
        backendPath: "/backtest/purge",
        buildQuery: () => ({ params: {} }),
      });
    }

    if (pathname === "/backtest/run" && request.method === "POST") {
      return handleTriggerRoute(request, env, config, {
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
      return handleTriggerRoute(request, env, config, {
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
      return handleTriggerRoute(request, env, config, {
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
      return handleTriggerRoute(request, env, config, {
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

    if (pathname === "/") {
      return new Response("news-market-ai dashboard API gateway is running. The UI is the dashboard-next Worker. See plan.md for architecture.", { status: 200 });
    }
    return jsonResponse({ error: "not found" }, { status: 404 });
  },
};
