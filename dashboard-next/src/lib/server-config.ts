// Server-side configuration — read once at module load.
// These values NEVER reach the browser (no NEXT_PUBLIC_ prefix).
// Used by src/app/api/[...path]/route.ts to forward to the real backend.

export const BACKEND_URL = process.env.BACKEND_URL?.trim() || "";
export const DASHBOARD_USERNAME = process.env.DASHBOARD_USERNAME?.trim() || "";
export const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD?.trim() || "";
export const SESSION_COOKIE_NAME =
  process.env.NMAI_SESSION_COOKIE?.trim() || "nmai_session";

/** True when a real backend URL is configured. False → MOCK mode. */
export const HAS_BACKEND = BACKEND_URL.length > 0;

/** Sanity check: if BACKEND_URL is set, credentials must be too. */
export function isBackendConfigured(): boolean {
  if (!HAS_BACKEND) return true; // mock mode is always "configured"
  return Boolean(DASHBOARD_USERNAME && DASHBOARD_PASSWORD);
}
