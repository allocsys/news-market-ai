// Server-side configuration — read once at module load.
// These values NEVER reach the browser (no NEXT_PUBLIC_ prefix).
// Which upstream the routes talk to is decided in lib/backend.ts.

/** Local dev only: base URL of a reachable dashboard Worker. On Cloudflare the DASHBOARD service binding is used instead. */
export const BACKEND_URL = process.env.BACKEND_URL?.trim() || "";

/** Mock-mode login check only (when no backend is configured). Ignored otherwise: the real Worker owns the credentials. */
export const DASHBOARD_USERNAME = process.env.DASHBOARD_USERNAME?.trim() || "";
export const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD?.trim() || "";

export const SESSION_COOKIE_NAME =
  process.env.NMAI_SESSION_COOKIE?.trim() || "nmai_session";
