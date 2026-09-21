# News → Market Analysis → Trade Signal Pipeline

_Trimmed 2026-09-21 (second pass). Full narration, CI-run notes, per-PR
implementation detail and investigation logs live in git history
(`git log -p plan.md`). Section names, "Adopted Pattern #N", "Backtesting
Integrity point N", "Step N", "Design: environments", "Engine ports" and
"Decided (2026-09-19)" labels are unchanged because code comments reference
them. **Start with "Current Status" → "Next steps: make backtests
trustworthy".**_

## Goal
An AI-driven pipeline that ingests financial news, summarizes it, has a second
LLM reason about likely market impact, and turns that analysis into trade
signals. Needs a historical archive for backtesting and fine-tuning.

## Prior Art
Primary architectural reference: **TradingAgents** (multi-agent: analysts →
bull/bear debate → trader → risk → portfolio sign-off). Also scanned for
narrower patterns: minimal folder layout, 5-band sentiment + justification
schema, proving a news signal via Sharpe comparison, and the general
`news-sentiment` GitHub topic (FinBERT/Kafka/TimescaleDB/EDGAR).

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
1. **Ingestion** — normalize every source into one JSON schema at the boundary:
   `id` (sha256 of source_url + published_at), `source`, `url`, `published_at`
   (exact public timestamp, not ingestion time), `ingested_at`, `tickers`,
   `title`, `body`, `raw`. Dedup on `id`/URL. Sources: Finnhub `/company-news`
   (primary), RSS, HTML scrape, Tiingo (bars; replaced yfinance, see "Price
   data sources"), SEC EDGAR (XBRL fundamentals).
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
   data-access layer (`storage/inputs_view.js` requires an explicit `asOf`), not by trusting the agent.
2. **Revision-aware storage** — every article revision stored with its own timestamp;
   serve the version that existed at `T`.
3. **Point-in-time fundamentals** — built for XBRL filers via EDGAR companyfacts
   (`getFundamentalFactsAsOf`, keyed by filing date). Residual gap: price data and
   other free sources aren't point-in-time; EDGAR covers US-listed XBRL filers only.
4. **The reflection/memory loop is the easiest place to leak the future** — memory fed
   to an agent at `T` must only contain reflections resolved before `T`, same filter as point 1.
5. **Walk-forward validation** — roll the cutoff forward in fixed windows, not one
   static split.
6. **A leak-check test, not just a design doc** — CI asserts zero rows returned to
   the agent have a timestamp after `T`.
7. **Backtest state must not touch live state, and vice versa.** Enforced
   structurally (separate D1 for state, no live binding in the backtest Worker).
   Built: M1–M5 merged (see "Backtest / Live Isolation").

**Price bars: the same-day leak (audit 2026-09-20) is FIXED (step C).**
`getPriceBarsAsOf` now returns only bars dated strictly before `asOf`'s UTC
date (`shared/price_availability.js`), so the freshest price anyone can see is
the previous UTC day's close — live included. Covered by
`test/price_bars_no_same_day_leak.test.js`. Residual: `pointInTime.js#assertNoLookahead`
is a test helper only, not called from `src/`; the price-bar read has its own guard.

## Backtest / Live Isolation — REDESIGN (implemented, M1–M5 merged 2026-09-20)
**Why (historical, full incident log in git history):** before the split,
backtest and live shared D1 state with nothing marking which run wrote a row —
backtests closed live positions, reflections leaked both directions, thesis ids
collided, failed runs had no cleanup. Prod D1 was wiped 2026-09-19 at the
owner's request (no backup).

**Design: environments.** One engine, run inside an environment; an
environment owns its state; its Worker holds no binding to any other
environment's state. No Durable Objects; D1 only.

| DB | Holds | Written by |
|---|---|---|
| `inputs` | `news_items`, `news_item_revisions`, `news_item_tickers`, `price_bars`, `fundamental_facts` — shared, append-only, point-in-time | `ingest` only |
| `live` | run state, `run_id = 'live'`: `positions`, `trade_decisions`, `decision_memory`, `pipeline_checkpoints`, `llm_calls`, `job_progress` | `llm` (live) |
| `sim` | same tables, `run_id` = backtest id, plus `backtest_runs` registry | `backtest` |

`run_id NOT NULL` is part of every primary/unique key. `RunStore(db, runId)` is
the only code that runs SQL on state tables (filters `run_id`, refuses
delete-by-run on `'live'`); input reads go through `InputsView(db)` (`asOf`
required). CI fails if `live`/`sim` schemas differ or if `wrangler.backtest.toml`
binds the `live` DB.

**Engine ports.** The pipeline receives `{ clock, inputs, store, enqueue }` and
never calls `Date.now()`. Live: real clock/queues. Backtest: `SimClock` (end
clamped to real now, throws on a future time) + a recording enqueue, so a
backtest cannot trigger live work.

**Atomic portfolio commit.** One D1 `batch` (all-or-nothing) does check-and-write:
predicate P (no newer open position for this ticker AND other-tickers' open
risk + new risk `<= MAX_PORTFOLIO_RISK_PCT`), then close-replace-insert
`WHERE P`, backstopped by a partial unique index on `(run_id, ticker) WHERE
closed_at IS NULL`. Latest `asOf` wins. Caveat (fixed in step E): the exposure
check originally used live semantics (`closed_at IS NULL`) instead of as-of.

**Decided (2026-09-19), still in force:**
- `backtest` has its own KV namespace so its cooldown state can't trip live's;
  per-run LLM-call budget exists in code (`src/llm/budget.js`) but
  **`BACKTEST_MAX_LLM_CALLS` is intentionally uncapped** — known risk of a
  runaway backtest burning the shared Gemini quota.
- **Failed runs: delete the data, keep the error log.** `src/backtest/cleanup.js`
  deletes positions/decisions/memory/checkpoints/non-error `llm_calls` in
  chunks (500 rows/table, ≤20 chunks/run); keeps the `backtest_runs` row
  (status `failed` + error) and error-status `llm_calls`. Complete runs are
  never auto-deleted.
- The `*/15` ingest cron stays **on**.

**Free-plan budgets** (Workers Free; per account, not per DB/Worker/namespace):
- **D1:** 5M rows read + 100K rows written/day across every DB in the account
  (hit once, 2026-09-20 — see "Live incidents"); an indexed column counts as an
  extra row written. 500 MB/DB, 5 GB/account, 10 DBs/account.
- **KV:** 1K writes, 1K lists, 100K reads/day. Cooldown keys written only on
  rate-limit events.
- **Queues:** 10K ops/day, shared with live. A backtest is a chain of messages
  on `BACKTEST` (~3 ops/message).
- **Workers:** 50 subrequests/invocation on Free. `commitThesis` stays at 3
  batched statements.
- **Backtest subrequest budget (built, CONFIRMED live 2026-09-21):**
  `src/backtest/subrequestBudget.js` counts Gemini fetches
  (`BACKTEST_MAX_EXTERNAL_SUBREQUESTS`, default 40) and D1/KV calls
  (`BACKTEST_MAX_TOTAL_SUBREQUESTS`, default 40) per invocation; when the next
  unit won't fit, the run returns a cursor and continues as a new **part**
  after `BACKTEST_CONTINUATION_DELAY_SECONDS` (15s). `BACKTEST_MAX_PARTS`
  (1500) fails a runaway chain. **Confirmed strict: D1 and KV DO count toward
  the same 40-request total as external calls** (`total = external + kv + d1`
  observed exactly, live logs 2026-09-21) — about one item processed per part.
  No `"Too many subrequests"` errors seen, so the 40 ceiling is safely under
  Cloudflare's real 50. Keep TOTAL ≥ 10 or a part can't persist one stage.
  Per-run LLM-call counter resets each part. Workers Paid removes all of this.
- No cross-DB joins/transactions (none needed). Backfill is a write to
  `inputs`; a backtest over an un-backfilled window fails fast (step D preflight).

**Milestones** (M1–M5, all merged 2026-09-19/20, squash-merged, one PR each):
provisioned the three DBs + `RunStore`/`readOnly`/`commitThesis` (M1); ported
the engine onto run-scoped ports (M2/M2b); built the `backtest` Worker +
`SimClock` + walk-forward + delete-by-run (M3); cut live over to `live`/`inputs`
(M4 — **left:** dashboard environment selector, see Other remaining work #6);
deleted the legacy pre-split DB from code/config/CI (M5). Full per-milestone
detail in git history.

### Overlapping open positions (former live bug, fixed)
`max_concurrency` 2 + per-article `asOf` let an older article processed after a
newer one open a duplicate position (23 overlapping AAPL positions seen).
Fixed structurally by the atomic portfolio commit above, live since M4.

## Deployment: Cloudflare Workers + D1 + KV (free tier)
| Resource | Free limit | Implication |
|---|---|---|
| Workers | 100K requests/day, 10ms CPU/invocation | CPU time excludes `fetch()` wait, so LLM-calling steps barely touch the budget |
| D1 | 5GB storage, 5M rows read/day, 100K rows written/day (hard-enforced) | Batch inserts, dedupe before writing |
| KV | 1GB storage, 100K reads/day, 1K writes/day | Only for low-frequency state (LLM key/model cooldowns) |
| Queues | 10K ops/day | ~5 guaranteed messages per 15-min tick at 3 tickers, plus one ANALYZE per new item; re-check before growing the watchlist |

**Architecture:** five Workers connected by queues, each binding only the D1s
it needs; only `backend` runs migrations.
- **`dashboard`** — the only public Worker: login, session, SSR UI; reaches
  `backend` via service binding.
- **`backend`** — private JSON `/api/*`, `POST /backfill`, `POST /backtest/run`,
  the `*/15` cron (pure fan-out), D1 migrations. No vendor key, no `queue()` export.
- **`ingest`** — `INGEST` (batch 10) + `BACKFILL` (batch 1) consumers. Holds
  `FINNHUB_API_KEY`; narrowly binds `LIVE_DB` (rw, `job_progress` only).
- **`llm`** — live Gemini caller; holds `GEMINI_API_KEYS`. Binds `LIVE_DB` (rw),
  `INPUTS_DB` (ro). Consumes `ANALYZE` (retries; checkpoint-resumable) and
  `LLM_JOBS` (`exit_check` only; logs+acks on failure).
- **`backtest`** — private; consumes `BACKTEST` (batch 1, concurrency 1, DLQ).
  Binds `SIM_DB` (rw), `INPUTS_DB` (ro), its own `CACHE_KV`, **no `LIVE_DB`**
  (CI-pinned). Own copy of `GEMINI_API_KEYS`, never `FINNHUB_API_KEY`.

Every queue has a DLQ (`max_retries` 3). CI: `test` → `migrate` (gated on
`migrations/**`) → one deploy job per Worker, each diffed against its own last
successful deploy; docs-only PRs deploy nothing. Provisioning is idempotent
(`ensure-{kv-namespace,queue}`, look up by name/create if missing). Per-Worker
secrets are scoped to the Worker that needs them (full list in git history).
**Lesson:** a green deploy says nothing about live bindings — compare each
Worker's live bindings to its wrangler file. wrangler v4 required (v3 exceeded
the free queue message-retention cap).

## LLM Calling Layer: Multi-Key Gemini Cascade
**Two-axis cascade, model-first:** outer loop tries `[requestedModel,
...GEMINI_FALLBACK_MODELS minus requestedModel]` across every key before
dropping a tier; inner loop rotates `GEMINI_API_KEYS` on 401/403/429/503/
transient failure. Model-first because 429/503 is usually per-model/per-key.
**Cooldown:** KV `gemini:cooldown:<model>:<keyIndex>` with `expirationTtl`,
written only on a rate-limit event; fails open if KV unreachable. The fallback
list must differ from the requested model (a single-model cascade let one 503
kill a whole backtest, fixed PR #41). `wrangler.llm.toml`: quick tier
`3.1-flash-lite → 2.5-flash-lite → 2.5-flash`; deep tier prepends `3.5-flash`.

**LLM call log** (`/dashboard/llm`): every Gemini prompt/response, including
failures, logged to `llm_calls` (state schema, scoped by `env_run_id`). One
choke point: `agents/utils/structured.js#callStructured`. Best-effort (never
fails/slows the call); `LLM_LOG_ENABLED=false` disables. ~4 D1 rows/call;
pruned after `LLM_LOG_RETENTION_DAYS` (14); prompt/response clipped at
`LLM_LOG_MAX_CHARS` (60000).

## Roadmap: Service Split — DONE 2026-09-19
One Worker used to run the cron pipeline, SSR dashboard, login and long manual
jobs, and hit free-plan CPU-time limits on nearly every tick. Split into the
five Workers described above across 7 PRs (#27–#33), each its own step, tested
via CI, squash-merged. Two notable gaps found and closed after the initial
split: `backend` briefly still held `FINNHUB_API_KEY` (closed PR #61, moved
`BACKFILL` consumer to `ingest`); and Cloudflare's queue-trigger deploy
ordering needed a transitional no-op `queue()` export (PRs #62–#63). Full
step-by-step history in git.

### Live incidents (fixed; kept for the lessons)
- **No analysis after the M4 cutover (2026-09-20):** `ANALYZE.sendBatch` threw
  above Cloudflare's 100-message batch cap and the handler silently acked.
  Fixed by chunked sending (`sendInChunks`, ≤100 msgs/200KB) and by
  `insertNewsItem` returning only genuinely-new items. **Open:** ~427 items
  ingested before the fix were never analyzed (owner hasn't decided whether to
  re-enqueue).
- **First price backfill failed + D1 write cap hit (2026-09-20 ~22:03 UTC):**
  yfinance 429'd on every ticker (0 bars saved, failed loudly as designed —
  proof Yahoo rejects Workers egress on the historical path too), and
  separately the day's D1 write cap (likely from the 10,025-item news backfill)
  made every `job_progress` write fail, leaving the job stuck `queued` forever
  (see Other remaining work #8). Resolved by switching to Tiingo (step A2,
  confirmed live 2026-09-21) and waiting for the UTC reset.

## Historical backfill (PRs #64–#67, verified live 2026-09-20)
`POST /backfill?from=&to=` enqueues onto `BACKFILL`; `ingest` consumes it in
self-continuing parts, fetching Finnhub in date windows (caps: 40 requests/
500 items/invocation, 50 parts/job). **Verified:** 90-day run
(2026-06-22..09-20) inserted 10,025 items in 13 parts, 0 errors, ~3.4 min;
duplicate rerun inserted 2 (dedupe works); Finnhub's `to` is inclusive.
**Sizing:** ~29 MB/10K articles, so a year is ~100–130 MB (500 MB/DB cap); a
year-long single range would need ~50 parts (near `MAX_BACKFILL_PARTS`), so run
in ~90-day slices instead. Aug 11–31 volume drop (~25–80/day vs 150–250) is
unexplained but the owner said "it's fine."

## Live incident: price backfill + D1 cap
Covered above under "Live incidents." Open item: whether the backfill path's
ANALYZE fan-out is safe against the Queues 10K ops/day cap — unassessed (Other
remaining work #3).

## Price data sources (owner requirement 2026-09-20/21: add gold + oil "so I can trade forex too")
Yahoo/yfinance 429'd on every Workers call seen 2026-09-20, so it's unusable as
the bar source (**decided: replaced by Tiingo, step A2, confirmed live
2026-09-21** — AAPL/MSFT/TSLA/USO/XAUUSD all have real Tiingo bars in `inputs`).

| Provider (free plan) | Limits | Notes |
|---|---|---|
| **Tiingo (in use)** | 50 req/hr, 1,000/day, 500 symbols/mo | EOD stock endpoint; separate Forex endpoint covers XAU/XAG/XPT + majors, OHLC only (no volume), no oil. |
| Twelve Data | 8 credits/min, 800/day | Forex free; commodities need paid Grow (~$29/mo). |
| Massive (ex-Polygon) | 5 calls/min, EOD, 2yr history | Fine for short windows, slow for long backtests. |
| Alpha Vantage | 25 req/day | Thin; commodity series unverified. |
| Finnhub / Stooq | — | Finnhub free-plan candles reportedly unusable; Stooq now needs a CAPTCHA-issued key. |

**Decided:** gold = spot XAUUSD via Tiingo Forex (not GLD); oil = ETF proxy on
the stock endpoint (USO/BNO, exact fund TBD) since no free spot-oil source was
found; forex = signals only (no execution layer, paper positions only, not
planned). Stored prices are **raw** (unadjusted), matching the old yfinance
bars — not discussed with the owner, so splits/dividends aren't reflected over
long windows. Still open: how news maps to a commodity/FX ticker (Finnhub is
per-equity-symbol); position/risk model for FX and commodities (units,
leverage, pip values, shorting); 24h/weekend markets vs daily bars and hold-day
exit logic; Queues/D1 budget re-check as the watchlist grows.

## Repo Structure
```
src/index.js          # `backend` Worker (wrangler.toml) -- JSON API, /backfill
                      # (enqueues onto BACKFILL), /backtest/run (enqueues onto
                      # BACKTEST), cron scheduler. No queue consumer, no
                      # vendor key
src/dashboard-worker.js  # `dashboard` Worker (wrangler.dashboard.toml) -- login,
                      # session, SSR UI; calls `backend` via service binding
src/ingest-worker.js  # `ingest` Worker (wrangler.ingest.toml) -- INGEST and
                      # BACKFILL consumers
src/llm-worker.js     # `llm` Worker (wrangler.llm.toml) -- ANALYZE + exit_check on
                      # {inputs, live store}; a stray backtest message on
                      # LLM_JOBS is rejected (logged, job marked failed, acked)
src/backtest-worker.js  # `backtest` Worker (wrangler.backtest.toml) -- BACKTEST
                      # consumer; binds only SIM_DB + INPUTS_DB + its own CACHE_KV
ingestion/           # Finnhub, GDELT (unwired), EDGAR, RSS, HTML-scrape, Tiingo adapters
  ingest.js           # scheduled-ingestion entry point
  enqueue.js          # chunked ANALYZE sendBatch (Queues caps a batch at 100 messages / 256 KB)
  errors.js           # typed vendor error taxonomy (Pattern 11)
  date_window.js       # point-in-time cutoff/boundary helpers
  market_data_validator.js  # sanity-check vendor data before agents see it (Pattern 9)
storage/             # run_store.js (RunStore, state-DB access), inputs_view.js
                      # (input-side D1 access), sim_registry.js (the backtest_runs
                      # registry, SIM_DB only); llm_calls.js and jobs.js hold pure
                      # helpers only -- their SQL is RunStore's
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
                      # (runBacktest.js, signalCompare.js, onSignalRunner.js,
                      # equity.js, priceGrid.js, metrics.js, simClock.js, cleanup.js)
dashboard/           # operational dashboard
migrations/          # inputs/, state/, sim/ -- the three environment schemas
config/
tests/
```

## Current Status
The pipeline is built end to end: shared schemas, Gemini cascade, bull/bear
debate + judge, deterministic risk/sizing + portfolio sign-off, all ingestion
adapters wired, a point-in-time positions store with stop-loss/take-profit/
time-based exits, technical analyst on price bars, realized-return settlement
feeding the reflection loop, date-windowed historical backfill, the signal
on/off backtest harness and a live-progress job panel. Backtest/live isolation
is built (M1–M5). CI and deploys are green across all five Workers.

Real Tiingo price data is now confirmed live for AAPL/MSFT/TSLA/USO/XAUUSD
(step A2, verified 2026-09-21 — see `inputs.price_bars`). The subrequest budget
that makes long backtests resumable (PR #80) is merged and confirmed working
under real load (see "Free-plan budgets" above).

**Backtests were NOT trustworthy as of the 2026-09-20 audit** ("is backtesting
bug free?" → no). Steps A–E of the fix plan below are done; **step F (a real
small first backtest) is in progress** as of 2026-09-21 — run
`backtest-1789988827184-yk8suu`, tickers AAPL/MSFT/TSLA/XAUUSD/USO,
2026-09-14→09-21, status `running`, zero errors so far. Treat its result as the
first trustworthy backtest once it completes.

### Next steps: make backtests trustworthy
Working rules: each step is its own PR off `main`; CI `test` job is the real
test (no local runner); merge only on the owner's explicit per-PR go-ahead,
squash-merge.

**Audit findings (2026-09-20), all now fixed except where noted — detail and
original reasoning in git history:**
1. **No price history** → **fixed by A/A2**: Tiingo backfill now covers all 5
   tickers for the current test window (verified 2026-09-21).
2. **Silent 500-row caps** on news items and realized returns → **fixed by
   B** (PR #72): keyset pagination, no limit on returns.
3. **Same-day price look-ahead** (day D's close visible any time on day D) →
   **fixed by C**: strict `<` on the UTC date.
4. **Metrics not real portfolio returns** (baseline vs. on-side not
   comparable, wrong Sharpe periods) → **fixed by D**: both sides now score as
   daily portfolio equity curves (`backtest/equity.js`), with a price-coverage
   preflight before any LLM call (fails loudly naming missing tickers/gaps
   instead of running on a silently smaller universe).
5. **Order-dependent multi-ticker walk** (ticker-major walk let one ticker's
   whole window run before another's, corrupting portfolio-ceiling checks) →
   **fixed by E**: day-major walk + as-of exposure checks in `commitThesis`.

**Not yet done / open:**
- **F. Small first backtest** — in progress now (see Current Status above).
  Once it completes: confirm no `Too many subrequests` errors across the full
  run, check the resulting `portfolio` equity curve looks sane, then decide
  with the owner whether to run the fuller historical span.
- Whether the 15-min queue wall-time limit and per-invocation subrequest/CPU
  limits hold up over a much longer run than the current 7-day window is still
  unverified — the part/continuation mechanism (confirmed strict-budgeted,
  ~1 item/part, no errors) is the mitigation, but a multi-month run hasn't been
  tried yet.

### Other remaining work
1. **Live verification** (not yet observed): a real ANALYZE crash-and-retry,
   Queues/D1 ops per day against real Observability numbers, fresh
   `pipeline_checkpoints` on the `*/15` cron.
2. **~427 pre-fix news items never analyzed** — leave or re-enqueue (owner
   hasn't answered).
3. **Check whether the backfill path enqueues ANALYZE**, before/after big
   backfills, given the Queues cap.
4. **`BACKTEST_DAILY_WRITE_BUDGET`** proposed (40K), not approved, not built.
5. **Optional:** owner runs the remaining historical backfill in ~90-day
   slices up to ~1 year (no code needed).
6. **Dashboard environment selector** (`?env=`), left over from M4.
7. **D1 daily write cap** — hit once (2026-09-20); after any future hit, check
   that `*/15` ingest/ANALYZE recovered post-reset.
8. **Job stuck `queued` when the terminal progress write fails** — progress
   writes are best-effort by design; needs a dashboard-side stale/timeout state.
9. **New instruments: gold, oil, forex** — sourcing decided (Tiingo,
   confirmed live); wider FX/commodity design (units, leverage, 24h markets)
   not started.
10. Whether `wrangler.dashboard.toml`'s `[observability.logs]` is enabled on
    the live dashboard Worker — status unverified.

## Known Gaps / Backlog
- **Entity resolution:** SEC-backed name matching exists but is **off**
  (`ENTITY_RESOLUTION_USE_NAME_INDEX`), suspected but unconfirmed cause of an
  earlier CPU-limit incident. Never validated against live SEC data + real
  headline traffic.
- **News sources:** Finnhub is primary and backfill-capable. `gdelt.js` is kept
  but unwired (response shape never confirmed, rate-limited hard). RSS/HTML-
  scrape are live-only (no from/to); scrape can't handle bot-challenge sites
  (Reuters/WSJ) and falls back to fetch-time (unsafe for point-in-time) when a
  page has no published-time meta.
- **yfinance** deprecated as a bar source (429s from Workers egress, see A2).
  **EDGAR** gives only reported `us-gaap` tags, paced at 110ms; no shared
  cross-vendor rate limiter; price/fundamentals ingestion has no delta fetching.
- **Untuned placeholders:** `MAX_PORTFOLIO_RISK_PCT` (0.20),
  `config.maxPositionHoldDays` (10). No correlation check in portfolio sign-off.
- **Exit logic** only fires time-based exits until price bars exist before a
  position opens. `alphaReturn` is always `null` (no benchmark series
  ingested). Reflection failures are logged and swallowed.
- **`debates` table** has no write path (`trade_decisions.debate_id` always null).
- **Backtest harness spends real Gemini quota** (several calls per news item +
  one per position close) — manual only, must never be wired into `scheduled()`.
- **CI:** no lockfile-sync job (fine with one `package.json`).
