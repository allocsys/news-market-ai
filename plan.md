# News → Market Analysis → Trade Signal Pipeline

## Goal
An AI-driven pipeline that ingests financial news, summarizes it, has a second
LLM reason about likely market impact, and turns that analysis into trade
signals. Needs a historical archive for backtesting and fine-tuning.

## Prior Art

Before building, we looked at what already exists so we're not reinventing
worse versions of solved problems.

- **[TradingAgents](https://github.com/TauricResearch/TradingAgents)** (TauricResearch,
  104k stars, published as an arXiv paper — UCLA/MIT/Tauric Research) — by far the
  most sophisticated open reference. Multi-agent architecture built on LangGraph:
  **Analyst Team** (parallel: fundamentals, sentiment, news, technical analysts) →
  **Researcher Team** (Bull researcher vs. Bear researcher *debate* the analysts'
  findings) → **Trader** (turns debated research into a position thesis) →
  **Risk Management Team** (multiple risk-profile agents review before approval) →
  **Portfolio Management** (final sign-off). Code is organized as
  `agents/{analysts, researchers, managers, risk_mgmt, trader}/` with a shared
  `schemas.py` for structured agent I/O. This is our primary architectural
  reference — see "Adopted Patterns" below.
- **[Agentic-AI-Trading-Bot](https://github.com/fsaavedra0003/Agentic-AI-Trading-Bot-with-LLM-reasoning-sentiment-analysis)**
  (fsaavedra0003) — smaller/portfolio-scale, but a clean minimal folder layout:
  `ingestion/ sentiment/ models/ agents/ execution/ dashboard/ config/ tests/`.
  Good reference for a lightweight skeleton.
- **[llm-news-sentiment-agent](https://github.com/rkaravangelis/llm-news-sentiment-agent)**
  (rkaravangelis) — small, but useful for the summarizer stage: Pydantic structured
  output, few-shot prompting, a 5-band sentiment schema (not just pos/neg/neutral),
  and a mandatory one-sentence justification field per score — makes output
  auditable, not just a number.
- **[llm-rl-finance-trader](https://github.com/franjgs/llm-rl-finance-trader)** —
  uses yfinance (free) for price history, FinBERT + Finnhub for sentiment, and
  compares a PPO trading agent with/without sentiment via Sharpe ratio. Good
  template for *proving* whether our news signal actually helps, not just
  assuming it does.
- Also scanned: LLM-Enhanced-Trading (Ronitt272, Docker/K8s production reference),
  Stock-Market-News-Sentiment-Analysis-and-Summarization (weekly summarization
  reference), and the broader `news-sentiment` GitHub topic (FinBERT + Kafka +
  TimescaleDB + SEC EDGAR patterns for the storage layer).

## Adopted Patterns (stolen from TradingAgents, adapted for us)

1. **Parallel analyst agents, not one big prompt.** Instead of a single
   "analyze this news" LLM call, split into role-specific analysts that each
   look at the same event from a different angle (news/event analyst, sentiment
   analyst, and — once we have price data wired up — a technical analyst). Each
   outputs a structured opinion independently.
2. **Bull/Bear debate before a verdict.** Before turning analysis into a trade
   thesis, run two agents arguing opposite cases (bull case vs. bear case) on
   the same evidence, then have a "judge" step synthesize. This catches
   single-pass overconfidence cheaply, without fine-tuning.
3. **Separate the trade thesis from risk/sizing.** A trader agent decides
   *direction and reasoning*. A distinct risk-management layer decides
   *whether to act and how much*. Never let one agent do both — keeps the
   audit trail clean and makes the sizing layer swappable/rule-based.
4. **Shared structured schemas everywhere.** One `schemas.py`-equivalent
   defining the structured I/O (Pydantic or JSON Schema) that every agent
   reads/writes against, so stages compose without prompt-string gluing.
5. **Mandatory justification field.** Every scored/classified output (sentiment,
   event type, bull/bear verdict) carries a short natural-language "why" field
   alongside the number — critical for debugging bad trades later.
6. **Prove the signal helps before trusting it.** Backtest with the news
   signal on vs. off (e.g. Sharpe ratio comparison) rather than assuming the
   LLM analysis adds value.
7. **Two-tier model strategy.** Split every stage into a cheap/fast model
   (`quick_think`) for high-volume simple tasks (per-article analyst passes)
   vs. a stronger model (`deep_think`) reserved for the parts where reasoning
   quality actually matters (debate, judge/synthesis, final decision). Directly
   solves our "free tier" budget problem: spend free-tier quota on the analyst
   stage, save the best available free/cheap model for the debate stage.
   `max_debate_rounds` / `max_risk_rounds` become explicit depth-vs-cost knobs.
8. **Persistent decision log + reflection loop.** Every completed pipeline run
   appends its decision + eventual realized outcome (raw return and return vs.
   a benchmark) to a memory log. The next run for the same ticker fetches that
   realized outcome, generates a short reflection on what worked/didn't, and
   injects recent same-ticker + cross-ticker lessons into the next run's
   prompt. This is a cheap substitute for actual fine-tuning and maps directly
   onto our original "use old data to improve the system" goal — **but see the
   Backtesting Integrity section below**, this loop is also the easiest place
   to accidentally leak future information into a backtest.
9. **Grounded, not free-associated, data claims.** The agent must not be
   allowed to state a price, indicator value, or financial figure from its own
   "knowledge" — every such claim must be grounded in a verified data snapshot
   fetched at that step. Stale data should be rejected outright, not silently
   reported as current.
10. **Deterministic entity resolution before any LLM runs.** Resolve which
    ticker/company/entity is being analyzed via a deterministic lookup step
    *before* any agent sees the task, rather than letting an LLM infer it —
    avoids a whole class of "analyzed the wrong company" bugs.
11. **Explicit vendor fallback chain, no silent degradation.** When a data
    source fails (GDELT down, rate-limited, etc.), surface a typed error and
    follow an explicit configured fallback order — never silently serve
    thinner data without logging that a source was skipped.
12. **Checkpoint/resume for multi-agent runs.** Persist state after each
    pipeline stage (per ticker/event) so a crashed run resumes from the last
    completed step instead of restarting and re-spending LLM calls.

## Pipeline Stages

### 1. Ingestion
Pull news from multiple sources and normalize everything into a common JSON
schema, so we're not limited to sources that already return JSON — anything
(RSS, scraped HTML, filings) gets "jsonified" into the same shape at the
ingestion boundary.

**Free sources to start with:**
- GDELT Project — free, global news monitoring, updates every 15 min, historical
  archive back to 2015. Best free option for backtesting since it's timestamped.
- SEC EDGAR full-text search API — free, official, filings (8-K, 10-Q, etc.)
- RSS feeds — Reuters, Yahoo Finance, MarketWatch, CNBC (free, self-parsed)
- yfinance — free, unofficial, per-ticker news endpoint + price/history data
- NewsAPI free tier — 100 req/day, 24h delayed, dev-only (no commercial use)
- Finnhub / Alpha Vantage free tiers — news+sentiment endpoints, rate-limited
- Reddit / StockTwits API — free, sentiment signal rather than "news" proper

**Common normalized schema (draft):**
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
- Raw layer: append-only, immutable store of the normalized JSON + original
  payload (object storage or flat files to start).
- Structured layer: Postgres (Neon free tier), indexed by ticker + published_at
  for fast time-range queries.
- Optional later: vector DB (pgvector) for semantic search over historical news.

### 3. Analyst Team (was: "Summarization LLM")
Parallel, role-specific agents, each taking raw article JSON and producing a
structured opinion against the shared schema:
- **News/Event analyst**: entities/tickers involved, event type (earnings, M&A,
  regulatory, macro, etc.), short factual summary
- **Sentiment analyst**: sentiment score (5-band, not just pos/neg/neutral) +
  mandatory one-sentence justification
- **Technical analyst** (later, once price data is wired up): price/volume
  context at time of news
Use a free/cheap model here (Groq, Gemini free tier, or local via Ollama) —
high volume, relatively simple task per agent.

### 4. Researcher Team (was: "Analysis LLM")
- **Bull researcher** and **Bear researcher**: two agents argue opposite cases
  using the Analyst Team's output as shared evidence.
- **Judge/synthesis step**: reconciles the debate into a single thesis with:
  direction/magnitude estimate, confidence score, time horizon (same-day
  catalyst vs. slow-burn), and the reasoning trail (both sides + why one won).

### 5. Trader Agent
Takes the Researcher Team's synthesized thesis and produces a concrete trade
recommendation (direction, instrument, rationale) — but does **not** decide
position size. That's a separate concern (see stage 6).

### 6. Risk Management + Portfolio Management
- Risk layer: rule-based, deterministic position sizing/risk limits (not an
  LLM). Reviews the trader's recommendation against account risk rules
  (max position size, stop-loss/take-profit, circuit breakers).
- Portfolio management: final go/no-go sign-off, then order generation.
Keep this layer simple and auditable — never let the LLM directly size
positions.

### 7. Historical data for backtesting
Point-in-time correctness matters: need what was actually publicly known at
each moment, not just old articles, to avoid lookahead bias. GDELT is the best
free option since it's timestamped and archived. Pair with historical
price/volume data via yfinance (free).

Validate the pipeline properly: backtest with the news/analysis signal on vs.
off and compare (e.g. Sharpe ratio, cumulative returns, max drawdown) —
following the llm-rl-finance-trader approach — rather than assuming the LLM
layer adds value.

## Backtesting Integrity (no look-ahead)

**Honest status: not yet built.** Tauric's own release notes claim look-ahead-safe
news windows already, so we are not starting from a place where they got this
wrong and we're fixing it — we just have a narrower focus (news specifically)
and can afford to be stricter about it there. This needs to be true by
construction, not by discipline, or it will quietly stop being true the moment
someone adds a feature (see point 4 below).

1. **Hard cutoff per simulated timestamp.** At simulated time `T`, every agent
   may only read: news with `published_at <= T`, price/volume data timestamped
   `<= T`, and memory/reflection entries from prior *backtest* decisions
   strictly before `T`. Enforce this at the data-access layer (the query itself
   filters by `T`), not by trusting the agent to behave — same principle as
   Tauric's "verified data snapshot" grounding, applied to the time dimension.
2. **Revision-aware storage.** Outlets edit articles after publishing
   (corrected headlines, updated figures). Store every revision with its own
   timestamp; at simulated time `T`, serve the version that existed at `T`,
   never the current live version. Most hobby backtests only keep the latest
   scrape — this is a common, easy-to-miss leak.
3. **Point-in-time fundamentals, not "as reported today."** Financials get
   restated after the fact. yfinance and most free sources only give current
   data, not point-in-time. **UPDATE: addressed, not just documented, for
   XBRL-filing US-listed companies** — see `src/ingestion/sources/
   edgar_fundamentals.js` and the matching checklist entry below: SEC EDGAR's
   companyfacts API tags every fact with its actual filing date, separately
   from the fiscal period it describes, so a restatement is a distinct
   later-dated row rather than an overwrite — `storage/d1.js#
   getFundamentalFactsAsOf` reconstructs "what was known as of T" from that
   for real. Residual gap, still real: everything free/current-only
   (yfinance, price data in general) still isn't point-in-time, and EDGAR
   itself only covers US-listed XBRL filers — international/private/small
   non-XBRL companies have no point-in-time fundamentals source here at all.
4. **The reflection/memory loop is the easiest place to leak the future.**
   Adopted Pattern #8 (persistent reflection) depends on a realized outcome,
   which requires later price data to "have happened." In backtest, the memory
   log fed to the agent at simulated time `T` must only contain reflections
   from decisions made before `T` — never later ones, even though in wall-clock
   terms all of history is already sitting in our database. This has to be
   enforced by the same timestamp filter as point 1, applied to the memory
   store too, not treated as a separate system.
5. **Walk-forward validation, not one static split.** Roll the cutoff forward
   in fixed windows (train Jan–Mar, test Apr; then train Jan–Apr, test May, ...)
   instead of a single train/test split, to catch a strategy that only worked
   in one regime.
6. **A leak-check test, not just a design doc.** Before trusting any backtest
   result, run an automated check: for a sample of simulated timestamps,
   assert that zero rows returned to the agent have a timestamp after `T`.
   This is a real test we can write and run in CI, not just a principle we
   promise to follow.

## Deployment: Cloudflare Workers + D1 + KV (free tier)

Verified against current Cloudflare free-tier limits (Sept 2026):

| Resource | Free limit | Implication for us |
|---|---|---|
| Workers | 100K requests/day, 10ms CPU time/invocation | CPU time excludes time spent awaiting `fetch()`, so LLM-calling steps (mostly I/O wait) barely touch the budget |
| D1 | 5GB storage, 5M rows read/day, **100K rows written/day** | As of Sept 1, 2026 this is now hard-enforced — queries over the limit fail outright, not just throttle. Treat "rows written/day" as a first-class ingestion constraint: batch inserts, dedupe before writing, don't write every raw field as its own row |
| KV | 1GB storage, 100K reads/day, **1K writes/day** | Too tight for high-frequency per-request caching, but a great fit for low-frequency state like LLM key/model cooldown tracking (see below) — that only writes on a rate-limit event, not per request |
| Bundle size | 64 MiB uncompressed (raised Sept 4, 2026) | Not a real constraint for us |

**Architecture sketch:**
- Cloudflare Workers as the orchestrator: Cron Triggers fire ingestion pulls (GDELT/EDGAR/RSS/yfinance) and drive the agent pipeline steps.
- D1 as the structured layer (ticker + published_at indexed news/summaries/decisions), replacing the Postgres/Neon plan from earlier — keeps everything in one platform's free tier. Revisit Neon only if D1's write cap becomes a real bottleneck.
- KV as the cooldown/rate-limit-state store for the LLM cascade (see below), and for lightweight config/flags. Not used for high-write-volume data.
- R2 (10GB free) as the raw/immutable article archive layer if we outgrow storing raw payloads directly in D1.

### CI/CD (added 2026-09-17)

Previously no automation at all — deploys were manual `wrangler deploy` runs.
`.github/workflows/deploy.yml` now handles this, adapted from
`allocsys/ai-campaign-builder`'s `deploy.yml` pattern (that repo confirmed
working in production there) but scaled DOWN: this repo is a single Worker
with one `package.json` and no npm workspaces, so none of that repo's
per-app `dorny/paths-filter` gating or lockfile-sync job apply — just three
jobs: `test` (all triggers) → `migrate` (push/`workflow_dispatch` only) →
`deploy` (same, needs both, `always()` + result-check so a skipped `migrate`
on a PR run doesn't skip `deploy` too — `deploy` is separately gated to
push/dispatch anyway, so this only matters for keeping the `needs` graph
correct).

What WAS carried over from ai-campaign-builder because it solves a real
problem here too: the idempotent "look up by name, create only if missing,
patch this job's own uncommitted `wrangler.toml` checkout, never commit the
real id back to the repo" pattern, as two composite actions —
`.github/actions/ensure-d1-database` and `.github/actions/ensure-kv-namespace`
— ported near-verbatim (only the working-directory changed, since this
repo's `wrangler.toml` lives at the repo root, not `apps/backend/`). This
means no manual one-time `wrangler d1 create` / `wrangler kv namespace
create` is needed before the first deploy, and `wrangler.toml`'s committed
`database_id`/KV `id` stay permanent placeholders — real ids are resolved
fresh every job run. Ported `ensure-kv-namespace`'s hard-won fix intact too:
`wrangler kv namespace list` returns JSON by default on the pinned wrangler
version and has NO `--json` flag — passing one silently breaks JSON
parsing by making wrangler print usage text instead (this cost
ai-campaign-builder two failed debugging attempts before the root cause was
found; don't reintroduce `--json` here).

Two real pre-existing bugs fixed as part of adding this (found while wiring
the `migrate` job, not something CI itself caused):
- `package.json`'s `"test"` script was `node --test test/` — the bare-directory
  form, which throws `MODULE_NOT_FOUND` on this repo's Node version (see the
  MANDATORY WORKFLOW note elsewhere in this doc). Fixed to the glob form
  `node --test 'test/**/*.test.js'`, matching what every session's own
  manual verification already had to use.
- `db:migrate:local`/`db:migrate:remote` were hardcoded to
  `wrangler d1 execute ... --file=migrations/0001_init.sql` — i.e. only ever
  applied the FIRST migration file, regardless of the other five
  (`0002_checkpoints.sql` through `0006_positions_exit_fields.sql`) that
  have been added since. Any real remote D1 database migrated only through
  this script would be missing five migrations' worth of schema. Fixed to
  `wrangler d1 migrations apply news_market_ai --local`/`--remote`, which
  uses wrangler's own migrations-directory convention (already satisfied —
  the numbered-prefix filenames in `migrations/` match what it expects) and
  tracks which migrations have already run, so it's safe to call on every
  deploy rather than needing to be extended by hand each time a migration
  file is added.

Required repo secrets (Settings → Secrets and variables → Actions):
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` — hard requirement, `migrate`
and `deploy` both fail fast with a clear error if either is missing, before
touching Cloudflare. `GEMINI_API_KEYS` — optional at the deploy-success
level (a first deploy that stands up the Worker/D1/KV/cron trigger but
hasn't configured a Gemini key yet still succeeds), but pushed via
`wrangler secret put` (idempotent on repeat runs) whenever it IS set; the
pipeline can't do anything useful without it since every LLM call goes
through `src/llm/gemini/client.js`'s cascade.

KNOWN GAPS: (1) no lockfile-sync job — fine for now since this repo has a
single `package.json` and no workspaces to hoist across, but if that
changes revisit whether ai-campaign-builder's `sync-lockfile` job is worth
porting too; (2) unlike ai-campaign-builder's backend job, there's no
narrower `migrations/**`-only path filter gating the `migrate` job separately
from general code changes — every push runs `wrangler d1 migrations apply`,
which is a deliberate simplification (the command is itself idempotent/
no-op when nothing new needs applying, so the extra invocation costs a
few seconds, not correctness) rather than an oversight; (3) not yet verified
against a real GitHub Actions run — `CLOUDFLARE_API_TOKEN`/
`CLOUDFLARE_ACCOUNT_ID`/`GEMINI_API_KEYS` need to be added as repo secrets
and a push to `main` (or a manual `workflow_dispatch`) watched end-to-end
before this can be called confirmed-working, same "wiring vs. live-verify"
caveat as EDGAR/GDELT/yfinance's own sandbox network block elsewhere in
this doc.

**UPDATE (2026-09-17):** gap 3 above is now closed, see the CI-fix and
secret-leak checklist items further down -- CI has run green end-to-end for
real, against real Cloudflare infra. Also added this session: none of the
three `actions/setup-node@v4` steps (test/migrate/deploy jobs) used
`cache: 'npm'`, so every job did a full cold dependency download
independently even within the same workflow run. Fixed (commit `e772eb9`)
by adding `cache: 'npm'` to all three -- keys automatically off the root
`package-lock.json`, no `cache-dependency-path` override needed since this
repo has a single lockfile at the repo root.

## LLM Calling Layer: Multi-Key Gemini Cascade (ported from our `madmcp` repo)

Our `madmcp` repo (`connectors/gemini/client.js`) already has a production-tested
cascade pattern for calling Gemini across multiple free API keys — reuse this
design rather than rebuilding it from scratch.

**Core shape: two-axis cascade, model-first.**
- Outer loop: `[GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS]` — try the strongest
  configured model across every available key before ever stepping down to a
  weaker fallback model.
- Inner loop: `GEMINI_API_KEYS` — for the current model, rotate through every
  key on 401/403 (bad/revoked key, skip and continue), 429 (rate limit), 503
  (overloaded), or a network-level transient failure (timeout/dropped
  connection, explicitly marked `transient` since it carries no HTTP status).
- Rationale for model-first ordering: a 429/503 is usually a per-model,
  per-key quota signal, so exhaust all keys on the best model first rather
  than dropping to a weaker model while unused quota still exists elsewhere.

**Cooldown tracking, adapted for our stack:** madmcp namespaces cooldown state
per `(model, keyIndex)` pair in Upstash Redis (their infra is Vercel-based),
using native TTL so a recorded cooldown expires itself. On Cloudflare, **KV is
the more natural fit than Redis** — same TTL-based "expires itself" semantics
via `expirationTtl`, no external dependency, and the write pattern (only on a
rate-limit event, not per request) sits comfortably inside KV's 1K writes/day
free cap.
- Key format: `gemini:cooldown:<model>:<keyIndex>`
- On 429: parse the provider's "retry in Ns" hint if present, else fall back
  to a default cooldown window; `kv.put(key, "1", { expirationTtl: seconds })`.
- Before attempting a (model, key) pair: `kv.get(key)` — if present, skip
  without spending a request.
- **Fail open**: if KV is unreachable or unconfigured, treat every pair as not
  cooling down rather than blocking the call — cross-call memory is a
  nice-to-have, not a dependency for correctness.

**Other behaviors worth keeping as-is:**
- A bad/revoked key (401/403) is skipped (`continue`), never treated as fatal
  for the whole cascade — only exhausting *every* key on *every* model is a
  hard failure.
- If a caller requests an explicit non-default model, honor it exactly (key
  rotation still applies, but no silent model substitution) — relevant for our
  two-tier `quick_think` / `deep_think` split (Adopted Pattern #7): a caller
  asking specifically for the cheap model shouldn't silently get upgraded.
- Tag which fallback model/key index actually served a given call (for
  logging/debugging), without changing the shape of the normal return value.

This cascade becomes the calling layer underneath every LLM-touching stage:
Analyst Team, Researcher Team (bull/bear/judge), and Trader agent all call
through it rather than hitting the Gemini API directly.

## Proposed Repo Structure
Revised after diffing our original skeleton against TradingAgents' actual repo
(not just its README description). Their real layout separates *orchestration*,
*decision arbitration*, and *shared agent tooling* into their own modules
instead of burying that logic inside analyst/trader/risk folders — we were
missing all three. Adopted `graph/`, `agents/managers/`, and `agents/utils/`
from them; kept our lighter ingestion/storage naming since we're on
Cloudflare (D1/KV/R2), not their Postgres-oriented `dataflows/`.
```
ingestion/           # GDELT, EDGAR, RSS, yfinance adapters -> normalized JSON
  errors.py           # typed vendor error taxonomy (Pattern 11: explicit fallback, no silent degradation)
  date_window.py       # point-in-time cutoff/boundary helpers (shared by ingestion + backtest)
  market_data_validator.py  # sanity-check vendor data before it reaches agents (Pattern 9: grounded claims)
storage/             # D1 schema access, R2 raw archive access
llm/                 # multi-key Gemini cascade (ported from madmcp), KV-backed cooldown
agents/
  analysts/          # news/event analyst, sentiment analyst, technical analyst
  researchers/        # bull researcher, bear researcher
  managers/            # NEW: research_manager (arbitrates bull/bear debate -> thesis),
                       #      portfolio_manager (final go/no-go, separate from trader's thesis)
  trader/             # trade thesis agent (direction/reasoning only, no sizing)
  risk_mgmt/          # deterministic sizing/risk rules (not LLM)
  utils/               # NEW: shared agent tooling -- memory.py (reflection log), structured.py
                       #      (schema-enforced LLM calls), rating.py, tool wrappers
  schemas.py           # shared structured I/O types for all agents
graph/               # NEW: orchestration layer, previously missing entirely
  pipeline.py          # wires stages together (their trading_graph.py equivalent)
  conditional_logic.py # routing between stages (e.g. debate round limits)
  checkpointer.py       # Pattern 12: persist/resume state per pipeline stage
  reflection.py         # Pattern 8: decision log + reflection loop (time-filtered per Backtesting Integrity #4)
backtest/            # point-in-time backtesting harness, walk-forward validation,
                     # signal on/off comparison, leak-check test
dashboard/           # optional visualization
config/
tests/               # mirror TradingAgents' naming for the integrity-critical ones,
                     # e.g. test_news_lookahead.py, test_memory_pointintime.py,
                     # test_checkpoint_resume.py -- copy the pattern, not just the idea
```

## Open questions / next steps
- [x] Define shared structured I/O types (agents read/write against
      `src/schemas/index.js`: NormalizedNewsItem, AnalystOpinion, DebateSide,
      DebateVerdict, TradeThesis, RiskDecision, PortfolioDecision)
- [x] Pick free LLM provider for the Analyst Team stage (Gemini, via the
      multi-key cascade in `src/llm/gemini/client.js`)
- [x] Prototype the Bull/Bear debate + judge step (`src/agents/researchers/
      {bull,bear}.js` + `src/agents/managers/research_manager.js`)
- [x] Build the deterministic risk/sizing layer (`src/agents/risk_mgmt/
      risk.js`, plus final go/no-go in `src/agents/managers/
      portfolio_manager.js`)
- [x] Repo restructuring after diffing against TradingAgents' actual layout:
      `graph/` (pipeline, conditional_logic, checkpointer, reflection),
      `agents/managers/`, `agents/utils/` (structured.js, memory.js),
      `ingestion/{date_window.js, market_data_validator.js}` all added and
      wired into `src/index.js#scheduled`
- [x] Build GDELT ingestion script (`src/ingestion/sources/gdelt.js`,
      DOC 2.0 API, one query per `config.watchlist` ticker, deterministic
      entity resolution via new `src/ingestion/entity_resolution.js`).
      `graph/pipeline.js#runScheduledIngestion` now calls it, persists via
      `insertNewsItem`, and runs the full agent pipeline end to end.
      KNOWN GAPS carried forward, not yet fixed: (1) GDELT DOC API returns
      metadata only, so `body` is empty -- analysts are effectively
      headline-only until full-text fetch is added; (2) entity resolution is
      a tiny hand-maintained domain map, real coverage TBD; (3) not yet
      exercised against a live GDELT request, so the actual JSON shape
      should be spot-checked before relying on this in production
- [x] Set up D1 schema for point-in-time fundamentals (or document the free-
      data limitation more concretely per Backtesting Integrity #3): built
      the schema AND made point-in-time fundamentals real for US-listed XBRL
      filers, not just documented the gap. `src/schemas/index.js#
      FundamentalFact` (adds `filedAt` alongside `fiscalYear`/`fiscalPeriod`
      -- the field that makes this genuinely point-in-time, see its own
      comment for why), `migrations/0005_fundamental_facts.sql`
      (`fundamental_facts` table, one row per (ticker, tag, fiscalYear,
      fiscalPeriod, form) so a restatement is a new row, not an overwrite),
      `storage/d1.js#insertFundamentalFact/getFundamentalFactsAsOf`
      (point-in-time read: latest-filed-as-of-`asOf` fact PER fiscal period,
      via a `ROW_NUMBER() OVER (PARTITION BY fiscal_year, fiscal_period
      ORDER BY filed_at DESC)` window query -- same required-asOf convention
      as every other `*AsOf` reader), `market_data_validator.js#
      validateFundamentalFact`, and `ingestion/sources/
      edgar_fundamentals.js#fetchFacts/fetchLatest` (SEC EDGAR XBRL
      companyfacts API, requires `config.edgarUserAgent` per SEC's terms,
      ticker->CIK via a small hand-maintained `config.edgarCikMap` --
      same honest convention as `entity_resolution.js`'s domain map). See
      also the updated Backtesting Integrity point 3 above.
      Covered by `test/fundamentals_pointintime.test.js` (18 tests,
      including the core point-in-time guarantee: a restated value is
      invisible to an `asOf` before its own filing date, and visible
      afterward, replacing the original for that period; 85 tests total in
      the suite now).
      KNOWN GAPS carried forward: (1) US-listed XBRL filers only -- no
      international/private/non-XBRL-small-cap coverage; (2) ticker->CIK
      resolution is hand-maintained, not a real lookup (SEC does publish a
      free `company_tickers.json` mapping file -- fetching/caching that is a
      separate future task); (3) only whatever XBRL `us-gaap` tags a filer
      actually reports are available, no non-GAAP/adjusted figures;
      (4) `config.edgarUserAgent` has no default and MUST be set before live
      use or SEC returns 403; (5) not wired into `graph/pipeline.js` or
      consumed by any agent -- like `price_bars`, there is no fundamentals
      analyst yet; (6) not rate-limited against SEC's own fair-use guidance,
      a caller pulling many tickers/tags in a loop should throttle itself.
- [x] Build "jsonify" adapters for non-JSON sources (RSS, scraped HTML):
      `src/ingestion/jsonify.js` (regex-based, no XML/DOM dependency --
      deliberate, see file header on why: `parseFeedItems` handles both
      RSS 2.0 `<item>` and Atom `<entry>`, `stripHtml` drops
      script/style/nav/header/footer and returns plain text, `decodeEntities`
      / `extractPageTitle` support both). Two new source adapters mirroring
      gdelt.js's conventions (typed VendorError, buildNormalizedItem +
      validateNormalizedNewsItem): `src/ingestion/sources/rss.js#fetchLatest`
      over `config.rssFeeds`, and `src/ingestion/sources/html_scrape.js`
      (`fetchArticle` single-page + `fetchLatest` batch). `config.js` gained
      `rssFeeds`/`scrapePages`, parsed from `RSS_FEED_URLS`/`SCRAPE_PAGE_URLS`
      env vars as `TICKER|url` pairs -- no hardcoded defaults (see inline
      comment: shipping default third-party URLs would silently start
      scraping sites the moment this code runs). Covered by
      `test/jsonify_adapters.test.js` (16 tests: pure parsing/stripping
      helpers + mocked-fetch response handling for both adapters; 56 tests
      total in the suite now).
      KNOWN GAPS carried forward: (1) `html_scrape.js`'s body extraction is
      tag-stripping, not readability/boilerplate-removal -- nav/sidebar text
      that survives the strip list ends up mixed into `body`; (2) when a
      page has no recognized published-time meta tag, the item falls back to
      fetch-time and is flagged `raw.publishedAtIsFetchTime: true` -- such
      items are NOT safe for point-in-time backtesting (Backtesting
      Integrity) until a better timestamp source exists for that
      ticker/domain; (3) neither adapter is wired into
      `graph/pipeline.js`/`runScheduledIngestion` yet, same as yfinance;
      (4) `rss.js` general (non-ticker-hinted) feed items rely on
      `entity_resolution.js`'s thin domain map for tickers -- expect many
      empty `tickers` arrays until that map grows; (5) neither has been
      spot-checked against a real live feed/page, only mocked-fetch tests.
- [x] Real positions store wired up: `migrations/0003_positions.sql`
      (`positions` table), `storage/d1.js#openPosition/closePosition/
      getOpenPositionsRiskPctAsOf` (point-in-time, same required-asOf
      convention as `getNewsAsOf`/`getDecisionMemoryAsOf`), and
      `graph/pipeline.js`'s `risk_checked` stage now reads live exposure and
      opens a position on approval instead of passing a hardcoded `0`.
      Covered by `test/positions_pointintime.test.js`.
      UPDATE: gap (1) below is now closed, see the new checklist item right
      after this one -- `closePosition` has a real caller now.
      KNOWN GAPS carried forward: (2) re-evaluating a thesis on a
      ticker that already has an open position double-counts that ticker's
      exposure (no netting/replace concept yet); (3) `MAX_PORTFOLIO_RISK_PCT`
      is still an untuned placeholder ceiling.
- [x] Give `closePosition` a caller -- stop-loss/take-profit/time-based exit
      logic: `migrations/0006_positions_exit_fields.sql` adds
      `direction`/`entry_price`/`stop_loss_pct`/`take_profit_pct`/
      `close_reason` to `positions` (copied from the TradeThesis/
      RiskDecision that opened it, so exit evaluation never has to join back
      out to another table). `agents/risk_mgmt/exit.js#evaluateExit` is the
      new deterministic, non-LLM rule (same Adopted Pattern #3 convention as
      `risk.js`): stop-loss beats take-profit beats time-based when more
      than one condition is met at once (protect capital first), and a
      position with no `entryPrice`/`currentPrice` available never gets a
      fabricated price -- it can still exit on the `maxHoldDays` time-based
      rule, just not on stop-loss/take-profit. `graph/exit_check.js#
      checkOpenPositionExits` is the orchestration: reads every open
      position via new `storage/d1.js#getOpenPositionsAsOf`, sources
      `currentPrice` from `getPriceBarsAsOf`, and calls `closePosition` with
      a `closeReason` when `evaluateExit` fires. `graph/pipeline.js`'s
      `risk_checked` stage now also writes `direction`/`entryPrice` (from
      the latest `price_bars` row at/before `asOf`, nullable)/
      `stopLossPct`/`takeProfitPct` onto every opened position instead of
      just `positionSizePct`. New `config.maxPositionHoldDays` (default 10,
      untuned). `src/index.js#scheduled` calls `checkOpenPositionExits`
      after ingestion, in its own try/catch (Adopted Pattern #11 -- an exit
      check failure must never be conflated with an ingestion failure).
      Covered by `test/exit_logic.test.js` (20 tests: pure `evaluateExit`
      rule coverage including the stop-loss-beats-take-profit priority and
      the null-price honest-degradation case, `d1.js`'s new fields/reads,
      and `checkOpenPositionExits` orchestration against a fake positions +
      price_bars store, including a re-run-safety test; 105 tests total in
      the suite now).
      KNOWN GAPS: (1) exit checks are correctly point-in-time (same
      required-asOf convention as every other `*AsOf` reader) but in
      practice will only ever fire time-based exits until yfinance
      ingestion is wired into `graph/pipeline.js` (separate, already-listed
      open item) -- `price_bars` has no real data yet, so stop-loss/
      take-profit can't evaluate for any position opened before that lands;
      (2) `config.maxPositionHoldDays` (10) is an untuned placeholder, same
      caveat as `MAX_PORTFOLIO_RISK_PCT`; (3) `checkOpenPositionExits` is a
      flat scan of every open position on every scheduled run -- fine at
      current/expected watchlist scale, would need a smarter query (e.g.
      only positions near a threshold) if the positions table grows large;
      (4) not yet exercised against a live scheduled run end-to-end, only
      against the fake-store tests -- consistent with every other
      not-yet-live-traffic-tested item below.
- [x] yfinance price/volume ingestion built: `schemas/index.js#PriceBar`,
      `migrations/0004_price_bars.sql` (`price_bars` table),
      `storage/d1.js#insertPriceBar/getPriceBarsAsOf` (point-in-time, same
      required-asOf convention as news/memory reads), `market_data_validator
      .js#validatePriceBar` now a real check (OHLC consistency, non-negative
      volume, non-future date) instead of the old "not yet implemented"
      stub, and `ingestion/sources/yfinance.js#fetchDailyBars` (mirrors
      gdelt.js's structure/config pattern). Covered by
      `test/price_bars_pointintime.test.js` (40 tests total in the suite
      now), including response-parsing against a mocked fetch.
      KNOWN GAPS carried forward: (1) UNVERIFIED against a live request --
      Yahoo's chart API has reportedly started requiring a cookie+crumb
      handshake for at least some requests (per recent yfinance library
      issue reports); this adapter does a plain fetch() and does NOT
      implement that handshake, so it may return 401/429 in production even
      though the parsing logic itself is tested and correct; (2) UPDATE: no
      longer true, see the technical analyst checklist item below --
      price_bars now has a real consumer; (3) daily bars only, no intraday.
- [x] Build a technical analyst agent to consume price_bars:
      `src/agents/analysts/technicalIndicators.js` (pure, no DB/LLM --
      `computeSMA`/`computePriceChangePct`/`computeVolumeRatio`/
      `computeTechnicalSnapshot`, same grounded-numbers convention as
      Adopted Pattern #9: every figure the LLM sees is a real computed value
      off `getPriceBarsAsOf` rows, never invented, and a `null` indicator
      means "not enough bars for that window", not zero) and
      `src/agents/analysts/technicalAnalyst.js` (the LLM-facing agent,
      parallel tier/shape to `newsEventAnalyst.js`/`sentimentAnalyst.js` --
      `agent: "technical"` was already anticipated in `schemas/index.js#
      AnalystOpinion`'s enum from an earlier session). Self-skips: when
      `computeTechnicalSnapshot` returns `{ hasData: false }` (no price bars
      at all for this ticker), `runTechnicalAnalyst` returns `null` WITHOUT
      calling the LLM, rather than asking a model to analyze nothing --
      proven directly in tests via a mocked `fetch` asserting it's never
      invoked in that case. `graph/pipeline.js`'s analyst stage now fetches
      `priceBars` via `getPriceBarsAsOf` and runs the technical analyst in
      parallel with news/sentiment, filtering the `null` out of
      `state.opinions` when there's no data.
      Covered by `test/technical_analyst.test.js` (16 tests: indicator math
      incl. null-when-insufficient-bars and divide-by-zero guards,
      `computeTechnicalSnapshot`'s `hasData` gate, the no-LLM-call
      guarantee via mocked fetch, and a grounding check proving the real
      computed close value -- not a placeholder -- ends up in the actual
      prompt sent to the model; 121 tests total in the suite now).
      KNOWN GAPS: (1) same as every other analyst here (news_event,
      sentiment) -- no unit test exercises the real "has data" LLM-call
      path end-to-end against a live model, only against mocked fetch, and
      structured.js still has no fake-model injection point for that; (2)
      in practice this agent will return `null` for every ticker until
      yfinance ingestion is wired into `graph/pipeline.js` (price_bars stays
      empty otherwise) -- same live-traffic-pipeline-wiring dependency as
      the exit-logic and signalCompare items above; (3) indicator windows
      (`smaWindow`/`momentumWindow`/`volumeWindow`, all default 5) are
      hardcoded defaults in `computeTechnicalSnapshot`, not yet exposed via
      `config.js` or tuned against anything real.
- [x] Build signal on/off backtest comparison harness (walk-forward windows
      already exist in `src/backtest/pointInTime.js#walkForwardWindows`):
      `src/backtest/metrics.js` (pure return-series stats -- cumulativeReturn,
      sharpeRatio (annualized), maxDrawdown, winRate, summarizeReturns) and
      `src/backtest/signalCompare.js` (`compareSignalOnOff` for two
      already-computed return series with a sign-normalized `delta` -- positive
      always means "signal looks better", including for maxDrawdown where a
      naive subtraction would have the wrong sign; `compareSignalOnOffByWindow`
      rolls that comparison across every `walkForwardWindows` window via
      caller-supplied `getOnReturns`/`getOffReturns` callbacks, plus one pooled
      overall comparison). Covered by `test/backtest_signal_compare.test.js`
      (14 tests, hand-checked metric values + walk-forward rolling/pooling
      behavior; 70 tests total in the suite now).
      HONEST SCOPE (see `signalCompare.js`'s header): this is the windowing +
      comparison MATH only, not an end-to-end backtest run -- it does not fetch
      or compute real trade returns itself. UPDATE: gap (1) below is now
      closed (`closePosition` has a real caller, see the exit-logic
      checklist item above) -- there IS now a realized-return series
      *mechanism*, it just has no live price data to compute a real return
      from yet, which is exactly gap (2)'s dependency. Still blocked on:
      (2) a real "signal on" run needs the full agent graph wired
      end-to-end against live data (GDELT/yfinance/rss/html_scrape, still
      not wired into `graph/pipeline.js`), and "signal off" needs a
      comparable no-signal baseline strategy that doesn't exist yet either.
      `getOnReturns`/`getOffReturns` are the exact seam where that real data
      plugs in later -- this harness itself won't need to change.
- [x] `checkpoint_resume` test added (`test/checkpoint_resume.test.js`):
      exercises `graph/checkpointer.js`'s stage ordering + resume/state
      semantics against a minimal in-memory fake of the `pipeline_checkpoints`
      D1 table (not a full D1 emulator -- honest, narrow scope, see the
      file's header). Does NOT exercise `runPipelineForTicker` end-to-end,
      since that needs live Gemini calls across six agent modules -- true
      integration-level resume testing is blocked on `agents/utils/
      structured.js` exposing a way to inject a fake model response.
- [x] `memory_pointintime` test added (`test/memory_pointintime.test.js`):
      verifies `getDecisionMemoryAsOf`'s strictly-before-asOf cutoff
      (Backtesting Integrity #4) and `fetchPriorLessons`'s formatted prompt
      text, against a minimal in-memory fake `decision_memory` table -- same
      honest, narrow-fake convention as `checkpoint_resume.test.js`. Does
      NOT exercise `recordAndReflect` (the write path, calls live Gemini).
- [x] Wire GDELT/yfinance/rss/html_scrape/edgar_fundamentals into
      `graph/pipeline.js` end-to-end -- the WIRING half only (see below for
      why the LIVE half is separate). `graph/pipeline.js#runScheduledIngestion`
      now calls every adapter, not just GDELT:
      `collectNewsItems(config)` fetches gdelt + rss + html_scrape and
      merges their items into one list; `ingestPriceBars(config, db)` calls
      `yfinance.js#fetchDailyBars` and upserts every bar via
      `insertPriceBar`; `ingestFundamentals(config, db)` calls
      `edgar_fundamentals.js#fetchLatest` and upserts every fact via
      `insertFundamentalFact`. All three are now exported from
      `pipeline.js` (previously only `runPipelineForTicker`/
      `runScheduledIngestion` were). `runScheduledIngestion` calls
      `ingestPriceBars`/`ingestFundamentals` before the news loop, so a
      same-run technical analyst call already sees freshly-landed bars.
      FAILURE ISOLATION CHANGE (worth flagging explicitly): the old
      GDELT-only `runScheduledIngestion` rethrew on any GDELT VendorError,
      aborting the whole scheduled run. With five independent vendors now
      in play that would mean one flaky source (e.g. EDGAR with no
      `edgarUserAgent` configured) kills ingestion for all the others --
      changed to per-source isolation instead: each source's VendorError is
      logged (vendor/transient/message) and that source alone is skipped,
      everything else still runs. Read literally, this is actually closer
      to Adopted Pattern #11's own wording ("follow an explicit configured
      fallback order -- never silently serve thinner data without logging
      that a source was skipped") than the old all-or-nothing behavior was.
      A non-VendorError (an actual bug) still propagates immediately,
      unchanged.
      Covered by `test/ingestion_wiring.test.js` (10 tests: collectNewsItems
      merging gdelt+rss+scrape and isolating a failing source, the
      unconfigured-sources-are-a-silent-no-op case, ingestPriceBars/
      ingestFundamentals against mocked fetch + a fake price_bars/
      fundamental_facts store, the edgarCikMap-empty no-op case
      distinguished from the map-set-but-no-User-Agent misconfiguration
      case, and one non-VendorError-still-throws test per helper; 131 tests
      total in the suite now). Does NOT exercise `runScheduledIngestion`
      end-to-end, since the news-item loop inside it still calls
      `runPipelineForTicker` -> six agent modules needing live Gemini calls
      -- same documented scope limit as `checkpoint_resume.test.js`.
      IMPORTANT ENVIRONMENT FINDING, reconfirm each fresh session: this
      sandbox's `bash_tool` network egress is BLOCKED from reaching GDELT
      (`api.gdeltproject.org`), Yahoo Finance (`query1.finance.yahoo.com`),
      and SEC EDGAR (`data.sec.gov`) -- confirmed via curl, HTTP 403 with
      `x-deny-reason: host_not_allowed`. That means the wiring above is
      real and tested against mocked responses, but has NOT been -- and
      currently CANNOT be, from this sandbox -- spot-checked against actual
      live vendor traffic. Every adapter's own header already flags its
      specific unverified risk (GDELT's empty-body gap, yfinance's
      cookie/crumb gap, etc); this item doesn't resolve any of those, it
      only makes the adapters reachable from the pipeline once a real
      network path exists.
      **UPDATE (2026-09-17): this block is bash_tool-specific, not absolute
      -- see the "Live-verify against real vendor traffic" checklist item
      below.** `mcp__Madmcp__web_fetch` reaches the internet through
      Madmcp's own server-side infra, not through the sandbox's egress
      proxy, and DOES reach all three of these hosts. Live-verification is
      possible from this sandbox after all, just not via bash/curl.
      KNOWN GAPS: (1) the live-spot-check gap above; (2) ~~real ticker->CIK
      resolution (SEC's `company_tickers.json`) still doesn't exist~~ --
      CLOSED, see the "Real ticker -> CIK lookup" checklist item below;
      (3) no throttling/backoff across the five
      sources when several are configured at once -- each adapter still
      makes its own unthrottled per-ticker/per-feed requests, sequentially,
      with no shared rate limiter; (4) `ingestPriceBars`/`ingestFundamentals`
      always fetch for the FULL watchlist/edgarCikMap on every scheduled
      run (no incremental/delta fetching) -- fine at current scale, would
      waste quota at a larger watchlist size.
- [x] Shared rate-limit pacer for the ingestion adapters (was KNOWN GAP 3 on
      the item above): `src/shared/throttle.js#createThrottle` -- a small,
      dependency-free, in-process pacer enforcing a minimum interval
      between successive `wait()` calls on ONE shared throttler instance.
      Deliberately NOT the same thing as `shared/cooldown.js`: cooldown.js
      is reactive (record + check a backoff *after* a real 429, KV-backed
      so it survives across separate Worker invocations -- fits Gemini's
      long-lived rate-limit windows); throttle.js is proactive in-run
      pacing only, no persistence, no vendor-response awareness at all --
      it just spaces calls apart. `minIntervalMs: 0` (the default) is a
      true no-op, same "no default without an explicit reason" convention
      as `rssFeeds`/`edgarUserAgent`.
      Wired into the one adapter that actually documents a rate limit:
      `ingestion/sources/edgar_fundamentals.js#fetchLatest`'s tickers x tags
      loop now creates ONE throttle (shared across the whole loop -- a
      fresh throttle per call would have no "last call" memory and pace
      nothing) and awaits `throttle.wait()` before every `fetchFacts` call.
      New `config.edgarMinRequestIntervalMs` (default 110ms, just over the
      100ms that exactly SEC's documented ~10 req/sec implies) -- UNLIKE
      `edgarUserAgent`/`rssFeeds`/`scrapePages`, this DOES ship a real
      default: it's a technical pacing value derived from SEC's own
      published number, not third-party identity/URL data that would be
      fabricated by defaulting it. `fetchFacts` itself (a single call, not
      the loop) is unaffected -- throttling only applies to calls made
      THROUGH `fetchLatest`'s own loop.
      Covered by `test/throttle.test.js` (10 tests: `createThrottle`'s
      first-call-never-waits/paces-off-previous-call/negative-interval-
      throws behavior against an injected fake clock+sleep (no real
      timers, no `node:test` mock.timers dependency), a test proving two
      fresh throttlers don't pace each other -- documenting why callers
      must share one instance -- and two `fetchLatest` wiring tests: a
      no-real-delay case when `edgarMinRequestIntervalMs` is unset, and a
      real ~150ms-apart-calls case when it is set, both against mocked
      fetch; 141 tests total in the suite now).
      KNOWN GAPS: (1) only EDGAR is throttled -- GDELT/yfinance/rss/
      html_scrape each still make one unthrottled request per
      ticker/feed/page with no shared pacing between them; this was a
      deliberate choice (EDGAR is the only adapter with a documented rate
      limit today) rather than an oversight, but if a real deployment hits
      rate limits on another vendor, `createThrottle` is already there to
      reuse, just needs wiring into that adapter's loop the same way; (2)
      `fetchFacts` called directly (bypassing `fetchLatest`) is still
      completely unthrottled -- fine today since nothing in this codebase
      calls it that way outside tests, but worth remembering if that
      changes; (3) like everything else touching SEC EDGAR, the actual
      pacing behavior is unverified against live traffic -- the sandbox's
      `data.sec.gov` network block (see the item above) means this can
      only be proven against mocked fetch, not confirmed to actually avoid
      a real 429 in production.

- [x] Real ticker -> CIK lookup: replaced `config.edgarCikMap` as the SOLE
      ticker->CIK source with a real lookup against SEC's public
      `company_tickers.json`, keeping `edgarCikMap` itself as an explicit
      per-ticker override rather than removing it.
    - `src/ingestion/sources/edgar_cik_lookup.js`: NEW file.
      `fetchTickerCikMap(config)` fetches+parses SEC's file (a ~1000-entry
      object keyed by arbitrary numeric strings, NOT an array and NOT
      keyed by ticker -- has to be scanned into a ticker-keyed map),
      requires `config.edgarUserAgent` (same SEC UA policy as
      `edgar_fundamentals.js`, this file is served from `www.sec.gov` not
      `data.sec.gov` but the UA requirement isn't host-specific). `getTickerCikMap(config, kv)`
      cache-aside wraps it via Cloudflare KV, same fails-open convention as
      `shared/cooldown.js` (a KV read/write failure falls through to a live
      fetch, never blocks resolution). `resolveCik(config, kv, ticker)`
      checks `config.edgarCikMap[ticker]` first (override wins, skips KV/
      fetch entirely), falls back to the live/cached SEC map, returns
      `null` (not a throw) when genuinely not found in either.
    - `edgar_fundamentals.js#fetchFacts`: now accepts an optional
      pre-resolved `cik` param to skip its own lookup -- but its OWN
      fallback (no `cik` passed) is still `config.edgarCikMap[ticker]`
      ONLY, unchanged from before this session, so a direct `fetchFacts`
      call for a ticker absent from `edgarCikMap` still throws immediately
      with zero network calls, same as always. The live SEC lookup only
      happens through `fetchLatest`.
    - `edgar_fundamentals.js#fetchLatest`: default ticker list is now
      `Object.keys(edgarCikMap)` when non-empty, else `config.watchlist`'s
      tickers (previously: ONLY `edgarCikMap`'s keys, so an empty map meant
      zero fundamentals ingestion no matter what else was configured).
      Resolves each ticker's CIK via `resolveCik` BEFORE the throttled
      `fetchFacts` call (an override or cache hit costs no throttle wait);
      a ticker that resolves to no CIK anywhere is logged
      (`console.warn`) and SKIPPED, not thrown -- deliberately different
      from `fetchFacts`'s own "missing from edgarCikMap" throw, since a
      live-lookup miss on one ticker in a larger batch is "no such ticker"
      information, not a reason to abort the whole run.
    - `config.js`: new `edgarTickerCikUrl` (default
      `https://www.sec.gov/files/company_tickers.json` -- DOES ship a real
      default, same "official published endpoint, not fabricated
      third-party data" reasoning as `edgarApiBase`) and
      `edgarCikCacheTtlSeconds` (default 86400 = 24h, same reasoning as
      `edgarMinRequestIntervalMs` -- a technical pacing/freshness constant,
      not identity/URL data). `edgarCikMap`'s own comment updated to
      describe it as an override, not the sole source.
    - `graph/pipeline.js#ingestFundamentals`: now takes a third `kv` param,
      threaded through to `fetchLatest` so `resolveCik`'s cache actually
      gets used in production; `runScheduledIngestion` passes
      `env.CACHE_KV`. Omitting `kv` (as every pre-existing test call site
      still does) works fine, it just means every lookup misses cache and
      re-fetches SEC's file live each time -- same fails-open behavior as
      not having KV at all.
    - `test/edgar_cik_lookup.test.js`: NEW file, 16 tests --
      `fetchTickerCikMap` (UA-missing throw, correct parsing of SEC's
      numeric-keyed shape incl. uppercasing + skipping malformed entries,
      transient-vs-non-transient VendorError by status/network-failure),
      `getTickerCikMap` (no-kv always-live, cache hit skips fetch, cache
      miss fetches+writes with the configured TTL, fails open on both a
      `kv.get` and a `kv.put` failure), `resolveCik` (override
      short-circuits kv/fetch entirely, live-map fallback, null on a
      genuine miss), and `fetchLatest` wiring (watchlist fallback when
      `edgarCikMap` is empty, skip-not-throw + warn-log for one
      unresolvable ticker while others still process, still a true no-op
      when both `edgarCikMap` and `watchlist` are empty, and a KV-sharing
      test proving two tickers in the same run only fetch SEC's file
      once). Full suite now 157/157 (was 141).
    - Every PRE-EXISTING edgar_fundamentals.js/pipeline.js test (map-based
      resolution, UA-missing throw, no-op-when-unconfigured, throttle
      wiring) still passes unmodified -- verified by running the full
      suite before writing any new test, not just the new file in
      isolation.
    KNOWN GAPS: (1) not verified against SEC's REAL `company_tickers.json`
    -- like everything else touching `*.sec.gov`, this sandbox's network
    block means the parsing logic is only proven against a mocked
    response shaped the way SEC's docs/existing samples describe;
    re-verify against a real fetch before relying on this in production if
    SEC ever changes the file's shape; (2) the KV cache key
    (`edgar:ticker-cik-map:v1`) is a single global entry for the WHOLE
    ticker->CIK map, not per-ticker -- fine at this file's size (~1000
    entries, comfortably under KV's 25MB per-value limit) but worth
    knowing if SEC's file ever grows enough to matter; (3) no cache-busting
    mechanism if SEC updates a CIK mid-TTL (e.g. a rare CIK reassignment)
    -- would self-correct within `edgarCikCacheTtlSeconds` (24h default),
    not immediately; not worth building a manual bust path for something
    this rare unless it actually happens.

- [x] Extend `throttle.js`'s pacing (previously EDGAR-only, see the item
      above it) to the four remaining ingestion adapters:
      `ingestion/sources/gdelt.js#fetchLatest`, `yfinance.js#fetchDailyBars`,
      `rss.js#fetchLatest`, `html_scrape.js#fetchLatest` -- same pattern in
      each: one `createThrottle` instance created per call, shared across
      that call's own loop (queries / tickers / feeds / pages
      respectively), `await throttle.wait()` before each iteration's fetch.
      `html_scrape.js` mirrors `edgar_fundamentals.js`'s split exactly:
      `fetchArticle` (the single-page function, analogous to `fetchFacts`)
      stays completely unthrottled -- only `fetchLatest`'s own loop paces.
      New config fields: `gdeltMinRequestIntervalMs`,
      `yfinanceMinRequestIntervalMs`, `rssMinRequestIntervalMs`,
      `scrapeMinRequestIntervalMs` -- UNLIKE `edgarMinRequestIntervalMs`,
      all four default to 0 (true no-op), because none of these vendors has
      a documented rate limit the way SEC does for EDGAR; shipping a
      nonzero default here would be fabricating a number, not deriving one
      from a published source (same "technical default vs. no default"
      distinction the config.js comments already draw for other fields).
      Each is still fully wireable via its own env var if a live deployment
      ever does start seeing 429s from one of these vendors.
      Covered by `test/throttle_ingestion_wiring.test.js` (10 tests: an
      unconfigured-stays-fast case + a configured-paces-at-~150ms-apart
      case for each of the four adapters, same real-timer-for-real-wiring
      convention as `throttle.test.js`'s own EDGAR wiring tests -- no
      injection seam exists from these call sites into `createThrottle`'s
      now/sleep, so these verify the actual production wiring path against
      mocked fetch, not a mock of the timing itself).
      IMPORTANT PROCESS NOTE: this session's sandbox had `bash_tool`
      network egress fully disabled (a change from prior sessions, which
      could `git clone`+`npm test` locally) -- all edits were made via the
      GitHub API tools (`edit_file`/`create_repo_file`) with NO local test
      run possible. Verification instead came from **CI actually passing
      for real** (see the CI fix item directly below) -- run
      https://github.com/allocsys/news-market-ai/actions/runs/35154079446's
      `test` job, commit `4aea327`+`0c2da1c`, completed/success. This is
      arguably a STRONGER verification than the usual sandbox `npm test`
      run (real GitHub Actions runner, not the dev sandbox), not a weaker
      one -- but flagging the changed workflow since every earlier
      checklist item's "142/141/157 tests passing" claims were sandbox-
      verified, not CI-verified, and future sessions should check which
      verification path is actually available before assuming the old one
      still is.
      KNOWN GAPS: (1) same residual gap as before -- `fetchFacts` bypassed
      directly, and now also `fetchArticle` bypassed directly, are still
      unthrottled, by design (mirrors the caller's own explicit single-item
      use case, not a loop); (2) all four new interval configs are 0 by
      default, so in practice NOTHING is throttled for these four vendors
      until an operator explicitly sets an env var -- this is a real
      behavior difference from EDGAR and is intentional, not a bug, but
      worth remembering if someone expects "throttle.js is wired in" to
      mean "pacing happens by default" for every adapter now; (3) still
      unverified against LIVE vendor traffic for the same reason as every
      other network-touching adapter in this doc.

- [x] Fixed a pre-existing, previously-undiscovered CI bug found while
      trying to verify the throttle-extension work above: the `test` job
      in `.github/workflows/deploy.yml` had been failing on EVERY run since
      CI was first added (run #1 through #8, all `completed/failure` on the
      `test` job, before any of today's changes) with
      `Could not find '.../test/**/*.test.js'`. Root cause: `package.json`'s
      `"test": "node --test 'test/**/*.test.js'"` single-quotes the glob,
      so the shell never expands it (no `shopt -s globstar` in play either
      way) and Node's own `--test` file-arg handling on the GitHub Actions
      runner's Node version does not itself glob-expand `**` -- it looked
      for one literal file named `test/**/*.test.js` and failed. This had
      been silently broken since the CI-add session; nobody had watched a
      run through to a real pass before now (see that session's own KNOWN
      GAP 3, "not yet verified against a real GitHub Actions run").
      FIX: `package.json`'s `test` script now reads
      `"node --test $(find test -name '*.test.js')"` -- shell command
      substitution enumerates the actual files first (portable POSIX `sh`,
      no bash-specific globstar needed), then passes them to `node --test`
      as literal file arguments, sidestepping Node-version-dependent glob
      support entirely. Confirmed fixed for real: pushing this fix (commit
      `0c2da1c`) produced a `test` job that completed `success` on the next
      run (https://github.com/allocsys/news-market-ai/actions/runs/35154079446),
      the first genuinely green CI test run this repo has ever had.
      KNOWN GAPS: (1) this only fixes the `test` job -- `migrate`/`deploy`
      still correctly fail-fast (by design) since `CLOUDFLARE_API_TOKEN`/
      `CLOUDFLARE_ACCOUNT_ID` repo secrets aren't set yet, unchanged from
      the CI-add session's own KNOWN GAP 3; (2) worth a periodic sanity
      check that `find test -name '*.test.js'` keeps matching every real
      test file as the suite grows -- low risk (it's a plain recursive
      name-glob, not fragile like the broken pattern was), but it's still
      an assumption a future added test file needs to satisfy (name ending
      in `.test.js`, located somewhere under `test/`).

- [x] User added the three repo secrets (`CLOUDFLARE_API_TOKEN`,
      `CLOUDFLARE_ACCOUNT_ID`, `GEMINI_API_KEYS`), and asked for a secret-
      leak audit of the resulting Actions logs. Triggered a real
      `workflow_dispatch` run and read the raw job logs (not just the
      error-filtered view) with targeted grep patterns for anything
      secret-shaped. Result:
      NO ACTUAL CREDENTIAL LEAKED -- `CLOUDFLARE_API_TOKEN`,
      `CLOUDFLARE_ACCOUNT_ID`, and `GEMINI_API_KEYS` all show as `***`
      everywhere in the logs (GitHub auto-masks registered secret values
      wherever they appear), and the `wrangler secret put GEMINI_API_KEYS`
      step never echoes the key itself -- only "Uploaded secret
      GEMINI_API_KEYS".
      REAL LEAK FOUND, THEN FIXED: both `.github/actions/ensure-d1-database`
      and `.github/actions/ensure-kv-namespace` let `wrangler ... create`'s
      own stdout print directly to the log -- and that output includes a
      wrangler.toml snippet with the REAL resource id (D1 database UUID /
      KV namespace id) in plaintext. Each action's own `::add-mask::` for
      that id was only registered afterward, from a SEPARATE re-query via
      `list` -- too late to redact `create`'s own already-printed output.
      Confirmed by reading the actual raw log lines from run
      https://github.com/allocsys/news-market-ai/actions/runs/35155406076:
      a real D1 database UUID and a real KV namespace id both appeared in
      plaintext, once each, exactly at the `create` step.
      FIX (commits `da3c31c`, `5c0794c`): both actions now capture
      `create`'s output into a variable instead of letting it print
      directly, extract the id from that captured text via a regex, and
      `echo "::add-mask::$ID"` on it BEFORE printing the captured output --
      GitHub's add-mask retroactively redacts that literal string in any
      log line emitted AFTER the mask is registered, so this keeps
      `create`'s own diagnostic text (useful if creation ever fails) while
      no longer showing the raw id anywhere. Failure handling preserved
      explicitly (`set +e`/capture-exit-code/`set -e` around the capture,
      then a real `exit 1` with the (now-masked) output already printed if
      `create` failed) rather than letting `set -euo pipefail` silently
      swallow the diagnostic on a failure path, which a naive
      `X=$(cmd)`-under-`set -e` fix would have done.
      NOT RETROACTIVELY FIXABLE: the two ids already printed in plaintext in
      that one specific run's log (35155406076) stay visible in THAT run's
      history -- GitHub's masking only ever applies going forward from
      registration, never backfills already-emitted lines, and there's no
      tool-based way to redact a historical run's log after the fact (only
      a manual "delete this run" in the Actions UI, which the user hasn't
      been asked to do and Claude can't do itself). Told the user this
      directly. Practical severity is low regardless -- a bare D1 database
      UUID or KV namespace id grants no access on its own without a valid
      Cloudflare API token alongside it -- but the fix closes the actual
      hole for every future first-time-creation run (a redeploy to a fresh
      Cloudflare account, a renamed database/namespace, etc).
      KNOWN GAPS: (1) not exercised against a REAL second creation event
      this session (the D1 database and KV namespace now already exist from
      run 35155406076, so the idempotent "already exists" branch runs on
      every subsequent call, not the `create` branch this fix touches) --
      the fix is code-reviewed and logically sound (mirrors the exact
      capture-then-mask-then-print order needed) but not fire-tested against
      a fresh Cloudflare account/renamed resource; (2) the `grep -oE`
      extraction patterns (`database_id = "[^"]+"` / `id = "[^"]+"`) assume
      wrangler's create-output snippet format stays stable -- same class of
      assumption as the existing `list`-based lookups' own defensive
      multi-key JSON parsing, worth re-checking if a wrangler upgrade ever
      changes that output shape.

- [x] Live-verified GDELT/yfinance/SEC EDGAR/RSS/HTML-scrape against REAL
      vendor traffic for the first time -- previously only possible against
      mocked fetch (see the "IMPORTANT ENVIRONMENT FINDING" note above,
      updated in place today rather than left stale). Key unlock:
      `mcp__Madmcp__web_fetch` reaches the internet through Madmcp's own
      server-side infra, NOT through the sandbox's `bash_tool` egress proxy
      -- the latter is domain-allowlisted and does block
      api.gdeltproject.org/query1.finance.yahoo.com/data.sec.gov, but the
      former isn't subject to that allowlist at all. USAGE GOTCHA worth
      remembering: `web_fetch`'s default behavior returns pre-extracted/
      stripped plain text for an HTML page, not raw markup -- irrelevant for
      JSON API endpoints, but you MUST pass `raw_html: true` to actually
      test regex-based HTML parsing (jsonify.js's `stripHtml`/
      `extractPageTitle`/`extractPublishedAt`) against something real.
      FINDINGS, by vendor:
      - **GDELT** (api.gdeltproject.org/api/v2/doc/doc): reachable, but got
        a real HTTP 429 ("please limit requests to one every 5 seconds")
        on every attempt (3 tries, different queries, spaced apart across
        the session) -- never obtained a live articles[] body. This confirms
        gdelt.js's `429 -> transient: true` VendorError handling is exactly
        correct vendor behavior, and gives a REAL number (GDELT's own
        documented "5 seconds" pacing) where `config.gdeltMinRequestIntervalMs`
        currently defaults to 0 -- worth reconsidering that default now,
        though repeated 429s even after spacing suggest this may be a
        persistent/shared-IP rate limit on the fetch infra rather than pure
        request-cadence, so pacing alone might not fully fix it.
      - **yfinance** (query1.finance.yahoo.com/v8/finance/chart/AAPL): HTTP
        200, real data, plain fetch, NO cookie/crumb handshake needed right
        now. Response shape is an exact match for `fetchDailyBars`'s parsing
        assumptions. This CORRECTS a previously-documented claim (both here
        and in yfinance.js's own header, both now updated) that Yahoo had
        started requiring a cookie+crumb handshake -- not true for this
        request pattern as of this check. Risk kept flagged, not deleted:
        Yahoo is unofficial/undocumented and could change this without notice.
      - **SEC EDGAR companyfacts** (data.sec.gov/api/xbrl/companyfacts/
        CIK0000320193.json, with a real descriptive User-Agent) and the
        companyconcept endpoint for us-gaap/Revenues specifically: both HTTP
        200, real Apple Inc. data, exact shape match for
        `edgar_fundamentals.js#fetchFacts`'s parsing
        (`units.<UNIT>[].{val,fy,fp,form,filed,accn}`) -- confirms the
        "Revenues" tag `fetchLatest` defaults to is real and populated, not
        just assumed to exist.
      - **SEC company_tickers.json** (www.sec.gov/files/company_tickers.json,
        with UA header): HTTP 200, real data, exact shape match for
        `edgar_cik_lookup.js#fetchTickerCikMap`'s parsing (object keyed by
        arbitrary numeric-string index, each value `{cik_str, ticker,
        title}`) -- confirmed real AAPL/NVDA/MSFT/GOOGL/AMZN/TSLA entries,
        uppercase tickers, numeric cik_str, no mismatch found.
      - **RSS** (feeds.a.dj.com/rss/RSSMarketsMain.xml -- WSJ Markets feed,
        picked arbitrarily since `config.rssFeeds` has no default and is
        100% env-configured): HTTP 200, real standard RSS 2.0 XML --
        `<item>` blocks with `<title>`, `<link>text</link>` (plain-text
        link, not an href attribute -- correctly handled by
        `jsonify.js#extractTag`, not `extractLinkHref`), `<description>`
        CDATA-wrapped, `<pubDate>` in RFC822 format, confirmed by inspection
        to match `parseFeedItems`'s regex logic exactly, including the
        "callers run pubDate through `new Date()` themselves" convention.
        Atom format (`<entry>` blocks) remains UNTESTED against a real feed
        -- only against mocked fixtures so far.
      - **HTML-scrape** -- MIXED, with one real newly-discovered gap: two
        major finance-publisher pages (`reuters.com/technology/`, and a real
        WSJ article URL pulled from the RSS feed above) both returned HTTP
        401 with a bot-challenge page body ("Please enable JS and disable
        any ad blocker") -- real Cloudflare/PerimeterX-style bot blocking,
        not a sandbox artifact. `html_scrape.js#fetchArticle`'s plain
        `fetch()` will hit exactly this 401 VendorError against the kind of
        major finance-publisher pages someone would most want to point it
        at -- matches the code's own non-ok-response handling correctly,
        but is a genuinely new, previously-undocumented practical limitation
        (not previously listed in html_scrape.js's KNOWN GAPS). A Wikipedia
        page (`en.wikipedia.org/wiki/Apple_Inc.`) and a Yahoo Finance news
        article page both returned HTTP 200 (not bot-blocked) with real
        HTML confirming `extractPageTitle`'s `<title>` fallback path works
        against real markup -- but neither page exposes a genuine
        `article:published_time`/`datePublished` meta tag, so
        `extractPublishedAt`'s pattern list is STILL untested against a real
        positive match (only against mocked fixtures) -- this remains open.
        Also worth noting as its own finding: the Yahoo Finance article page
        is a heavy SPA with tens of KB of inline `<script>`/`<style>` before
        any content-bearing meta tags appear -- not a correctness problem
        for the regex-based extraction (it will still find tags wherever
        they are), but a real illustration of how much boilerplate
        `stripHtml`'s script/style stripping has to wade through on a
        modern page.
      KNOWN GAPS: (1) `extractPublishedAt`'s meta-tag patterns are still
      untested against a real page that actually has one of the four
      patterns present -- need to find a scrapeable (non-bot-blocked) page
      that exposes `article:published_time`, `datePublished`, or a
      `<time datetime=...>` tag; (2) Atom-format RSS (`<entry>` blocks) is
      still untested against a real feed; (3) GDELT's actual `articles[]`
      JSON body shape was never obtained live (every attempt 429'd) -- the
      shape assumption in `gdelt.js` remains verified only against mocked
      fixtures, unlike every other vendor here; (4) none of this changes
      any adapter's actual behavior/code (aside from the two header-comment
      corrections) -- it's verification only, confirming existing parsing
      logic against real responses rather than finding bugs to fix (the
      html_scrape bot-blocking finding is the one exception: a real,
      previously-undocumented practical limitation, not just a confirmation).
