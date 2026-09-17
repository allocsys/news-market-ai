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
   only covers US-listed XBRL filers.
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
  not an oversight. `backfillHistoricalNews` also isn't yet wired to any
  operational entry point (a CLI/script, a one-off `workflow_dispatch`
  job) — it exists as a callable function with test coverage
  (`test/ingestion_wiring.test.js`), not something anyone can invoke
  outside a test yet. A real end-to-end run also still needs a comparable
  no-signal baseline strategy and will make live LLM calls across
  historical data (expensive/slow), separate from the backfill gap itself.
- **CI**: no lockfile-sync job (fine while there's one `package.json`). The
  docs-vs-code path filter is now exclusion-based (`**` minus any `*.md`,
  anywhere) rather than a manually maintained inclusion list, so a new
  top-level code directory is gated correctly without a workflow-file edit.
- **Dashboard** UI/UX pass has not been screenshot-reviewed.
