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
Structured layer: D1, indexed by ticker + published_at (see Deployment section).
Optional later: pgvector for semantic search over historical news.

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

**Done (2026-09-19):** the system described below is the built, 4-Worker layout
-- see "Roadmap: Service Split" for the step-by-step history of how it got here.

**Architecture:** four Cloudflare Workers, connected by queues rather than
synchronous calls, all binding the same D1 database (only `backend` runs
migrations) and the same `CACHE_KV` namespace:
- **`dashboard`** (`wrangler.dashboard.toml`) -- the only public-facing Worker:
  login, session cookies, and the server-rendered UI. Reaches `backend` via a
  service binding, never a queue (it needs a synchronous response). Holds
  `DASHBOARD_USERNAME`/`DASHBOARD_PASSWORD`/`JWT_SECRET`/`SESSION_TTL_SECONDS`.
- **`backend`** (`wrangler.toml`) -- orchestrator: the JSON `/api/*` surface,
  `POST /backfill` and `POST /backtest/run` (reachable only via `dashboard`'s
  service binding, private otherwise), the cron trigger (`scheduled()`, which
  fans out onto `INGEST` and `LLM_JOBS`, nothing else), D1 migrations, and the
  `JOBS` queue consumer (`backfill` only). Holds `FINNHUB_API_KEY` (needed only
  for `backfill`'s direct Finnhub call -- see Step 5's documented gap) and no
  Gemini vars/keys.
- **`ingest`** (`wrangler.ingest.toml`) -- consumes `INGEST` (`ingest_ticker`/
  `ingest_feeds`), fetches Finnhub/yfinance/EDGAR/RSS/HTML-scrape data, writes
  it to D1, and produces onto `ANALYZE`. Holds `FINNHUB_API_KEY` and
  `EDGAR_USER_AGENT`/`EDGAR_CIK_MAP`; no Gemini vars/keys.
- **`llm`** (`wrangler.llm.toml`) -- the only Worker that calls Gemini and the
  only one holding `GEMINI_API_KEYS`. Consumes `ANALYZE` (the Analyst Team ->
  debate -> trader -> risk -> portfolio pipeline) and `LLM_JOBS` (`backtest`,
  `exit_check`). Owns the `gemini:cooldown:*` keys in `CACHE_KV`.

Cron Triggers on `backend` drive the whole system: `scheduled()` fans out
per-ticker/per-feed messages onto `INGEST` and one `exit_check` onto `LLM_JOBS`;
everything downstream (ingestion, analysis, trading decisions) happens via queue
consumers in `ingest`/`llm`, never synchronously in the cron handler itself. D1 is
the structured layer (replaces the earlier Postgres/Neon plan); KV is
cooldown/rate-limit state plus lightweight config; R2 (10GB free) remains an
option as a raw archive layer if D1 storage is ever outgrown, not yet used.

**CI/CD:** `.github/workflows/deploy.yml` runs `test` → `migrate` (push/dispatch
only, gated on `migrations/**` changes) → one deploy job per Worker
(`deploy` for `backend`, `deploy-dashboard`, `deploy-ingest`, `deploy-llm`),
each with its own `dorny/paths-filter` output (its own source paths, shared
code paths it bundles, or the workflow file itself) and its own `concurrency`
group so an unrelated Worker's push never cancels this one's in-flight deploy
(`workflow_dispatch` always runs every job, bypassing the filters). Idempotent
D1/KV/queue provisioning via `.github/actions/ensure-d1-database` /
`ensure-kv-namespace` / `ensure-queue` (look up by name, create only if
missing, never commit real ids to the repo; each action takes a
`wrangler-config` input so every Worker's job can patch its own config file --
added in Step 6 after a Step 5 review found `deploy-ingest` skipping this
entirely). Every Worker job that depends on the DB uses `needs: [changes,
migrate]` with `if: always() && (needs.migrate.result == 'success' ||
needs.migrate.result == 'skipped')` (the `always()` is required so GitHub
Actions doesn't also skip the dependent job when `migrate` itself is skipped).

**Per-Worker secret scoping (the Step 5/6 key-isolation goal, done):** each
deploy job fails fast on its own required secrets, then pushes them via
`wrangler secret put --config <its wrangler file>` right after deploy --
`dashboard`'s job only ever sees `DASHBOARD_USERNAME`/`DASHBOARD_PASSWORD`/
`JWT_SECRET`/`SESSION_TTL_SECONDS`; `backend`'s only `FINNHUB_API_KEY` (for
`backfill`, its one remaining vendor-key use); `ingest`'s only
`FINNHUB_API_KEY`; `llm`'s only `GEMINI_API_KEYS` -- no job touches a secret
it doesn't own. Required repo secrets regardless of Worker:
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (hard requirement for
migrate/deploy). Optional secret groups use a bash `-z` guard inside `run:`
and skip cleanly (the `secrets` context is rejected inside a step's `if:`).
CI is green end-to-end against real Cloudflare infra as of Step 2's live
`workflow_dispatch` check. Steps 3-6's own deploy jobs got their live-deploy
check on 2026-09-19: run #237 (`workflow_dispatch`) deployed all four Workers
and provisioned every queue/DLQ green -- see "Post-split follow-ups" below.
Deploys are verified; each step's runtime behavior (see its own "still open"
notes) is not.
A secret-leak audit (pre-split) found and fixed a real plaintext-id leak in
the provisioning actions' `create` step output (ids are now masked before
printing -- see git history on `ensure-d1-database`/`ensure-kv-namespace` for
detail if ever revisited).

**Design precedent (historical note):** the per-Worker-job/per-Worker-secret
shape above was adapted from `allocsys/ai-campaign-builder`'s `deploy.yml`
(reviewed 2026-09-18), which deploys 5 frontend apps + 1 backend Worker from a
single npm-workspaces monorepo the same way. Carried over: one job per
Worker gated on its own path filter, one concurrency group per Worker,
migrations in their own job, and secrets scoped to the job that owns them.
Not carried over: that repo's npm-workspaces layout (`apps/<name>/**`) --
this repo keeps a flat `src/` with one `wrangler.<worker>.toml` per Worker
instead.

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

**Fallback list must differ from the requested model.** The cascade for a call is
`[requestedModel, ...GEMINI_FALLBACK_MODELS minus requestedModel]`, so a fallback
list that only contains the quick model leaves every quick-tier call with a
one-model cascade and no fallback (a single 503 killed a whole backtest before
PR #41). `wrangler.llm.toml` now lists three distinct models; quick tier cascades
`3.1-flash-lite -> 2.5-flash-lite -> 2.5-flash`, deep tier prepends `3.5-flash`.

### LLM call log (dashboard "LLM calls" page)
Every prompt sent to Gemini and the raw text that came back is stored in D1
(`llm_calls`, migration 0012) and shown at `/dashboard/llm` (list + filters by
source/status/ticker/backtest/run) and `/dashboard/llm/:id` (full prompt,
response, cascade attempts). It covers the live ANALYZE pipeline, manual
backtests (tagged with the backtest's job id, so a backtest's Runs list links
straight to its calls) and exit-check reflections, and it records FAILED calls
too (Gemini errors, non-JSON, schema mismatch).

- **One choke point:** `agents/utils/structured.js#callStructured` writes the
  row; agents only pass a `label`. Context (`source`, `jobId`, `runId`,
  `ticker`) rides on `config.llmLog` (`storage/llm_calls.js#withLlmLogContext`),
  set by `llm-worker.js` and `runPipelineForTicker`.
- **Best-effort:** a failed log write never fails or slows the call it
  describes. `LLM_LOG_ENABLED="false"` turns it off.
- **Cost:** each logged call is ~4 D1 rows written (table + 3 indexes) against
  the free tier's 100K/day. Rows older than `LLM_LOG_RETENTION_DAYS` (14) are
  pruned on the scheduled exit-check tick; each of prompt/response is clipped
  at `LLM_LOG_MAX_CHARS` (60000), with true lengths kept.
- **Not logged:** stages skipped on checkpoint resume (no call was made), and
  anything before migration 0012 is applied.

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

### Step 0 -- Diagnose (no code) -- DONE 2026-09-18
Confirmed via Workers Observability: **free tier**, and **CPU time** is the limit
actually failing (not subrequests, not wall time). The `*/15 * * * *` cron has hit
`outcome: exceededCpu` on nearly every tick since 2026-09-17 15:21 -- many events
report `cpuTimeMs: 10` exactly, the free tier's 10ms cap (a paid/unbound Worker
caps at 30s soft / 5min hard, so this pins the account as free). Wall times stay
under ~5.6s, nowhere near the 15-minute cron ceiling, so it's pure CPU exhaustion
in-pipeline, not a slow external call. Timing lines up with the entity-resolution
default flip to `true` on 2026-09-17 -- a plausible but unconfirmed root cause,
worth checking before Step 4's fan-out ships.

Also checked `backtest_runs` for stuck rows: found one --
`backtest-1789756783629-bxavoi` (AAPL), started 2026-09-18T18:39:43Z, still
`status: running` with `finished_at: null` as of this check. A separate run from
earlier the same day recorded `status: failed` correctly after ~37s, so failure
recording works in general; this run just never completed or errored out.
**Done when:** the failing limit is written down here. -- Done: CPU time, free tier.

### Step 1 -- Backend JSON API (no behavior change) -- DONE 2026-09-18
Merged to main via PR #27 (squash commit `a78ac0f`). Investigation notes below
kept for record; all code described was written and shipped as planned.

- **Exposure bug, confirmed, 3 call sites, all duplicate the same buggy sum:**
  `openPositions.reduce((sum,p)=>sum+(p.positionSizePct??0),0)*100` computed over
  an array fetched with `limit: params.positionsLimit` (default 50) --
  `helpers.js#renderSummaryCards` (~line 249), `views/snapshot.js` (~line 15,
  duplicated inline rather than calling renderSummaryCards's own copy), and
  `views/positions.js`'s exposure gauge (~line 48). All three understate total
  exposure once open positions exceed the Rows filter.
- **Fix plan:** add one new dashboard-only aggregate read in `storage/d1.js`,
  e.g. `getOpenPositionsExposureTotal(db)` -> `SELECT COALESCE(SUM(position_size_pct),0)
  AS total_pct, COUNT(*) AS count FROM positions WHERE closed_at IS NULL` (no
  LIMIT, no asOf -- same "Dashboard-only reads" section/convention as
  `getAllOpenPositions` etc., not the agent-facing asOf-gated
  `getOpenPositionsRiskPctAsOf`). Thread the result through as an explicit
  `totalExposurePct` prop into `renderSummaryCards` and both view files instead
  of each recomputing it from the (limited) `openPositions` array.
- **Extraction plan:** new `src/dashboard/data.js` holding one data-fetching
  function per section (`getSnapshotData`, `getActivityData`, `getChartsData`,
  `getHealthData`, `getDecisionsData`, `getPositionsData`, `getPipelineData`,
  `getBacktestRunsData`) -- literally the D1-fetching body of each
  `handle*Route` in `routes.js` today, minus the HTML render call. `routes.js`'s
  existing handlers call these same functions for SSR (no behavior change);
  new `src/dashboard/api.js` exposes `/api/snapshot`, `/api/activity`,
  `/api/charts`, `/api/health`, `/api/decisions`, `/api/positions`,
  `/api/pipeline`, `/api/backtest-runs`, each auth-gated via the existing
  `checkAuth`/`getSessionUsername` session check (reuse, don't duplicate),
  returning `Response.json(...)`. Wire the 8 new routes into `src/index.js`
  next to the existing `/dashboard/*` block.
- **Test contract confirmed safe:** `test/dashboard_refresh.test.js` uses a
  generic `FakeDashboardDb` (empty `.all()`/`.first()`/`.run()`) and only
  asserts the Refresh-link/Loaded-time toolbar markup per section -- extracting
  the fetch logic into `data.js` functions that `routes.js` still calls
  changes nothing this test observes, as long as `handle*Route` keeps calling
  `renderShell`/`render*View` the same way. Have not yet re-checked
  `test/index_login.test.js` / `test/index_backfill.test.js` line-by-line
  against the new `/api/*` routes in `index.js` -- do that before opening the
  PR, not after.
- Shipped on `feat/step1-api-layer`, squash-merged as PR #27. `src/dashboard/data.js`
  (per-section fetchers incl. `getOpenPositionsExposureTotal`), `src/dashboard/api.js`
  (8 `/api/*` handlers reusing `checkAuth`), wired into `src/index.js`, JSON
  responses matched to the codebase's existing `new Response(JSON.stringify(...))`
  convention, and `test/dashboard_api.test.js` added (auth gating + the exposure
  regression test). `routes.js`/view files updated to take `totalExposurePct` as
  an explicit prop instead of recomputing it from the Rows-limited array.
**Done when:** every dashboard panel's data is reachable via `/api/*`, exposure is
correct above the Rows filter, tests pass, dashboard unchanged. -- **Done.**

### Step 2 -- Dashboard Worker -- DONE 2026-09-18
Merged to main via PR #28 (squash commit `3cb3e38`). CI on the PR ran green
(changes + test; deploy/migrate/deploy-dashboard skipped as expected pre-merge,
per the pattern above). **Live-verified 2026-09-18:** the immediate post-merge
push (run #213) got cancelled by a same-concurrency-group docs-only push before
deploy-dashboard could run, and the next push's path filter correctly skipped it
again (docs-only diff). Forced a manual `workflow_dispatch` run (deploy.yml run
id 35393210094) to bypass the path filter -- changes/test/migrate/deploy/
deploy-dashboard all completed green, confirming the new dashboard Worker
deploys successfully against real Cloudflare infra end to end.

What's on the branch: new `wrangler.dashboard.toml` + `src/dashboard-worker.js`
owning login, the session cookie, and the UI (server-rendered, reusing `views/*`
as planned); `backend`'s `src/index.js`/`src/dashboard/routes.js` trimmed to drop
all HTML/login and now reachable only via service binding (`workers_dev = false`
in `wrangler.toml`) -- unconfigured login now fails closed everywhere rather than
serving an open dashboard (fixed a stale disabled-notice copy in `login.js` to
match). `package.json` gained dev/deploy scripts for the new Worker.
`deploy.yml` gained a path-filtered `deploy-dashboard` job (own concurrency
group, owns only `DASHBOARD_USERNAME`/`DASHBOARD_PASSWORD`/`JWT_SECRET`/
`SESSION_TTL_SECONDS`, depends on backend's deploy job) and dropped the now-
obsolete "set dashboard login secrets" step from backend's job, per the
"CI/CD for the 4-Worker split" pattern above.
`POST /backfill`/`POST /backtest/run` on `backend` no longer session-check
themselves (the dashboard does that one hop up); a new `?async=1` fire-and-forget
ack mode was added for the dashboard's browser-form submissions.
Test contracts updated deliberately, not silently: `test/index_login.test.js`
and `test/dashboard_refresh.test.js` removed and consolidated into a new
`test/dashboard_worker.test.js` (login/session flow, section rendering +
Refresh toolbar via a fake service binding, and the backfill/backtest
auth-then-forward flow); `test/index_backfill.test.js` rewritten for the
no-longer-session-checked backend contract plus `?async=1` coverage.

**Done when:** the dashboard works end to end from the new Worker, `backend` serves
no HTML, the login secrets exist only on `dashboard`, `dashboard` has its own
path-filtered CI job per the "CI/CD for the 4-Worker split" pattern above, and
the above is merged + verified live. -- Merged; live-deploy verification result
recorded in Current Status.

### Step 3 -- Job queue for backfill and backtest -- DONE 2026-09-18
Merged to main via PR #29 (squash commit `32f229d`).

What's on main: `JOBS` queue + `news-market-ai-jobs-dlq` dead-letter queue in
`wrangler.toml` (`max_batch_size = 1`, `max_retries = 3` -- each message is
already one full backfill or one full signal-on/off backtest run, so batching
wouldn't help). New `ensure-queue` composite action (same idempotent
look-up-by-name-or-create pattern as `ensure-d1-database`/`ensure-kv-namespace`),
wired into `deploy.yml` so the queue + DLQ are provisioned before deploy.
`POST /backfill` and `POST /backtest/run` in `src/index.js` now validate and
enqueue instead of running synchronously or via `ctx.waitUntil`; a new `queue()`
consumer runs `backfillHistoricalNews` / `runManualBacktest`, catching
business-logic failures internally and persisting them as `failed` rows in
`backtest_runs` rather than retrying (retrying would re-spend Gemini/Finnhub
quota for a result that's already known). `dashboard-worker.js` dropped the
now-meaningless `?async=1` flag since the backend always enqueues now. Test
contracts updated deliberately: `test/index_backfill.test.js` rewritten for the
enqueue behavior; new `test/queue_consumer.test.js` covers backfill
success/failure, backtest job persistence, unrecognized job types, and the
crash-retry path.

CI on PR #29 was still queued/in-progress at merge time -- deliberately not
blocked on, per instruction, to be checked after Step 7 instead of per-step
from here on.

**Still open (not yet done):** live verification that a real long backtest
actually survives past the old 30s cutoff against live Cloudflare infra, the
same kind of `workflow_dispatch` check Step 2 got. Not done this session.
**Done when:** a long backtest completes past 30s, failures land as `failed` rows,
and `test/index_backfill.test.js` is updated for the enqueue behavior. --
Code-level criteria met (tests + failure-handling); live-past-30s verification
still outstanding.

### Step 4 -- Cron fan-out (still inside `backend`) -- DONE 2026-09-18
Merged to main via PR #30 (squash commit `ba6a5b4`).

`scheduled()` (`src/index.js`) is now a thin scheduler: it enqueues one
`ingest_ticker` message per watchlist ticker plus one `ingest_feeds` message
(both onto the new `INGEST` queue), batched via one `sendBatch` call for the
per-ticker messages, and separately enqueues one `exit_check` message onto
the existing `JOBS` queue -- own message, own queue, isolated from ingestion
failures by construction, per this step's own requirement. It does no
fetching, no D1 writes, and no LLM calls itself anymore.

`queue()`'s INGEST consumer (`ingest_ticker` branch) calls new
`graph/pipeline.js#ingestTickerData`: fetches finnhub news, price bars
(yfinance), and fundamentals (EDGAR) SCOPED TO THAT ONE TICKER (via each
adapter's existing `queries`/`tickers` override param -- `ingestPriceBars`/
`ingestFundamentals` gained an optional `{tickers}` override for this), writes
them to D1, then enqueues one `analyze` message per resulting news item onto
the new `ANALYZE` queue. General (non-ticker-scoped) feeds -- rss,
html_scrape -- have no per-ticker query mode, so they're handled separately by
a new `ingestFeedNews` and the `ingest_feeds` branch, run once per cron tick
rather than fanned out per ticker; this enqueues one `analyze` message per
(item, ticker) pair since a general feed item may resolve to several tickers.
`collectNewsItems`/`runScheduledIngestion` (the original whole-watchlist sweep)
are left completely unchanged for any other caller -- Step 4 added new,
separately-scoped functions rather than modifying those.

`queue()`'s ANALYZE consumer (`analyze` branch) runs `runPipelineForTicker`
for one (ticker, newsItem) pair. This is the ONE deliberate exception to every
other message type's ack-and-log-on-failure convention: a failure here is
RETRIED, not acked, because `runPipelineForTicker` is checkpoint-resumable
(Adopted Pattern #12, `graph/checkpointer.js`) -- a retried message re-enters
`resumeFrom` and only re-runs whatever stage didn't finish, never re-spending
an LLM call on an already-checkpointed stage, and never double-opening a
position (`openPosition`'s own id-based `ON CONFLICT DO NOTHING`). Every other
new branch (`exit_check`, `ingest_ticker`, `ingest_feeds`) acks and logs on
failure, same convention Step 3's `backfill`/`backtest` already established --
there's no partial state worth resuming, the next cron tick just tries again.

`wrangler.toml`: new `news-market-ai-ingest` + `news-market-ai-analyze` queues
(plus their own dead-letter queues), each with its own `[[queues.producers]]`/
`[[queues.consumers]]` block. `INGEST`'s `max_batch_size = 10` (vs. JOBS's 1)
since these messages are individually small/cheap. `ANALYZE`'s
`max_concurrency = 2` is the actual Gemini-call throttle this step calls for
(each invocation's `runPipelineForTicker` makes several Gemini calls of its
own) -- a conservative starting point against the free-tier Gemini quota
Adopted Pattern #7 budgets around, not tuned against real traffic yet.
`deploy.yml` provisions both new queues + both new DLQs before deploy, same
`ensure-queue` composite action Step 3 already added (reused unmodified).

Test contract: new `test/cron_fanout.test.js` covers `scheduled()`'s fan-out
shape (right message types/counts, isolated failure domains) and `queue()`'s
four new branches, including proving `analyze` specifically retries where
every other branch acks. Does not duplicate `test/checkpoint_resume.test.js`'s
existing full-success-path coverage of `runPipelineForTicker` itself.

**Ops/day budget check:** current `WATCHLIST_TICKERS` default is 3 tickers.
Per 15-minute cron tick (96 ticks/day): 3 `ingest_ticker` + 1 `ingest_feeds` +
1 `exit_check` = 5 guaranteed messages, before any `analyze` fan-out --
96 x 5 = 480 messages/day x ~3 ops/message (Cloudflare's own estimate) =
~1,440 ops/day just for the guaranteed floor. `analyze` messages add on top of
that proportional to actual news volume (one message per inserted item per
mentioned ticker) -- even at a generous 50 news items/day system-wide, that's
at most another ~150 ops/day. Total stays comfortably under the 10K ops/day
free-tier ceiling at this watchlist size; re-check this arithmetic before
growing the watchlist substantially.

**Done when:** a full cron cycle completes as many small invocations (done --
see above), a crashed message retries without duplicating rows or LLM spend
(done for ANALYZE specifically, by design -- see above; not yet exercised
against a REAL crash/retry in live Cloudflare infra), and ops/day fits the
budget (done, by the arithmetic above -- not yet confirmed against real
Workers Observability numbers). **Still open:** CI on PR #30 was not chased
before merging (same deferral as Step 3, per this session's instruction --
to be checked once, after Step 7); no live deploy verification against real
Cloudflare infra yet either -- both outstanding for whenever that check happens.

### Step 5 -- Extract `ingest` Worker -- DONE 2026-09-19
Merged to main via PR #31 (squash commit `7ace9be`).

New `wrangler.ingest.toml` + `src/ingest-worker.js` (`news-market-ai-ingest`
Worker): owns the INGEST queue's consumer -- `ingest_ticker`/`ingest_feeds`
handling moved here VERBATIM from `backend`'s queue() (same functions called,
same ack-on-business-failure/retry-on-crash convention, see that file's own
header). Binds D1 directly (not a service binding -- there's no synchronous
caller waiting on a response the way `dashboard`->`backend` has one, and
plan.md's Roadmap rule is "all Workers bind the same D1", not "only backend
touches D1") plus its own CACHE_KV binding (EDGAR CIK lookup cache, entity-
resolution SEC name-index cache, Finnhub/yfinance's cross-invocation 429
cooldown -- all now exercised only from this Worker). Consumes
`news-market-ai-ingest`, produces onto `news-market-ai-analyze` -- `backend`'s
`scheduled()` is unchanged and still enqueues onto INGEST, it just no longer
consumes it (a queue can only have one consumer Worker, so `backend`'s
`[[queues.consumers]]` block for `news-market-ai-ingest` was removed from
`wrangler.toml`, its producer block kept).

`backend` trimmed accordingly: `ingest_ticker`/`ingest_feeds` branches and
their `ingestTickerData`/`ingestFeedNews` imports removed from `src/index.js`'s
queue() (dead code after the consumer binding was removed -- Cloudflare would
never route those message types to this Worker again regardless), module
header comment updated to describe the reduced two-queue (JOBS + ANALYZE)
responsibility. `EDGAR_USER_AGENT`/`EDGAR_CIK_MAP` vars removed from
`wrangler.toml` (moved to `wrangler.ingest.toml`) -- `backend` no longer calls
EDGAR directly.

**Known, deliberate gap against this step's original "done when" wording**
("backend no longer holds vendor keys"): `backend` STILL separately holds its
own `FINNHUB_API_KEY`, because `POST /backfill`'s JOBS-queue `backfill` job
(plan.md Step 3, `src/index.js`'s queue()) calls
`graph/pipeline.js#backfillHistoricalNews` directly, which hits Finnhub itself
-- and JOBS has exactly one consumer (`backend`), so moving that call to
`ingest` isn't possible without either a second queue for backfill jobs
specifically or some other larger redesign, which is out of scope for this
step's size (comparable to Step 2's dashboard extraction, not a bigger
rewrite). Flagged explicitly in `wrangler.toml`'s own secrets comment,
`wrangler.ingest.toml`'s own comment, and `src/index.js`'s module header --
not silently left unmentioned. A future step (or a dedicated backfill-queue
redesign) could close this; not attempted here.

`package.json` gained `dev:ingest`/`deploy:ingest` scripts, same pattern as
`dashboard`'s. `deploy.yml` gained a path-filtered `deploy-ingest` job (own
concurrency group, depends on `backend`'s own `deploy` job since that job
provisions the `news-market-ai-ingest`/`news-market-ai-analyze` queues +
DLQs this Worker's `wrangler.ingest.toml` binds to, via the same `ensure-queue`
composite action reused unmodified) that pushes `FINNHUB_API_KEY` scoped to
`--config wrangler.ingest.toml`, same idempotent non-blocking shape as every
other per-Worker secret push in this file. Path filter watches
`src/ingest-worker.js`, `wrangler.ingest.toml`, `src/graph/pipeline.js`,
`src/ingestion/**`, `src/storage/**`, `src/shared/**`, `src/config.js`, and
the workflow file itself.

Test contract updated deliberately: the `ingest_ticker`/`ingest_feeds`
`queue()` tests that used to live in `test/cron_fanout.test.js` (testing
`backend`'s queue(), plan.md Step 4) moved to a new `test/ingest_worker.test.js`
unchanged in behavior/assertions -- the underlying `ingestTickerData`/
`ingestFeedNews` functions didn't change at all, only which Worker's queue()
calls them -- plus two new tests for the unrecognized-type and genuine-crash-
retry paths (a null message body, since both message types' own inner
try/catch already covers their business-logic failures, so a null body is
what actually reaches the outer catch). `test/cron_fanout.test.js`'s own
scope note and header comment updated to describe what's left there
(`scheduled()`'s own fan-out tests, `exit_check`, `analyze`) versus what moved.
**Verified locally** (cloned the branch, `npm ci && npm test`): 340 tests,
338 pass, 2 fail -- confirmed via the same run against `main` that those
same 2 failures pre-date this step entirely (unrelated `dashboard_worker`
backfill tests, not touched by Step 5). The two new/moved test files
(`test/cron_fanout.test.js`, `test/ingest_worker.test.js`) pass 100% in
isolation (10/10).

CI on the PR not chased individually, same deferral as Steps 3/4 (checked
once, after Step 7, per standing instruction). No live-deploy verification
yet either -- same deferral.
**Done when:** ingestion runs only from `ingest` (done), `ingest` has its own
path-filtered CI job per the "CI/CD for the 4-Worker split" pattern above
(done, `deploy-ingest`), and `FINNHUB_API_KEY`/EDGAR identity are held there
(done) -- **with the one exception above** (`backend` also still holds
`FINNHUB_API_KEY`, for `backfill` only): not fully met by the letter of the
original wording, met in every other respect, and the gap is documented
rather than silently claimed closed.

### Step 6 -- Extract `llm` Worker -- DONE 2026-09-19 (PR #32)
Move the `ANALYZE` consumer (analysts -> debate -> trader -> risk -> portfolio) to
`news-market-ai-llm`. It alone holds `GEMINI_API_KEYS` and the cooldown KV
(`gemini:cooldown:*`); its queue's `max_concurrency` is the Gemini throttle. Raise
`limits.cpu_ms` there only if the paid plan is in use.
**Done when:** every LLM call originates from `llm`, no other Worker holds
Gemini keys, and `llm` has its own path-filtered CI job per the "CI/CD for the
4-Worker split" pattern above (its job is the only one that ever sees
`GEMINI_API_KEYS`).

**What shipped (PR #32, squash commit `62ce1f8`):** new
`wrangler.llm.toml` + `src/llm-worker.js` (`news-market-ai-llm`). It consumes
ANALYZE (moved from `backend`, config unchanged: `max_batch_size = 5`,
`max_retries = 3`, `max_concurrency = 2` -- the Gemini throttle) AND a new
`news-market-ai-llm-jobs` queue (+ `-dlq`, `max_batch_size = 1`,
`max_concurrency = 1`) carrying `backtest` and `exit_check`. Binds D1 and the
same CACHE_KV namespace as the other Workers (the Gemini cascade's
`gemini:cooldown:*` keys are prefix-namespaced, and only this Worker's code
path writes them now); holds `GEMINI_API_KEYS` and the Gemini model vars, no
vendor data key.

**Scope was wider than "move the ANALYZE consumer" -- found by reading the call
graph, not assumed:** `backend`'s JOBS consumer also ran `backtest`
(`runManualBacktest` -> `onSignalRunner` -> `runPipelineForTicker`) and
`exit_check` (`checkOpenPositionExits` -> `settlePositionOutcome` ->
`closeTheLoop` -> `callStructured`, one reflection LLM call per closed
position). Both call Gemini, so moving only ANALYZE would have left `backend`
holding Gemini keys and missed this step's own done-when. A queue can only
have one consumer Worker and JOBS's has to stay in `backend` for `backfill`
(Finnhub), so those two types moved onto the new LLM_JOBS queue instead --
the same class of problem Step 5 hit with `backfill`, but cheap enough here to
close in full rather than document as a gap. `runManualBacktest` never calls
Finnhub (reads D1 only), so `llm` needs no vendor data key. `backend` now
PRODUCES onto LLM_JOBS (`POST /backtest/run`, `scheduled()`'s exit_check) but
consumes only JOBS, which carries `backfill` alone; its ANALYZE producer/
consumer blocks, ANALYZE handling, Gemini model vars and `GEMINI_API_KEYS` push
were removed.

**`deploy.yml`:** path-filtered `deploy-llm` job (own concurrency group,
depends on backend's `deploy` job, the only job that ever sees
`GEMINI_API_KEYS`); backend's `deploy` job now provisions the LLM_JOBS queue +
DLQ and no longer pushes `GEMINI_API_KEYS`. The `llm` path filter is broader
than the other Workers' (`src/graph/**`, `src/agents/**`, `src/llm/**`,
`src/backtest/**`, `src/schemas/**`, `src/ingestion/**`, `src/storage/**`,
`src/shared/**`) because `llm-worker.js` transitively bundles all of them.

**Also fixed -- latent Step 5 bug, found while writing the llm job:**
`ensure-d1-database`/`ensure-kv-namespace` hard-coded `sed ... wrangler.toml`,
and `deploy-ingest` never ran them at all. Each CI job has its own checkout, so
`wrangler deploy --config wrangler.ingest.toml` would have shipped the
`REPLACE_WITH_*` placeholder ids. Both actions now take a `wrangler-config`
input (default `wrangler.toml`, so backend's job is unchanged), and
`deploy-ingest`/`deploy-llm` each patch their own config. Found by static
reading; Step 5 was never live-deployed, so this is unproven either way until
the post-Step-7 check.

**Test contract updated deliberately:** new `test/llm_worker.test.js`
(`backtest` moved from `test/queue_consumer.test.js`, `exit_check`/`analyze`
moved from `test/cron_fanout.test.js`, plus unrecognized-type/crashed-handler
paths), new `test/index_backtest_enqueue.test.js` (`/backtest/run` -> LLM_JOBS,
never JOBS), `test/queue_consumer.test.js` gained a test that `backend`'s
`queue()` acks the three moved types as unrecognized without processing, and
`test/cron_fanout.test.js`'s `scheduled()` tests now assert `exit_check` lands
on LLM_JOBS.

**Rollout notes / still open:**
- A `backtest`/`exit_check` message already on JOBS at the moment `backend`
  deploys is acked-and-dropped as unrecognized (no forwarder added --
  `exit_check` re-enqueues every 15 min, a dropped backtest would need
  resubmitting). Between backend's and `llm`'s deploys, ANALYZE/LLM_JOBS just
  accumulate, then drain.
- **Stale secret:** deploys no longer push `GEMINI_API_KEYS` to
  `news-market-ai`, but a copy set by an earlier deploy stays on that Worker
  until deleted (`wrangler secret delete GEMINI_API_KEYS`). Nothing reads it
  any more, but key isolation isn't real until it's gone -- Step 7's secrets
  audit item.
- Tests were NOT run locally for this step (sandbox had no network); verified
  by reading plus the PR's CI `test` job only. CI on this PR is otherwise
  deferred to after Step 7, same as Steps 3-5. Known baseline: the 2
  pre-existing `dashboard_worker` POST /backfill failures on `main`.
- No live-deploy verification (same deferral).
**Done when:** every LLM call originates from `llm` (done -- ANALYZE,
`backtest`, `exit_check`), no other Worker holds Gemini keys (done in code and
CI; the stale secret above is the one loose end), and `llm` has its own
path-filtered CI job (done, `deploy-llm`).

### Step 7 -- Cleanup and docs -- DONE 2026-09-19 (PR #33, squash commit `10c9910`)
Remove dead code left in `backend`, run a per-Worker secrets audit, and rewrite the
Deployment and Repo Structure sections above for the 4-Worker layout. Fix stale
docs: Known Gaps still describes `X-Backfill-Secret`/`BACKFILL_API_SECRET`, but the
code now gates on the dashboard session.

**Dead-code check in `backend` -- came back clean, not a bug:** `src/index.js`
imports `backfillHistoricalNews` from `graph/pipeline.js`, which also exports
`runPipelineForTicker`/`collectNewsItems`/`ingestTickerData`/etc. that `backend`
itself never calls anymore (moved to `ingest`/`llm` in Steps 5-6). This looked
like dead weight in backend's bundle at first read, but it isn't removable
dead code -- those same exports are live, load-bearing code for `llm` (which
imports `runPipelineForTicker`) and `ingest` (which imports `ingestTickerData`/
`ingestFeedNews`) from that identical file. Splitting `pipeline.js` into
per-Worker files to trim backend's bundle would be a real refactor with its
own risk, not a cleanup; wrangler's bundler (esbuild) also tree-shakes unused
ESM exports already, so the deployed bundle isn't actually carrying dead
weight in practice. Left as-is; not flagged as a gap. `backend`'s `wrangler.toml`
itself has no leftover bindings/vars it doesn't use (confirmed by reading).

**Stale comment fixed:** `src/ingest-worker.js`'s queue() header described
backend's queue() as still fanning in JOBS/INGEST/ANALYZE through one handler
-- inaccurate since Step 6 (backend now consumes JOBS/`backfill` only).
Corrected. `wrangler.ingest.toml`'s comments were all re-read and are accurate
as written; no changes needed there.

**Secrets audit result:** every Worker's `wrangler secret put` pushes in
`deploy.yml` match what its own code actually reads, with the one already-
documented exception (`backend` holding `FINNHUB_API_KEY` for `backfill`
only -- Step 5's gap, not new). One item is NOT fixable from this repo: an
earlier deploy left a `GEMINI_API_KEYS` secret sitting on the `backend`
(`news-market-ai`) Worker in Cloudflare; `deploy.yml` stopped pushing it as
of Step 6, and nothing in `backend`'s code reads it, but the value itself is
Cloudflare account state, not a repo file, and no available tool here can
issue `wrangler secret delete` against live infra. **Manual follow-up still
required:** run `wrangler secret delete GEMINI_API_KEYS --config wrangler.toml`
against the `news-market-ai` Worker. Key isolation is correct in code/CI but
not yet real in the deployed environment until that command runs.
**Resolved 2026-09-19:** the secret was deleted from the `news-market-ai`
Worker in the Cloudflare dashboard (its latest version is annotated "Deleted
Secret binding GEMINI_API_KEYS"). See "Post-split follow-ups" below for the
same class of leftover that did break something.

**Docs rewritten:** the Deployment section's "Planned: split into 4" framing
replaced with the actual built architecture (each Worker, its bindings, its
secrets); the two CI/CD paragraphs (one describing the old single-deploy-job
workflow, one describing the 4-Worker split as an upcoming plan "once Step 2
starts") rewritten as one description of the deploy.yml as it exists today,
with the `ai-campaign-builder` precedent kept as a historical note rather than
a forward-looking plan; Repo Structure gained the 4 Worker entry-point files
(previously only the shared modules were listed); the Known Gaps paragraph
about `X-Backfill-Secret`/`BACKFILL_API_SECRET` rewritten to describe the
actual dashboard-session-based auth that replaced it back in Step 2.

**Done when:** this plan describes the system as built, not as planned --
met for every doc section above. **Still open:** the `GEMINI_API_KEYS`
secret-deletion action on live Cloudflare infra (manual, listed above), and
the standing deferred CI/live-deploy check across Steps 3-6 (unchanged from
before this step, not part of Step 7's own scope).

## Post-split follow-ups (2026-09-19)
Everything here happened after Step 7 merged. None of it changes the
architecture above.

- **wrangler v3 -> v4 (PR #34, `e56f64b`).** CI had failed on every push to
  `main` since run #219, at `wrangler queues create`: wrangler 3.x silently
  sent a 4-day default message-retention (345600s), which exceeds the free
  tier's 86400s cap, and the API rejected it with a generic "queue settings
  are invalid" error. Cloudflare removed that default in workers-sdk#12458
  (merged 2026-02-06), which was not backported to v3 (v3 only gets
  critical-security patches), so bumping within `^3.x` could not have fixed
  it. Fix: wrangler v4.135.0 (v4 requires Node >= 22, so CI moved to Node
  22) plus an explicit `--message-retention-period-secs 86400` in
  `ensure-queue`, so queue creation no longer depends on any implicit
  default.
- **`ensure-queue` idempotency (PR #35, `1538491`).** v4 reports an existing
  queue as `Queue name '<n>' is already taken ... [code: 11009]`, not v3's
  "already exists", so the first re-run after the bump failed at "Ensure JOBS
  queue exists" (run #236). The check now matches `already (exists|taken)`
  or `code: 11009`. Verified by run #237: all 7 jobs green, and every queue/DLQ
  step took the "already exists -- skipping creation" path.
- **Live-deploy check for Steps 3-6.** Run #237 is the first full green
  deploy of all four Workers, so provisioning, per-Worker path filters and
  per-Worker secret pushes are now proven against real Cloudflare infra.
  Still NOT observed live: a backtest surviving past the old 30s cutoff
  (Step 3), a real ANALYZE crash-and-retry (Step 4), ops/day against real
  Workers Observability numbers (Step 4), and the full ingest -> analyze ->
  llm flow producing decisions end to end.
- **Stale login secrets on `backend` broke the whole dashboard (fixed
  2026-09-19).** Step 2's "done when" says the login secrets exist only on
  `dashboard`, but `DASHBOARD_USERNAME`/`DASHBOARD_PASSWORD`/`JWT_SECRET`
  were never deleted from the `news-market-ai` Worker after moving. `routes.js`'s
  `checkAuth` is a deliberate no-op ONLY when those three are unset, so
  backend kept demanding a session cookie that dashboard's service-binding
  call never forwards: every `/api/*` call returned 401 and every dashboard
  page showed "Couldn't load this section: unauthorized". Fixed by deleting
  the three secrets from `backend` in the Cloudflare dashboard (no code
  change). It is the same class of leftover as the stale `GEMINI_API_KEYS`,
  and Step 7's secrets audit compared `deploy.yml` against code but never
  against what was actually bound on the live Workers. **Lesson:** a green
  deploy says nothing about live bindings/secrets; the check that would have
  caught this is a live comparison of each Worker's bindings to its wrangler
  file's own "Secrets" comment, or the smoke test below.
- **Config drift: dashboard logs.** `wrangler.dashboard.toml` enables
  `[observability.logs]`, but the live `news-market-ai-dashboard` had logs
  off, which hid the dashboard's own `console.error` during the incident
  above. The toml is the intended state; re-enable in the Cloudflare
  dashboard (a later full deploy of that Worker may also restore it).

**Remaining work (nothing here blocks the system running):**
- **Post-deploy smoke test** in `deploy.yml`: log in through `dashboard`, fetch
  one `/api/*` route via the service binding, fail the workflow if it isn't
  200. Not built yet; would have caught the 401 incident.
- **Live verification** of the four behaviors listed under "Live-deploy check"
  above.
- **Stuck backtest row** from Step 0 (`backtest-1789756783629-bxavoi`, still
  `running`) was never resolved.
- **Step 5's deliberate gap:** `backend` still holds `FINNHUB_API_KEY` for
  `backfill` only (needs a second queue to close).
- **Loose ends:** unreferenced `src/dashboard.js` shim; an unrelated stray
  Worker `restless-manager-6789` on the account.
- Everything under "Known Gaps / Backlog" below is unchanged.

## Repo Structure
```
src/index.js          # `backend` Worker entry point (wrangler.toml) -- JSON
                      # API, /backfill + /backtest/run, cron scheduler, JOBS
                      # (backfill-only) queue consumer, D1 migrations
src/dashboard-worker.js  # `dashboard` Worker entry point (wrangler.dashboard.toml)
                      # -- login, session, SSR UI; calls `backend` via a
                      # service binding
src/ingest-worker.js  # `ingest` Worker entry point (wrangler.ingest.toml) --
                      # INGEST queue consumer (ingest_ticker/ingest_feeds)
src/llm-worker.js     # `llm` Worker entry point (wrangler.llm.toml) -- ANALYZE
                      # + LLM_JOBS (backtest/exit_check) queue consumer, the
                      # only Worker holding GEMINI_API_KEYS
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
`getCompanyNameIndex`, gated by `config.entityResolutionUseNameIndex` — now
defaults **on**, flipped 2026-09-17; see Known Gaps for the live-verification
caveat) — wired into GDELT, RSS, and HTML-scrape ingestion, with `kv` threaded
through `collectNewsItems` so the index is cached in production. Fails open on
any error; `resolveTickers` stays fully backward-compatible when the index is
omitted. `structured.js` now has a `config.fakeModel` injection
point (off by default, falls through unchanged to the real Gemini cascade),
with true end-to-end tests riding it: `callStructured` itself (precedence,
arg passthrough, JSON-fence stripping, schema validation), `recordAndReflect`'s
write path, and a full `runPipelineForTicker` run through every agent/stage
plus a resume-after-crash test proving already-completed stages are never
re-invoked. checkpoint/resume, memory/reflection, and technical-analyst tests
are no longer limited to mocks/fakes for the LLM-call path.

**Fixed (2026-09-17):** a resume-after-crash off-by-one in `graph/pipeline.js`
(block conditions assumed the last-COMPLETED stage instead of `resumeFrom`'s
actual NEXT-NEEDED convention, skipping the debate block and crashing
`runTrader`) — realigned; CI green end-to-end again.

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
- **GDELT**: live `articles[]` response shape remains **unverified** — every
  verification attempt has hit GDELT's own rate limiter (429) rather than a
  successful response. **REPLACED** (2026-09-18) as the primary news source by
  `src/ingestion/sources/finnhub.js` (Finnhub's free `/company-news` endpoint,
  60 req/min, production-permitted unlike NewsAPI's dev-only tier or Alpha
  Vantage's 25/day cap) — unwired from `graph/pipeline.js#collectNewsItems`,
  but `gdelt.js` and its tests are kept in the repo for easy re-enable.
  Finnhub's field mapping (`headline`/`summary`/`url`/`datetime`/`source`) is
  written from its published docs only and is **not yet live-verified**
  (blocked on a real `FINNHUB_API_KEY` repo secret). Do not mark either as
  confirmed without an actual successful fetch in hand.
- **yfinance** adapter is unofficial/undocumented; daily bars only, no intraday.
- **EDGAR fundamentals**: only whatever XBRL `us-gaap` tags a filer reports (no
  non-GAAP figures); not rate-limited beyond EDGAR itself (110ms pacing only).
- **HTML-scrape**: tag-stripping, not real boilerplate removal; major
  finance-publisher pages (Reuters, WSJ) return bot-challenge 401s in practice;
  pages with no published-time meta tag fall back to fetch-time and are flagged
  unsafe for point-in-time backtesting.
- **RSS**: general (non-ticker-hinted) feed items previously depended on the
  thin `COMPANY_DOMAIN_MAP` (3 domains). Self-resolved as a byproduct of the
  entity-resolution default flip above — `rss.js#fetchLatest` already passes
  `nameIndex` into `resolveTickers`, so untagged items now get real
  substring/word-boundary matching against the SEC name index. Same
  unvalidated-against-live-traffic caveat as that flag applies here too.
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
  entry point: `POST /backfill?from=...&to=...` (`src/index.js`). As of
  Step 2, auth is dashboard-session-based, not a header/secret: `dashboard`
  (`src/dashboard-worker.js`) requires its own login/session cookie before
  forwarding the request to `backend` over their service binding, and
  `backend`'s route no longer session-checks itself. The header-based
  fallback this paragraph used to describe (`X-Backfill-Secret` matched
  against a `BACKFILL_API_SECRET`/`BACKTEST_API_SECRET` config value) has
  been removed entirely (see `src/config.js`'s comment on `dashboardUsername`
  for confirmation) -- `dashboard`'s session is now the only way to call
  either route. Covered by `test/dashboard_worker.test.js` (the
  auth-then-forward flow) and `test/index_backfill.test.js` (the
  no-longer-session-checked backend contract, validation branches, success,
  and the genuine-bug-vs-vendor-isolation 500 distinction). The comparable
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
