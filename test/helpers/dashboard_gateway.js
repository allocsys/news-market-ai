// Shared harness for the dashboard gateway tests (dashboard-next/src/server/
// gateway.mjs, which replaced the old src/dashboard-worker.js Worker).
//
// `worker.fetch(request, env)` is handleGateway under the name the pre-collapse
// tests used, so a request reads the same as it did against the old Worker.
// Login no longer has an HTTP route inside the gateway (the Next.js
// /api/login route calls login()), so sessionCookieFor() logs in directly.

import assert from "node:assert/strict";
import { handleGateway, login } from "../../dashboard-next/src/server/gateway.mjs";

export const worker = { fetch: handleGateway };

export const ADMIN_USERNAME = "admin";
export const ADMIN_PASSWORD = "correct-horse-battery-staple";

/** An env with the login configured (plus whatever else, e.g. a BACKEND binding). */
export function loginConfigured(overrides = {}) {
  return {
    DASHBOARD_USERNAME: ADMIN_USERNAME,
    DASHBOARD_PASSWORD: ADMIN_PASSWORD,
    JWT_SECRET: "test-jwt-signing-key",
    ...overrides,
  };
}

/** Logs in as the operator and returns the session cookie's own name=value pair, ready to replay as a request Cookie header. */
export async function sessionCookieFor(env) {
  const result = await login(env, ADMIN_USERNAME, ADMIN_PASSWORD);
  assert.equal(result.status, 200, "test login should succeed");
  return result.cookie.split(";")[0];
}
