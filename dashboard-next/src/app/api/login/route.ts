// Dedicated login endpoint.
//
// The browser POSTs `{ username, password }` JSON to /api/login. The gateway
// (src/server/gateway.mjs#login) compares them with the DASHBOARD_USERNAME /
// DASHBOARD_PASSWORD secrets on this Worker and, on success, signs the session
// JWT with JWT_SECRET. The session cookie is set directly on the response:
// the app and its API share one origin, so there is nothing to forward or
// rewrite.
//
// In MOCK mode (no backend configured, local dev only) any credentials are
// accepted (or the ones in .env, if set) and a fake session cookie is issued,
// so the UI flow can be exercised end to end.

import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, DASHBOARD_USERNAME, DASHBOARD_PASSWORD, COOKIE_SECURE } from "@/lib/server-config";
import { getBackend } from "@/lib/backend";
import { login } from "@/server/gateway.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  let body: { username?: string; password?: string } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const username = body.username?.trim() ?? "";
  const password = body.password?.trim() ?? "";

  if (!username || !password) {
    return NextResponse.json({ error: "username and password are required" }, { status: 400 });
  }

  const backend = getBackend();
  if (backend.kind === "unconfigured") {
    return NextResponse.json(
      { error: "dashboard backend is not configured (missing BACKEND service binding)" },
      { status: 503 },
    );
  }

  // === Mock mode (local dev only) ===
  if (backend.kind === "mock") {
    if (DASHBOARD_USERNAME && DASHBOARD_PASSWORD) {
      // If local env has credentials set even in mock mode, validate against them
      if (username !== DASHBOARD_USERNAME || password !== DASHBOARD_PASSWORD) {
        return NextResponse.json({ error: "Invalid username or password." }, { status: 401 });
      }
    }
    const fakeJwt = btoa(JSON.stringify({ sub: username || "mock-user", iat: Date.now(), exp: Date.now() + 86400_000 }));
    const attrs = [
      `${SESSION_COOKIE_NAME}=${fakeJwt}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      "Max-Age=86400",
    ];
    if (COOKIE_SECURE) attrs.push("Secure");
    return NextResponse.json(
      { ok: true, user: { username: username || "mock-user" }, mock: true },
      {
        status: 200,
        headers: { "set-cookie": attrs.join("; ") },
      },
    );
  }

  // === Real mode ===
  const result = await login(backend.env, username, password, { secure: COOKIE_SECURE });
  if (result.status !== 200 || !result.cookie) {
    return NextResponse.json({ error: result.error ?? "login failed" }, { status: result.status });
  }
  return NextResponse.json(
    { ok: true, user: { username } },
    {
      status: 200,
      headers: { "set-cookie": result.cookie },
    },
  );
}
