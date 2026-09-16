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
  (`src/llm/gemini/client.js`), ported from our `madmcp` repo.

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
  storage/d1.js             # ALL point-in-time-safe reads/writes go through here
  backtest/pointInTime.js    # leak-check + walk-forward window helpers
  agents/
    analysts/                # quick-tier: news/event, sentiment
    researchers/              # deep-tier: bull, bear, judge
    trader/                   # deep-tier: direction/thesis only
    risk_mgmt/                # deterministic, NOT an LLM -- position sizing
  index.js                  # Worker entry (fetch + scheduled)
migrations/0001_init.sql    # D1 schema
test/                       # includes the mandatory backtest leak-check test
```

## Local setup

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in GEMINI_API_KEYS
npm run db:migrate:local
npm test
npm run dev
```

Before deploying: create the real D1 database and KV namespace in the
Cloudflare dashboard (or via `wrangler d1 create` / `wrangler kv namespace
create`), then replace the placeholder ids in `wrangler.toml`, and
`wrangler secret put GEMINI_API_KEYS`.
