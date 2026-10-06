// Dashboard login session, built on jwt.mjs. Turns a username into a session
// cookie header value, and a request's Cookie header back into a verified
// username (or null). One operator credential pair, no user table; the
// credential check itself lives in gateway.mjs#login.
//
// Ported from src/auth/session.js (still used by the backend Worker and its
// tests); test/dashboard_gateway_parity.test.js pins the cookie name and the
// token format to that copy.
//
// HONEST SCOPE: the session is a plain signed JWT with no server-side
// revocation. Logging out clears the browser's cookie but does not invalidate
// the token; a copied token stays valid until its own `exp`. Acceptable for a
// single-operator internal tool with a day-scale TTL.
//
// COOKIE ATTRIBUTES: HttpOnly (page scripts can't read it), SameSite=Lax (not
// sent on cross-site requests, which blocks the common CSRF vector), Secure
// (HTTPS only). `secure: false` exists only so `next dev` over plain http can
// keep a session; production always uses the default.

import { signJwt, verifyJwt } from "./jwt.mjs";

export const SESSION_COOKIE_NAME = "nmai_session";

/** Reads the request's Cookie header into a plain { name: value } map. Malformed pairs are skipped, never thrown on. */
function parseCookies(request) {
  const header = request.headers.get("Cookie") || "";
  const cookies = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const raw = part.slice(eq + 1).trim();
    if (!key) continue;
    try {
      cookies[key] = decodeURIComponent(raw);
    } catch {
      cookies[key] = raw;
    }
  }
  return cookies;
}

/** Set-Cookie value for a fresh login. `username` is the only claim (payload.sub); jwt.mjs adds iat/exp. */
export async function createSessionCookie(username, config, { secure = true } = {}) {
  const token = await signJwt({ sub: username }, config.jwtSecret, { expiresInSeconds: config.sessionTtlSeconds });
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly;${secure ? " Secure;" : ""} SameSite=Lax; Max-Age=${config.sessionTtlSeconds}`;
}

/** Set-Cookie value that clears the session cookie (Max-Age=0 tells the browser to delete it). */
export function clearSessionCookie({ secure = true } = {}) {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly;${secure ? " Secure;" : ""} SameSite=Lax; Max-Age=0`;
}

/**
 * The authenticated username for this request, or null when there is no
 * cookie, the JWT fails verification for any reason, or `sub` isn't a string.
 * Never throws.
 */
export async function getSessionUsername(request, config) {
  const token = parseCookies(request)[SESSION_COOKIE_NAME];
  if (!token) return null;
  const payload = await verifyJwt(token, config.jwtSecret);
  if (!payload || typeof payload.sub !== "string") return null;
  return payload.sub;
}
