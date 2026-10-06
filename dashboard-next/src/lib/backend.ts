// Resolves where the BFF routes send their upstream requests.
//
//   binding      Cloudflare: the DASHBOARD service binding to the existing
//                `news-market-ai-dashboard` Worker (wrangler.jsonc). This is
//                the production path. A plain fetch() to that Worker's
//                workers.dev URL from another Worker in the same account is
//                blocked (error 1042), hence the binding.
//   url          Local dev only: BACKEND_URL points at a reachable dashboard
//                Worker (e.g. `wrangler dev`).
//   mock         Local dev only: canned data from lib/mock-server.ts. Never
//                used in production unless ALLOW_MOCK=1 is set on purpose, so
//                a missing binding can't silently show fake trading data.
//   unconfigured Production with neither of the above: callers return 503.

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { BACKEND_URL } from "./server-config";

interface ServiceBinding {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
}

export type Backend =
  | { kind: "binding" | "url"; fetch: (path: string, init?: RequestInit) => Promise<Response> }
  | { kind: "mock" }
  | { kind: "unconfigured" };

export function getBackend(): Backend {
  try {
    const { env } = getCloudflareContext();
    const binding = (env as unknown as { DASHBOARD?: ServiceBinding }).DASHBOARD;
    if (binding) {
      // The host is a placeholder; service bindings route in-process.
      return { kind: "binding", fetch: (path, init) => binding.fetch(`https://dashboard${path}`, init) };
    }
  } catch {
    // Not running on Workers / no context (plain `next dev`): fall through.
  }

  if (BACKEND_URL) {
    return {
      kind: "url",
      fetch: (path, init) => fetch(new URL(path, BACKEND_URL).toString(), init),
    };
  }

  if (process.env.NODE_ENV !== "production" || process.env.ALLOW_MOCK === "1") {
    return { kind: "mock" };
  }
  return { kind: "unconfigured" };
}
