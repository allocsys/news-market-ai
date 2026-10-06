// Server-side configuration. These values NEVER reach the browser (no
// NEXT_PUBLIC_ prefix). Which upstream the routes talk to, and where the login
// secrets come from, is decided in lib/backend.ts.

export { SESSION_COOKIE_NAME } from "../server/session.mjs";

/** Local dev only: base URL of a reachable `backend` Worker (e.g. `wrangler dev` in the repo root). On Cloudflare the BACKEND service binding is used instead. */
export const BACKEND_URL = process.env.BACKEND_URL?.trim() || "";

/** Mock-mode login check only (when no backend is configured). Ignored otherwise: the real login reads the DASHBOARD_USERNAME / DASHBOARD_PASSWORD secrets at request time (lib/backend.ts). */
export const DASHBOARD_USERNAME = process.env.DASHBOARD_USERNAME?.trim() || "";
export const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD?.trim() || "";

/** Production is always https; `next dev` over plain http needs a cookie without Secure to keep a session. */
export const COOKIE_SECURE = process.env.NODE_ENV === "production";
