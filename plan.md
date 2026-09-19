# News → Market Analysis → Trade Signal Pipeline

_Trimmed 2026-09-19. Per-step PR narration, CI-run notes and investigation
logs that used to live here are in git history (`git log -p plan.md`). Section
names, "Adopted Pattern #N", "Backtesting Integrity point N" and "Step N"
labels are unchanged because code comments reference them._

## Goal
An AI-driven pipeline that ingests financial news, summarizes it, has a second
LLM reason about likely market impact, and turns that analysis into trade
signals. Needs a historical archive for backtesting and fine-tuning.

## Prior Art
- **[TradingAgents](https://github.com/TauricResearch/TradingAgents)** — primary
  architectural reference (multi-agent: analysts → bull/bear debate → trader →
  risk → portfolio sign-off). See Adopted Patterns.
- **Agentic-AI-Trading-Bot** (fsaavedra0003) — minimal folder-layout reference.
- **llm-news-sentiment-agent** (rkaravangelis) — 5-band sentiment schema +
  mandatory justification field.
- **llm-rl-finance-trader** (franjgs) — prove a news signal helps via Sharpe
  comparison instead of assuming it does.
- Also scanned: LLM-Enhanced-Trading, Stock-Market-News-Sentiment-Analysis and
  the `news-sentiment` GitHub topic (FinBERT/Kafka/TimescaleDB/EDGAR patterns).

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
   Integrity below, this is also the easiest place to leak information.
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
1. **Ingestion** — normalize every source (RSS, scraped HTML, filings, APIs) into one
   JSON schema at the boundary: `id` (sha256 of source_url + published_at), `source`,
   `url`, `published_at` (exact public timestamp, not ingestion time), `ingested_at`,
   `tickers`, `title`, `body`, `raw` (original payload). Dedup on `id`/URL.
   Sources: Finnhub `/company-news` (primary; GDELT was replaced, see Known Gaps),
   RSS, HTML scrape, yfinance (bars), SEC EDGAR (XBRL fundamentals).
2. **Storage** — D1 (structured, indexed by ticker + published_at). R2 is an
   unused option for a raw archive if D1 is ever outgrown.
3. **Analyst Team** — parallel News/Event, Sentiment (5-band + justification) and
   Technical analysts on the quick model.
4. **Researcher Team** — Bull and Bear argue from the analysts' output; the Research
   Manager (judge) reconciles into one verdict (direction, confidence, horizon).
5. **Trader** — turns the verdict into a trade thesis (instrument, rationale). Never sizes.
6. **Risk + Portfolio** — deterministic (no LLM): sizing, stop-loss/take-profit, then
   portfolio go/no-go against a total-risk ceiling. The LLM never sizes positions.
7. **Historical data for backtesting** — point-in-time correctness (below); validated
   by signal on/off comparison (Sharpe, cumulative return, max drawdown).

## Backtesting Integrity (no look-ahead)
Must be true by construction, not by discipline.
1. **Hard cutoff per simulated timestamp `T`** — agents may only read news/price
   data timestamped `<= T` and memory entries strictly before `T`. Enforced at the
   data-access layer (`storage/d1.js` requires an explicit `asOf`), not by trusting the agent.
2. **Revision-aware storage** — every article revision stored with its own timestamp;
   serve the version that existed at `T`.
3. **Point-in-time fundamentals** — built for XBRL filers via EDGAR companyfacts
   (`getFundamentalFactsAsOf`, keyed by filing date). Residual gap: price data and
   other free sources aren't point-in-time; EDGAR covers US-listed XBRL filers only.
   The dashboard's Charts view follows the same convention (see `renderChartsView`).
4. **The reflection/memory loop is the easiest place to leak the future** — memory fed
   to an agent at `T` must only contain reflections resolved before `T`, same filter as point 1.
5. **Walk-forward validation** — roll the cutoff forward in fixed windows, not one
   static split.
6. **A leak-check test, not just a design doc** — CI asserts zero rows returned to
   the agent have a timestamp after `T`.
7. **Backtest state must not touch live state, and vice versa.** _Currently
   violated_ — see "Backtest / Live Isolation" below.

## Backtest / Live Isolation — OPEN (verified 2026-09-19)
**Problem:** backtest and live runs share the same D1 tables and nothing marks
which run wrote a row. Verified by reading the code and running read-only
queries against production D1 (`news_market_ai`, 2026-09-19 ~04:35Z).

### What is and isn't shared
| Store | Tagged by run type? | Notes |
|---|---|---|
| `positions`, `trade_decisions`, `decision_memory` | **No** | Written by both paths; every reader (agent-facing and dashboard) is unfiltered |
| `pipeline_checkpoints` | Partly | `run_id` = news item id (live) vs `<testStart>\|<ticker>\|<itemId>` (backtest) — no live/backtest collision, but no link to `backtest_runs.id` |
| `llm_calls` | **Yes** (`source`, `job_id`) | Already isolatable; only the default list view is unfiltered |
| `backtest_runs`, `job_progress` | Backtest-only | Fine |
| `news_items`, `price_bars`, `fundamental_facts` | Shared **by design** | Immutable market data; leave shared |

### Verified failure modes
1. **A backtest closes live positions, at simulated (even future) dates.**
   `checkOpenPositionExits(asOf)` → `getOpenPositionsAsOf` has no ticker/scope
   filter, and `onSignalRunner.js` calls it for every day in
   `[testStart, testEnd + graceDays]` (`graceDays` defaults to
   `maxPositionHoldDays` = 10, so the walk runs past today). Any live position
   older than 10 simulated days gets a `time_based` exit at the latest real bar,
   stamped with the simulated date. **Evidence:** 26 positions have
   `closed_at` up to 2026-09-29 and 17 `decision_memory` rows have
   `resolved_at` in the future — live-opened positions (not in any backtest
   checkpoint) among them.
2. **The dashboard and the pipeline disagree about what is open.**
   `getOpenPositionsRiskPctAsOf(now)` treats `closed_at > now` as still open,
   while the dashboard's `getOpenPositionsExposureTotal` uses `closed_at IS
   NULL`. **Evidence:** the dashboard shows 1 open position / 3.25%; the
   pipeline's math sees 27 open / 88.25% (AAPL alone: 24 / 78.5%). The
   future-dated closes do **not** change the pipeline's number (those positions
   were open before and still count as open until the simulated date). They only
   hide the positions from the dashboard and stamp bogus outcomes into memory.
   The high exposure itself is a separate live bug, see "Overlapping open
   positions" below.
3. **Reflection contamination, both directions.**
   - Live → poisoned: `getDecisionMemoryAsOf` filters only `ticker` +
     `resolved_at < asOf`, so live debates read backtest reflections (3 of the 24
     memory rows come from backtest pipeline runs; the future-dated ones start
     feeding live prompts on 09-27).
   - Backtest → invalid: `getRealizedReturnsInRange` reads every
     `decision_memory` row for the ticker/window, live outcomes included. The
     signal on/off comparison (Adopted Pattern #6) is therefore not measuring
     the strategy alone.
4. **Silent id collisions.** `tradeThesisId` = `ticker|asOf` (`risk.js`), with
   `asOf` = news `published_at` in both paths, and `openPosition` /
   `insertTradeDecision` / `recordDecisionOutcome` are all `ON CONFLICT DO
   NOTHING`. Whoever writes first wins; the other run's rows vanish silently.
   **Observed** between two backtest windows (`AAPL|2026-09-13T08:45:00Z`, run
   twice). **Latent** live-vs-backtest: `ingestTickerData` enqueues ANALYZE for
   every fetched item even if `insertNewsItem` hit a conflict, so a live run on
   an already-backfilled item will collide with the backtest's rows.
5. **No cleanup path.** No row except `llm_calls.job_id` carries the backtest
   id, and a failed run just marks `backtest_runs` failed. **Evidence:** 9 runs
   (8 failed, 1 complete), 13 backtest-style checkpoints (3 stuck at `analyzed`),
   4 backtest-opened positions still in `positions`.
6. **Re-running an identical window is a no-op.** `runId` = `testStart|ticker|itemId`
   has no job id, so a second run resumes the finished checkpoints and returns
   early — stale results, no fresh LLM run, and it hides prompt/config changes.
7. **Concurrent visibility.** Backtests run on `LLM_JOBS` and live analysis on
   `ANALYZE` (different consumers), so live decisions made mid-backtest see its
   intermediate positions.
8. **Dashboard mixes streams.** `getRecentTradeDecisions`, `getAllOpenPositions`,
   `getRecentlyClosedPositions`, `getOpenPositionsExposureTotal`,
   `getDecisionStats` and `getRecentCheckpoints` are unfiltered.

### Proposed fix (tagging + scoped access; no second database)
- **Migration `0013_run_scope.sql`:** `run_scope TEXT` (NULL = live, else the
  backtest job id) on `positions`, `trade_decisions`, `decision_memory` and
  `pipeline_checkpoints`, plus indexes. `ALTER TABLE ... ADD COLUMN`, no table rebuild.
- **Scope-unique ids:** backtest `tradeThesisId` = `<scope>|<ticker>|<asOf>`
  (`evaluateRisk` takes an optional scope). Live ids stay `ticker|asOf`, so no PK
  change and no live data rewrite.
- **Thread scope like `withLlmLogContext`:** a `withRunScope(config, id)` helper;
  every function in `storage/d1.js` touching those tables filters
  `run_scope IS ?` (NULL-safe). Covers `getOpenPositionsAsOf`,
  `getOpenPositionsRiskPctAsOf`, `getOpenPositionForTickerAsOf`,
  `getDecisionMemoryAsOf`, `getRealizedReturnsInRange`, the write functions,
  `checkOpenPositionExits`, `settlePositionOutcome` and the checkpointer.
- **A backtest sees only its own scope** (empty memory and positions at start).
  Walk-forward windows inside one run share a scope, so lessons still accumulate
  within it. Runs become reproducible and independent.
- **Never simulate the future:** clamp the backtest walk end to today, and have
  the live exit check reject `asOf` > now.
- **Dashboard:** default to live only (`run_scope IS NULL`); the backtest detail
  page reads by scope; add delete-by-scope for failed runs.
- **Tests (extends Backtesting Integrity point 6):** after a backtest, zero
  live-scope rows changed; live memory reads return zero backtest rows; the same
  `ticker|asOf` in two scopes doesn't collide; an identical window run twice
  re-executes.
- **Rejected alternative:** a separate D1 for backtests. Hard isolation, but a
  second binding, duplicated schema/migrations and copied market data.

**Order:** (1) clamp the walk + live `asOf` guard (no migration); (2) migration +
scoped storage layer + tests; (3) dashboard filter + delete-by-scope.
**Until (2) ships, don't run a backtest over a window that overlaps live data.**

### Overlapping open positions (separate live bug, found during this check)
Not caused by backtests. 23 of the 24 open AAPL positions were opened by the
live pipeline (09-17 13:12 → 09-18 18:41), all overlapping. Mechanism (from
`pipeline.js`, consistent with the data): ANALYZE runs at `max_concurrency` 2
and each run uses the article's `published_at` as `asOf`. `getOpenPositionForTickerAsOf`
only sees positions opened at or before that `asOf`, and the replace step closes
at most one (`LIMIT 1`). An older article processed after a newer one opens its
own position and nothing ever closes it. Evidence: `trade_decisions.created_at`
is not in `as_of` order (AAPL `09-18T12:47:00` was decided at 16:01, before
`09-18T08:37:53` at 19:02).
**Impact:** every non-AAPL live thesis sees 0.58–0.89 open exposure against the
0.20 ceiling and is rejected (6 rejections on 09-18: EVR, GOOGL, INTC, MSFT, NVDA,
SKHY; per-decision causation not replayed).
**Options (needs an owner decision, changes live trading behavior):**
(a) enforce at most one open position per ticker at write time by closing every
other open position for it as `replaced`, regardless of `asOf` order;
(b) process ANALYZE per ticker in `published_at` order; (c) cap the ceiling
check per ticker. Not started.

**Proposed one-off repair (NOT run; needs owner approval, copy the affected rows
into `_bak_*` tables first):** (1) delete the backtest-derived rows: 4 positions,
3 `decision_memory` rows, 9 distinct `trade_decisions` and 13 checkpoints
(identify via checkpoints whose `run_id` contains `|`; thesis id in
`state.riskDecision.tradeThesisId`); (2) delete `decision_memory` rows with
`resolved_at > now`; (3) reopen positions with `closed_at > now` (`closed_at`,
`close_reason`, `exit_price` → NULL). This makes the ledger honest and the
dashboard agree with the pipeline (27 open / 88%). It does **not** unblock live
trading; that needs the overlapping-position fix above.

## Deployment: Cloudflare Workers + D1 + KV (free tier)
| Resource | Free limit | Implication |
|---|---|---|
| Workers | 100K requests/day, 10ms CPU/invocation | CPU time excludes `fetch()` wait, so LLM-calling steps barely touch the budget |
| D1 | 5GB storage, 5M rows read/day, 100K rows written/day (hard-enforced) | Batch inserts, dedupe before writing |
| KV | 1GB storage, 100K reads/day, 1K writes/day | Only for low-frequency state (LLM key/model cooldowns) |
| Queues | 10K ops/day | ~5 guaranteed messages per 15-min tick at 3 tickers, plus one ANALYZE per new item; re-check before growing the watchlist |

**Architecture (built 2026-09-19):** four Workers connected by queues, all binding
the same D1 (only `backend` runs migrations) and the same `CACHE_KV`.
- **`dashboard`** (`wrangler.dashboard.toml`, `src/dashboard-worker.js`) — the only
  public Worker: login, session cookie, server-rendered UI. Reaches `backend`
  through a service binding. Holds the dashboard login secrets.
- **`backend`** (`wrangler.toml`, `src/index.js`) — private (no workers.dev, no
  routes). JSON `/api/*`, `POST /backfill`, `POST /backtest/run`, the `*/15` cron
  `scheduled()` (pure fan-out: per-ticker `ingest_ticker` + one `ingest_feeds`
  onto `INGEST`, one `exit_check` onto `LLM_JOBS`), D1 migrations, and the `JOBS`
  consumer (`backfill` only). Holds `FINNHUB_API_KEY` for `backfill` only.
- **`ingest`** (`wrangler.ingest.toml`) — `INGEST` consumer (`max_batch_size` 10).
  Fetches Finnhub/yfinance/EDGAR/RSS/scrape, writes D1, enqueues one `analyze`
  per item (per item×ticker for general feeds) onto `ANALYZE`.
- **`llm`** (`wrangler.llm.toml`) — the only Worker holding `GEMINI_API_KEYS` and
  the `gemini:cooldown:*` KV keys. Consumes `ANALYZE` (`max_batch_size` 5,
  `max_concurrency` 2 = the Gemini throttle; failures **retry**, since the
  pipeline is checkpoint-resumable) and `LLM_JOBS` (`backtest`, `exit_check`;
  batch 1, concurrency 1; failures are logged and acked).

Every queue has a DLQ (`max_retries` 3). D1 is the structured layer; KV holds
cooldown state and light config.

**CI/CD** (`.github/workflows/deploy.yml`): `test` → `migrate` (push/dispatch,
gated on `migrations/**`) → one deploy job per Worker (`deploy`=backend,
`deploy-dashboard`, `deploy-ingest`, `deploy-llm`), each with its own
`dorny/paths-filter` output and `concurrency` group; `workflow_dispatch` runs
all. Provisioning is idempotent via `.github/actions/ensure-{d1-database,
kv-namespace,queue}` (look up by name, create if missing, never commit ids; the
first two take a `wrangler-config` input so each Worker's job patches its own
file). Worker jobs use `needs: [changes, migrate]` with `if: always() &&
(needs.migrate.result == 'success' || needs.migrate.result == 'skipped')`.
Deploy path filters live in `.github/path-filters.yml`, and each target is
diffed against its own last successful deploy.

**Per-Worker secrets:** each deploy job fails fast on its own required secrets
and pushes them with `wrangler secret put --config <its file>`. `dashboard`:
`DASHBOARD_USERNAME/PASSWORD`, `JWT_SECRET`, `SESSION_TTL_SECONDS`. `backend`:
`FINNHUB_API_KEY`. `ingest`: `FINNHUB_API_KEY` (+ `EDGAR_USER_AGENT`/
`EDGAR_CIK_MAP` vars). `llm`: `GEMINI_API_KEYS`. Repo-wide:
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. Optional groups use a bash
`-z` guard (the `secrets` context is rejected in a step `if:`). Provisioning
actions mask ids before printing (a plaintext-id leak was found and fixed).

_Design precedent:_ the per-Worker-job/secret shape follows
`allocsys/ai-campaign-builder`'s `deploy.yml`, minus its npm-workspaces layout
(this repo keeps a flat `src/`).

## LLM Calling Layer: Multi-Key Gemini Cascade (ported from `madmcp`)
**Two-axis cascade, model-first:** the outer loop tries `[requestedModel,
...GEMINI_FALLBACK_MODELS minus requestedModel]` across every key before dropping a
tier; the inner loop rotates `GEMINI_API_KEYS` on 401/403 (skip key), 429/503 or
transient network failure. Model-first because 429/503 is usually per-model/per-key quota.

**Cooldown:** KV `gemini:cooldown:<model>:<keyIndex>` with `expirationTtl`, written
only on a rate-limit event (fits KV's 1K writes/day); fails open if KV is unreachable.

Other rules: a bad key is skipped, not fatal; an explicit non-default model
request is honored exactly; the serving model/key is tagged for logging. Nothing
calls Gemini directly. **The fallback list must differ from the requested model**
— a list containing only the quick model gave quick-tier calls a one-model cascade
(a single 503 killed a whole backtest before PR #41). `wrangler.llm.toml` now
lists three distinct models: quick `3.1-flash-lite → 2.5-flash-lite → 2.5-flash`;
deep tier prepends `3.5-flash`.

### LLM call log (dashboard "LLM calls" page)
Every Gemini prompt and raw response, including failed calls, goes to `llm_calls`
(migration 0012), shown at `/dashboard/llm` (filters: source/status/ticker/
backtest/run) and `/dashboard/llm/:id`.
- **One choke point:** `agents/utils/structured.js#callStructured` writes the row.
  Context (`source`, `jobId`, `runId`, `ticker`) rides on `config.llmLog`
  (`storage/llm_calls.js#withLlmLogContext`), set by `llm-worker.js` and
  `runPipelineForTicker`.
- **Best-effort:** a failed log write never fails or slows the call.
  `LLM_LOG_ENABLED="false"` turns it off.
- **Cost:** ~4 D1 rows written per call (table + 3 indexes) against 100K/day. Rows
  older than `LLM_LOG_RETENTION_DAYS` (14) are pruned on the exit-check tick; prompt
  and response are each clipped at `LLM_LOG_MAX_CHARS` (60000), true lengths kept.
- **Not logged:** stages skipped on checkpoint resume; anything before migration 0012.

## Roadmap: Service Split — DONE 2026-09-19
**Why:** one Worker ran the cron pipeline, the SSR dashboard, login and long manual
jobs. Free-plan limits bite per invocation (10ms CPU, 50 subrequests); queue/cron
consumers get 15 min wall time; `ctx.waitUntil` extends only ~30s.
**Rules used:** one repo, one `wrangler` config per Worker, shared code imported
(never copied), only `backend` migrates, one PR per step, squash-merge, never
work on `main` directly.

- **Step 0 — Diagnose (2026-09-18).** Free tier; the failing limit was **CPU time**
  (`exceededCpu` on nearly every `*/15` tick since 2026-09-17 15:21, wall time
  under ~6s). Timing lined up with the entity-resolution default flip on 09-17
  (plausible, unconfirmed).
- **Step 1 — Backend JSON API (PR #27).** `src/dashboard/data.js` per-section
  fetchers and `src/dashboard/api.js` with 8 `/api/*` routes reusing `checkAuth`.
  Fixed an exposure bug (summing a Rows-limited array in 3 places) with
  `getOpenPositionsExposureTotal`.
- **Step 2 — Dashboard Worker (PR #28).** Owns login, session and UI; `backend`
  serves no HTML and is reachable only via service binding. Header-based
  `X-Backfill-Secret` auth removed — the dashboard session is the only gate.
  Live-verified with a `workflow_dispatch` deploy.
- **Step 3 — Job queue (PR #29).** `JOBS` + DLQ; `POST /backfill` and
  `POST /backtest/run` validate and enqueue; business failures persist as `failed`
  rows rather than retrying (a retry would re-spend quota).
- **Step 4 — Cron fan-out (PR #30).** `scheduled()` is a thin scheduler onto
  `INGEST` and the exit-check queue; ANALYZE is the one consumer that retries
  (checkpoint-resumable, `openPosition` id-idempotent).
- **Step 5 — `ingest` Worker (PR #31).** `INGEST` consumer moved out. **Deliberate
  gap:** `backend` still holds `FINNHUB_API_KEY` because `backfill` calls Finnhub
  and `JOBS` allows one consumer; closing it needs a second queue.
- **Step 6 — `llm` Worker (PR #32).** Wider than "move ANALYZE": `backtest` and
  `exit_check` also call Gemini, so they moved to a new `LLM_JOBS` queue. Fixed a
  latent bug where `ensure-*` actions hard-coded `wrangler.toml` and
  `deploy-ingest` skipped them (would have shipped `REPLACE_WITH_*` ids). Rollout
  note: a `backtest`/`exit_check` message on `JOBS` at backend-deploy time is
  acked and dropped.
- **Step 7 — Cleanup and docs (PR #33).** Dead-code check in `backend` came back
  clean (esbuild tree-shakes the shared `pipeline.js`); secrets audit matched
  `deploy.yml` to code; docs rewritten for the 4-Worker layout. The stale
  `GEMINI_API_KEYS` secret on `backend` was deleted in the Cloudflare dashboard.

### Post-split follow-ups (2026-09-19)
- **wrangler v3 → v4 (PR #34, #35).** CI had failed since run #219 at
  `wrangler queues create`: v3 silently sent a 4-day message retention, over the
  free tier's 86400s cap (fixed upstream only in v4, workers-sdk#12458). Now v4
  (Node ≥ 22) with explicit `--message-retention-period-secs 86400`; `ensure-queue`
  matches `already (exists|taken)` / `code: 11009`. Run #237 was the first fully
  green deploy of all four Workers.
- **Stale secrets on `backend` broke the whole dashboard (fixed).** The login
  secrets were never deleted from `backend` after Step 2; `checkAuth` is a no-op
  only when they're unset, so every `/api/*` call returned 401. **Lesson:** a green
  deploy says nothing about live bindings. Compare each Worker's live bindings to
  its wrangler file's "Secrets" comment, or add the smoke test below.
- **Config drift:** `wrangler.dashboard.toml` enables `[observability.logs]` but the
  live dashboard Worker had logs off. The toml is the intended state; re-enable.

## Repo Structure
```
src/index.js          # `backend` Worker (wrangler.toml) -- JSON API, /backfill +
                      # /backtest/run, cron scheduler, JOBS (backfill-only) consumer
src/dashboard-worker.js  # `dashboard` Worker (wrangler.dashboard.toml) -- login,
                      # session, SSR UI; calls `backend` via service binding
src/ingest-worker.js  # `ingest` Worker (wrangler.ingest.toml) -- INGEST consumer
src/llm-worker.js     # `llm` Worker (wrangler.llm.toml) -- ANALYZE + LLM_JOBS
                      # (backtest/exit_check) consumer; only holder of GEMINI_API_KEYS
ingestion/           # Finnhub, GDELT (unwired), EDGAR, RSS, HTML-scrape, yfinance adapters
  errors.js           # typed vendor error taxonomy (Pattern 11)
  date_window.js       # point-in-time cutoff/boundary helpers
  market_data_validator.js  # sanity-check vendor data before agents see it (Pattern 9)
storage/             # D1 access layer (d1.js, llm_calls.js, jobs.js)
llm/                 # multi-key Gemini cascade, KV-backed cooldown
agents/
  analysts/          # news/event, sentiment, technical
  researchers/        # bull, bear
  managers/            # research_manager (debate -> verdict), portfolio_manager (go/no-go)
  trader/             # trade thesis (direction/reasoning only)
  risk_mgmt/          # deterministic sizing/risk rules, exit rules
  utils/               # memory.js (reflection log), structured.js (schema-enforced LLM calls)
  schemas.js           # shared structured I/O types
graph/               # orchestration
  pipeline.js          # wires stages together
  conditional_logic.js # routing between stages
  checkpointer.js       # Pattern 12: persist/resume state
  reflection.js         # Pattern 8: decision log + reflection loop
  settle.js             # realized return -> reflection on position close
  exit_check.js         # stop-loss / take-profit / time-based exits
backtest/            # point-in-time harness, walk-forward, signal on/off comparison
dashboard/           # operational dashboard
migrations/          # D1 schema (0001-0012)
config/
tests/
```

## Current Status
The pipeline is built end to end: shared schemas, Gemini cascade, bull/bear debate
+ judge, deterministic risk/sizing + portfolio sign-off, all ingestion adapters
wired, a point-in-time positions store with stop-loss/take-profit/time-based
exits, technical analyst on price bars, realized-return settlement feeding the
reflection loop, a backfill entry point, the signal on/off backtest harness
(`runManualBacktest`, persisted in `backtest_runs`) and a live-progress job panel.
CI and deploys are green across all four Workers.

**Not yet true:** backtests are not isolated from live state (see above). The
four behaviors below have not been observed live end to end.

**Remaining work (item 1b blocks non-AAPL live trades; nothing else blocks the system running):**
1. **Backtest / live isolation** — see the section above.
1b. **Overlapping open positions per ticker** (live) — blocks every non-AAPL
   live trade today; see "Overlapping open positions" above. Needs a decision.
2. **Post-deploy smoke test** in `deploy.yml`: log in via `dashboard`, fetch one
   `/api/*` route through the service binding, fail unless 200. Would have caught
   the 401 incident.
3. **Live verification** of: a backtest surviving past the old 30s cutoff (Step 3),
   a real ANALYZE crash-and-retry (Step 4), ops/day against real Observability
   numbers (Step 4), and the full ingest → analyze → llm flow producing decisions.
4. **Step 5's gap:** `backend` still holds `FINNHUB_API_KEY` for `backfill`.
5. **Loose ends:** unreferenced `src/dashboard.js` shim; a stray unrelated Worker
   `restless-manager-6789` on the account; dashboard UI/UX not screenshot-reviewed.
6. Old stuck backtest row `backtest-1789756783629-bxavoi` is now `failed` in D1.

## Known Gaps / Backlog
- **Entity resolution:** SEC-backed name matching exists
  (`entity_resolution.js#buildCompanyNameIndex`/`matchTickersByName`, gated by
  `config.entityResolutionUseNameIndex`) and is wired into RSS/scrape/GDELT. It
  defaulted **on** on 09-17 and was flipped **back to off** on 09-19 (commit
  `cd25317`); Step 0 suspected it of the CPU-limit failures, unconfirmed. Never
  validated against live SEC data plus real headline traffic. Opt in with
  `ENTITY_RESOLUTION_USE_NAME_INDEX=true`.
- **News sources:** Finnhub `/company-news` (free, 60 req/min) replaced GDELT on
  09-18; its field mapping is written from docs and is **not live-verified**.
  `gdelt.js` and its tests are kept, unwired (its response shape was never
  confirmed; it rate-limited hard). RSS and HTML-scrape are live-only and can't
  backfill (no from/to). HTML-scrape does tag-stripping only; Reuters/WSJ return
  bot-challenge 401s; pages with no published-time meta fall back to fetch time and
  are unsafe for point-in-time use.
- **yfinance** is unofficial, daily bars only. **EDGAR** gives only reported
  `us-gaap` tags (no non-GAAP), paced at 110ms. Ingestion pacing exists per
  adapter but there is no shared cross-vendor limiter, and `ingestPriceBars`/
  `ingestFundamentals` fetch the full watchlist with no delta fetching.
- **Untuned placeholders:** `MAX_PORTFOLIO_RISK_PCT` (0.20) and
  `config.maxPositionHoldDays` (10). No correlation check in portfolio sign-off.
- **Exit logic** only fires time-based exits for a ticker until price bars exist
  before its position opens. `alphaReturn` is always `null` (no benchmark series
  ingested). Reflection failures are logged and swallowed; the position stays closed.
- **`debates` table** has no write path (`trade_decisions.debate_id` is always null).
- **Backtest harness:** the math layer, no-signal baseline (`noSignalBaseline.js`),
  signal-on runner (`onSignalRunner.js`) and the persisted end-to-end run are built.
  Every run spends real Gemini quota (several calls per news item plus one per
  position close), so it is manual only and must never be wired into `scheduled()`.
  Backfill it via `POST /backfill?from=&to=` first (runs read only what is in D1).
  Isolation problems: see above.
- **CI:** no lockfile-sync job (fine with one `package.json`); the docs-vs-code
  path filter is exclusion-based (`**` minus any `*.md`), so new code directories
  are gated without a workflow edit. The 2 pre-existing `dashboard_worker`
  `POST /backfill` test failures on `main` were a known baseline as of Step 6.
