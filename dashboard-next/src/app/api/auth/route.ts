// Auth status: the client polls this on first load to find out if it's logged in.
// Returns `{ authenticated: false }` when there is no valid session and
// `{ authenticated: true, user: { username } }` when the session cookie verifies.
//
// The cookie's signature and expiry are checked here (gateway.mjs#getSession),
// the same check every /api/* call goes through. Any /api/* call answers 401
// when the session is invalid, and the client uses that to redirect to /login;
// this endpoint is a lightweight pre-flight so the right shell renders without
// waiting for a full /api/overview round trip.
//
// In MOCK mode (local dev, no backend) any session cookie counts as logged in.

import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME } from "@/lib/server-config";
import { getBackend } from "@/lib/backend";
import { getSession } from "@/server/gateway.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const backend = getBackend();

  if (backend.kind === "unconfigured") {
    return NextResponse.json({ authenticated: false, mock: false });
  }

  if (backend.kind === "mock") {
    const sessionValue = extractCookie(request.headers.get("cookie") ?? "", SESSION_COOKIE_NAME);
    if (!sessionValue) return NextResponse.json({ authenticated: false, mock: true });
    let username = "operator";
    try {
      const parsed = JSON.parse(atob(sessionValue));
      if (typeof parsed.sub === "string" && parsed.sub) username = parsed.sub;
    } catch {
      /* not our fake cookie: keep the default name */
    }
    return NextResponse.json({ authenticated: true, user: { username }, mock: true });
  }

  const session = await getSession(request, backend.env);
  if (!session.username) {
    return NextResponse.json({ authenticated: false, mock: false });
  }
  return NextResponse.json({
    authenticated: true,
    user: { username: session.username },
    mock: false,
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
