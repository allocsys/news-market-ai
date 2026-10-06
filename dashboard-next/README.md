# dashboard-next

Mobile-first Next.js 16 ops dashboard for news-market-ai. It is ONE Cloudflare
Worker, `news-market-ai-dashboard` (built with `@opennextjs/cloudflare`): the
UI, the login, the session cookie and the session-gated API in front of the
private backend all run in it. It replaced both the server-rendered dashboard
and the separate gateway Worker (`src/dashboard-worker.js`) that used to hold
this name.

## Architecture

```
browser ──► news-market-ai-dashboard (this app, one Cloudflare Worker)
              │  src/app/api/*  routes call the gateway in-process
              │  src/server/gateway.mjs: login, session gate, validation
              │  service binding BACKEND
              ▼
            news-market-ai (private backend Worker: JSON API, D1, queues)
```

- The browser only ever talks to this app, same origin. A plain fetch from one
  Worker to another in the same account's workers.dev URL is blocked, hence the
  `BACKEND` service binding (`wrangler.jsonc`).
- **Reads:** `GET /api/<x>` → session check → `GET /api/<x>` on the backend. 401
  JSON when there is no valid session, 503 when the login isn't configured.
- **Writes:** the POST trigger routes (`/backfill`, `/backfill-prices`,
  `/backtest/run`, `/backtest/:id/{cancel,pause,resume}`, `/backtest/cleanup`,
  `/backtest/purge`, `/backtest/replay/run`, `/controls/set`,
  `/controls/tickers`). The catch-all `src/app/api/[...path]/route.ts` maps the
  browser's `/api/<route>` to the gateway path (`toGatewayPath`), then
  `handleGateway` checks the session, validates the body (JSON or form fields),
  and forwards to the backend, passing its status and JSON body back.
- **Auth:** `/api/login` calls `login()` in `src/server/gateway.mjs`, which
  compares the credentials with the Worker secrets and signs a session JWT
  (HS256, `JWT_SECRET`); the cookie `nmai_session` (HttpOnly, SameSite=Lax,
  Secure in production) is set directly on the response. `/api/auth` verifies
  it for the UI's pre-flight; `/api/logout` clears it. There is no server-side
  revocation: a copied token stays valid until it expires (24 h by default).
- `src/server/{gateway,session,jwt}.mjs` are plain `.mjs` with no imports from
  outside their folder, so the root `node --test` suite imports them as they are
  (`test/dashboard_gateway*.test.js`). They keep copies of `src/auth/*` and two
  backend constants; `test/dashboard_gateway_parity.test.js` fails if those drift.

Upstream selection lives in `src/lib/backend.ts`:

| Mode | When | Behaviour |
| --- | --- | --- |
| binding | `BACKEND` service binding present (Cloudflare) | production path |
| url | `BACKEND_URL` set | local dev against a reachable `backend` Worker (`wrangler dev` in the repo root); login secrets from `.env` |
| mock | dev, no binding/URL (or `ALLOW_MOCK=1`) | canned data, any login works |
| unconfigured | production, none of the above | API routes answer 503 |

Mock data is never used in production unless `ALLOW_MOCK=1` is set on purpose.

## Secrets

Set on the Worker by `deploy.yml`'s `deploy-dashboard` job (from repo secrets of
the same name) after each deploy:

- `DASHBOARD_USERNAME`, `DASHBOARD_PASSWORD`, `JWT_SECRET`: all three must be
  set together, or the login answers 503 and every `/api/*` call is refused.
- `SESSION_TTL_SECONDS`: optional, default 86400.

They are read from the Worker env at request time, never at module load.

## Develop

```bash
cd dashboard-next
npm install
npm run dev          # mock mode, http://localhost:3000
npm run lint
npm run typecheck
npm run preview      # OpenNext build + local workerd preview
```

The gateway tests run from the repo root: `node --test test/dashboard_gateway*.test.js`.

## Deploy

CI (`.github/workflows/dashboard-next.yml`) lints, type-checks and builds the
Worker bundle on every PR touching this folder. On push to `main`, the
`deploy-dashboard` job in `.github/workflows/deploy.yml` (the 8th job: after
the backend `deploy` job, gated by the `dashboard` filter in
`.github/path-filters.yml`, so only `dashboard-next/**` changes redeploy it) runs
`npm run deploy` (`opennextjs-cloudflare build && deploy`) using the repo's
`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` secrets, then sets the login
secrets above. The gateway tests run in the root `test` job that every deploy
job waits on. It is the only job that deploys this Worker.

No lockfile is committed yet, so installs use `npm install`.
