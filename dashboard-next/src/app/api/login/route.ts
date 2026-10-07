// Dedicated login endpoint.
//
// The browser POSTs `{ username, password }` JSON to /api/login. The gateway
// (src/server/gateway.mjs#login) compares them with the DASHBOARD_USERNAME /
// DASHBOARD_PASSWORD secrets on this Worker and, on success, signs the session
// JWT with JWT_SECRET. The session cookie is set directly on the response:
// the app and its API share one origin, so there is nothing to forward or
// rewrite.

import { NextRequest, NextResponse } from "next/server";
import { COOKIE_SECURE } from "@/lib/server-config";
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
      { error: "dashboard backend is not configured (set the BACKEND service binding, or BACKEND_URL for local dev)" },
      { status: 503 },
    );
  }

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
