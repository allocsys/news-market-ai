// Catch-all API route.
//
// Every data request from the browser hits /api/<something> on this app. The
// request goes straight into the gateway (src/server/gateway.mjs), which checks
// the session cookie and then talks to the private backend Worker over the
// BACKEND service binding. Same origin throughout, so the browser's own cookie
// is simply read from the request: nothing is re-issued or rewritten.
//
// Login, logout and the auth probe have their own routes (api/login, api/logout,
// api/auth); Next.js prefers those over this catch-all.
//
// When no backend is configured in local dev (see lib/backend.ts), the route
// falls back to the mock server so the UI keeps working.

import { NextRequest, NextResponse } from "next/server";
import { getBackend } from "@/lib/backend";
import { mockResolve } from "@/lib/mock-server";
import { handleGateway, toGatewayPath } from "@/server/gateway.mjs";

// Always run dynamically, never cache: every request depends on the session
// cookie and the current backend state.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(request: NextRequest, ctx: Ctx) {
  return handle("GET", request, ctx);
}
export async function POST(request: NextRequest, ctx: Ctx) {
  return handle("POST", request, ctx);
}

async function handle(method: "GET" | "POST", request: NextRequest, ctx: Ctx) {
  const { path: pathSegments } = await ctx.params;
  const path = "/" + pathSegments.join("/");
  const url = new URL(request.url);

  const backend = getBackend();
  if (backend.kind === "unconfigured") {
    return NextResponse.json(
      { error: "dashboard backend is not configured (missing BACKEND service binding)" },
      { status: 503 },
    );
  }

  // === Mock mode (local dev only, see lib/backend.ts) ===
  if (backend.kind === "mock") {
    let body: Record<string, unknown> | null = null;
    if (method === "POST") {
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
    const result = mockResolve(method, path, url.searchParams, body);
    if (!result) {
      return NextResponse.json({ error: "not found (mock mode)" }, { status: 404 });
    }
    return NextResponse.json(result.body, {
      status: result.status,
      headers: result.headers,
    });
  }

  // === Real backend mode: the gateway does the session check, validation and forwarding ===
  const target = new URL(toGatewayPath(path) + url.search, url.origin);
  const init: RequestInit = { method, headers: request.headers };
  if (method === "POST") init.body = await request.arrayBuffer();
  return handleGateway(new Request(target, init), backend.env);
}
