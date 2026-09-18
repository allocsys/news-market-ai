// Dashboard login session, built on jwt.js's HS256 sign/verify. Single
// concern: turn a username into a session cookie header value, and turn a
// request's Cookie header back into a verified username (or null). No
// user table, no multi-user anything -- config.dashboardUsername/
// dashboardPassword (src/config.js) is exactly one operator credential
// pair, checked in src/index.js's POST /login route; this file only ever
// deals with the SESSION side (the cookie), not the credential check
// itself.
//
// HONEST SCOPE: the session token is a plain signed JWT with no server-
// side revocation list -- logging out (POST /logout) clears the browser's
// cookie but does NOT invalidate the token itself; a copied/stolen token
// stays valid until its own `exp` (config.sessionTtlSeconds after
// issuance). Acceptable for a single-operator internal ops tool with a
// same-day-scale TTL, not a substitute for real session revocation if
// this ever grows multiple users or a longer TTL.
//
// COOKIE ATTRIBUTES: HttpOnly (no client-JS access -- irrelevant to XSS
// exfiltration of this cookie even though this page's one inline script,
// setDateRange in dashboard.js, doesn't touch cookies anyway), Secure
// (HTTPS-only -- true in production on Workers, but means the cookie
// silently won't be set/sent under plain-http local dev via `wrangler
// dev`; a known, accepted trade-off, not a bug if local login appears to
// not "stick"), SameSite=Lax (sent on top-level navigation, e.g. the
// /login form's own POST redirect chain, but not on cross-site requests --
// blocks the common CSRF vector without needing a separate CSRF token,
// though a dedicated CSRF token would still be the stronger fix if this
// ever needs it).

import { signJwt, verifyJwt } from "./jwt.js";

export const SESSION_COOKIE_NAME = "nmai_session";

/** Reads the request's Cookie header into a plain { name: value } map -- malformed pairs (no "=") are skipped, never thrown on. */
function parseCookies(request) {
  const header = request.headers.get("Cookie") || "";
  const cookies = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

/** Builds the Set-Cookie header value for a fresh login -- `username` is the only claim carried (payload.sub), see jwt.js#signJwt for iat/exp. */
export async function createSessionCookie(username, config) {
  const token = await signJwt({ sub: username }, config.jwtSecret, { expiresInSeconds: config.sessionTtlSeconds });
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${config.sessionTtlSeconds}`;
}

/** Builds the Set-Cookie header value that clears the session cookie (POST /logout) -- Max-Age=0 tells the browser to delete it immediately. */
export function clearSessionCookie() {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/**
 * Returns the authenticated username for this request, or null if there's
 * no cookie, the JWT fails verification for any reason (see
 * jwt.js#verifyJwt's own header), or the payload's `sub` claim isn't a
 * string. Never throws -- every caller (src/index.js's /dashboard,
 * /backfill, /backtest/run routes) treats null as "not logged in", not a
 * special error case to handle separately.
 */
export async function getSessionUsername(request, config) {
  const cookies = parseCookies(request);
  const token = cookies[SESSION_COOKIE_NAME];
  if (!token) return null;
  const payload = await verifyJwt(token, config.jwtSecret);
  if (!payload || typeof payload.sub !== "string") return null;
  return payload.sub;
}
