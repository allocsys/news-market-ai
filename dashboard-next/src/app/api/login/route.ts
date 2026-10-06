// Dedicated login endpoint.
//
// The browser POSTs `{ username, password }` JSON to /api/login.
// This route forwards the form fields to ${BACKEND_URL}/login (the original
// dashboard Worker expects URL-encoded form fields and returns a 303 with
// a Set-Cookie on success).
//
// We capture the Set-Cookie, rewrite it to the Next.js origin, and return
// `{ ok: true }` to the browser. Subsequent /api/* calls will carry the
// session cookie automatically (same-origin).
//
// In MOCK mode (no BACKEND_URL) we accept any credentials and return ok=true
// with a fake session cookie so the UI flow can be exercised end-to-end.

import { NextRequest, NextResponse } from "next/server";
import {
  BACKEND_URL,
  HAS_BACKEND,
  SESSION_COOKIE_NAME,
  DASHBOARD_USERNAME,
  DASHBOARD_PASSWORD,
} from "@/lib/server-config";

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

  // === Mock mode ===
  if (!HAS_BACKEND) {
    if (DASHBOARD_USERNAME && DASHBOARD_PASSWORD) {
      // If local env has credentials set even in mock mode, validate against them
      if (username !== DASHBOARD_USERNAME || password !== DASHBOARD_PASSWORD) {
        return NextResponse.json({ error: "Invalid username or password." }, { status: 401 });
      }
    }
    // Mock mode: accept anything (or whatever matches env if set), set a fake cookie
    const fakeJwt = btoa(JSON.stringify({ sub: username || "mock-user", iat: Date.now(), exp: Date.now() + 86400_000 }));
    const attrs = [
      `${SESSION_COOKIE_NAME}=${fakeJwt}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      "Max-Age=86400",
    ];
    if (process.env.NODE_ENV === "production") attrs.push("Secure");
    return NextResponse.json(
      { ok: true, user: { username: username || "mock-user" }, mock: true },
      {
        status: 200,
        headers: { "set-cookie": attrs.join("; ") },
      },
    );
  }

  // === Real backend mode ===
  // Forward as form-encoded to ${BACKEND_URL}/login
  const form = new URLSearchParams();
  form.set("username", username);
  form.set("password", password);

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(new URL("/login", BACKEND_URL).toString(), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: form.toString(),
      redirect: "manual", // capture the 303 + Set-Cookie
    });
  } catch (err) {
    return NextResponse.json(
      { error: `failed to reach backend at ${BACKEND_URL}: ${String(err)}` },
      { status: 502 },
    );
  }

  // The dashboard Worker returns:
  //   - 401 on bad credentials (re-renders the login page with an error)
  //   - 303 → /dashboard/overview with Set-Cookie on success
  //   - 503 when auth is not configured on the Worker
  if (upstreamRes.status === 401) {
    return NextResponse.json({ error: "Invalid username or password." }, { status: 401 });
  }
  if (upstreamRes.status === 503) {
    return NextResponse.json(
      { error: "Dashboard auth is not configured on the backend Worker (503)." },
      { status: 503 },
    );
  }

  // Look for the Set-Cookie on a 303 (or any 2xx/3xx)
  const setCookies = upstreamRes.headers.getSetCookie?.() ?? [];
  const sessionCookie = setCookies.find((sc) => sc.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (!sessionCookie) {
    return NextResponse.json(
      { error: "backend did not set a session cookie" },
      { status: 502 },
    );
  }

  const rewritten = rewriteSetCookie(sessionCookie, SESSION_COOKIE_NAME);
  if (!rewritten) {
    return NextResponse.json(
      { error: "failed to parse session cookie from backend" },
      { status: 502 },
    );
  }

  return NextResponse.json(
    { ok: true, user: { username } },
    {
      status: 200,
      headers: { "set-cookie": rewritten },
    },
  );
}

function rewriteSetCookie(sc: string, expectedName: string): string | null {
  const firstSemi = sc.indexOf(";");
  const nv = firstSemi < 0 ? sc : sc.slice(0, firstSemi);
  const eq = nv.indexOf("=");
  if (eq < 0) return null;
  const name = nv.slice(0, eq).trim();
  if (name !== expectedName) return null;
  const value = nv.slice(eq + 1).trim();

  const attrs = [
    `${expectedName}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=86400",
  ];
  if (process.env.NODE_ENV === "production") attrs.push("Secure");
  return attrs.join("; ");
}
