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
      KNOWN GAPS: (1) the live-spot-check gap above; (2) real ticker->CIK
      resolution (SEC's `company_tickers.json`) still doesn't exist --
      `edgarCikMap` is still the hand-maintained list, same as before, and
      fetching/caching that file is separately blocked on the same
      `data.sec.gov` restriction; (3) no throttling/backoff across the five
      sources when several are configured at once -- each adapter still
      makes its own unthrottled per-ticker/per-feed requests, sequentially,
      with no shared rate limiter; (4) `ingestPriceBars`/`ingestFundamentals`
      always fetch for the FULL watchlist/edgarCikMap on every scheduled
      run (no incremental/delta fetching) -- fine at current scale, would
      waste quota at a larger watchlist size.
