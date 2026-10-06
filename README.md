# news-market-ai

News ingestion -> multi-agent LLM analysis -> trade signal pipeline, with
rigorous point-in-time backtesting. This file is setup only.

## `dashboard-next/` — the ops dashboard

A mobile-friendly Next.js 16 app that is the `news-market-ai-dashboard`
Cloudflare Worker: the UI, the login and the session-gated API in front of the
private backend, all in one Worker. See
[`dashboard-next/README.md`](./dashboard-next/README.md) for the architecture,
path mapping, auth flow and secrets.

Run locally in MOCK mode (no backend needed):
```bash
cd dashboard-next
npm install
npm run dev
```
Open http://localhost:3000/ and sign in with any credentials.

Switch to a real backend by setting `BACKEND_URL` (a `wrangler dev` of the
backend), `DASHBOARD_USERNAME`, `DASHBOARD_PASSWORD` and `JWT_SECRET` in
`dashboard-next/.env` (see `.env.example`).


## Where things are documented

- [`plan.md`](./plan.md): design, rationale, architecture, repo structure, known gaps and the current to-do list. Start here.
- [`docs/rollout.md`](./docs/rollout.md): the backtest -> paper -> micro-live gates and the knob-tuning rules.
- [`docs/pipeline-diagram.md`](./docs/pipeline-diagram.md): stage and Worker/queue/D1 diagrams (`docs/diagrams/`).

Status: the pipeline is implemented end to end, with a point-in-time
backtester and a dashboard. Live trading is OFF by owner decision.

## Stack

- Cloudflare Workers (compute) + D1 (structured storage) + KV (LLM cascade
  cooldown state), all free tier. plan.md's "Free-plan budgets" lists the
  limits this is designed around.
- Gemini, called through a multi-key model-cascade client
  (`src/llm/gemini/client.js`).

## Local setup

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in GEMINI_API_KEYS
npm run db:migrate:local:all     # inputs + live + sim D1 databases
npm test
npm run dev
```

Deploys run from CI (`.github/workflows/deploy.yml`). The three D1 databases
(`news-market-ai-inputs`, `-live`, `-sim`) have their real ids committed in the
wrangler configs; the KV namespace id is resolved by CI at deploy time. Secrets
are set with `wrangler secret put` -- see the comments at the bottom of each
`wrangler.*.toml`.
