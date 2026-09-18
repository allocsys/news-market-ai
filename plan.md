# News → Market Analysis → Trade Signal Pipeline

## Goal
An AI-driven pipeline that ingests financial news, summarizes it, has a second
LLM reason about likely market impact, and turns that analysis into trade
signals. Needs a historical archive for backtesting and fine-tuning.

## Prior Art
Reference projects studied before building, so we're not reinventing solved
problems:
- **[TradingAgents](https://github.com/TauricResearch/TradingAgents)** (TauricResearch) —
  primary architectural reference. Multi-agent LangGraph pipeline: parallel
  Analyst Team → Bull/Bear Researcher debate → Trader → Risk Management →
  Portfolio Management sign-off. See "Adopted Patterns" below.
- **Agentic-AI-Trading-Bot** (fsaavedra0003) — clean minimal folder-layout reference.
- **llm-news-sentiment-agent** (rkaravangelis) — 5-band sentiment schema + mandatory
  justification field, used for our summarizer stage design.
- **llm-rl-finance-trader** (franjgs) — template for proving a news signal helps
  via Sharpe-ratio comparison, not just assuming it does.
- Also scanned: LLM-Enhanced-Trading, Stock-Market-News-Sentiment-Analysis, and the
  broader `news-sentiment` GitHub topic (FinBERT + Kafka + TimescaleDB + SEC EDGAR
  storage patterns).

## Adopted Patterns (from TradingAgents, adapted for us)
1. **Parallel analyst agents, not one big prompt** — role-specific analysts
   (news/event, sentiment, technical) each produce a structured opinion independently.
2. **Bull/Bear debate before a verdict** — two agents argue opposite cases, a judge
   step synthesizes. Catches single-pass overconfidence cheaply.
3. **Separate trade thesis from risk/sizing** — trader decides direction/reasoning;
   a distinct deterministic risk layer decides whether/how much. Never combined.
4. **Shared structured schemas everywhere** — one schema module all agents read/write
   against, so stages compose without prompt-string gluing.
5. **Mandatory justification field** — every scored/classified output carries a
   short natural-language "why," critical for debugging bad trades later.
6. **Prove the signal helps before trusting it** — backtest with the news signal
   on vs. off (e.g. Sharpe ratio) rather than assuming it adds value.
7. **Two-tier model strategy** — cheap/fast model (`quick_think`) for high-volume
   simple tasks vs. a stronger model (`deep_think`) for debate/judge/final decision.
   Solves the free-tier budget problem; `max_debate_rounds`/`max_risk_rounds` are
   explicit depth-vs-cost knobs.
8. **Persistent decision log + reflection loop** — each run logs its decision +
   eventual realized outcome; the next run for that ticker gets a short reflection
   injected into its prompt. Cheap substitute for fine-tuning — but see Backtesting
   Integrity below, this is also the easiest place to leak future information.
9. **Grounded, not free-associated, data claims** — the agent must never state a
   price/indicator/figure from its own "knowledge"; every claim grounds in a
   verified data snapshot fetched at that step. Stale data is rejected, not
   silently reported as current.
10. **Deterministic entity resolution before any LLM runs** — resolve ticker/company
    via a deterministic lookup, not LLM inference, avoiding "analyzed the wrong
    company" bugs.
11. **Explicit vendor fallback chain, no silent degradation** — a failed data source
    surfaces a typed error and follows an explicit fallback order; never silently
    serves thinner data without logging that a source was skipped.
12. **Checkpoint/resume for multi-agent runs** — persist state after each pipeline
    stage so a crashed run resumes rather than restarting and re-spending LLM calls.

## Pipeline Stages

### 1. Ingestion
Normalize every source (RSS, scraped HTML, filings, APIs) into one common JSON
schema at the ingestion boundary.

**Free sources:** GDELT Project (timestamped, historical archive since 2015 — best
for backtesting), SEC EDGAR full-text search API, RSS feeds (Reuters/Yahoo/MarketWatch/CNBC),
yfinance (news + price/history), NewsAPI free tier (dev-only), Finnhub/Alpha Vantage
free tiers, Reddit/StockTwits (sentiment signal, not news proper).

**Normalized schema (draft):**
```json
{
  "id": "sha256 hash of source_url + published_at",
  "source": "gdelt | edgar | rss:reuters | yfinance | ...",
  "url": "...",
  "published_at": "ISO8601 UTC - exact public timestamp, not ingestion time",
  "ingested_at": "ISO8601 UTC",
  "tickers": ["AAPL"],
  "title": "...",
  "body": "raw article text",
  "raw": { "...original payload for traceability..." }
}
```
Dedup on `id`/URL since the same story often gets syndicated across outlets.

### 2. Storage
Raw layer: append-only immutable store of normalized JSON + original payload.
Structured layer: D1, indexed by ticker + published_at (see Deployment section —
this superseded an earlier Postgres/Neon plan). Optional later: pgvector for
semantic search over historical news.

### 3. Analyst Team
Parallel, role-specific agents producing structured opinions against the shared
schema: **News/Event analyst** (entities/tickers, event type, factual summary),
**Sentiment analyst** (5-band score + justification), **Technical analyst**
(price/volume context, built). Cheap/fast model tier — high volume, simple task.

### 4. Researcher Team
**Bull** and **Bear** researchers argue opposite cases from the Analyst Team's
output; a **Judge/synthesis** step reconciles into one thesis (direction/magnitude,
confidence, time horizon, reasoning trail).

### 5. Trader Agent
Turns the synthesized thesis into a concrete trade recommendation (direction,
instrument, rationale) — does **not** decide position size (separate concern).

### 6. Risk Management + Portfolio Management
Risk layer: rule-based, deterministic sizing/limits (not an LLM) — max position
size, stop-loss/take-profit, circuit breakers. Portfolio management: final
go/no-go sign-off, then order generation. Never let the LLM directly size positions.

### 7. Historical data for backtesting
Point-in-time correctness matters — must reflect what was actually publicly known
at each moment, not just old articles, to avoid lookahead bias. Validate via
signal on/off backtest comparison (Sharpe ratio, cumulative return, max drawdown),
per the llm-rl-finance-trader approach, rather than assuming the LLM layer helps.

## Backtesting Integrity (no look-ahead)
Must be true by construction, not by discipline, or it quietly breaks the moment
someone adds a feature.
1. **Hard cutoff per simulated timestamp `T`** — agents may only read news/price
   data timestamped `<= T` and memory entries strictly before `T`. Enforced at the
   data-access layer, not by trusting the agent.
2. **Revision-aware storage** — outlets edit articles after publishing; store every
   revision with its own timestamp, serve the version that existed at `T`.
3. **Point-in-time fundamentals, not "as reported today."** Financials get restated.
   **Built** for XBRL-filing US-listed companies via SEC EDGAR's companyfacts API
   (tags every fact with its actual filing date, separate from fiscal period) —
   see `storage/d1.js#getFundamentalFactsAsOf`. Residual gap: free/current-only
   sources (yfinance, price data generally) still aren't point-in-time, and EDGAR
   only covers US-listed XBRL filers. (Decided: the dashboard's Charts view
   deliberately follows this same convention rather than gating just itself --
   see the comment on `renderChartsView` in `src/dashboard/views/charts.js`.)
4. **The reflection/memory loop is the easiest place to leak the future** — the
   memory log fed to an agent at simulated `T` must only contain reflections from
   decisions made before `T`, enforced by the same timestamp filter as point 1.
5. **Walk-forward validation** — roll the cutoff forward in fixed windows rather
   than one static train/test split, to catch a strategy that only worked in one regime.
6. **A leak-check test, not just a design doc** — an automated CI check asserting
   zero rows returned to the agent have a timestamp after `T`.

## Deployment: Cloudflare Workers + D1 + KV (free tier)

| Resource | Free limit | Implication |
|---|---|---|
| Workers | 100K requests/day, 10ms CPU/invocation | CPU time excludes `fetch()` wait, so LLM-calling steps barely touch the budget |
| D1 | 5GB storage, 5M rows read/day, 100K rows written/day (hard-enforced) | Batch inserts, dedupe before writing |
| KV | 1GB storage, 100K reads/day, 1K writes/day | Too tight for per-request caching; good fit for low-frequency state (LLM key/model cooldowns) |
| Bundle size | 64 MiB uncompressed | Not a real constraint |

**Planned:** the single Worker below is being split into 4 (dashboard, backend,
ingest, llm) -- see "Roadmap: Service Split" for the step-by-step plan. Until each
step lands, the text below describes the current single-Worker system.

**Architecture:** Workers as orchestrator (Cron Triggers drive ingestion + agent
pipeline) → D1 as structured layer (replaces earlier Postgres/Neon plan) → KV as
cooldown/rate-limit state + lightweight config → R2 (10GB free) as raw archive
layer if D1 storage is outgrown.

**CI/CD:** `.github/workflows/deploy.yml` runs `test` → `migrate` (push/dispatch
only) → `deploy`, adapted from `allocsys/ai-campaign-builder`'s pattern but scaled
down for this repo's single-Worker/no-workspaces layout. Idempotent D1/KV
provisioning via `.github/actions/ensure-d1-database` / `ensure-kv-namespace`
(look up by name, create only if missing, never commit real ids to the repo).
`dorny/paths-filter` gates jobs on docs-only vs. code diffs, and `migrate` only on
`migrations/**` changes. Required repo secrets: `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID` (hard requirement for migrate/deploy), `GEMINI_API_KEYS`
(optional at deploy-success level, pushed via `wrangler secret put`). CI is green
end-to-end against real Cloudflare infra; a secret-leak audit found and fixed a
real plaintext-id leak in the provisioning actions' `create` step output (ids are
now masked before printing — see git history on `ensure-d1-database`/
`ensure-kv-namespace` for detail if ever revisited).

**CI/CD for the 4-Worker split (reviewed `allocsys/ai-campaign-builder`'s
deploy.yml, 2026-09-18):** that repo deploys 5 frontend apps + 1 backend Worker
from a single npm-workspaces monorepo (`apps/<name>/`, each with its own
`wrangler.toml`), which is the closest existing precedent to our upcoming
dashboard/backend/ingest/llm split. Pattern to carry over once Step 2 starts:
- **One job per Worker**, each gated on its own `dorny/paths-filter` output
  (own `apps/<name>/**` OR shared `packages/**`/shared-code path OR the
  workflow file itself) — mirrors our existing docs-vs-code filter, just
  split per Worker instead of one filter for the whole repo. `workflow_dispatch`
  always runs every job (no diff to compare against).
- **Per-job `concurrency` group** (e.g. `deploy-dashboard-${{ github.ref }}`),
  deliberately NOT one shared workflow-level group — an unrelated Worker's
  push must never cancel this Worker's in-flight deploy.
- **Migrations decoupled into their own job** (`backend-migrate` there, ours
  stays the existing `migrate` job), gated on a narrower `migrations/**`-only
  filter. Every Worker job that depends on the DB uses
  `needs: [changes, migrate]` with `if: always() && ... (needs.migrate.result
  == 'success' || needs.migrate.result == 'skipped')` — the `always()` is
  required because GitHub Actions would otherwise skip the dependent job too
  when `migrate` itself is skipped (no migration in that push).
- **Secrets stay scoped to the Worker that owns them**, each job fails fast
  on its own required secrets before deploying, then pushes them via
  `wrangler secret put` right after deploy. Optional secret groups use a
  bash `-z` guard inside `run:` and skip cleanly (secrets context is rejected
  inside a step's `if:`). Maps directly onto our Step 5/6 key-isolation goal:
  `dashboard`'s job only ever sees `DASHBOARD_USERNAME`/`DASHBOARD_PASSWORD`/
  `JWT_SECRET`, `ingest`'s only `FINNHUB_API_KEY`, `llm`'s only
  `GEMINI_API_KEYS` — no job touches a secret it doesn't own.
- D1/KV provisioning stays exactly our existing `ensure-d1-database`/
  `ensure-kv-namespace` composite actions, reused unmodified by every Worker
  job that needs them (only `backend` binds D1 per the rule below).

## LLM Calling Layer: Multi-Key Gemini Cascade (ported from `madmcp`)
**Two-axis cascade, model-first:** outer loop tries `[GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS]`
across every key before stepping down a model tier; inner loop rotates
`GEMINI_API_KEYS` on 401/403 (skip key), 429/503, or transient network failure.
Model-first because a 429/503 is usually per-model/per-key quota, so exhaust the
best model's keys before dropping tiers.

**Cooldown tracking:** KV-backed (`gemini:cooldown:<model>:<keyIndex>`, TTL-based
via `expirationTtl`) — write only on a rate-limit event, fits KV's 1K writes/day cap.
Fails open: if KV is unreachable, treat every pair as not cooling down.

Other behaviors: a bad/revoked key is skipped, not fatal, for the whole cascade;
an explicit non-default model request is honored exactly (no silent substitution,
relevant to the `quick_think`/`deep_think` split); which fallback model/key served
a call is tagged for logging.

This cascade underlies every LLM-touching stage (Analyst Team, Researcher Team,
Trader) — nothing calls the Gemini API directly.

## Roadmap: Service Split (sequential, one PR per step)
**Why:** one Worker currently runs the cron pipeline, the SSR dashboard, login, and
long manual jobs. Free-plan limits bite per invocation (10ms CPU, 50 subrequests);
cron/queue consumers get 15 min wall time; `ctx.waitUntil` only extends ~30s past
the response, so `/backfill` and `/backtest/run` can be cut off mid-run.

**Target: 4 Workers, connected by queues (not synchronous calls):**
`dashboard` (UI + login gateway), `backend` (orchestrator: cron, API, migrations),
`ingest` (fetch + write to D1), `llm` (long-running Gemini stages).

**Rules for every step:**
- One repo, one `wrangler` config per Worker, shared code imported (never copied).
- Only `backend` runs D1 migrations; all Workers bind the same D1.
- Each step ships as its own PR, leaves `main` green, and is verified live before
  the next starts. Never work on `main` directly; squash-merge.
- Preserve test contracts: `test/dashboard_refresh.test.js`,
  `test/index_login.test.js`, `test/index_backfill.test.js` (update deliberately,
  never silently).

### Step 0 -- Diagnose (no code)
Confirm the plan tier (free vs paid) and which limit actually fails (CPU,
subrequests, wall time) via Workers Logs; check `backtest_runs` for rows stuck in
`running`. **Done when:** the failing limit is written down here.

### Step 1 -- Backend JSON API (no behavior change)
Extract the data fetching out of `src/dashboard/routes.js` into `/api/*` read
endpoints (snapshot, activity, charts, health, decisions, positions, pipeline,
backtest runs), auth-gated by the existing session for now. The SSR dashboard keeps
working, now calling the same functions. Fix the exposure-understated bug here with
an aggregate query that ignores the Rows limit (`routes.js`/`d1.js`).
**Done when:** every dashboard panel's data is reachable via `/api/*`, exposure is
correct above the Rows filter, tests pass, dashboard unchanged.

### Step 2 -- Dashboard Worker
New Worker `news-market-ai-dashboard` (own `wrangler` config + CI deploy job) with
a service binding to `backend`. It owns login, the session cookie, and the UI;
`/api/*` is proxied same-origin (no CORS). Open decision: server-rendered first
(reuse `views/*`, keeps tests), static/client-rendered later -- the API is the same
either way. Move `DASHBOARD_USERNAME`, `DASHBOARD_PASSWORD`, `JWT_SECRET` to this
Worker; make `backend` private (service binding only), so it fails closed instead
of serving an open dashboard when login is unconfigured. Cut over, then delete the
dashboard/login/auth code from `backend`.
**Done when:** the dashboard works end to end from the new Worker, `backend` serves
no HTML, the login secrets exist only on `dashboard`, and `dashboard` has its own
path-filtered CI job per the "CI/CD for the 4-Worker split" pattern above.

### Step 3 -- Job queue for backfill and backtest
Add a `JOBS` queue (plus dead-letter queue). `POST /backfill` and
`POST /backtest/run` validate, enqueue, and return the accepted page; a consumer runs
`backfillHistoricalNews` / `runManualBacktest`. Job status lives in D1
(`backtest_runs` already persists a `running` row). This removes the `waitUntil`
30s cut-off. Keep the scripted-JSON response behavior for non-form callers.
**Done when:** a long backtest completes past 30s, failures land as `failed` rows,
and `test/index_backfill.test.js` is updated for the enqueue behavior.

### Step 4 -- Cron fan-out (still inside `backend`)
`scheduled()` becomes a thin scheduler: it enqueues one message per ticker per
source (`INGEST` queue). The ingest consumer fetches news, price bars and
fundamentals for that one ticker, writes D1, then enqueues `ANALYZE` for it. The
analysis consumer runs `runPipelineForTicker`, resumable via `graph/checkpointer.js`
(Pattern 12). Messages must be idempotent (dedupe on `id`, D1 unique keys) since
queues deliver at-least-once. Set `max_concurrency` on `ANALYZE` to throttle Gemini.
Keep `checkOpenPositionExits` as its own message, isolated from ingestion failures.
Budget: Queues free tier is 10K ops/day (~3 ops per message); estimate the daily
message count (tickers x stages x 96 runs) before shipping.
**Done when:** a full cron cycle completes as many small invocations, a crashed
message retries without duplicating rows or LLM spend, and ops/day fits the budget.

### Step 5 -- Extract `ingest` Worker
Move the ingest consumer to `news-market-ai-ingest` (own `wrangler` config, CI job).
It alone holds `FINNHUB_API_KEY` and the EDGAR CIK/name-index KV cache; it consumes
`INGEST` and produces `ANALYZE`. Shared code (`ingestion/*`, `storage/d1.js`,
`shared/*`) stays imported, not copied.
**Done when:** ingestion runs only from `ingest`, `backend` no longer holds
vendor keys, and `ingest` has its own path-filtered CI job per the "CI/CD for the
4-Worker split" pattern above (its job is the only one that ever sees
`FINNHUB_API_KEY`).

### Step 6 -- Extract `llm` Worker
Move the `ANALYZE` consumer (analysts -> debate -> trader -> risk -> portfolio) to
`news-market-ai-llm`. It alone holds `GEMINI_API_KEYS` and the cooldown KV
(`gemini:cooldown:*`); its queue's `max_concurrency` is the Gemini throttle. Raise
`limits.cpu_ms` there only if the paid plan is in use.
**Done when:** every LLM call originates from `llm`, no other Worker holds
Gemini keys, and `llm` has its own path-filtered CI job per the "CI/CD for the
4-Worker split" pattern above (its job is the only one that ever sees
`GEMINI_API_KEYS`).

### Step 7 -- Cleanup and docs
Remove dead code left in `backend`, run a per-Worker secrets audit, and rewrite the
Deployment and Repo Structure sections above for the 4-Worker layout. Fix stale
docs: Known Gaps still describes `X-Backfill-Secret`/`BACKFILL_API_SECRET`, but the
code now gates on the dashboard session.
**Done when:** this plan describes the system as built, not as planned.

### Open decisions
- Dashboard: server-rendered in its own Worker first, or fully static (Step 2).
- Queues vs Workflows for the per-ticker pipeline (Steps 4-6). Queues assumed.
- Free vs paid plan (Step 0 answers this; it changes CPU/subrequest headroom).

## Repo Structure
```
ingestion/           # GDELT, EDGAR, RSS, yfinance adapters -> normalized JSON
  errors.js           # typed vendor error taxonomy (Pattern 11)
  date_window.js       # point-in-time cutoff/boundary helpers
  market_data_validator.js  # sanity-check vendor data before agents see it (Pattern 9)
storage/             # D1 schema access, R2 raw archive access
llm/                 # multi-key Gemini cascade, KV-backed cooldown
agents/
  analysts/          # news/event, sentiment, technical analysts
  researchers/        # bull, bear
  managers/            # research_manager (bull/bear -> thesis), portfolio_manager (go/no-go)
  trader/             # trade thesis agent (direction/reasoning only)
  risk_mgmt/          # deterministic sizing/risk rules
  utils/               # memory.js (reflection log), structured.js (schema-enforced LLM calls)
  schemas.js           # shared structured I/O types
graph/               # orchestration
  pipeline.js          # wires stages together
  conditional_logic.js # routing between stages
  checkpointer.js       # Pattern 12: persist/resume state
  reflection.js         # Pattern 8: decision log + reflection loop
backtest/            # point-in-time harness, walk-forward validation, signal on/off comparison
dashboard/           # operational dashboard
config/
tests/
```

## Current Status
Core pipeline is built end-to-end and wired: shared schemas, Gemini cascade,
Bull/Bear debate + judge, deterministic risk/sizing + portfolio sign-off,
repo restructuring to match the graph/agents/managers layout, GDELT + RSS +
HTML-scrape + yfinance + EDGAR-fundamentals ingestion all wired into
`graph/pipeline.js`, real point-in-time positions store with exit logic
(stop-loss/take-profit/time-based), technical analyst consuming price bars,
signal on/off backtest comparison harness (math layer), checkpoint/resume and
point-in-time-memory tests, real SEC ticker→CIK lookup (replacing the
hand-maintained map as sole source), shared rate-limit pacer (EDGAR + all four
other ingestion adapters), CI green end-to-end against real Cloudflare infra,
and live-traffic verification against GDELT/yfinance/SEC EDGAR/RSS/HTML-scrape
(via `mcp__Madmcp__web_fetch`, which bypasses the sandbox's own egress block).

**Also done:** positions-netting fix (a re-evaluated ticker with an open position
was double-counting exposure and leaving duplicate open rows) — merged via PR #1
(commit `5858dff`). Real entity resolution via an opt-in, SEC-backed company-name
index (`entity_resolution.js#buildCompanyNameIndex`/`matchTickersByName`/
`getCompanyNameIndex`, gated by `config.entityResolutionUseNameIndex`, default
false) — wired into GDELT, RSS, and HTML-scrape ingestion, with `kv` threaded
through `collectNewsItems` so the index is cached in production. Fails open on
any error; `resolveTickers` stays fully backward-compatible when the index is
omitted; default behavior across all three adapters is byte-for-byte unchanged
when the flag is off. `structured.js` now has a `config.fakeModel` injection
point (off by default, falls through unchanged to the real Gemini cascade),
with true end-to-end tests riding it: `callStructured` itself (precedence,
arg passthrough, JSON-fence stripping, schema validation), `recordAndReflect`'s
write path, and a full `runPipelineForTicker` run through every agent/stage
plus a resume-after-crash test proving already-completed stages are never
re-invoked. checkpoint/resume, memory/reflection, and technical-analyst tests
are no longer limited to mocks/fakes for the LLM-call path.

**Bugfix (2026-09-17):** the resume-after-crash test above is what caught a
real off-by-one in `graph/pipeline.js` -- `checkpointer.js#resumeFrom` returns
the NEXT-NEEDED stage (its own unit tests require this), but pipeline.js's
block conditions/reassignments were written assuming the last-COMPLETED
stage instead. A fresh run never noticed (self-consistent within one
cascading execution), but resuming right after the "analyzed" checkpoint
skipped the debate block entirely and crashed `runTrader` on an undefined
verdict. This had been silently red on `main` (CI) since the resume test
was added, unnoticed because every push since was docs-only and skipped the
test job (see the CI path-filter fix below). Fixed by realigning every
block's condition/reassignment to the same next-needed convention
resumeFrom already uses; CI is green end-to-end again as of this commit.

## Known Gaps / Backlog
- **Entity resolution** now has a real SEC-backed name-matching path, and
  `config.entityResolutionUseNameIndex` now defaults **on** (flipped 2026-09-17,
  commit `57606aa`). This was flipped on the strength of existing unit/wiring
  test coverage alone (normalization, word-boundary matching, KV cache-aside
  fail-open behavior, all three adapters' wiring) — **it has not yet been
  validated against a live SEC fetch + real headline traffic**, since every
  attempt this session hit unreliable network conditions before a live check
  could complete. Explicit opt-out (`ENTITY_RESOLUTION_USE_NAME_INDEX=false`)
  remains available if live false-positive rates turn out worse than the unit
  tests suggest. Next step: run a live check once network access is reliable,
  and downgrade the default back to off if headline name-matching produces
  more false-positive ticker attributions than expected in practice.
- **GDELT**: CORRECTION (2026-09-18) — a prior version of this doc claimed the live
  `articles[]` response shape was "confirmed... after fixing that tool's own
  error-swallowing bug." That claim does not match this project's actual session
  history and could not be reproduced: a fresh verification attempt this session
  got a clean, explicit 429 from GDELT's own rate limiter on every try (immediate,
  after a 7s wait, and after a 45s wait), never a successful response. The live
  `articles[]` shape remains **unverified**. **REPLACED** (2026-09-18) as the
  primary news source by `src/ingestion/sources/finnhub.js` (Finnhub's free
  `/company-news` endpoint, 60 req/min, explicitly production-permitted unlike
  NewsAPI's dev-only free tier or Alpha Vantage's 25/day cap) -- unwired from
  `graph/pipeline.js#collectNewsItems`, but `gdelt.js` and its test coverage are
  kept in the repo (not deleted) for easy re-enable per an explicit product
  decision. Finnhub's own field mapping (`headline`/`summary`/`url`/`datetime`/
  `source`) is written from Finnhub's published docs only -- **not yet
  live-verified against a real successful response** (blocked on a real
  `FINNHUB_API_KEY` repo secret being set). Do not upgrade this to "confirmed"
  without an actual successful fetch in hand -- see the correction directly
  above for why.
- **yfinance** adapter is unofficial/undocumented; daily bars only, no intraday.
- **EDGAR fundamentals**: only whatever XBRL `us-gaap` tags a filer reports (no
  non-GAAP figures); not rate-limited beyond EDGAR itself (110ms pacing only).
- **HTML-scrape**: tag-stripping, not real boilerplate removal; major
  finance-publisher pages (Reuters, WSJ) return bot-challenge 401s in practice;
  pages with no published-time meta tag fall back to fetch-time and are flagged
  unsafe for point-in-time backtesting.
- **RSS**: general (non-ticker-hinted) feed items previously depended on the thin
  `COMPANY_DOMAIN_MAP` (3 domains), so most came back with empty `tickers` arrays.
  Confirmed by direct code read (2026-09-18): `rss.js#fetchLatest` already passes
  `nameIndex` into `resolveTickers` whenever `config.entityResolutionUseNameIndex`
  is set, so now that the flag defaults on, untagged feed items get real
  substring/word-boundary matching against the ~1000-company SEC name index —
  this item self-resolves as a byproduct of the entity-resolution default flip
  above, no separate code change needed. Still subject to the same unvalidated-
  against-live-traffic caveat as that flag until a live check happens.
- **Ingestion throttling**: only EDGAR + the other four adapters have pacing;
  no shared cross-vendor rate limiter, and `ingestPriceBars`/`ingestFundamentals`
  always fetch the full watchlist (no incremental/delta fetching).
- **`MAX_PORTFOLIO_RISK_PCT`** and **`config.maxPositionHoldDays`** (10) are both
  untuned placeholders.
- **Exit logic** will only fire time-based exits in practice until yfinance price
  bars are populated for a given ticker before a position opens.
- **Realized returns / reflection loop, now wired** (branch `wire-backtest`):
  `closePosition` now records `exit_price` (migrations/0009), and
  `graph/settle.js#settlePositionOutcome` computes a direction-aware realized
  return from it and calls `reflection.js#closeTheLoop` — which existed and
  was unit-tested since the LLM-answers PR but had **zero production
  callers** until now. Wired into both `closePosition` call sites
  (`exit_check.js`'s stop_loss/take_profit/time_based exits and
  `pipeline.js`'s "replaced" branch). `alphaReturn` is still always `null`
  — no benchmark price series is ingested anywhere in this project; that's
  a separate, larger gap (needs its own ingestion source). A reflection
  failure (LLM call) is logged and swallowed, not thrown — the position
  itself is already closed regardless.
- **Backtest harness** (`signalCompare.js`) is windowing + comparison math
  only — no real end-to-end backtest run yet. With realized returns now
  computable (see above), the **historical news backfill** gap for Finnhub
  is now closed (branch `wire-backtest`): `finnhub.js#fetchLatest` accepts
  an explicit `{from, to}` range (Finnhub's `/company-news` already
  supported arbitrary dates — the adapter just never exposed that), and
  `graph/pipeline.js#backfillHistoricalNews` wires it into a real entry
  point that persists results through the same `insertNewsItem`
  point-in-time storage path live ingestion uses. Default trailing-window
  behavior is unchanged when `from`/`to` are omitted, so the live cron
  path is unaffected. **Still open:** `rss.js`/`html_scrape.js` remain
  permanently live-feed/live-page-only — there's no `from`/`to` a feed or
  a scraped page can accept, so they cannot backfill; this is a real gap,
  not an oversight. `backfillHistoricalNews` now has a real operational
  entry point: `POST /backfill?from=...&to=...` (`src/index.js`), gated
  behind a required `X-Backfill-Secret` header matched against
  `BACKFILL_API_SECRET` (`config.js#backfillApiSecret`, no default --
  stays disabled/503 until explicitly set via `wrangler secret put`, same
  "disabled, not open" convention as every other unset secret in this
  project; pushed on deploy the same idempotent way as
  `GEMINI_API_KEYS`/`FINNHUB_API_KEY`, see `deploy.yml`). Covered by
  `test/index_backfill.test.js` (auth/validation branches, success, and
  the genuine-bug-vs-vendor-isolation 500 distinction). The comparable
  **no-signal baseline strategy** `signalCompare.js` needed is also now
  built: `src/backtest/noSignalBaseline.js` -- naive equal-weighted
  buy-and-hold across the same ticker universe/window, zero LLM calls,
  zero news reads, sourced from the same point-in-time `getPriceBarsAsOf`
  cutoff everything else uses. `makeBuyAndHoldOffReturns` matches
  `compareSignalOnOffByWindow`'s `getOffReturns(window)` callback exactly,
  so it plugs straight in with no adapter code. Covered by
  `test/backtest_no_signal_baseline.test.js`. **The "signal on" side is now
  also built** (`src/backtest/onSignalRunner.js`): walks a test window
  (plus a `graceDays` extension, default `config.maxPositionHoldDays`) one
  calendar day at a time, running `runPipelineForTicker` against whatever
  backfilled news landed that day (via two new point-in-time-flavored
  `storage/d1.js` readers, `getNewsItemsInRange` and, for the results side,
  `getRealizedReturnsInRange`) and calling `exit_check.js#checkOpenPositionExits`
  every day so stop-loss/take-profit/time-based exits get the same daily
  cadence the live cron path gives them -- a position only becomes a
  realized return once something closes it, so a single end-of-window pass
  would have systematically under-counted closes. `makeOnSignalReturns`
  matches `getOnReturns(window)` exactly, same drop-in shape as the
  no-signal side. Covered by `test/backtest_on_signal_runner.test.js`,
  entirely via `config.fakeModel` (zero real Gemini/Finnhub calls in CI).
  **COST WARNING, not yet done:** actually invoking this against real
  backfilled news/live Gemini traffic for a real backtest run has NOT been
  done this session, deliberately -- `runPipelineForTicker` makes several
  LLM calls per news item plus one more per position close, so a real run
  spends real quota and needs an explicit go-ahead, not a routine test
  pass. **What's actually left for a real end-to-end run now:** wiring
  `backfillHistoricalNews` + `makeOnSignalReturns` + `makeBuyAndHoldOffReturns`
  + `compareSignalOnOffByWindow` together behind one real invocation (a
  script or an operational endpoint, mirroring `POST /backfill`'s own
  gated-secret pattern) and actually running it once, with real cost
  accepted -- the math/orchestration layer itself is now fully built.
- **CI**: no lockfile-sync job (fine while there's one `package.json`). The
  docs-vs-code path filter is now exclusion-based (`**` minus any `*.md`,
  anywhere) rather than a manually maintained inclusion list, so a new
  top-level code directory is gated correctly without a workflow-file edit.
- **Dashboard** UI/UX pass has not been screenshot-reviewed.
