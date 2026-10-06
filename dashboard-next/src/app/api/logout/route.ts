// Logout — clears the session cookie on the Next.js origin.
// Also forwards a GET to ${BACKEND_URL}/logout so the backend clears its
// own cookie (though the JWT itself is not server-side revoked — it just
// expires naturally; the original dashboard Worker behaves the same way).

import { NextRequest, NextResponse } from "next/server";
import { BACKEND_URL, HAS_BACKEND, SESSION_COOKIE_NAME } from "@/lib/server-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(_request: NextRequest) {
  if (HAS_BACKEND) {
    try {
      await fetch(new URL("/logout", BACKEND_URL).toString(), {
        method: "GET",
        redirect: "manual",
      });
    } catch {
      /* best-effort */
    }
  }
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
