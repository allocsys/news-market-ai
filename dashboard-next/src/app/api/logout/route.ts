// Logout: clears the session cookie. The session is a signed JWT with no
// server-side state, so there is nothing to call upstream.

import { NextRequest, NextResponse } from "next/server";
import { COOKIE_SECURE } from "@/lib/server-config";
import { clearSessionCookie } from "@/server/session.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(_request: NextRequest) {
  return NextResponse.json(
    { ok: true },
    { status: 200, headers: { "set-cookie": clearSessionCookie({ secure: COOKIE_SECURE }) } },
  );
}
