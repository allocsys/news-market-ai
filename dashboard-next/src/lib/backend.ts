// Resolves where the API routes send their upstream requests, and which
// settings the in-process gateway (server/gateway.mjs) runs with.
//
//   binding      Cloudflare: the BACKEND service binding to the private
//                `news-market-ai` Worker (wrangler.jsonc). This is the
//                production path. A plain fetch() to that Worker's workers.dev
//                URL from another Worker in the same account is blocked (error
//                1042), hence the binding.
//   url          Local dev only: BACKEND_URL points at a reachable `backend`
//                Worker (e.g. `wrangler dev` in the repo root). Login secrets
//                then come from dashboard-next/.env.
//   mock         Local dev only: canned data from lib/mock-server.ts. Never
//                used in production unless ALLOW_MOCK=1 is set on purpose, so
//                a missing binding can't silently show fake trading data.
//   unconfigured Production with neither of the above: callers return 503.

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { BACKEND_URL } from "./server-config";

/** What server/gateway.mjs reads from its env: the backend binding plus the login secrets. */
export interface GatewayEnv {
  BACKEND: { fetch: (input: string, init?: RequestInit) => Promise<Response> };
  DASHBOARD_USERNAME?: string;
  DASHBOARD_PASSWORD?: string;
  JWT_SECRET?: string;
  SESSION_TTL_SECONDS?: string;
}

export type Backend =
  | { kind: "binding" | "url"; env: GatewayEnv }
  | { kind: "mock" }
  | { kind: "unconfigured" };

/** A Worker secret/var if set, else the process env (local `next dev`). Read per request, never at module load: Worker secrets aren't available while the module is evaluated. */
function setting(cf: Record<string, unknown> | undefined, name: string): string | undefined {
  const fromWorker = cf?.[name];
  if (typeof fromWorker === "string" && fromWorker !== "") return fromWorker;
  const fromProcess = process.env[name];
  return fromProcess ? fromProcess : undefined;
}

function authSettings(cf: Record<string, unknown> | undefined) {
  return {
    DASHBOARD_USERNAME: setting(cf, "DASHBOARD_USERNAME"),
    DASHBOARD_PASSWORD: setting(cf, "DASHBOARD_PASSWORD"),
    JWT_SECRET: setting(cf, "JWT_SECRET"),
    SESSION_TTL_SECONDS: setting(cf, "SESSION_TTL_SECONDS"),
  };
}

export function getBackend(): Backend {
  let cf: Record<string, unknown> | undefined;
  try {
    cf = getCloudflareContext().env as unknown as Record<string, unknown>;
  } catch {
    // Not running on Workers / no context (plain `next dev`): fall through.
  }

  const binding = cf?.BACKEND as GatewayEnv["BACKEND"] | undefined;
  if (binding && typeof binding.fetch === "function") {
    return { kind: "binding", env: { BACKEND: binding, ...authSettings(cf) } };
  }

  if (BACKEND_URL) {
    return {
      kind: "url",
      env: {
        // The gateway addresses backend as https://backend/<path>; only the path and query matter here.
        BACKEND: {
          fetch: (input, init) => {
            const requested = new URL(input);
            return fetch(new URL(requested.pathname + requested.search, BACKEND_URL).toString(), init);
          },
        },
        ...authSettings(cf),
      },
    };
  }

  if (process.env.NODE_ENV !== "production" || process.env.ALLOW_MOCK === "1") {
    return { kind: "mock" };
  }
  return { kind: "unconfigured" };
}
