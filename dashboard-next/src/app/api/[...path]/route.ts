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

import { NextRequest, NextResponse } from "next/server";
import { getBackend } from "@/lib/backend";
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
      { error: "dashboard backend is not configured (set the BACKEND service binding, or BACKEND_URL for local dev)" },
      { status: 503 },
    );
  }

  // The gateway does the session check, validation and forwarding.
  const target = new URL(toGatewayPath(path) + url.search, url.origin);
  const init: RequestInit = { method, headers: request.headers };
  if (method === "POST") init.body = await request.arrayBuffer();
  return handleGateway(new Request(target, init), backend.env);
}
