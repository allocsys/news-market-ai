// Auth status — client polls this on first load to find out if it's logged in.
// Returns `{ authenticated: false }` in mock mode when no session cookie is set,
// `{ authenticated: true, user: { username } }` when the session cookie is present.
//
// In real-backend mode, the proxy at /api/[...path]/route.ts will return 401
// from any /api/* call when the session is invalid; the client uses that to
// trigger the redirect to /login. This endpoint is a lightweight pre-flight
// so we can render the right shell without waiting for a full /api/overview
// round-trip.

import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, HAS_BACKEND } from "@/lib/server-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const cookie = request.headers.get("cookie") ?? "";
  const sessionValue = extractCookie(cookie, SESSION_COOKIE_NAME);

  if (!sessionValue) {
    return NextResponse.json({ authenticated: false, mock: !HAS_BACKEND });
  }

  // Decode the JWT payload (no signature verification — the backend does that
  // on every real request; we just need the username for the UI).
  let username: string | null = null;
  try {
    const parts = sessionValue.split(".");
    if (parts.length === 3) {
      const payload = Buffer.from(parts[1], "base64url").toString("utf-8");
      const parsed = JSON.parse(payload);
      username = parsed.sub ?? null;
    }
  } catch {
    /* malformed cookie — treat as unauthenticated */
    return NextResponse.json({ authenticated: false, mock: !HAS_BACKEND });
  }

  return NextResponse.json({
    authenticated: true,
    user: { username: username ?? "operator" },
    mock: !HAS_BACKEND,
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
