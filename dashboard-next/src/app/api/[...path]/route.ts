// Catch-all BFF proxy.
//
// Every request from the browser hits /api/<something> on the Next.js side.
// This route forwards the request to the real Cloudflare dashboard Worker
// (BACKEND_URL) with the session cookie attached — bypassing the
// SameSite=Lax restriction that would otherwise block cross-site cookies
// from a `space-z.ai` origin to a `*.workers.dev` origin.
//
// When BACKEND_URL is empty (sandbox / preview without a configured
// backend), the route falls back to the mock server so the UI keeps working.

import { NextRequest, NextResponse } from "next/server";
import {
  BACKEND_URL,
  HAS_BACKEND,
  SESSION_COOKIE_NAME,
  DASHBOARD_USERNAME,
  DASHBOARD_PASSWORD,
} from "@/lib/server-config";
import { mockResolve } from "@/lib/mock-server";

// Always run dynamically — never cache. Every request depends on the
// session cookie and the current backend state.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const FORWARD_HEADERS = new Set([
  "content-type",
  "accept",
  // We do NOT forward cookie — we explicitly extract the session cookie
  // and forward it under its expected name.
]);

export async function GET(request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return handle("GET", request, ctx);
}
export async function POST(request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return handle("POST", request, ctx);
}
export async function PUT(request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return handle("PUT", request, ctx);
}
export async function DELETE(request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return handle("DELETE", request, ctx);
}

async function handle(
  method: string,
  request: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
) {
  const { path: pathSegments } = await ctx.params;
  const path = "/" + pathSegments.join("/");
  const url = new URL(request.url);
  const params = url.searchParams;

  // === Mock mode ===
  if (!HAS_BACKEND) {
    let body: Record<string, unknown> | null = null;
    if (method === "POST" || method === "PUT") {
      try {
        const text = await request.text();
        if (text) {
          // Try JSON first, fall back to form-encoded
          try {
            body = JSON.parse(text);
          } catch {
            body = Object.fromEntries(new URLSearchParams(text));
          }
        }
      } catch {
        /* empty body */
      }
    }
    const result = mockResolve(method, path, params, body);
    if (!result) {
      return NextResponse.json({ error: "not found (mock mode)" }, { status: 404 });
    }
    return NextResponse.json(result.body, {
      status: result.status,
      headers: result.headers,
    });
  }

  // === Real backend mode ===
  // Extract the session cookie from the incoming request (same-origin from browser).
  const cookieHeader = request.headers.get("cookie") ?? "";
  const sessionValue = extractCookie(cookieHeader, SESSION_COOKIE_NAME);

  // Map the Next.js-side path to the upstream Cloudflare dashboard Worker path.
  //
  // Next.js catches /api/<...> (this catch-all). On the Worker side, the
  // original routes are:
  //   /api/<...>            — GET JSON endpoints (overview, snapshot, ...)
  //   /backfill             — POST (form forward, 303 on success)
  //   /backfill-prices      — POST
  //   /backtest/run         — POST
  //   /backtest/:id/cancel  — POST
  //   /backtest/cleanup     — POST
  //   /backtest/purge       — POST
  //   /controls/set         — POST
  //   /controls/tickers     — POST
  //
  // The Next.js client always uses /api/<...> (cleaner), and we re-map the
  // non-/api routes back to their original Worker paths here.
  const NON_API_ROUTES = new Set([
    "/backfill",
    "/backfill-prices",
    "/backtest/run",
    "/backtest/cleanup",
    "/backtest/purge",
    "/backtest/replay/run",
    "/controls/set",
    "/controls/tickers",
  ]);
  // Also match /backtest/:id/{cancel,pause,resume}
  const backtestActionMatch = path.match(/^\/backtest\/[^/]+\/(cancel|pause|resume)$/);

  let upstreamPath = path;
  if (NON_API_ROUTES.has(path) || backtestActionMatch) {
    // These were called as /api/<route> on the Next.js side but the Worker
    // exposes them at /<route> (without the /api/ prefix).
    upstreamPath = path;
  } else if (path.startsWith("/")) {
    // Default: the Worker exposes /api/<path> — re-add the prefix.
    upstreamPath = "/api" + path;
  }

  const upstream = new URL(upstreamPath, BACKEND_URL);
  upstream.search = url.search;

  // Build upstream request headers
  const upstreamHeaders = new Headers();
  upstreamHeaders.set("accept", "application/json");
  // Forward content-type for POSTs
  const ct = request.headers.get("content-type");
  if (ct) upstreamHeaders.set("content-type", ct);
  // Attach the session cookie (if any) under its expected name
  if (sessionValue) {
    upstreamHeaders.set("cookie", `${SESSION_COOKIE_NAME}=${sessionValue}`);
  }

  // Body — for form-POSTs (login etc) we forward as-is; for JSON we forward as-is
  let bodyForward: BodyInit | undefined;
  if (method !== "GET" && method !== "HEAD") {
    bodyForward = await request.arrayBuffer();
  }

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstream.toString(), {
      method,
      headers: upstreamHeaders,
      body: bodyForward,
      redirect: "manual", // we want to see 303 redirects, not follow them
    });
  } catch (err) {
    return NextResponse.json(
      { error: `failed to reach backend at ${BACKEND_URL}: ${String(err)}` },
      { status: 502 },
    );
  }

  // Build the downstream response
  const resHeaders = new Headers();
  // Copy through content-type
  const upCt = upstreamRes.headers.get("content-type");
  if (upCt) resHeaders.set("content-type", upCt);

  // Forward Set-Cookie (e.g. the login response sets the session cookie).
  // We re-write the cookie attributes so it lands on the Next.js origin
  // (HttpOnly + SameSite=Lax + Secure when in production).
  const setCookies = upstreamRes.headers.getSetCookie?.() ?? [];
  for (const sc of setCookies) {
    const rewritten = rewriteSetCookie(sc, SESSION_COOKIE_NAME);
    if (rewritten) resHeaders.append("set-cookie", rewritten);
  }

  // Handle 303 redirects — the dashboard Worker returns 303 → /dashboard/overview
  // after a successful POST (form-forward). For an SPA we want to return JSON
  // with the redirect target instead, so the client can decide what to do.
  if (upstreamRes.status >= 300 && upstreamRes.status < 400) {
    const location = upstreamRes.headers.get("location") ?? "";
    return NextResponse.json(
      { accepted: true, redirect: location },
      { status: 200, headers: resHeaders },
    );
  }

  // Pass through 401 — the client will redirect to /login
  if (upstreamRes.status === 401) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: resHeaders });
  }

  // Stream the body through
  const bodyBytes = await upstreamRes.arrayBuffer();
  return new NextResponse(bodyBytes, {
    status: upstreamRes.status,
    headers: resHeaders,
  });
}

function extractCookie(header: string, name: string): string | null {
  const parts = header.split(/;\s*/);
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    const k = p.slice(0, eq).trim();
    if (k === name) return p.slice(eq + 1).trim();
  }
  return null;
}

/**
 * Take a Set-Cookie header from the upstream dashboard Worker and rewrite
 * its Domain/Path/Secure/SameSite so it lands on the Next.js origin.
 *
 * The original cookie is `nmai_session=<jwt>; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`.
 * We strip the Domain attribute (so the cookie is host-only on the Next.js
 * origin) and keep HttpOnly + SameSite=Lax so the browser sends it on
 * same-origin XHR/fetch.
 */
function rewriteSetCookie(sc: string, expectedName: string): string | null {
  // Parse name=value
  const firstSemi = sc.indexOf(";");
  const nv = firstSemi < 0 ? sc : sc.slice(0, firstSemi);
  const eq = nv.indexOf("=");
  if (eq < 0) return null;
  const name = nv.slice(0, eq).trim();
  if (name !== expectedName) return null;
  const value = nv.slice(eq + 1).trim();

  // Re-emit with our own attributes
  const attrs = [
    `${expectedName}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=86400",
  ];
  // In production (https), mark Secure. In dev (http), omit Secure so it lands.
  if (process.env.NODE_ENV === "production") attrs.push("Secure");
  return attrs.join("; ");
}

// Suppress unused-import lint
void DASHBOARD_USERNAME;
void DASHBOARD_PASSWORD;
