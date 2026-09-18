// Backend no longer renders any dashboard HTML (plan.md "Step 2 -- Dashboard
// Worker" -- that moved to src/dashboard-worker.js, the new `dashboard`
// Worker). All that's left here is checkAuth, still imported by
// src/dashboard/api.js so the /api/* handlers don't duplicate this logic.
//
// Since backend no longer holds DASHBOARD_USERNAME/DASHBOARD_PASSWORD/
// JWT_SECRET (moved to `dashboard`'s own wrangler config), isDashboardAuthConfigured
// is always false here, so checkAuth always returns { sessionUsername: null }
// (never a redirect) -- i.e. it's now a deliberate no-op pass-through. That's
// fine, not a bug: backend has no public route (see wrangler.toml) and is
// only ever reached via `dashboard`'s service binding, which already
// verified the session cookie one hop up before forwarding. Kept as a named
// function (rather than deleted outright) so a future public route to this
// Worker would fail closed by simply configuring these three vars again,
// not by resurrecting deleted logic.

import { getSessionUsername } from "../auth/session.js";

function isDashboardAuthConfigured(config) {
  return Boolean(config.dashboardUsername && config.dashboardPassword && config.jwtSecret);
}

export async function checkAuth(request, config) {
  const sessionUsername = isDashboardAuthConfigured(config) ? await getSessionUsername(request, config) : null;
  if (isDashboardAuthConfigured(config) && !sessionUsername) return { redirect: "/login" };
  return { sessionUsername };
}
