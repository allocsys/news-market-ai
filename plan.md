# News → Market Analysis → Trade Signal Pipeline

_Trimmed 2026-09-25 (fifth pass). Per-PR narration, incident
logs and vendor research live in git history (`git log -p plan.md`). Labels
that code comments reference are unchanged: "Adopted Pattern #N", "Backtesting
Integrity point N", "Step N", "Design: environments", "Engine ports",
"Decided (2026-09-19)", "Other remaining work #N". **Start with "Next To-Dos",
then "Current Status".**

## Next To-Dos (2026-09-25)
Priority order, code-verified against current `main` (3a3bb6a):
1. ~~Decide fate of ~427 pre-fix news items never analyzed~~ — DECIDED (owner, 2026-09-25): leave them be, no re-enqueue.
2. ~~**Backfill path still never enqueues ANALYZE**~~ — BY DESIGN (owner, 2026-09-25): backfill and analysis are intentionally separate; not a gap to fix.
3. ~~**Investigate stalled equities intraday backfill**~~ — RESOLVED 2026-09-25: verified via direct D1 query, `intraday_backfill_status` shows all 5 tickers (AAPL/MSFT/TSLA/USO/XAUUSD) `done`, 92/92 days each, range 2026-06-26→2026-09-25. Plan.md's "stalled at 2026-07-01" note was itself stale; the gradual per-day cron (deployed 2026-09-24) caught up.
3b. **NEW (2026-09-25): D1 free-tier daily row-read limit hit again** (`INPUTS_DB`) — a live query against `price_bars_intraday` failed with "exceeded D1's free tier daily row read limit"; same cap noted as hit once before on 2026-09-20 (see Free-plan budgets). Blocks further reads/writes on that DB until UTC midnight reset, or a plan upgrade.
4. **Verify `SIM_DB` purge-guard actually fires in prod** — binding and guard code are in place (`ingest-worker.js`, `wrangler.ingest.toml`), just never confirmed against a real purge run.
5. **First clean backtest (F)** — 2 complete / 11 failed / 3 cancelled in `sim.backtest_runs` as of 2026-09-24; still unreviewed whether either complete run counts.
6. Build `BACKTEST_DAILY_WRITE_BUDGET` (proposed 40K, not approved) if the owner signs off.
7. Portfolio correlation/cross-asset-exposure check — still just a flat risk-budget check (`portfolio_manager.js`).
8. Wire `debates` table write path, or drop `trade_decisions.debate_id` for real (currently always null, table already dropped).

**Done since last pass, removed from backlog:** dashboard `?env=` selector (built — `src/dashboard/views/env_selector.js`, `parseEnvParam`/`resolveEnv`); #125/#126 merged 2026-09-25 (Gemini 3.5-flash fallback added, D1 news-scan bounded by date instead of ticker history, job-progress polling cut 1.5s→5s, `deleteRun` batched).

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
1. **Ingestion**: normalize every source into one schema (`id` = sha256(url+published_at), `source`, `url`, `published_at` = exact public time not ingestion time, `ingested_at`, `tickers`, `title`, `body`, `raw`). Sources: Finnhub `/company-news` (primary), RSS, HTML scrape, Tiingo (bars), Alpaca (intraday), SEC EDGAR (XBRL fundamentals).
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

## Architecture: Cloudflare Workers + D1 + KV (free tier)
Five Workers connected by queues, each binding only the D1s it needs; only `backend` runs migrations.
- **`dashboard`**: only public Worker: login, session, SSR UI; reaches `backend` via service binding.
- **`backend`**: private JSON `/api/*`, `POST /backfill`, `POST /backtest/run`, `*/15` cron (pure fan-out), migrations. No vendor key, no `queue()` export.
- **`ingest`**: `INGEST` (batch 10) + `BACKFILL` (batch 1) consumers; holds `FINNHUB_API_KEY`; binds `LIVE_DB` (rw, `job_progress` only) and `SIM_DB` (only to check whether a backtest is running before the intraday purge).
- **`llm`**: live Gemini caller (`GEMINI_API_KEYS`); binds `LIVE_DB` rw, `INPUTS_DB` ro; consumes `ANALYZE` and `LLM_JOBS` (`exit_check` only).
- **`backtest`**: private; consumes `BACKTEST` (batch 1, concurrency 1, DLQ); binds `SIM_DB` rw, `INPUTS_DB` ro, own `CACHE_KV`, **no `LIVE_DB`** (CI-pinned); own `GEMINI_API_KEYS`, never `FINNHUB_API_KEY`.

Every queue has a DLQ (`max_retries` 3). CI: `test` → `migrate` (gated on `migrations/**`) → one deploy job per Worker, each diffed against its last successful deploy; docs-only PRs deploy nothing. **Lesson:** a green deploy says nothing about live bindings; compare each Worker's live bindings to its wrangler file. wrangler v4 required.

## LLM Layer: Multi-Key Gemini Cascade
**Model-first, two-axis:** outer loop tries `[requestedModel, ...GEMINI_FALLBACK_MODELS]` across every key before dropping a tier; inner loop rotates keys on 401/403/429/503/transient. **Cooldown:** KV `gemini:cooldown:<model>:<keyIndex>` with TTL, written only on rate-limit; fails open. The fallback list must differ from the requested model.

**Models (2026-09-22):** quick `3.1-flash-lite`, deep `3.6-flash`; fallbacks `3.1-flash-lite, 3.5-flash-lite, 3.7-flash, 3.8-flash, 3.6-flash, 3-flash-preview` (`wrangler.llm.toml`, `wrangler.backtest.toml`, `config.js`). **Lesson (2026-09-22 incident):** Google retired `gemini-2.5-flash` while it sat last in the fallback list; a 404 is fatal-not-transient by design, so an exhausted cascade killed a live backtest. Revisit the list periodically; entries can go from "rate-limited" to "retired" with no warning.

**LLM call log** (`/dashboard/llm`): every prompt/response incl. failures → `llm_calls`, via `agents/utils/structured.js#callStructured`. Best-effort; `LLM_LOG_ENABLED=false` disables; ~4 D1 rows/call; pruned after 14 days; clipped at 60,000 chars.

## Live incidents (fixed; lessons)
- **No analysis after M4 cutover (2026-09-20):** `ANALYZE.sendBatch` exceeded Cloudflare's 100-message cap and acked silently; fixed via chunked sending. **Open:** ~427 pre-fix items never analyzed (see Next To-Dos #1).
- **First price backfill (2026-09-20):** yfinance 429s + D1 write cap stuck a job `queued` forever; resolved via Tiingo switch.
- **Service split (2026-09-19, PRs #27–#33):** one Worker was hitting CPU limits nearly every tick; fixed by splitting Workers.

## Historical news backfill
`POST /backfill?from=&to=` → `BACKFILL` queue → `ingest` in self-continuing parts (caps: 40 requests/500 items/invocation, 50 parts/job). Verified 2026-09-20: 90 days = 10,025 items in 13 parts, 0 errors; reruns dedupe; Finnhub `to` is inclusive. ~29 MB/10K articles, so run ~90-day slices up to a year.

## Price data sources
Yahoo/yfinance 429s on Workers, so **Tiingo** is the daily-bar source (AAPL/MSFT/TSLA/USO/XAUUSD confirmed live 2026-09-21). Free plan: 50 req/hr, 1,000/day; Forex endpoint covers XAU/XAG/XPT + majors, OHLC only, no oil.

**Decided:** gold = spot XAUUSD via Tiingo Forex (not GLD); oil = ETF proxy (USO); forex = signals only, paper positions, no execution layer. Stored prices are **raw** (unadjusted), so splits/dividends aren't reflected over long windows (not discussed with the owner). **Open:** how news maps to a commodity/FX ticker; position/risk model for FX/commodities (units, leverage, pips, shorting); 24h/weekend markets vs daily bars and hold-day exits.

## Repo Structure (under `src/` unless noted)
```
index.js               # `backend` Worker: API, /backfill, /backtest/run, cron
dashboard-worker.js    # `dashboard`: login, SSR UI
ingest-worker.js       # `ingest`: INGEST + BACKFILL consumers
llm-worker.js          # `llm`: ANALYZE + exit_check
backtest-worker.js     # `backtest`: BACKTEST consumer
ingestion/             # Finnhub, GDELT (unwired), EDGAR, RSS, scrape, Tiingo, Alpaca adapters
  intraday_backfill.js # cron-driven gradual intraday backfill
  intraday_purge.js    # retention purge (skipped while a backtest runs)
  errors.js, date_windows.js, market_data_validator.js
shared/                # price_availability.js, intraday_availability.js, intraday_sanity.js, errors.js
storage/               # run_store.js, inputs_view.js, sim_registry.js
llm/  agents/  graph/  backtest/  dashboard/
migrations/            # inputs/, state/, sim/
config/  tests/
```

## Current Status
Built end to end: schemas, Gemini cascade, debate + judge, deterministic risk/sizing + portfolio sign-off, all adapters, positions store with stop/take-profit/time exits, technical analyst on price bars, settlement → reflection loop, date-windowed backfill, signal on/off backtest harness, live-progress job panel, backtest/live isolation (M1–M5), subrequest-budgeted resumable backtests. CI and deploys are green across all five Workers.

### Backtest trustworthiness (audit 2026-09-20: "is backtesting bug free?" → no)
Working rules: one PR per step off `main`; CI `test` is the real test (no local runner); **merge only on the owner's explicit go-ahead**, squash.

Fixed: (A/A2) real Tiingo price history; (B, PR #72) silent 500-row caps removed via keyset paging; (C) same-day price look-ahead fixed (strict `<` on UTC date); (D) real daily portfolio equity curves + price-coverage preflight; (E) day-major walk + as-of exposure checks.

**Open: F. First small clean backtest.** `sim.backtest_runs` (2026-09-24): 2 complete, 11 failed, 3 cancelled; whether the complete runs count as clean F results is unreviewed. Once a run completes cleanly: confirm no `Too many subrequests`, sanity-check the equity curve, then decide with the owner on a fuller span. Note that the first clean run predates intraday pricing, so the next run is the first to exercise finding G's fills. A multi-month run (queue wall-time, CPU limits) is untried; the part/continuation mechanism is the mitigation.

### Finding G: same-day replacement booked zero PnL (found 2026-09-23) — FIXED
**Cause:** `getPriceBarsAsOf` resolves at UTC-day granularity, so two same-ticker same-day news items get the same price (previous close). `graph/pipeline.js`'s replace path used one price for both `entryPrice` and `exitPrice`, so `computeRealizedReturn` always returned 0.
**Fix:** price entry/exit off real intraday bars at each item's own timestamp, falling back to the daily close (logged loudly, Pattern #11) when no intraday bar exists.

**Vendors (decided 2026-09-23, owner; free tiers only):** **Alpaca** for AAPL/MSFT/TSLA/USO; **Tiingo FX intraday** for XAUUSD (switched 2026-09-24 off Twelve Data, whose XAUUSD feed proved untrustworthy). Paid tiers avoided (Polygon/Massive Starter $29/mo, Twelve Data Grow $29/mo). Tiingo's equity intraday feed is capped at the newest 2,000 points/ticker, so unusable as a history archive.

**Built (each its own PR, squash-merged):**
1. Schema `price_bars_intraday` (separate from daily `price_bars`); 2. adapters; 3. `getIntradayPriceAsOf` (`ts + 5min <= asOf`, optional `maxAgeMs`, leak guard + test); 4. `pipeline.js` and `exit_check.js` intraday-with-daily-fallback (PRs #100–109); 5. tests (`finding_g_intraday_pnl.test.js`, PR #110); 6. gradual backfill (PR #111): `intraday_backfill.js` claims the oldest pending/failed day per ticker per `*/15` tick (`intraday_backfill_status`, stale `in_progress` reclaimed after 30 min, per-ticker failure isolation, 90-day lookback seeded once per new ticker); `intraday_purge.js` retention 180 days, skipped entirely while any backtest is queued/running, ~03:00 UTC daily.
7. **XAUUSD vendor switch, 2026-09-24:** #115 `tiingo_fx_intraday.js` adapter (5min resample via `tiingoFxIntradayResampleFreq`) + routing in `resolveIntradayVendor`. CI caught a real bug: the adapter kept milliseconds in `ts`, but reads compare `ts` as strings, so `…:00.000Z` sorts before `…:00Z` and misplaces the boundary bar (fixed with `canonicalIntradayTs`). #116 write-time sanity gate in `insertPriceBarsIntraday`, used by every vendor: drops bars that are unparseable, non-positive, >10% range per 5-min bar, a lone >15% spike vs both neighbours, or inside a closed-market window (equities Sat 01:00Z–Mon 08:00Z; XAUUSD Fri 22:00Z–Sun 22:00Z); canonicalises `ts`. Rejections are logged and noted in `intraday_backfill_status.error` (the day stays `done`; a `failed` day would be re-claimed every tick and burn vendor quota). Thresholds are untuned placeholders; no holiday calendar.
8. **Twelve Data purge, executed 2026-09-24** (owner-approved, no backup): deleted 2,017 XAUUSD `twelvedata` bars and reset all 91 XAUUSD status rows to `pending` with `vendor='tiingo_fx_intraday'`. **Lesson:** `claimNextBackfillDay` routes by the status row's own `vendor`, and seeding never rewrites it, so a vendor switch must also update existing rows or they'd fetch from the wrong vendor.

**Open after G:**
- Verify the first live Tiingo XAUUSD ticks (bars written, gate rejections in `status.error`). **Unverified:** whether Tiingo FX intraday reaches 90 days back or is subject to the same 2,000-point cap.
- ~~Equities intraday bars stop at 2026-07-01~~ RESOLVED 2026-09-25: fully caught up, see Next To-Dos #3.
- The `ingest` Worker's live `SIM_DB` binding (purge guard) is unverified in production; purge-run check on a real run still to do.
- No dashboard view of `intraday_backfill_status`; no re-seed path if the lookback is widened; the 03:00 UTC purge hour is arbitrary.

### Other remaining work
1. **Live verification** (not yet observed): an ANALYZE crash-and-retry, Queues/D1 ops/day vs. real Observability numbers, fresh `pipeline_checkpoints` on the `*/15` cron.
2. ~~**~427 pre-fix news items never analyzed**~~: DECIDED 2026-09-25 (owner) — leave as-is, no re-enqueue.
3. ~~**Check whether the backfill path enqueues ANALYZE** given the Queues cap.~~ BY DESIGN (owner, 2026-09-25): backfill and analysis are intentionally separate concerns, not a gap.
4. **`BACKTEST_DAILY_WRITE_BUDGET`** proposed (40K), not approved, not built.
5. **Optional:** owner runs remaining news backfill in ~90-day slices up to ~1 year.
6. ~~Dashboard environment selector (`?env=`)~~ — DONE (`src/dashboard/views/env_selector.js`, `parseEnvParam`/`resolveEnv`).
7. **D1 daily write cap**: after any future hit, confirm `*/15` ingest/ANALYZE recovered post-reset.
8. **Job stuck `queued` when the terminal progress write fails**: needs a dashboard-side stale/timeout state.
9. **New instruments (gold, oil, forex):** sourcing decided; wider FX/commodity design not started.
10. Whether `wrangler.dashboard.toml`'s `[observability.logs]` is enabled on the live dashboard Worker: unverified.

## Dashboard (all DONE)
**UX adoption (2026-09-22):** ported the `prototype-ui-overhaul` ideas into the existing edge-native SSR dashboard (`src/dashboard/*`: `helpers.js` renderers, `data.js` reads, `api.js` routes): theme toggle, auto-refresh, CSV/JSON export, mobile bottom-sheet nav (#89), Overview command center (#90), global ticker search (#91). The Next.js prototype was a design reference only and was **removed from the repo 2026-09-24**; Next.js would need its own hosting and an extra hop per fetch.

**Redesign (2026-09-22), 7 steps, one PR each:** tokens + shell (#92: Carbon Ink `#14171F`, Ticker Amber `#D98E3C`, Bull Sage/Bear Brick; Fraunces / IBM Plex Sans / IBM Plex Mono) → nav reorg to 5 groups Overview/Book/Research/Operations/Backtest (#93; nav-level only, old URLs unchanged, group landing routes 302 to the first section) → ledger tables (direct push to `main` `85056c6`, out of process, audited and left in place) → verdict card, bull left/bear right/judge's ruling beneath (#94) → stat cards as instrument readouts (#95) → light theme parity (#96) → focus states + a11y pass (#97). Light-theme contrast was hand-computed (AA); a real checker pass is still worth doing.

**Process lessons:** no direct pushes to `main`. **Never `workflow_dispatch` `deploy.yml` from a non-`main` branch**: it has no test-only mode and runs the full pipeline including migrations and every deploy job (near-miss 2026-09-22, cancelled in time). A CI signal before merge comes only from a real PR into `main` or local `npm test`. For the redesign the owner had confirmed auto-merge on green CI; for the intraday work the go-ahead is per PR.

## Known Gaps / Backlog
- **Entity resolution:** SEC-backed name matching exists but is **off** (`ENTITY_RESOLUTION_USE_NAME_INDEX`), suspected cause of an earlier CPU-limit incident; never validated on live data.
- **News sources:** Finnhub primary and backfill-capable. `gdelt.js` unwired (response shape never confirmed). RSS/HTML-scrape are live-only; scrape can't handle bot-challenge sites (Reuters/WSJ) and falls back to fetch-time (unsafe for point-in-time) when a page has no published-time meta.
- **yfinance** deprecated. **EDGAR** gives only reported `us-gaap` tags, paced at 110ms; no shared cross-vendor rate limiter; no delta fetching for price/fundamentals.
- **Untuned placeholders:** `MAX_PORTFOLIO_RISK_PCT` (0.20), `config.maxPositionHoldDays` (10), intraday gate thresholds. No correlation check in portfolio sign-off.
- **Exit logic** fires only time-based exits until price bars exist before a position opens. `alphaReturn` is always `null` (no benchmark). Reflection failures are logged and swallowed.
- **`debates` table** has no write path (`trade_decisions.debate_id` always null).
- **Backtests spend real Gemini quota** (several calls per news item + one per close): manual only, never wire into `scheduled()`.
- **CI:** no lockfile-sync job (fine with one `package.json`).
