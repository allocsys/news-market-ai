# dashboard-next

Mobile-first Next.js 16 redesign of the news-market-ai ops dashboard. Runs as
its own Cloudflare Worker (`news-market-ai-dashboard-next`, built with
`@opennextjs/cloudflare`) and replaces the server-rendered dashboard UI.

## Architecture

```
browser ──► news-market-ai-dashboard-next (this app, Cloudflare Worker)
              │  /api/* BFF routes (src/app/api)
              │  service binding DASHBOARD
              ▼
            news-market-ai-dashboard (existing Worker: login, session JWT)
              │  GET /api/*  (session-gated passthrough, src/dashboard-worker.js)
              │  service binding BACKEND
              ▼
            news-market-ai (private backend Worker: JSON API, D1, queues)
```

- The browser only ever talks to this app, same-origin. Its `/api/*` routes
  forward to the existing dashboard Worker over the `DASHBOARD` service
  binding (`wrangler.jsonc`). A plain fetch to that Worker's workers.dev URL
  from another Worker in the same account is blocked, hence the binding.
- **Reads:** `GET /api/<x>` here → `GET /api/<x>` on the dashboard Worker →
  backend. The dashboard Worker checks the session cookie first (401 JSON if
  missing/invalid).
- **Writes:** the same POST routes the old UI used (`/backfill`,
  `/backfill-prices`, `/backtest/run`, `/backtest/:id/{cancel,pause,resume}`,
  `/backtest/cleanup`, `/backtest/purge`, `/backtest/replay/run`,
  `/controls/set`, `/controls/tickers`). The proxy maps client `/api/<route>`
  back to those Worker paths; 3xx responses are returned as JSON
  `{ accepted, redirect }`.
- **Auth:** `/api/login` forwards the credentials (form-encoded) to the
  dashboard Worker's `POST /login`, takes the `nmai_session` cookie from the
  response and re-issues it on this origin (HttpOnly, SameSite=Lax, Secure in
  production). This app never holds the username/password/JWT secret.

Upstream selection lives in `src/lib/backend.ts`:

| Mode | When | Behaviour |
| --- | --- | --- |
| binding | `DASHBOARD` service binding present (Cloudflare) | production path |
| url | `BACKEND_URL` set | local dev against a reachable dashboard Worker |
| mock | dev, no binding/URL (or `ALLOW_MOCK=1`) | canned data, any login works |
| unconfigured | production, none of the above | API routes answer 503 |

Mock data is never used in production unless `ALLOW_MOCK=1` is set on purpose.

## Develop

```bash
cd dashboard-next
npm install
npm run dev          # mock mode, http://localhost:3000
npm run lint
npm run typecheck
npm run preview      # OpenNext build + local workerd preview
```

## Deploy

CI (`.github/workflows/dashboard-next.yml`) lints, type-checks and builds the
Worker bundle on every PR touching this folder. On push to `main`,
`.github/workflows/deploy-dashboard-next.yml` runs `npm run deploy`
(`opennextjs-cloudflare build && deploy`) using the repo's
`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` secrets. No other secrets
are needed here.

No lockfile is committed yet, so installs use `npm install`.
