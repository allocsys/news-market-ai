# News → Market Analysis → Trade Signal Pipeline

_Consolidated 2026-10-03 (ninth pass). Known Gaps re-verified against code; incident narration and duplicated values folded into git._ Per-PR narration, incident logs and vendor research live in git history (`git log -p plan.md`). Labels that code comments reference are unchanged: "Adopted Pattern #N", "Backtesting Integrity point N", "Step N", "Design: environments", "Engine ports", "Decided (2026-09-19)", "Other remaining work #N". **Start with "Next To-Dos", then "Current Status".**_

## Next To-Dos (2026-10-03)
Priority order, code-verified against current `main` (PRs #165-#194 merged; live trading OFF by owner decision; paper clock not running). Backtests are started only by the owner from `/dashboard/backtest`.
1. **Finish the baseline backtest and read it against the rollout gate** (`docs/rollout.md`: >=500 closed trades AND >=3 months, mean net return lower bound `mean - 1.645*SE > 0`). Earlier baselines were tiny (e.g. `backtest-1790860459100-zpv5ex`: AAPL only, 11 trades, FAILED the gate). A run started 2026-10-03 (`backtest-1791023632932-u65p8e`, AAPL, 2026-09-01..05) COMPLETED at 12:08Z in 151 parts (~95 min): n=4 signals, one position traded, nowhere near the gate. The 2026-10-02 run `emy6gk` failed at the part cap (17/120 ticker-days) before #188/#189. Expect to need several runs to reach 500 trades.
2. **Verify #188 and #189 on a live run.** #188 (Gemini cooldowns in one KV key) is confirmed on `u65p8e`: `kvReads` is 0-1 per part in the `backtest part finished` log. #189 (idle parts do not count toward `BACKTEST_MAX_PARTS`) is not exercised: that run used only 151 of 1500 parts.
3. **Verify the `SIM_DB` purge-guard fires in prod** (`ingest-worker.js`, `wrangler.ingest.toml`): never confirmed against a real purge run. It cannot be confirmed before about 2026-12-23: retention is 180 days (`INTRADAY_RETENTION_DAYS` unset) and intraday data starts 2026-06-26, so the purge deletes nothing until then. The guard skips the purge while a backtest is `queued`/`running` (fresh `job_progress`) or `paused` (`backtest_runs`, no idle cutoff, because parking leaves `job_progress` stale).
4. **Tune knobs only after >= 500 trades** (`FLIP_MIN_CONFIDENCE`, `DRAWDOWN_BREAKER_PCT` + `DRAWDOWN_BREAKER_WINDOW_DAYS`, `SPLIT_GUARD_TOLERANCE`, `TRADE_COST_BPS`, trailing knobs; per-run overrides via `backtest/knobOverrides.js`).
5. **Vol-aware sizing:** on hold. It changes every backtest, so if built it is a per-run knob that defaults to off.

**Decided (owner, 2026-10-03):**
- Risk ceilings stay as they are until there is trade evidence: gross exposure 20% (`MAX_PORTFOLIO_RISK_PCT`), loss-at-stop 0.75% (`MAX_PORTFOLIO_STOP_RISK_PCT`), group cap 10%, drawdown breaker 2% over 14 days. Trailing/break-even knobs stay at 0 (off): the evidence is 3 trades.
- **Correlation:** the 2026-09-25 plan for a computed correlation matrix is SUPERSEDED by the static `TICKER_GROUPS` map + `MAX_GROUP_EXPOSURE_PCT` (#176/#177): a computed matrix needs extra price reads per decision, which the 40-subrequest backtest budget cannot afford (`shared/constants.js`). Known gap: macro co-movement across groups (e.g. USO/XAUUSD in a risk-off move) is only bounded by the loss-at-stop ceiling.
- **No config changes** to backtest limits (`BACKTEST_MAX_TOTAL_SUBREQUESTS` 40, 15s part delay); no pre-warm, parallelisation or batching of pipeline stages. More Gemini keys is the only accepted lever for throughput (currently 4 keys, confirmed by the owner 2026-10-03).
- No news relevance filter. Backtest resume is manual only; a backtest never starts or resumes by itself.
- The `platform_limit` pause trigger stays unbuilt (needs the exact D1/KV limit error text from observability). Replacing the quota ledger with the Cloudflare analytics API was considered and dropped.
- Jev (TypeSafe) provider scratched.

## Goal
AI pipeline: ingest financial news → summarize → second LLM reasons about
market impact → trade signals. Needs a historical archive for backtesting.

## Prior Art / Adopted Patterns
Primary reference: **TradingAgents** (analysts → bull/bear debate → trader →
risk → portfolio sign-off).
1. **Parallel analyst agents**, not one big prompt (news/event, sentiment, technical).
2. **Bull/Bear debate** then a judge step. Catches single-pass overconfidence.
3. **Trade thesis separate from risk/sizing.** Trader picks direction; a deterministic risk layer decides whether/how much. Never combined.
4. **Shared structured schemas** (`schemas.js`) so stages compose without prompt-gluing.
5. **Mandatory justification field** on every scored/classified output.
6. **Prove the signal helps**: backtest signal on vs. off (Sharpe etc.).
7. **Two-tier models**: `quick_think` (cheap, high-volume) vs `deep_think` (debate/judge/decision); `max_debate_rounds`/`max_risk_rounds` are depth-vs-cost knobs.
8. **Decision log + reflection loop**: cheap substitute for fine-tuning, but the easiest place to leak the future (see Backtesting Integrity).
9. **Grounded data claims**: agents never state a price/figure from memory; every claim comes from a verified snapshot; stale data is rejected, not reported as current.
10. **Deterministic entity resolution** before any LLM runs.
11. **Explicit vendor fallback chain, no silent degradation**: typed errors, explicit fallback order, log every skipped source.
12. **Checkpoint/resume** per pipeline stage so a crash doesn't re-spend LLM calls.

## Pipeline Stages
1. **Ingestion**: normalize every source into one schema (`id` = sha256(url+published_at), `source`, `url`, `published_at` = exact public time not ingestion time, `ingested_at`, `tickers`, `title`, `body`, `raw`). Sources: Finnhub `/company-news` (primary), RSS, HTML scrape, Tiingo (daily bars; FX intraday for XAUUSD), Alpaca (intraday), SEC EDGAR (XBRL fundamentals). GDELT is unwired.
2. **Storage**: D1 (R2 is an unused option if D1 is outgrown).
3. **Analyst team**: News/Event, Sentiment (5-band + justification), Technical, on the quick model.
4. **Researchers**: Bull and Bear argue; Research Manager reconciles into a verdict (direction, confidence, horizon).
5. **Trader**: verdict → thesis. Never sizes.
6. **Risk + Portfolio**: deterministic, no LLM: sizing, stop/take-profit, portfolio go/no-go vs. a total-risk ceiling.
7. **Backtesting**: point-in-time, validated by signal on/off (Sharpe, cumulative return, max drawdown).

## Backtesting Integrity (no look-ahead)
True by construction, not discipline.
1. **Hard cutoff per simulated `T`**: news/price ≤ `T`, memory strictly before `T`, enforced in the data-access layer (`storage/inputs_view.js` requires `asOf`).
2. **Revision-aware storage**: serve the article version that existed at `T`.
3. **Point-in-time fundamentals** via EDGAR companyfacts (`getFundamentalFactsAsOf`, keyed by filing date). Gap: price data and other free sources aren't point-in-time; EDGAR covers US XBRL filers only.
4. **Reflection/memory loop** only contains reflections resolved before `T`.
5. **Walk-forward validation**, not one static split.
6. **Leak-check tests in CI**: zero rows with timestamp after `T`.
7. **Backtest state never touches live state** (separate D1, no live binding in the backtest Worker). Built (M1–M5).

**Price bars:** `getPriceBarsAsOf` returns only bars dated strictly before `asOf`'s UTC date (`shared/price_availability.js`), so the freshest daily price is the previous day's close, live included (test: `price_bars_no_same_day_leak.test.js`). **Intraday bars:** visible once fully closed, `ts + 5min <= asOf` (`shared/intraday_availability.js`). Residual: `pointInTime.js#assertNoLookahead` is a test helper only.

## Backtest / Live Isolation (M1–M5 merged 2026-09-19/20)
Before the split, backtest and live shared D1 state and nothing marked which run wrote a row (backtests closed live positions, reflections leaked, thesis ids collided). Prod D1 was wiped 2026-09-19 at the owner's request (no backup).

**Design: environments.** One engine, run inside an environment that owns its state; its Worker holds no binding to another environment's state. D1 only, no Durable Objects.

| DB | Holds | Written by |
|---|---|---|
| `inputs` | `news_items`, `news_item_revisions`, `news_item_tickers`, `price_bars`, `price_bars_intraday`, `intraday_backfill_status`, `fundamental_facts`: shared, append-only, point-in-time | `ingest` only |
| `live` | run state, `run_id='live'`: `positions`, `trade_decisions`, `decision_memory`, `pipeline_checkpoints`, `llm_calls`, `job_progress` | `llm` |
| `sim` | same tables, `run_id` = backtest id, plus `backtest_runs` | `backtest` |

`run_id NOT NULL` is in every primary/unique key. `RunStore(db, runId)` is the only code running SQL on state tables (refuses delete-by-run on `'live'`); input reads go through `InputsView(db)` (`asOf` required). CI fails if `live`/`sim` schemas differ or `wrangler.backtest.toml` binds `live`.

**Engine ports.** The pipeline gets `{ clock, inputs, store, enqueue }` and never calls `Date.now()`. Backtest uses `SimClock` (clamped to real now, throws on a future time) and a recording enqueue, so it can't trigger live work.

**Atomic portfolio commit.** One D1 `batch` checks and writes: predicate P (no newer open position for the ticker AND other tickers' open risk + new risk ≤ `MAX_PORTFOLIO_RISK_PCT`), then close-replace-insert `WHERE P`, backstopped by a partial unique index on `(run_id, ticker) WHERE closed_at IS NULL`. Latest `asOf` wins. This structurally fixed the overlapping-open-positions bug (23 overlapping AAPL positions seen pre-M4).

**Decided (2026-09-19), still in force:**
- `backtest` has its own KV namespace so its cooldowns can't trip live's.
- Per-run LLM budget exists (`src/llm/budget.js`) but **`BACKTEST_MAX_LLM_CALLS` is intentionally uncapped**. Known risk: a runaway backtest burning shared Gemini quota.
- **Failed runs: delete the data, keep the error log** (`src/backtest/cleanup.js`, 500 rows/table, ≤20 chunks/run; keeps the `backtest_runs` row and error-status `llm_calls`). Complete runs are never auto-deleted.
- The `*/15` ingest cron stays **on**.

**Free-plan budgets** (per account):
- **D1:** 5M reads + 100K writes/day across all DBs (hit once, 2026-09-20); an indexed column counts as an extra row written. 500 MB/DB, 5 GB total.
- **KV:** 1K writes, 1K lists, 100K reads/day. **Queues:** 10K ops/day, shared with live (~3 ops per backtest message). **Workers:** 50 subrequests/invocation.
- **Backtest subrequest budget** (`src/backtest/subrequestBudget.js`, confirmed live 2026-09-21): defaults 40 external + 40 total; D1/KV calls count toward the same total, so ~1 item per part. When the next unit won't fit the run returns a cursor and continues as a new part after 15s (`BACKTEST_MAX_PARTS` 1500). Keep TOTAL ≥ 10. Workers Paid removes all of this.
- A backtest over an un-backfilled window fails fast (step D preflight).
- **Backtest pause/resume + daily quota guard (2026-10-02, PR #187):** a huge span can hit the daily D1/KV/Gemini caps mid-run, so a run can be **paused instead of failed** (status `paused`, data kept; `backtest_runs.cursor` holds a resume envelope `{part, cursor, job}`). Each part adds its D1 rows written/read, KV writes/reads and Gemini calls to one `quota_usage` row per UTC day (same `db.batch` as `rows_written`, ~+1 row/part, no extra subrequest). At a part boundary the run parks once today's total reaches `QUOTA_PAUSE_PCT` (90) of one of our shares: `BACKTEST_DAILY_WRITE_BUDGET` 40000, `BACKTEST_DAILY_READ_BUDGET` 2000000 (a lower bound), `BACKTEST_DAILY_KV_WRITE_BUDGET` 500, `BACKTEST_DAILY_KV_READ_BUDGET` 50000 (`0` disables a counter). Also parks when every Gemini key is on a daily cooldown (`gemini_daily_cap`) and on the dashboard Pause button (`operator`). `paused_reason`: `operator | d1_write_budget | gemini_daily_cap | quota_threshold`; `platform_limit` is reserved, not built. **Resume is manual only** (`POST /backtest/:id/resume`, dashboard button); a backtest never restarts by itself, and part 1 of a new run is never refused. `resume_after` is a hint (next UTC midnight, or the shortest Gemini cooldown), not a timer.
- **Gemini cooldowns in ONE KV key (2026-10-03):** `src/shared/cooldown_map_kv.js` serves every `gemini:cooldown:*` key from one map key `gemini:cooldown-map` (`{key: [value, expiryMs]}`), so a backtest part or live `llm` message costs ONE KV read however many model/key pairs the cascade walks, plus one write per cooldown event. (The old one-read-per-pair design burned the whole 40-subrequest budget with zero progress while keys were cooling.) Entries carry their expiry, so a cached map never reports an expired cooldown. Backtest = exclusive writer (loads once); live `llm` re-reads before each write and refreshes every 15s. A per-minute cooldown reports its real remaining time, so the pause delay follows the soonest recovery instead of a flat 60s. Old per-key entries are ignored and expire on their own.

## Architecture: Cloudflare Workers + D1 + KV (free tier)
Five Workers connected by queues, each binding only the D1s it needs; only `backend` runs migrations.
- **`dashboard`**: only public Worker: login, session, SSR UI; reaches `backend` via service binding.
- **`backend`**: private JSON `/api/*`, `POST /backfill`, `POST /backtest/run`, `*/15` cron (pure fan-out), migrations. No vendor key, no `queue()` export.
- **`ingest`**: `INGEST` (batch 10) + `BACKFILL` (batch 1) consumers; holds `FINNHUB_API_KEY`; binds `LIVE_DB` (rw, `job_progress` only) and `SIM_DB` (only to check whether a backtest is running before the intraday purge).
- **`llm`**: live Gemini caller (`GEMINI_API_KEYS`); binds `LIVE_DB` rw, `INPUTS_DB` ro; consumes `ANALYZE` and `LLM_JOBS` (`exit_check` only).
- **`backtest`**: private; consumes `BACKTEST` (batch 1, concurrency 1, DLQ); binds `SIM_DB` rw, `INPUTS_DB` ro, own `CACHE_KV`, **no `LIVE_DB`** (CI-pinned); own `GEMINI_API_KEYS`, never `FINNHUB_API_KEY`.

Every queue has a DLQ (`max_retries` 3). CI: `test` → `migrate` (gated on `migrations/**`) → one deploy job per Worker, each diffed against its last successful deploy; docs-only PRs deploy nothing. **Lesson:** a green deploy says nothing about live bindings; compare each Worker's live bindings to its wrangler file. wrangler v4 required. `sendBatch` takes at most 100 messages per call, so senders chunk (an oversized batch was once acked silently and no analysis ran).

## LLM Layer: Multi-Key Gemini Cascade
**Model-first, two-axis:** outer loop tries `[requestedModel, ...GEMINI_FALLBACK_MODELS]` across every key before dropping a tier; inner loop rotates keys on 401/403/429/503/transient. **Cooldown:** KV with TTL, written only on rate-limit; fails open. Stored as ONE map key `gemini:cooldown-map` (see the 2026-10-03 note above; the cascade still asks per `gemini:cooldown:<model>:<keyIndex>` name, `shared/cooldown_map_kv.js` answers from the map). The fallback list must differ from the requested model.

**Models (2026-09-22):** quick `3.1-flash-lite`, deep `3.6-flash`; fallbacks `3.1-flash-lite, 3.5-flash-lite, 3.7-flash, 3.8-flash, 3.6-flash, 3-flash-preview` (`wrangler.llm.toml`, `wrangler.backtest.toml`, `config.js`). **Lesson (2026-09-22 incident):** Google retired `gemini-2.5-flash` while it sat last in the fallback list; a 404 is fatal-not-transient by design, so an exhausted cascade killed a live backtest. Revisit the list periodically; entries can go from "rate-limited" to "retired" with no warning.

**LLM call log** (`/dashboard/llm`): every prompt/response incl. failures → `llm_calls`, via `agents/utils/structured.js#callStructured`. Best-effort; `LLM_LOG_ENABLED=false` disables; ~4 D1 rows/call; pruned after `LLM_LOG_RETENTION_DAYS` (default 14; the prune runs in `llm-worker.js`); clipped at 60,000 chars. Rows are buffered per news item and flushed in one batch (see Known Gaps).

## Historical news backfill
`POST /backfill?from=&to=` → `BACKFILL` queue → `ingest` in self-continuing parts (caps: 40 requests/500 items/invocation, 50 parts/job). Verified 2026-09-20: 90 days = 10,025 items in 13 parts, 0 errors; reruns dedupe; Finnhub `to` is inclusive. ~29 MB/10K articles, so run ~90-day slices up to a year.

## Price data sources
Yahoo/yfinance 429s on Workers, so **Tiingo** is the daily-bar source (AAPL/MSFT/TSLA/USO/XAUUSD confirmed live 2026-09-21). Free plan: 50 req/hr, 1,000/day; Forex endpoint covers XAU/XAG/XPT + majors, OHLC only, no oil.

**Decided:** gold = spot XAUUSD via Tiingo Forex (not GLD); oil = ETF proxy (USO); forex = signals only, paper positions, no execution layer. Stored prices are **raw** (unadjusted), so splits/dividends aren't reflected over long windows (not discussed with the owner). **Open:** how news maps to a commodity/FX ticker; position/risk model for FX/commodities (units, leverage, pips, shorting); 24h/weekend markets vs daily bars and hold-day exits.

## Repo Structure (under `src/` unless noted)
```
index.js               # `backend` Worker: API, /backfill, /backtest/run, cron
dashboard-worker.js    # `dashboard`: login, session, SSR UI
ingest-worker.js       # `ingest`: INGEST + BACKFILL consumers
llm-worker.js          # `llm`: ANALYZE + exit_check
backtest-worker.js     # `backtest`: BACKTEST consumer
ingestion/             # ingest.js (orchestration + news backfill), entity_resolution.js, date_windows.js, market_data_validator.js
  sources/             # adapters: Finnhub, GDELT (unwired), EDGAR, RSS, scrape, Tiingo (+FX intraday), Alpaca, yfinance
  intraday_backfill.js # cron-driven gradual intraday backfill
  intraday_purge.js    # retention purge (skipped while a backtest runs)
shared/                # price_availability.js, intraday_availability.js, intraday_sanity.js, constants.js (risk ceilings, groups),
                       # cooldown.js + cooldown_map_kv.js (Gemini cooldowns), errors.js, retry.js, throttle.js, split_guard.js
storage/               # run_store.js, inputs_view.js, sim_registry.js, quota_usage.js, jobs.js, llm_calls.js, pause_flags.js
llm/  agents/  graph/  backtest/  dashboard/
migrations/            # inputs/, state/, sim/
config.js              # the single place that reads env vars
test/                  # incl. the mandatory backtest leak-check test
```

## Current Status
Built end to end: schemas, Gemini cascade, debate + judge, deterministic risk/sizing + portfolio sign-off, all adapters, positions store with stop/take-profit/time exits, technical analyst on price bars, settlement → reflection loop, date-windowed backfill, signal on/off backtest harness, live-progress job panel, backtest/live isolation (M1–M5), subrequest-budgeted resumable backtests with pause/resume and a daily quota ledger, deterministic risk gates (exposure, loss-at-stop, group cap, mark-to-market drawdown breaker, SQL re-check), break-even/trailing stops (knobs default off), a single-key Gemini cooldown store, and a part cap that ignores idle parts. CI and deploys are green across all five Workers.

### Backtest trustworthiness (audit 2026-09-20: "is backtesting bug free?" → no)
Working rules: one PR per step off `main`; CI `test` is the real test (no local runner); **merge only on the owner's explicit go-ahead**, squash.

Fixed: (A/A2) real Tiingo price history; (B, PR #72) silent 500-row caps removed via keyset paging; (C) same-day price look-ahead fixed (strict `<` on UTC date); (D) real daily portfolio equity curves + price-coverage preflight; (E) day-major walk + as-of exposure checks.

### Finding G (found 2026-09-23) — FIXED
A same-day replacement booked zero PnL because both prices resolved to the previous daily close. Entry and exit now price off real intraday bars at each item's own timestamp (daily close when none exists).
**Vendors (owner, 2026-09-23; free tiers only):** Alpaca for AAPL/MSFT/TSLA/USO; Tiingo FX intraday for XAUUSD (replaced Twelve Data). Tiingo's equity intraday feed is capped at the newest 2,000 points/ticker.

## Dashboard
Edge-native SSR dashboard (`src/dashboard/*`), done: five nav groups (Overview/Book/Research/Operations/Backtest), theme toggle with light/dark parity, auto-refresh, CSV/JSON export, mobile bottom-sheet nav, global ticker search, verdict card (bull left, bear right, judge beneath), focus states and an a11y pass. The Next.js prototype was a design reference only and was removed 2026-09-24. The 7-step redesign (#92-#97) and token values live in git history.

**Process lessons:** no direct pushes to `main`. **Never `workflow_dispatch` `deploy.yml` from a non-`main` branch**. A CI signal before merge comes only from a real PR into `main` or local `npm test`.

## Known Gaps / Backlog
- **Entity resolution:** SEC-backed name matching exists but is **off by default** (`ENTITY_RESOLUTION_USE_NAME_INDEX` must be `"true"`; `entityResolutionUseNameIndex` in `config.js`), suspected cause of an earlier CPU-limit incident; never validated on live data.
- **News sources:** Finnhub is primary and the ONLY backfill source (`backfillHistoricalNews` uses just the Finnhub windowed fetcher). `gdelt.js` is unwired (only tests import it). RSS/HTML-scrape are live-only; scrape can't handle bot-challenge sites (Reuters/WSJ) and, when a page has no published-time meta, uses fetch time as `publishedAt` (flagged `raw.publishedAtIsFetchTime`; `html_scrape.js` ~L80-82).
- **yfinance** deprecated. **EDGAR** gives only reported `us-gaap` tags, paced at 110ms (`edgarMinRequestIntervalMs`); no delta fetching for price/fundamentals. **Twelve Data removed (2026-10-03):** the adapter, `shared/d1_rate_limiter.js`, their tests, the `twelveData*` config keys and the `TWELVE_DATA_API_KEY` deploy step are gone; XAUUSD intraday is Tiingo FX, everything else Alpaca (`resolveIntradayVendor`). The `vendor_request_counters` table from `migrations/inputs/0003` was dropped by `migrations/inputs/0004` (#194); 0003 itself is untouched (applied migrations are not edited). The `TWELVE_DATA_API_KEY` repo secret, and the Worker secret if one was ever set, can be deleted.
- **Untuned placeholders:** `FLIP_MIN_CONFIDENCE` 0.75, `TRADE_COST_BPS` 5, `SPLIT_GUARD_TOLERANCE` 0.05, `MAX_POSITION_HOLD_DAYS` 10, intraday gate thresholds, and the risk ceilings listed under Decided (`shared/constants.js`). Cross-asset correlation is a static group map only (see Next To-Dos).
- **Exit logic** is bar-based (`graph/exit_check.js`, `agents/risk_mgmt/exit_bars.js`): it walks intraday bars, using the daily bar (coarser) for a UTC day with none. A bar touching both stop and target resolves as the stop; fills are at the level, or the bar's open if it gapped past it. A time exit fills at the first bar open after the hold limit and closes at the `asOf` price if no bar appears within 5 days. A ticker with no bars in the window gets only the time exit, and an entry day with no intraday rows is not checked. `alphaReturn` is always `null` (no benchmark; `graph/settle.js`). Reflection failures are logged and swallowed (LLM-budget and subrequest-budget errors still propagate).
- **No `debates` table exists** (in no migration; the dead `trade_decisions.debate_id` column was dropped in `state/0003`). The debate output is stored on the `trade_decisions` row.
- **Backtests spend real Gemini quota** (several calls per news item + one per close). `scheduled()` only fans out ingest, `exit_check`, the intraday backfill tick and the 03:00 UTC purge; no backtest starts from it, and none should.
- **Not yet observed live:** an ANALYZE crash-and-retry, Queues/D1 ops/day vs. real Observability numbers, fresh `pipeline_checkpoints` on the `*/15` cron, and whether `wrangler.dashboard.toml`'s `[observability.logs]` (enabled in the file) is also on in the live dashboard Worker. After any D1 daily write cap hit, confirm `*/15` ingest/ANALYZE recovered post-reset.
- **Job stuck `queued`/`running` when the terminal progress write fails (mitigated):** `GET /api/jobs/:id` now returns `stale: true` for a queued/running row idle past `ACTIVE_JOB_MAX_IDLE_MS` (15 min, `storage/jobs.js#isJobStale`), and the progress panel stops polling and shows "stalled". The row itself is not rewritten, and no finished-job list shows it. A paused backtest also reads as stale after 15 min (`parkRun` leaves `job_progress` frozen), so the wording is "no progress", not "dead".
- **New instruments:** gold/oil/FX sourcing is decided (see Price data sources); the wider FX/commodity design is not started. Optional: owner runs the remaining news backfill in ~90-day slices up to ~1 year.
- **Dashboard header chrome** (`shell.js`, `env_selector.js`, `controls.js`) and `llm.js` from #185: owner checks on phone, unverified here.
- **LLM-call log buffering (#171)** applies to every `runPipelineForTicker` call, live and backtest alike (`graph/pipeline.js`): rows flush in one batch in `finally`, so a killed Worker loses that item's rows. The `gemini_daily_cap` park path is covered at worker level by `backtest_worker_gemini_daily_cap.test.js`.
- **CI:** no lockfile-sync job (dropped on purpose: one `package.json`, no workspaces; `npm ci` fails on lock drift).
