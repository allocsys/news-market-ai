# News → Market Analysis → Trade Signal Pipeline

_Consolidated 2026-10-03 (ninth pass). Known Gaps re-verified against code; incident narration and duplicated values folded into git._ Per-PR narration, incident logs and vendor research live in git history (`git log -p plan.md`). Labels that code comments reference are unchanged: "Adopted Pattern #N", "Backtesting Integrity point N", "Step N", "Design: environments", "Engine ports", "Decided (2026-09-19)", "Other remaining work #N". **Start with "Next To-Dos", then "Current Status".**_

## Next To-Dos (2026-10-03)
Priority order, code-verified against current `main` (PRs #165-#247 merged, see "Update 2026-10-09" below; live trading OFF by owner decision; paper clock not running). Backtests are started only by the owner from the dashboard's Backtest tab.
1. **Finish the baseline backtest and read it against the rollout gate** (`docs/rollout.md`: >=500 closed trades AND >=3 months, mean net return lower bound `mean - 1.645*SE > 0`). Earlier baselines were tiny (e.g. `backtest-1790860459100-zpv5ex`: AAPL only, 11 trades, FAILED the gate). A run started 2026-10-03 (`backtest-1791023632932-u65p8e`, AAPL, 2026-09-01..05) COMPLETED at 12:08Z in 151 parts (~95 min): n=4 signals, one position traded, nowhere near the gate. The 2026-10-02 run `emy6gk` failed at the part cap (17/120 ticker-days) before #188/#189. A run started 2026-10-03 15:17Z (`backtest-1791040666352-ejwkgx`, AAPL, 2026-09-01..10) was at 6/24 ticker-days at 18:20Z (ETA ~03:20Z). Expect to need several runs to reach 500 trades.
2. **Verify #188 and #189 on a live run.** #188 (Gemini cooldowns in one KV key) is confirmed on `u65p8e`: `kvReads` is 0-1 per part in the `backtest part finished` log. #189 (idle parts do not count toward `BACKTEST_MAX_PARTS`) is not exercised: that run used only 151 of 1500 parts.
3. **Verify the `SIM_DB` purge-guard fires in prod** (`ingest-worker.js`, `wrangler.ingest.toml`): never confirmed against a real purge run. It cannot be confirmed before about 2026-12-23: retention is 180 days (`INTRADAY_RETENTION_DAYS` unset) and intraday data starts 2026-06-26, so the purge deletes nothing until then. The guard skips the purge while a backtest is `queued`/`running` (fresh `job_progress`) or `paused` (`backtest_runs`, no idle cutoff, because parking leaves `job_progress` stale).
4. **Tune knobs only after >= 500 trades** (`FLIP_MIN_CONFIDENCE`, `DRAWDOWN_BREAKER_PCT` + `DRAWDOWN_BREAKER_WINDOW_DAYS`, `SPLIT_GUARD_TOLERANCE`, `TRADE_COST_BPS`, trailing knobs; per-run overrides via `backtest/knobOverrides.js`).
5. **Vol-aware sizing:** on hold. It changes every backtest, so if built it is a per-run knob that defaults to off.

**Update 2026-10-09 (PRs #204-#249 merged; #250 open: dashboard LLM-drawer crash fix):**
- **#244:** backtest equity books a closed position's final stretch at its `exit_price`. Backtests with intraday exits or flips from before #244 are NOT comparable with later ones; re-run comparisons.
- **#245:** the backtest registry row is written at POST time, so run detail no longer 404s right after a start.
- **#246 (XAUUSD exposure experiment, shared with LIVE config):** `MAX_POSITION_PCT_BY_TICKER` XAUUSD 0.30, `GROUP_EXPOSURE_CAP_BY_GROUP` gold 0.30, `MAX_PORTFOLIO_RISK_PCT` 0.50, `MAX_PORTFOLIO_STOP_RISK_PCT` 0.02 (all in `shared/constants.js`). Supersedes the 2026-10-03 "ceilings stay" decision for these values; the default group cap (10%), drawdown breaker (2% over 14 days) and other tickers' 5% size cap are unchanged. Still untuned placeholders.
- **#236 / #247:** macro ingestion (FRED + COT) and a backfill button; FRED requests use `realtime_start=observationStart` and chunk long ranges. Macro live switch is ON.
- **#240-#243:** dashboard Overview changes (realized P&L hero card, latest-decision fold, batched reads, exposure gauge and mobile grid fix); #238 removed dashboard mock mode.
- **Latest XAUUSD backtest** (`backtest-1791492263927-i5f3w8`, 2026-10-01..10-08, 30% sizing, macro ON): +0.25%, max drawdown 0.15%, avg exposure 19.5%, 1 trade (open at end); the earlier 15% run was -0.12%, buy-and-hold -1.20%. All 9 rejections were confidence 0.55-0.58 under the 0.6 threshold. Owner decision: keep the 0.6 threshold and the relevance filter as they are. Longer (60-90 day) XAU run still open.
- **#249 BTCUSD support (merged):** Tiingo crypto daily branch, crypto 5-min intraday adapter + vendor routing, `CRYPTO_24X7_TICKERS` in `shared/intraday_sanity.js` (no closed window), per-ticker hold calendar in `risk_mgmt/exit.js` (BTCUSD counts 7 days), `BTCUSD` in `WATCHLIST_TICKERS` (all 4 tomls), `TICKER_GROUPS` crypto, default Finnhub news proxy `BTCUSD: IBIT` (`config.js`), dashboard `NO_EDGAR_TICKERS`. BTC sizing matches XAUUSD for the experiment: `MAX_POSITION_PCT_BY_TICKER` BTCUSD 0.30 and `GROUP_EXPOSURE_CAP_BY_GROUP` crypto 0.30. BTC is far more volatile than gold: a stop wider than ~6.7% at 30% size exceeds `MAX_PORTFOLIO_STOP_RISK_PCT` (2%) and the trade is rejected. Keep `macroEnabled` OFF for BTC runs (the macro prompt data is gold-specific). BTC-only runs use the active-tickers switch (`POST /controls/tickers?tickers=BTCUSD`).
- **BTC data checks (inputs D1, 2026-10-09):** Tiingo crypto works on the current plan (91 daily bars 2026-07-11..10-09; 3,456 five-minute bars = 12 full days). Intraday backfill is partial: 12 days done (07-11..07-22), 79 pending (07-23..10-09), so a long BTC backtest waits for it. IBIT news is thin: 78 BTCUSD items in the 30 days to 10-08 (~2.6/day, some days 0) vs XAUUSD 147 and AAPL 1,525; GBTC/COIN remain fallback proxies. `TRADE_COST_BPS` is the global 5 bps for crypto (untuned). First BTC-only backtest (`backtest-1791557731669-1zz0ev`, 2026-10-02..10-09, macro off, gate on): strategy -0.66%, max drawdown 1.1%, avg exposure 16.8%, 1 trade (net -4.5%); buy-and-hold -3.77%. One trade is not evidence. XAUUSD leverage is still not started and needs owner approval.

**Decided (owner, 2026-10-03):**
- Risk ceilings stay as they are until there is trade evidence: gross exposure 50% (`MAX_PORTFOLIO_RISK_PCT`), loss-at-stop 2% (`MAX_PORTFOLIO_STOP_RISK_PCT`), group cap 10% (gold group 30%) [values raised by #246 on 2026-10-08, see "Update 2026-10-09"; the original 2026-10-03 values were 20% / 0.75%], drawdown breaker 2% over 14 days. Trailing/break-even knobs stay at 0 (off): the evidence is 3 trades.
- **Correlation:** the 2026-09-25 plan for a computed correlation matrix is SUPERSEDED by the static `TICKER_GROUPS` map + `MAX_GROUP_EXPOSURE_PCT` (#176/#177): a computed matrix needs extra price reads per decision, which the 40-subrequest backtest budget cannot afford (`shared/constants.js`). Known gap: macro co-movement across groups (e.g. USO/XAUUSD in a risk-off move) is only bounded by the loss-at-stop ceiling.
- **No config changes** to backtest limits (`BACKTEST_MAX_TOTAL_SUBREQUESTS` 40, 15s part delay); no pre-warm, parallelisation or batching of pipeline stages. More Gemini keys is the only accepted lever for throughput (currently 4 keys, confirmed by the owner 2026-10-03).
- No news relevance FILTER: every item is ingested and stored, and nothing is dropped by keyword or source. **Price-impact gate (owner, 2026-10-04):** the one analyst call also judges whether the article can move the TICKER'S PRICE (relevance none/indirect/direct, price direction, channel; not the article's tone, not whether the ticker is named). A confident `none` ends the run before the debate and trader calls (decision status `skipped_irrelevant`, opinions and reason kept, no position); a missing, unclear, `indirect` or `direct` verdict continues as before. `SKIP_NO_PRICE_IMPACT=false` turns the gate off. Motivation: XAUUSD news is fetched under GLD, so many items (personal-finance and dividend pieces) have no price effect yet each cost a full pipeline run of Gemini quota. Audit skipped items with `status = 'skipped_irrelevant'`. Backtest resume is manual only; a backtest never starts or resumes by itself.
- The `platform_limit` pause trigger stays unbuilt (needs the exact D1/KV limit error text from observability). Replacing the quota ledger with the Cloudflare analytics API was considered and dropped.
- **Backtest window (owner, 2026-10-03):** baselines look back at most ~1 month, inside the intraday data (from 2026-06-26), so the daily-bar fallback is not reached. No older intraday backfill, no price-adjustment work, and `DAILY_BOTH_TOUCHED_NEAREST_OPEN` stays 0 (stop first). The stored daily bars (5 tickers, 2025-08-25..2026-10-02) have no one-day close-to-close move above +25% or below -20% (checked 2026-10-03), i.e. no split to adjust for. Revisit only if a window reaches before 2026-06-26, a ticker is added, or a held ticker splits. These two gaps are CLOSED: do not re-check them.
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
3. **Analyst team**: News/Event, Sentiment (5-band + justification), Price impact (relevance to the ticker's price, direction, channel; gates the debate, see Decided), Technical, in one call on the quick model.
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
Five Workers (the dashboard plus four backend-side ones), connected by queues and service bindings, each binding only the D1s it needs; only `backend` runs migrations.
- **`dashboard`** (`dashboard-next/`, Worker `news-market-ai-dashboard`, OpenNext): ONE Worker, the only UI and the public entry point. It also does what the old gateway Worker did, in-process (`dashboard-next/src/server/gateway.mjs`): login + session cookie (`/api/login`, `/api/logout`) and the session-gated JSON gateway (`GET /api/*`, and the POST trigger routes `/backfill`, `/backfill-prices`, `/backtest/*`, `/controls/*`) forwarded to `backend` over the `BACKEND` service binding. Only Worker holding the session JWT secret; secrets `DASHBOARD_USERNAME`, `DASHBOARD_PASSWORD`, `JWT_SECRET` (+ optional `SESSION_TTL_SECONDS`); no D1/KV. Deployed from `main` by the `deploy-dashboard` job in `.github/workflows/deploy.yml` (8th job: after the backend `deploy` job, gated by the `dashboard` filter = `dashboard-next/**`; builds with OpenNext, then sets the secrets; the gateway tests run in the root `test` job; PR build check: `dashboard-next.yml`). The separate gateway Worker (`src/dashboard-worker.js`, `wrangler.dashboard.toml`, the old SSR-era `deploy-dashboard` job) was retired 2026-10-07.
- **`backend`**: private JSON `/api/*`, `POST /backfill`, `POST /backtest/run`, `*/15` cron (pure fan-out), migrations. No vendor key, no `queue()` export.
- **`ingest`**: `INGEST` (batch 10) + `BACKFILL` (batch 1) consumers; holds `FINNHUB_API_KEY`; binds `LIVE_DB` (rw, `job_progress` only) and `SIM_DB` (only to check whether a backtest is running before the intraday purge).
- **`llm`**: live Gemini caller (`GEMINI_API_KEYS`); binds `LIVE_DB` rw, `INPUTS_DB` ro; consumes `ANALYZE` and `LLM_JOBS` (`exit_check` only).
- **`backtest`**: private; consumes `BACKTEST` (batch 1, concurrency 1, DLQ); binds `SIM_DB` rw, `INPUTS_DB` ro, own `CACHE_KV`, **no `LIVE_DB`** (CI-pinned); own `GEMINI_API_KEYS`, never `FINNHUB_API_KEY`.

Every queue has a DLQ (`max_retries` 3). CI: `test` → `migrate` (gated on `migrations/**`) → one deploy job per Worker, each diffed against its last successful deploy; docs-only PRs deploy nothing. **Lesson:** a green deploy says nothing about live bindings; compare each Worker's live bindings to its wrangler file. wrangler v4 required. `sendBatch` takes at most 100 messages per call, so senders chunk (an oversized batch was once acked silently and no analysis ran).

## LLM Layer: Multi-Key Gemini Cascade
**Model-first, two-axis:** outer loop tries `[requestedModel, ...GEMINI_FALLBACK_MODELS]` across every key before dropping a tier; inner loop rotates keys on 401/403/429/503/transient. **Cooldown:** KV with TTL, written only on rate-limit; fails open. Stored as ONE map key `gemini:cooldown-map` (see the 2026-10-03 note above; the cascade still asks per `gemini:cooldown:<model>:<keyIndex>` name, `shared/cooldown_map_kv.js` answers from the map). The fallback list must differ from the requested model.

**Models (2026-09-22):** quick `3.1-flash-lite`, deep `3.6-flash`; fallbacks `3.1-flash-lite, 3.5-flash-lite, 3.5-flash, 3.7-flash, 3.8-flash, 3.6-flash, 3-flash-preview` (`wrangler.llm.toml`, `wrangler.backtest.toml`, `config.js`). **Lesson (2026-09-22 incident):** Google retired `gemini-2.5-flash` while it sat last in the fallback list; a 404 is fatal-not-transient by design, so an exhausted cascade killed a live backtest. Revisit the list periodically; entries can go from "rate-limited" to "retired" with no warning. **Retired-model handling:** the first 404 for a model logs `[gemini] MODEL UNAVAILABLE (404): "<model>" ...` at error level (grep that string in Observability) and stores a 6 h mark (`gemini:cooldown:dead-<model>:0`, inside the single cooldown map, so no extra KV read); later calls skip the model without spending an attempt. If every model is marked the marks are ignored (a false 404 heals itself). Remove the model from the wrangler lists when you see the line.

**LLM call log** (LLM tab in dashboard-next, `GET /api/llm-calls[/:id]`): every prompt/response incl. failures → `llm_calls`, via `agents/utils/structured.js#callStructured`. Best-effort; `LLM_LOG_ENABLED=false` disables; ~4 D1 rows/call; pruned after `LLM_LOG_RETENTION_DAYS` (default 14; the prune runs in `llm-worker.js`); clipped at 60,000 chars. Rows are buffered per news item and flushed in one batch (see Known Gaps).

## Historical news backfill
`POST /backfill?from=&to=` → `BACKFILL` queue → `ingest` in self-continuing parts (caps: 40 requests/500 items/invocation, 50 parts/job). Verified 2026-09-20: 90 days = 10,025 items in 13 parts, 0 errors; reruns dedupe; Finnhub `to` is inclusive. ~29 MB/10K articles, so run ~90-day slices up to a year.

## Price data sources
Yahoo/yfinance 429s on Workers, so **Tiingo** is the daily-bar source (AAPL/MSFT/TSLA/USO/XAUUSD confirmed live 2026-09-21). Free plan: 50 req/hr, 1,000/day; Forex endpoint covers XAU/XAG/XPT + majors, OHLC only, no oil.

**Decided:** gold = spot XAUUSD via Tiingo Forex (not GLD); oil = ETF proxy (USO); forex = signals only, paper positions, no execution layer. Stored prices are **raw** (unadjusted); `shared/split_guard.js` stops the exit walk at a suspected split. Decided 2026-10-03: no adjustment work (no split in the stored bars, windows stay within ~1 month; see Next To-Dos > Decided). **Open:** how news maps to a commodity/FX ticker; position/risk model for FX/commodities (units, leverage, pips, shorting); 24h/weekend markets vs daily bars and hold-day exits.

## Repo Structure (under `src/` unless noted)
```
index.js               # `backend` Worker: API, /backfill, /backtest/run, cron
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
llm/  agents/  graph/  backtest/
dashboard/             # JSON API support only: api.js, data.js, routes.js, helpers.js (query-param parsing + constants)
dashboard-next/        # (repo root) the `dashboard` Worker: Next.js UI + login, session and the JSON gateway (src/server/gateway.mjs); own CI/deploy workflows
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
The UI is **`dashboard-next/`**: a mobile-first Next.js 16 app deployed as its own Cloudflare Worker via OpenNext (PR #225; replaced the server-rendered UI). Flow: browser -> `news-market-ai-dashboard` (the Next.js app; login, the session cookie and the session-gated gateway run in the same Worker, `dashboard-next/src/server/gateway.mjs`) -> service binding `BACKEND` -> private `backend` JSON API. `dashboard-next/src/lib/backend.ts` picks the upstream (`BACKEND` binding, else `BACKEND_URL` for local dev; with neither, the API routes answer 503 and there is no mock mode); the catch-all `dashboard-next/src/app/api/[...path]/route.ts` maps `/api/<route>` to the gateway paths (`toGatewayPath`; `NON_API_ROUTES` lists the ones outside `/api`) and calls `handleGateway`. `gateway.mjs`, `session.mjs` and `jwt.mjs` keep copies of `src/auth/*` and two backend constants (`PAUSE_KEYS`, `BACKTEST_ID_RE`); `test/dashboard_gateway_parity.test.js` fails if they drift. Tabs: Today, Book, Signals, More (backtest, backfill, controls, LLM calls). The old SSR code (`src/dashboard/shell.js`, `views/*`, the card/picker/CSS modules, the HTML login page and their view tests) was deleted in #225; `src/dashboard/` keeps only the JSON API support listed under Repo Structure, and the old `/dashboard/*` URLs now 404. Details: `dashboard-next/README.md`.

**Unverified (owner, on a real deployment):** the first deploy of the new app happens on merge to `main`, and it replaces both the old UI and the old gateway Worker in one step (same Worker name and workers.dev URL, no fallback UI). Still to check after merge: Deploy and Deploy Dashboard Next green (its "Set login secrets" step must not have skipped), log in and walk every tab on a phone; cookie `Secure`/`SameSite` behaviour on the new origin; no lockfile in `dashboard-next/` (installs use `npm install`).

**Process lessons:** no direct pushes to `main`. **Never `workflow_dispatch` `deploy.yml` from a non-`main` branch**. A CI signal before merge comes only from a real PR into `main` or local `npm test`.

## Known Gaps / Backlog
- **Entity resolution:** SEC-backed name matching exists but is **off by default** (`ENTITY_RESOLUTION_USE_NAME_INDEX` must be `"true"`; `entityResolutionUseNameIndex` in `config.js`), suspected cause of an earlier CPU-limit incident; never validated on live data.
- **News sources:** Finnhub is primary and the ONLY backfill source (`backfillHistoricalNews` uses just the Finnhub windowed fetcher). `gdelt.js` is unwired (only tests import it). RSS/HTML-scrape are live-only; scrape can't handle bot-challenge sites (Reuters/WSJ) and, when a page has no published-time meta, uses fetch time as `publishedAt` (flagged `raw.publishedAtIsFetchTime`; `html_scrape.js` ~L80-82).
- **yfinance** deprecated. **EDGAR** gives only reported `us-gaap` tags, paced at 110ms (`edgarMinRequestIntervalMs`); no delta fetching for price/fundamentals. **Twelve Data removed (2026-10-03):** the adapter, `shared/d1_rate_limiter.js`, their tests, the `twelveData*` config keys and the `TWELVE_DATA_API_KEY` deploy step are gone; XAUUSD intraday is Tiingo FX, everything else Alpaca (`resolveIntradayVendor`). The `vendor_request_counters` table from `migrations/inputs/0003` was dropped by `migrations/inputs/0004` (#194); 0003 itself is untouched (applied migrations are not edited). The `TWELVE_DATA_API_KEY` repo secret, and the Worker secret if one was ever set, can be deleted.
- **Untuned placeholders:** `FLIP_MIN_CONFIDENCE` 0.75, `TRADE_COST_BPS` 5, `SPLIT_GUARD_TOLERANCE` 0.05, `MAX_POSITION_HOLD_DAYS` 10, intraday gate thresholds, and the risk ceilings listed under Decided (`shared/constants.js`). Cross-asset correlation is a static group map only (see Next To-Dos).
- **Exit logic** is bar-based (`graph/exit_check.js`, `agents/risk_mgmt/exit_bars.js`): it walks intraday bars, using the daily bar (coarser) for a UTC day with none. A bar touching both stop and target resolves as the stop (a daily bar flags it as ambiguous and logs it; `DAILY_BOTH_TOUCHED_NEAREST_OPEN`, default 0, with a per-run override, can pick the level nearest the open instead; with intraday bars the real touch order is used, so this is not reached inside the intraday data, see Decided 2026-10-03); fills are at the level, or the bar's open if it gapped past it. A time exit fills at the first bar open after the hold limit and closes at the `asOf` price if no bar appears within 5 days. A ticker with no bars in the window gets only the time exit, and an entry day with no intraday rows is not checked. `alphaReturn` is always `null` (no benchmark; `graph/settle.js`). Reflection failures are logged and swallowed (LLM-budget and subrequest-budget errors still propagate).
- **No `debates` table exists** (in no migration; the dead `trade_decisions.debate_id` column was dropped in `state/0003`). The debate output is stored on the `trade_decisions` row.
- **Backtests spend real Gemini quota** (several calls per news item + one per close). `scheduled()` only fans out ingest, `exit_check`, the intraday backfill tick and the 03:00 UTC purge; no backtest starts from it, and none should.
- **Not yet observed live:** an ANALYZE crash-and-retry, Queues/D1 ops/day vs. real Observability numbers, fresh `pipeline_checkpoints` on the `*/15` cron, and whether `dashboard-next/wrangler.jsonc`'s `observability.logs` (enabled in the file) is on in the live dashboard Worker. After any D1 daily write cap hit, confirm `*/15` ingest/ANALYZE recovered post-reset.
- **Job stuck `queued`/`running` when the terminal progress write fails (mitigated):** `GET /api/jobs/:id` now returns `stale: true` for a queued/running row idle past `ACTIVE_JOB_MAX_IDLE_MS` (15 min, `storage/jobs.js#isJobStale`), and the progress panel stops polling and shows "stalled". The row itself is not rewritten, and no finished-job list shows it. A paused backtest also reads as stale after 15 min (`parkRun` leaves `job_progress` frozen), so the wording is "no progress", not "dead".
- **New instruments:** gold/oil/FX sourcing is decided (see Price data sources); the wider FX/commodity design is not started. Optional: owner runs the remaining news backfill in ~90-day slices up to ~1 year.
- **Dashboard (dashboard-next) on phone:** owner checks Today/Book/Signals/More, the backtest env selector and PAUSED banner, the LLM-answer expander, and the Step 5 cards; unverified here.
- **LLM-call log buffering (#171)** applies to every `runPipelineForTicker` call, live and backtest alike (`graph/pipeline.js`): rows flush in one batch in `finally`, so a killed Worker loses that item's rows. The `gemini_daily_cap` park path is covered at worker level by `backtest_worker_gemini_daily_cap.test.js`.
- **CI:** no lockfile-sync job (dropped on purpose: one `package.json`, no workspaces; `npm ci` fails on lock drift).
