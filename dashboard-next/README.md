# news-market-ai dashboard — Next.js redesign

Mobile-first UI/UX redesign of the [news-market-ai](https://github.com/allocsys/news-market-ai) ops dashboard, wired to the real Cloudflare backend through a server-side BFF proxy.

## Architecture

```
Browser (space-z.ai)
    │
    │  same-origin, cookies flow naturally
    ▼
Next.js Route Handlers  ← src/app/api/[...path]/route.ts (BFF)
    │
    │  server-to-server fetch, attaches session cookie
    ▼
Cloudflare dashboard Worker  (BACKEND_URL, public)
    │
    │  service binding env.BACKEND
    ▼
Cloudflare backend Worker  (private, no public route)
    │
    ▼
D1 / KV / Gemini
```

The original dashboard Worker uses an `HttpOnly; SameSite=Lax` session cookie. A browser on `space-z.ai` cannot send that cookie to `*.workers.dev` cross-site — so we proxy every `/api/*` call through a Next.js Route Handler that holds the cookie on the Next.js origin and forwards it to the dashboard Worker.

## Modes

### MOCK mode (default, no config)
- `BACKEND_URL` is empty
- All `/api/*` requests are served by `src/lib/mock-server.ts` from `src/lib/mock-data.ts`
- The login page accepts any credentials and sets a fake session cookie
- A "MOCK mode" banner is shown above the dashboard

### Real backend mode
- Set `BACKEND_URL` to your deployed dashboard Worker URL
- Set `DASHBOARD_USERNAME` and `DASHBOARD_PASSWORD` to the credentials from `wrangler.dashboard.toml`
- The BFF forwards every `/api/*` call to `${BACKEND_URL}/api/*` with the session cookie attached
- POSTs that the original Worker expects at `/backfill`, `/backtest/run`, etc. are called from the client as `/api/<route>` and re-mapped by the BFF to the original `/backfill`, `/backtest/run` paths upstream

## Setup

### 1. Configure env

```bash
cp .env.example .env
```

Edit `.env`:

```bash
BACKEND_URL=https://news-market-ai-dashboard.<your-subdomain>.workers.dev
DASHBOARD_USERNAME=operator
DASHBOARD_PASSWORD=<your-password>
```

Leave `BACKEND_URL` empty to keep running in MOCK mode.

### 2. Run

The dev server is already running. Restart after editing `.env`:

```bash
# Inside the project root
touch src/app/api/[...path]/route.ts
```

Or restart the dev server.

### 3. Verify

- Visit `/login` and sign in
- The dashboard should load with real data
- The "MOCK mode" banner should disappear

## Path mapping

| Next.js client calls | BFF forwards upstream |
|---|---|
| `GET /api/overview` | `GET ${BACKEND_URL}/api/overview` |
| `GET /api/decisions?decisionStatus=opened` | `GET ${BACKEND_URL}/api/decisions?decisionStatus=opened` |
| `GET /api/backtest-runs/123` | `GET ${BACKEND_URL}/api/backtest-runs/123` |
| `POST /api/backfill` (JSON) | `POST ${BACKEND_URL}/backfill` (form-encoded, original Worker expects form fields) |
| `POST /api/backtest/run` (JSON) | `POST ${BACKEND_URL}/backtest/run` (form-encoded) |
| `POST /api/backtest/:id/cancel` | `POST ${BACKEND_URL}/backtest/:id/cancel` |
| `POST /api/controls/set` (JSON) | `POST ${BACKEND_URL}/controls/set` (form-encoded) |

**Note on body encoding:** the original dashboard Worker reads form fields (`request.formData()`) on POST routes. The Next.js client sends JSON (cleaner). The BFF currently forwards the JSON body as-is. If you need form-encoding for those POSTs, you'll need to convert the JSON body to `URLSearchParams` before forwarding — see the `TODO` comments in `src/app/api/[...path]/route.ts`.

## Auth flow

1. Browser POSTs `{username, password}` (JSON) to `/api/login` (Next.js route)
2. BFF forwards as `application/x-www-form-urlencoded` to `${BACKEND_URL}/login`
3. Dashboard Worker verifies, returns `303` with `Set-Cookie: nmai_session=<jwt>; HttpOnly; Secure; SameSite=Lax`
4. BFF captures the Set-Cookie, rewrites the cookie attributes to land on the Next.js origin (drops `Domain`, keeps `HttpOnly` + `SameSite=Lax`)
5. Browser stores cookie on Next.js origin
6. Subsequent `/api/*` requests carry the cookie (same-origin)
7. BFF extracts the cookie and forwards it to the upstream Worker

## Files

- `src/app/api/[...path]/route.ts` — BFF catch-all proxy (mock fallback + real forwarding)
- `src/app/api/login/route.ts` — login handler (forwards to `${BACKEND_URL}/login`, captures Set-Cookie)
- `src/app/api/logout/route.ts` — logout handler (clears cookie)
- `src/app/api/auth/route.ts` — auth status check
- `src/lib/server-config.ts` — server-side env reads
- `src/lib/api.ts` — typed API client + TanStack Query hooks
- `src/lib/mock-server.ts` — mock data per endpoint
- `src/lib/mock-data.ts` — mock dataset (realistic shapes)
- `src/components/auth-provider.tsx` — client auth context
- `src/components/query-provider.tsx` — TanStack Query client
- `src/app/login/page.tsx` — login form
- `src/app/page.tsx` — main dashboard (auth gate + view router)

## What's not wired (yet)

- **Form-encoded POSTs** — the original Worker expects form fields on POST routes (`/backfill`, `/backtest/run`, etc.). The current BFF forwards JSON bodies as-is. If your Worker rejects JSON, you'll need to convert in the BFF (one-line change per route, see TODO in route.ts).
- **303 redirect handling** — the original Worker returns 303 → `/dashboard/overview` on POST success. The BFF captures this and returns JSON `{ accepted: true, redirect: "/dashboard/overview" }` so the SPA can decide what to do.
- **Per-ticker detail page** — the search palette currently navigates to `/llm?llmTicker=<T>`. A dedicated ticker detail view would be a new surface.
- **WebSocket auto-refresh** — TanStack Query polls every 30s by default. For real-time updates, you could swap to WebSocket.
