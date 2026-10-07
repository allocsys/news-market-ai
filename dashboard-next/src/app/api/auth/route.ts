// Auth status: the client polls this on first load to find out if it's logged in.
// Returns `{ authenticated: false }` when there is no valid session and
// `{ authenticated: true, user: { username } }` when the session cookie verifies.
//
// The cookie's signature and expiry are checked here (gateway.mjs#getSession),
// the same check every /api/* call goes through. Any /api/* call answers 401
// when the session is invalid, and the client uses that to redirect to /login;
// this endpoint is a lightweight pre-flight so the right shell renders without
// waiting for a full /api/overview round trip.

import { NextRequest, NextResponse } from "next/server";
import { getBackend } from "@/lib/backend";
import { getSession } from "@/server/gateway.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const backend = getBackend();

  if (backend.kind === "unconfigured") {
    return NextResponse.json({ authenticated: false });
  }

  const session = await getSession(request, backend.env);
  if (!session.username) {
    return NextResponse.json({ authenticated: false });
  }
  return NextResponse.json({
    authenticated: true,
    user: { username: session.username },
  });
}
