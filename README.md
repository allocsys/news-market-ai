# news-market-ai

News ingestion -> multi-agent LLM analysis -> trade signal pipeline, with
rigorous point-in-time backtesting. Full design and rationale live in
[`plan.md`](./plan.md) -- read that first, this file is just setup.

## Status

Early scaffold. Architecture and shared helpers are in place; ingestion
source adapters and the actual orchestration loop (wiring ingestion -> 
analyst agents -> researcher debate -> trader -> risk) are not yet
implemented. See plan.md's "Open questions / next steps".

## Stack

- Cloudflare Workers (compute) + D1 (structured storage) + KV (LLM cascade
  cooldown state) -- all free tier. See plan.md's Deployment section for the
  exact limits this is designed around.
- Gemini, called through a multi-key model-cascade client
  (`src/llm/gemini/client.js`).

## Directory layout

```
src/
  config.js               # single place that reads env vars
  shared/                 # errors, KV-backed cooldown tracking
  llm/gemini/              # Gemini cascade client
  schemas/                 # shared zod types every agent reads/writes against
  ingestion/
    normalize.js            # "jsonify anything" boundary
    sources/                # one adapter per source (gdelt.js first, stubbed)
  storage/                  # D1 access: run_store.js, inputs_view.js, jobs.js, llm_calls.js, sim_registry.js (see plan.md Repo Structure)
  backtest/pointInTime.js    # leak-check + walk-forward window helpers
  agents/
    analysts/                # quick-tier: news/event, sentiment
    researchers/              # deep-tier: bull, bear, judge
    trader/                   # deep-tier: direction/thesis only
    risk_mgmt/                # deterministic, NOT an LLM -- position sizing
  index.js                  # Worker entry (fetch + scheduled)
migrations/                 # D1 schemas: inputs/, state/ (live + sim), sim/ (backtest_runs)
test/                       # includes the mandatory backtest leak-check test
```

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
