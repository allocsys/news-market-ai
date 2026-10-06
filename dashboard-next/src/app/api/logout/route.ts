// Logout — clears the session cookie on the Next.js origin.
// The session is a signed JWT with no server-side state (the original
// dashboard Worker's /logout only clears the cookie too), so there is
// nothing to call upstream.

import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME } from "@/lib/server-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(_request: NextRequest) {
  const attrs = [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (process.env.NODE_ENV === "production") attrs.push("Secure");
  return NextResponse.json(
    { ok: true },
    { status: 200, headers: { "set-cookie": attrs.join("; ") } },
  );
}
