# News → Market Analysis → Trade Signal Pipeline

_Trimmed 2026-09-21. Per-step PR narration, CI-run notes, pre-split evidence and
investigation logs that used to live here are in git history
(`git log -p plan.md`). Section names, "Adopted Pattern #N", "Backtesting
Integrity point N", "Step N", "Design: environments", "Engine ports" and
"Decided (2026-09-19)" labels are unchanged because code comments reference
them. **Start with "Current Status" -> "Next steps: make backtests
trustworthy".**_

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
   RSS, HTML scrape, yfinance (bars; returns 429 from Workers, replacement pending: see "Price data sources"), SEC EDGAR (XBRL fundamentals).
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
   The dashboard's Charts view follows the same convention (see `renderChartsView`).
4. **The reflection/memory loop is the easiest place to leak the future** — memory fed
   to an agent at `T` must only contain reflections resolved before `T`, same filter as point 1.
5. **Walk-forward validation** — roll the cutoff forward in fixed windows, not one
   static split.
6. **A leak-check test, not just a design doc** — CI asserts zero rows returned to
   the agent have a timestamp after `T`.
7. **Backtest state must not touch live state, and vice versa.** Enforced
   structurally (separate D1 for state, no live binding in the backtest Worker),
   not by row tags: design in "Backtest / Live Isolation" below. _Built: M1–M5
   are merged (see Milestones)._

**Known violation (audit 2026-09-20):** point 1 is NOT fully true for price bars.
`price_bars.date` is a `YYYY-MM-DD` string and `getPriceBarsAsOf` compares
`date <= asOf`, so day D's final bar is visible at any time on day D. The point-6
leak-check test does not cover intraday `asOf`. Fix = Next steps, step C.

## Backtest / Live Isolation — REDESIGN (verified 2026-09-19; implemented, M1–M5 merged 2026-09-20)
**Why:** before the split, backtest and live runs shared the same D1 state tables
and nothing marked which run wrote a row. Verified failure modes: a backtest
closed live positions at simulated (even future) dates; the dashboard and the
pipeline disagreed about what was open; reflections leaked in both directions
(live prompts read backtest memory; backtest returns included live outcomes);
`ticker|asOf` thesis ids collided silently (`ON CONFLICT DO NOTHING`); a failed
run had no cleanup path; re-running an identical window was a no-op that returned
stale results; live decisions saw a running backtest's intermediate positions;
dashboard panels mixed streams. Prod D1 was wiped on 2026-09-19 at the owner's
request (no backup); the row-level evidence is in git history.

### Design: environments (rewrite, D1 only — agreed 2026-09-19, built in M1–M5)
**One engine, run inside an environment; an environment owns its state, and its
Worker holds no binding to any other environment's state.** No Durable Objects;
D1 only.

**Three D1 databases**
| DB | Holds | Written by |
|---|---|---|
| `inputs` | `news_items`, `news_item_revisions`, `news_item_tickers`, `price_bars`, `fundamental_facts`: shared, append-only, point-in-time through the `asOf` filters | `ingest` only |
| `live` | run state with `run_id = 'live'`: `positions`, `trade_decisions`, `decision_memory`, `pipeline_checkpoints`, `llm_calls`, `job_progress` | `llm` (live) |
| `sim` | the same tables with `run_id` = backtest id, plus `backtest_runs` (registry) | `backtest` |

**Schema and access**
- One state schema, `migrations/state/`, applied to both `live` and `sim`
  (`migrations/inputs/` for `inputs`, `migrations/sim/` for the registry).
  `run_id NOT NULL` is part of every primary/unique key, so `ticker|asOf` thesis
  ids can no longer collide across runs, and an identical window re-run gets a new
  `run_id` and really executes. CI fails if the `live` and `sim` schemas differ.
- `RunStore(db, runId)` is the only code that runs SQL on state tables; every
  method filters `run_id`, and delete-by-run refuses `'live'`. Input reads go
  through `InputsView(db)` (`asOf` required).

**Workers and bindings**
- `ingest`: `inputs` read/write. Enqueues ANALYZE. Also consumes `BACKFILL` and
  narrowly binds `live` (rw, `job_progress` reporting only).
- `llm` (live only): `live` read/write, `inputs` read-only. Consumes `ANALYZE`
  and `exit_check`.
- `backtest` (`wrangler.backtest.toml`, own `BACKTEST` queue + DLQ): `sim`
  read/write, `inputs` read-only, its own KV namespace (`backtest-CACHE_KV`) for
  cooldowns. **No `live` binding and no live KV.**
- `backend`: read-only handles to all three for the dashboard API; runs the
  migrations for all three; enqueues backfill and backtest jobs.
- `dashboard`: views read `live`/`inputs`; the environment selector is not built
  yet (see M4).
- Enforcement is config first, code second: CI fails if `wrangler.backtest.toml`
  binds the `live` DB; `readOnly(db)` rejects anything but SELECT (tested).
  D1 bindings can't be made read-only, so the `inputs` guard is the one that is
  code, not config.

**Engine ports.** The pipeline receives `{ clock, inputs, store, enqueue }` and
never calls `Date.now()`. Live: real clock and queues. Backtest: `SimClock`
(end clamped to real now, throws on a future time) and a recording enqueue, so a
backtest cannot trigger live work.

**Atomic portfolio commit.** D1 runs a `batch` as one transaction (sequential,
all-or-nothing; verified against the docs 2026-09-19), so check-and-write goes in
one batch with the checks inside the SQL (`RunStore#commitThesis`, 3 statements):
1. Predicate P = no open position for this ticker with a later `opened_at` AND
   (open risk of *other* tickers) + new risk <= `MAX_PORTFOLIO_RISK_PCT`.
2. `UPDATE positions` closing this ticker's older open positions as `replaced`
   `WHERE P`; `INSERT` the new position `WHERE P`; insert the decision row either
   way, with the outcome (opened / rejected / superseded) recorded.
3. Backstop: partial unique index on `(run_id, ticker) WHERE closed_at IS NULL`,
   so a bug fails loudly instead of double-opening.
Latest `asOf` wins, so a late-finishing older article can't open or close
anything out of order. The ceiling is checked against other tickers' exposure,
because a ticker's new position replaces its old one. Caveat: P's exposure check
uses live semantics (`closed_at IS NULL`), not as-of; see audit finding 5.
`settlePositionOutcome` logs and swallows a failed reflection by design (the
position stays closed, no reflection recorded), so `getUnsettledReplacedPositions`
only recovers a crash or queue retry between the commit and the settle step.

**Memory** is per run. A backtest starts with empty memory; seeding from a frozen
live snapshot is deferred (it needs a cross-environment copy, which the isolation
rules forbid inside a backtest). **Cleanup** = delete-by-run in `sim`, chunked,
run by the `backtest` Worker.

**Decided (2026-09-19)**
- The portfolio ceiling is checked against other tickers' exposure (see above).
- `backtest` gets its own KV namespace, so its `gemini:cooldown:*` state cannot
  trip live's. The upstream Gemini quota per key is still shared, so backtests
  also get a per-run LLM-call budget (`BACKTEST_MAX_LLM_CALLS`; the run fails when
  exceeded) on top of concurrency 1.
  *Implemented:* `src/llm/budget.js`; one counter per run on `config.llmBudget`,
  charged at `callStructured` (logical calls, not cascade HTTP attempts).
  **Owner decided (2026-09-19): no cap** -- leave `BACKTEST_MAX_LLM_CALLS` unset;
  the mechanism stays in code. Known risk: an uncapped runaway backtest can burn
  the Gemini quota live also uses. A redelivered queue message starts a fresh
  counter.
- **Failed runs are cleaned up: delete the data, keep the error log.**
  *Implemented:* when a run ends `failed`, the `backtest` Worker
  (`src/backtest/cleanup.js`) deletes its positions, decisions, memory,
  checkpoints and non-error `llm_calls`, in chunks (`RunStore.deleteRun`, 500
  rows/table/chunk, at most 20 chunks per run). It **keeps** the `backtest_runs`
  row (status `failed` + the error, ending in `[while processing <ticker> <day>]`
  when the failure was mid-walk), the run's `status='error'` `llm_calls` rows and
  its single `job_progress` row. Complete runs are never auto-deleted; cleanup
  refuses anything whose registry row is not `failed`, and always refuses `live`.
  Best-effort: an error is logged, never retried, never changes the ack. D1
  deletes count as rows written, so a run that fails late pays roughly double its
  writes against the 100K/day cap. A redelivered message for a `complete` or
  `failed` run is acked and skipped; a `running` row resumes from checkpoints.
- The `*/15` ingest cron stays **on** (owner, 2026-09-20). `wrangler.toml`
  declares it, so every `backend` deploy re-applies it.

**Free-plan budgets** (account is on Workers Free; limits from Cloudflare's docs,
checked 2026-09-19). All are per account, not per DB, Worker or namespace, so
three D1s and a second KV isolate state but add no quota.
- D1: 5M rows read and 100K rows written per day across every DB in the account (**the write cap was hit on 2026-09-20; see "Live incident: first price backfill failed"**);
  an indexed column counts as an extra row written. When exhausted, all queries
  error until 00:00 UTC, live's included. Storage: 500 MB per DB, 5 GB per
  account. Databases: 10 per account (other projects' DBs included).
- **Backtest write cap (proposed, NOT approved or built):** the `backtest` Worker
  records `meta.rows_written` per run in `backtest_runs` and refuses to start a
  run when the day's total would pass `BACKTEST_DAILY_WRITE_BUDGET` (proposed
  default 40K, leaving live 60K). It would run with `LLM_LOG_ENABLED=false`
  (`llm_calls` is ~4 rows per call) unless a run opts in.
- KV: 1K writes, 1K lists and 100K reads per day. Cooldown keys are written only
  on rate-limit events.
- Queues: 10K ops per day. A backtest is one message on `BACKTEST`; the
  `SimClock` walk runs inside the consumer and never fans out per day.
- Workers: 50 queries per invocation on Free. Whether each statement in a `batch`
  counts is **unmeasured** (`node:sqlite` has no such cap); `commitThesis` stays
  at 3 statements. Needs a real deploy to settle.
- Concurrent backtests share `sim`: `run_id` prevents collisions but writes
  contend and the DB grows; delete-by-run must chunk.
- No cross-DB joins or transactions. None needed today.
- Backfill is still a write to `inputs`. It stays an explicit ingest job; a
  backtest over an un-backfilled window should fail fast instead of fetching
  (see step E).

**Milestones** (one PR each, squash-merge; all merged)
- **M1** Provisioned `inputs`/`live`/`sim` and `backtest-CACHE_KV`, split
  migrations, `RunStore`, `readOnly`, `commitThesis` (+ tests: out-of-order
  `asOf`, concurrent same-ticker commits, ceiling race, run isolation). Uses a
  real `node:sqlite` D1 adapter (`test/helpers/sqlite_d1.js`), not hand-written
  fakes. D1 ids are committed directly, not placeholders.
- **M2 / M2b** Engine ports: `pipeline.js`, `settle.js`, `exit_check.js`, memory
  reads via `RunStore`/`InputsView`; `llm_calls` and `job_progress` moved onto
  the state DB via `RunStore`. Backfill jobs and the rejected-backtest row live
  under `run_id = 'live'`.
- **M3** `backtest` Worker + queue, `SimClock`, runner rewrite (walk-forward,
  signal on/off), delete-by-run, CI checks (no live binding, equal schemas).
- **M4** Cut live over to `live`/`inputs`; every dashboard panel reads
  `readOnly(LIVE_DB)` through `RunStore` or `readOnly(INPUTS_DB)` (M4a). Those
  reads are `run_id`-scoped, deliberately not asOf-gated (dashboard-only) and
  must never feed an agent prompt. **Left:** the environment selector (a `?env=`
  reading a backtest's `run_id` off SIM_DB; `getDecisionStats`' "last N days"
  window is wall-clock relative, so it needs an anchor for a finished backtest).
- **M5** (PR #57) Removed the old `news_market_ai` DB from code, config and CI
  (`ensure-d1-database` deleted; root `migrations/0001-0012` deleted; tests pin
  that no config binds the legacy DB). The owner deletes the actual Cloudflare
  resource out of band.

### Overlapping open positions (former live bug)
Cause: ANALYZE runs at `max_concurrency` 2 and each run uses the article's
`published_at` as `asOf`, so an older article processed after a newer one opened
its own position and nothing closed it (23 overlapping AAPL positions; every
other ticker was rejected against the 0.20 ceiling). Fixed structurally by the
atomic portfolio commit above (one open position per ticker in SQL + unique-index
backstop), live since M4. Not yet observed in practice.

## Deployment: Cloudflare Workers + D1 + KV (free tier)
| Resource | Free limit | Implication |
|---|---|---|
| Workers | 100K requests/day, 10ms CPU/invocation | CPU time excludes `fetch()` wait, so LLM-calling steps barely touch the budget |
| D1 | 5GB storage, 5M rows read/day, 100K rows written/day (hard-enforced) | Batch inserts, dedupe before writing |
| KV | 1GB storage, 100K reads/day, 1K writes/day | Only for low-frequency state (LLM key/model cooldowns) |
| Queues | 10K ops/day | ~5 guaranteed messages per 15-min tick at 3 tickers, plus one ANALYZE per new item; re-check before growing the watchlist |

**Architecture:** five Workers connected by queues, each binding only the D1s it
needs, with only `backend` running migrations, and all sharing one `CACHE_KV`
except `backtest`, which has its own.
- **`dashboard`** (`wrangler.dashboard.toml`, `src/dashboard-worker.js`) — the only
  public Worker: login, session cookie, server-rendered UI. Reaches `backend`
  through a service binding. Holds the dashboard login secrets.
- **`backend`** (`wrangler.toml`, `src/index.js`) — private (no workers.dev, no
  routes). JSON `/api/*`, `POST /backfill`, `POST /backtest/run`, the `*/15` cron
  `scheduled()` (pure fan-out: per-ticker `ingest_ticker` + one `ingest_feeds`
  onto `INGEST`, one `exit_check` onto `LLM_JOBS`), D1 migrations. Holds NO
  vendor key and has no `queue()` export.
- **`ingest`** (`wrangler.ingest.toml`) — `INGEST` consumer (`max_batch_size` 10)
  and `BACKFILL` consumer (`max_batch_size` 1). Fetches Finnhub/yfinance/EDGAR/
  RSS/scrape, writes D1, enqueues one `analyze` per new item (per item×ticker for
  general feeds) onto `ANALYZE`. The sole holder of `FINNHUB_API_KEY`; also
  narrowly binds `LIVE_DB` (rw, `job_progress` reporting only).
- **`llm`** (`wrangler.llm.toml`) — the live Gemini caller: holds `GEMINI_API_KEYS`
  and the live `gemini:cooldown:*` KV keys. Binds `LIVE_DB` (rw) and `INPUTS_DB`
  (read-only by convention). Consumes `ANALYZE` (`max_batch_size` 5,
  `max_concurrency` 2 = the Gemini throttle; failures **retry**, since the
  pipeline is checkpoint-resumable) and `LLM_JOBS` (`exit_check` only; batch 1,
  concurrency 1; failures are logged and acked; a stray `backtest` message is
  rejected and marked failed).
- **`backtest`** (`wrangler.backtest.toml`, `src/backtest-worker.js`) — private;
  consumes `BACKTEST` (batch 1, concurrency 1, DLQ): one message is one full
  signal-on/off run. Binds `SIM_DB` (rw), `INPUTS_DB` (read-only by convention)
  and its own `CACHE_KV`, and **no `LIVE_DB`** (pinned by
  `test/ci_env_isolation.test.js`). Holds its own copy of `GEMINI_API_KEYS`,
  never `FINNHUB_API_KEY`.

Every queue has a DLQ (`max_retries` 3). D1 is the structured layer; KV holds
cooldown state and light config.

**CI/CD** (`.github/workflows/deploy.yml`): `test` → `migrate` (push/dispatch,
gated on `migrations/**`) → one deploy job per Worker (`deploy`=backend,
`deploy-dashboard`, `deploy-ingest`, `deploy-llm`, `deploy-backtest`), each with
its own `dorny/paths-filter` output and `concurrency` group; `workflow_dispatch`
runs all. CI triggers on `pull_request` and `main` pushes, not branch pushes.
Provisioning is idempotent via `.github/actions/ensure-{kv-namespace,queue}`
(look up by name, create if missing, never commit ids; `ensure-kv-namespace`
takes a `wrangler-config` input so each Worker's job patches its own file). D1
ids are committed directly. Worker jobs use `needs: [changes, migrate]` with
`if: always() && (needs.migrate.result == 'success' || needs.migrate.result ==
'skipped')`. Deploy path filters live in `.github/path-filters.yml` (exclusion
based: `**` minus any `*.md`, so docs-only PRs deploy nothing), and each target
is diffed against its own last successful deploy.

**Per-Worker secrets:** each deploy job fails fast on its own required secrets
and pushes them with `wrangler secret put --config <its file>`. `dashboard`:
`DASHBOARD_USERNAME/PASSWORD`, `JWT_SECRET`, `SESSION_TTL_SECONDS`. `backend`:
none. `ingest`: `FINNHUB_API_KEY` (+ `EDGAR_USER_AGENT`/`EDGAR_CIK_MAP` vars) --
the only holder of that secret. `llm` and `backtest`: `GEMINI_API_KEYS`.
Repo-wide: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. Optional groups use a
bash `-z` guard (the `secrets` context is rejected in a step `if:`).
Provisioning actions mask ids before printing.

**Lessons:** a green deploy says nothing about live bindings; compare each
Worker's live bindings to its wrangler file's "Secrets" comment (stale login
secrets left on `backend` once made every `/api/*` call 401). wrangler v4 is
required (v3 sent a 4-day queue message retention over the free 86400s cap);
`ensure-queue` passes `--message-retention-period-secs 86400`.

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
(a single 503 killed a whole backtest before PR #41). `wrangler.llm.toml` lists
three distinct models: quick `3.1-flash-lite → 2.5-flash-lite → 2.5-flash`; deep
tier prepends `3.5-flash`.

### LLM call log (dashboard "LLM calls" page)
Every Gemini prompt and raw response, including failed calls, goes to `llm_calls`
(state schema, scoped by `env_run_id`, so each environment only sees and prunes
its own rows), shown at `/dashboard/llm` (filters: source/status/ticker/backtest/
run) and `/dashboard/llm/:id`.
- **One choke point:** `agents/utils/structured.js#callStructured` writes the row.
  Context (`source`, `jobId`, `runId`, `ticker`, and the `store` the row is
  written through) rides on `config.llmLog`
  (`storage/llm_calls.js#withLlmLogContext`), set by `llm-worker.js`,
  `runPipelineForTicker` and `checkOpenPositionExits`. No store on the context
  means logging is a silent no-op. `runId` here is the PIPELINE run (column
  `run_id`); the environment is the store's run id (`env_run_id`).
- **Best-effort:** a failed log write never fails or slows the call.
  `LLM_LOG_ENABLED="false"` turns it off.
- **Cost:** ~4 D1 rows written per call (table + 3 indexes) against 100K/day. Rows
  older than `LLM_LOG_RETENTION_DAYS` (14) are pruned on the exit-check tick; prompt
  and response are each clipped at `LLM_LOG_MAX_CHARS` (60000), true lengths kept.
- **Not logged:** stages skipped on checkpoint resume.

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
  fetchers and `src/dashboard/api.js` with `/api/*` routes reusing `checkAuth`.
- **Step 2 — Dashboard Worker (PR #28).** Owns login, session and UI; `backend`
  serves no HTML and is reachable only via service binding. The dashboard
  session is the only gate (header-based `X-Backfill-Secret` auth removed).
- **Step 3 — Job queue (PR #29).** `POST /backfill` and `POST /backtest/run`
  validate and enqueue; business failures persist as `failed` rows rather than
  retrying (a retry would re-spend quota). The queue was later renamed `BACKFILL`
  (Step 5 follow-up).
- **Step 4 — Cron fan-out (PR #30).** `scheduled()` is a thin scheduler onto
  `INGEST` and the exit-check queue; ANALYZE is the one consumer that retries
  (checkpoint-resumable, `openPosition` id-idempotent).
- **Step 5 — `ingest` Worker (PR #31).** `INGEST` consumer moved out. **Gap
  closed 2026-09-20 (PR #61):** `backend` had still held `FINNHUB_API_KEY`
  because `backfill` called Finnhub; renamed `JOBS` to `BACKFILL` and moved its
  consumer to `ingest`. **Deploy lesson (PRs #62, #63):** Cloudflare refuses a
  script upload with no `queue()` export while a queue-consumer trigger from the
  last successful deploy is still attached, and the trigger detach and the
  handler removal can't happen in one deploy. It took one deploy with a
  transitional no-op `queue()` on `backend` (PR #62), then its removal (PR #63).
- **Step 6 — `llm` Worker (PR #32).** `backtest` and `exit_check` also call
  Gemini, so they moved to a new `LLM_JOBS` queue (backtests later moved to their
  own Worker in M3). Fixed a latent bug where `ensure-*` actions hard-coded
  `wrangler.toml`.
- **Step 7 — Cleanup and docs (PR #33).** Dead-code check and secrets audit
  came back clean.

### Live incident: no analysis after the M4 cutover (fixed 2026-09-20)
`LIVE_DB` had no decisions while `INPUTS_DB` held 427 news items. Cause: every
`ingest_ticker` tick threw `batch message count of 163 exceeds limit of 100` from
`ANALYZE.sendBatch`; the handler caught it, logged it and acked. Second trap:
ingest returned every fetched item, not just new ones. Fixed by
`insertNewsItem` returning `{ inserted, newTickers }`, ingest returning
`{ fetched, fresh }`, and `ingestion/enqueue.js#sendInChunks` (chunks of at most
100 messages / 200 KB, continues past a failed chunk). **Open consequences:**
(1) the ~427 items ingested before the fix were never analyzed and are no longer
detected as new; analyzing them is LLM spend and the owner hasn't decided.
(2) A queue failure after the D1 write is logged but not retried. (3) PR #64
batched news-item D1 inserts and pre-filtered existing ids in the backfill path;
the live per-tick cost of re-running `insertNewsItem` over the trailing window
has not been re-measured.

## Historical backfill (PRs #64–#67, verified live 2026-09-20)
`POST /backfill?from=&to=` (dashboard: `/dashboard/backfill`) enqueues onto
`BACKFILL`; the `ingest` Worker consumes it in self-continuing **parts**.
- Finnhub is fetched in **date windows** (PR #67). One request returns at most
  ~245 articles per ticker (inferred cap), so a window that hits it is split
  adaptively. Per-invocation caps: 40 Finnhub requests
  (`MAX_FINNHUB_REQUESTS_PER_BACKFILL_INVOCATION`, a conservative guess) and 500
  items (`MAX_ITEMS_PER_BACKFILL_INVOCATION`); a job stops after
  `MAX_BACKFILL_PARTS` = 50. Inserts are batched and existing ids pre-filtered.
- **Verified:** 90-day run 2026-06-22..2026-09-20 inserted 10,025 items in 13
  parts, 0 errors, 91/91 days, ~3.4 min. A duplicate rerun inserted 2 (dedupe
  works). Finnhub's `to` date is **inclusive** (window-boundary days populated).
  Totals after: 11,741 finnhub items, 13,248 ticker links, inputs DB ~33.5 MB.
- **Sizing:** ~29 MB per ~10K articles, so a year is ~100–130 MB (500 MB per DB).
  Free-tier Finnhub depth is ~1 year.
- **Year run:** no code change needed if run in ~90-day slices (~13 parts each).
  A single year-long range needs ~50 parts and may hit `MAX_BACKFILL_PARTS`.
  Optional later PR: raise `MAX_BACKFILL_PARTS`, the 500-item and 40-request
  caps. Not requested by the owner.
- **Unexplained:** Aug 11–31 2026 weekday volume drops to ~25–80/day (vs 150–250
  either side). 0 errors/truncations recorded, so probably thin Finnhub data;
  unproven (settle with one direct Finnhub call for AAPL 2026-08-19). Owner: "It's
  fine."
- **Unverified:** dashboard UI after PR #66 (redirect to `/dashboard/backfill`,
  "Backfill complete" panel, Last-run panel); Workers Observability for
  CPU/subrequest errors on `ingest` during the 90-day run; whether the backfill
  path enqueues ANALYZE (Queues free cap is 10K ops/day) — unassessed.

## Live incident: first price backfill failed; D1 write cap hit (2026-09-20)
The owner ran `POST /backfill-prices` at ~22:03 UTC (job `backfill-prices-1789941826739-dvbcj3`, 2026-09-13..2026-09-20, watchlist AAPL/MSFT/TSLA) after PR #69 deployed (deploy #349 green, all Worker deploy jobs ran). The dashboard showed it stuck at `queued`. Findings, from `job_progress` (LIVE_DB) and Workers Observability (`ingest`, queue `news-market-ai-backfill`):
- **It did not stall; it failed in ~1.5s.** The consumer picked it up immediately (8ms CPU). yfinance returned **429 for AAPL, MSFT and TSLA** on the single request each, so 0 bars were inserted; the worker logged `No price bars saved -- ...` and acked. The designed failure path (fail loudly, name tickers and reasons) worked. `fetchHistoricalBars` ignores the shared cooldown, so this is Yahoo rejecting Workers egress on the historical path too. Mechanism still unproven.
- **Every `job_progress` write failed** (`start`, three `update`s, `fail`) with `D1_ERROR: Your account has exceeded D1's free tier daily row write limit ... (midnight UTC)`. The row therefore stayed `queued` with `started_at` null, and the dashboard's 2s poll of `/dashboard/jobs/<id>` never ends. Reads still worked.
- **Likely cause of the cap (unproven, not measured):** the 90-day news backfill (10,025 articles, each also writing revisions, ticker links and index rows, all counted as rows written) plus several other backfill runs and the `*/15` cron against the 100K rows/day free cap.
- **Impact:** all D1 writes fail until 00:00 UTC, so live ingest and ANALYZE writes were likely failing too (not checked). It would also have blocked `insertPriceBars` had Yahoo answered.
- **Open:** wait for the reset or upgrade the Workers plan (undecided); the stuck-`queued` bug (Other remaining work #8).

## Price data sources (research 2026-09-20/21; nothing built or tested from Workers)
**Why:** Yahoo's unofficial chart API returns 429 for every call from Workers, so it cannot be the bar source. Only published limits were checked; no provider has been called yet.

| Provider (free plan) | Limits | Notes |
|---|---|---|
| **Tiingo** (recommended, unconfirmed by owner) | 50 req/hour, 1,000/day, 500 unique symbols/month | EOD endpoint (from memory: start/end dates, raw and adjusted prices; verify in docs). Separate Forex API: 140+ pairs incl. **gold, silver, platinum** (per its product page), OHLC only (no volume), 3+ years of history, free plan listed with the same request limits, internal-use licence. **Oil not listed.** |
| Twelve Data | 8 credits/min, 800/day, 1 credit per symbol per `/time_series`, 5,000 rows/request, resets 00:00 UTC | Second choice. Supports start/end dates. Forex is on the free plan, but its Commodity market (XAU/USD gold spot, WTI, etc.) needs the Grow plan (about $29/month). |
| Massive (ex-Polygon) | 5 calls/min, end-of-day, 2 years of history | Fine for 3-month windows but slow and limits older backtests. Free-plan forex/commodity coverage not checked. |
| Alpha Vantage | 25 req/day, 5/min | Enough for 3 tickers, exhausted fast. Reportedly has commodity series (unverified). |
| Finnhub | 60/min | A 2025 report says stock candles returned "no access" on the free plan (not re-verified): not usable for bars. |
| Stooq | API key via on-site CAPTCHA since early 2026, quota unpublished | Skip. |

**Owner requirement (2026-09-20/21):** add proper **gold and oil** tickers "so I can trade forex too", i.e. a watchlist beyond AAPL/MSFT/TSLA. Not specified: signals only vs execution (the pipeline has no execution layer today). Open questions before building:
- **Gold:** spot via Tiingo's Forex API (untested with a free key) or a gold ETF such as GLD as a proxy on the stock endpoint (no extra code; a proxy, trades US hours only).
- **Oil:** no confirmed free spot source. Candidates: an oil ETF proxy (e.g. USO) on the stock endpoint, or a commodity series (Alpha Vantage unverified; Twelve Data needs paid Grow). Undecided.
- **Forex pairs:** Tiingo's Forex API is the candidate; OHLC only, so `price_bars.volume` would be null.
- **Symbols:** `POST /backfill-prices` accepts Yahoo-style symbols (`/^[A-Z0-9^.=-]{1,12}$/`, e.g. `GC=F`, `EURUSD=X`); a provider needs its own symbol map.
- **Raw vs adjusted prices:** pick one so new bars match the existing yfinance bars (AAPL/TSLA 2026-09-14..09-18).
- **Wider design, not started:** how news maps to a commodity/FX ticker (Finnhub `/company-news` and entity resolution are per equity symbol); position and risk model for FX and commodities (units, leverage, pip values, shorting; sizing is deterministic in `risk_mgmt/`); 24h and weekend markets vs daily bars and the hold-days/exit logic; and Queues/D1 budgets as the watchlist grows (the Deployment table already says to re-check before growing it).

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
ingestion/           # Finnhub, GDELT (unwired), EDGAR, RSS, HTML-scrape, yfinance adapters
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
                      # noSignalBaseline.js, metrics.js, simClock.js, cleanup.js)
dashboard/           # operational dashboard
migrations/          # inputs/, state/, sim/ -- the three environment schemas
config/
tests/
```

## Current Status
The pipeline is built end to end: shared schemas, Gemini cascade, bull/bear debate
+ judge, deterministic risk/sizing + portfolio sign-off, all ingestion adapters
wired, a point-in-time positions store with stop-loss/take-profit/time-based
exits, technical analyst on price bars, realized-return settlement feeding the
reflection loop, date-windowed historical backfill, the signal on/off backtest
harness (`runManualBacktest`, persisted in `backtest_runs`) and a live-progress
job panel. Backtest/live isolation is built (M1–M5). CI and deploys are green
across all five Workers (`main` = `031825d`: PR #69, step A, squash-merged 2026-09-20 on top of PR #68 = `8d8775b`; deploy #349 green). Price bars still do not exist: the first live price backfill failed (see "Live incident: first price backfill failed").

**Backtests are NOT yet trustworthy.** An audit (2026-09-20, in response to
"is backtesting bug free?") answered **no**: results would currently be
meaningless. Do not run a real backtest until steps A–E below are done.

### Next steps: make backtests trustworthy (agreed 2026-09-20; step A merged as PR #69 but its first live run FAILED, so no price bars exist yet; A2 (new price source) is next; B-F not started)
Working rules: each step is its own PR off `main` (direct GitHub-API edits on a
feature branch; the CI `test` job is the real test; no local runner); merge
only on the owner's explicit per-PR go-ahead, squash-merge. First thing next
session: re-verify repo/CI state from real commits, not from notes.

**Pipeline under audit:** `POST /backtest/run` (`src/index.js`) → `BACKTEST` queue
→ `backtest-worker.js` (concurrency 1, batch 1; the whole run is ONE queue
invocation, no continuation) → `backtest/runBacktest.js#runManualBacktest` →
`compareSignalOnOffByWindow` (`signalCompare.js`), on-side
`onSignalRunner.js#makeOnSignalReturns`, off-side
`noSignalBaseline.js#makeBuyAndHoldOffReturns`. On side, per ticker
(sequentially, whole window each), per UTC day from `testStart` through
`testEnd + graceDays` (default `maxPositionHoldDays` = 10, clamped to now by
`SimClock`): `graph/pipeline.js#runPipelineForTicker` per news item
(`asOf = published_at`), then `graph/exit_check.js#checkOpenPositionExits`
(`asOf` = day midnight). Returns come from `RunStore#getRealizedReturnsInRange`.

**Confirmed findings** (verified by reading code and/or querying D1), worst first:
1. **No price history.** `price_bars` holds only 5 bars each for AAPL and TSLA
   (2026-09-14..09-18) and none for MSFT (cause unknown; yfinance 429s were seen
   in ingest logs, cooldown KV not checked). `config.js` `yfinanceRange` defaults
   to `"5d"` and `ingestion/sources/yfinance.js` only fetches that trailing
   range; there is no historical price backfill. Consequences: on a 90-day
   window positions can't open outside those 5 days; the buy-and-hold baseline
   takes the first bar on/after `testStart` with no horizon check, so it
   silently measures a ~5-day return (`noSignalBaseline.js#computeBuyAndHoldReturn`);
   MSFT is simply absent. The price check also happens **last**:
   `pipeline.js`'s `portfolio_checked` stage calls `getPriceBarsAsOf` only after
   every LLM stage, and records `skipped_no_price_data` if null, so an empty
   backtest still burns the full LLM chain per news item
   (`BACKTEST_MAX_LLM_CALLS` is uncapped by decision). This is also what makes
   live trading skip decisions (7 of the first 10 post-fix live decisions were
   `skipped_no_price_data`).
2. **Silent 500-row caps.** `inputs_view.js#getNewsItemsInRange` defaults to
   `limit=500` (`ORDER BY published_at ASC`) and `onSignalRunner.js#runOnSignalForTicker`
   passes no limit, so only the FIRST 500 news items per ticker per window are
   processed (~2 weeks of a 90-day window at ~35–50 items/ticker/day) while the
   walk still runs the full window for exits. `run_store.js#getRealizedReturnsInRange`
   also defaults to 500 (`ORDER BY resolved_at ASC`) and truncates realized
   returns silently.
3. **Same-day price look-ahead.** `getPriceBarsAsOf` uses `date <= ?` on a
   `YYYY-MM-DD` string with an ISO `asOf`, so day D's bar (final OHLC/close) is
   visible at any time on day D, including the midnight exit-check and a 09:35
   article. The pipeline's entry price is that same bar's close, and the
   technical analyst sees it too.
4. **Metrics are not portfolio returns.** The baseline yields ONE return per
   ticker per window; the on side yields one per closed trade; both go through
   `metrics.js#summarizeReturns`, which compounds the array as if sequential,
   ignores `position_size_pct` and concurrency, and annualizes Sharpe with
   sqrt(252) though the periods are trades/tickers, not days. The on/off
   comparison is apples-to-oranges.
5. **Order-dependent multi-ticker walk.** `onSignalRunner.js#runOnSignalReturns`
   loops tickers outermost, so ticker A's whole window runs before B starts; A
   never sees B's exposure while B sees A's. Also `RunStore#commitThesis`'s
   ceiling predicate and replace logic use `closed_at IS NULL` (live semantics),
   not as-of, so in a sequential backtest it can count another ticker's later
   positions and ignore ones closed later, making `rejected` wrong (matters only
   near `MAX_PORTFOLIO_RISK_PCT` = 0.20). The pipeline's own pre-check uses the
   as-of `getOpenPositionsRiskPctAsOf` (correct).

**Suspected / not measured:** the whole backtest runs in one queue invocation
(an agent asserted a 15-min queue wall limit; NOT verified) with subrequest and
CPU limits unmeasured; redelivery could loop until the DLQ.
**Agent-only claims (Gemini delegate run, unverified):** no `testStart < testEnd`
validation in `POST /backtest/run` (low severity); the calendar-day walk counts
weekends toward hold days (same as live; probably not a bug). **Rejected agent
claim:** `maxDrawdown` NaN/negative peak (wrong: peak starts at 1; only a >100%
"drawdown" if a single return < -1, minor).
**Checked correct:** `asOf` is REQUIRED on news/fundamentals/price reads
(`LookaheadViolationError`); `getFundamentalFactsAsOf` uses `filed_at <= asOf`;
`getNewsAsOf` is revision-aware; `readOnly(INPUTS_DB)`; no `LIVE_DB` in the
backtest Worker (`test/ci_env_isolation.test.js`); `commitThesis` is idempotent;
failed-run cleanup keeps the error log; Sharpe guards stdev 0.
**Not read by the audit:** `signalCompare.js`, `pointInTime.js`, `cleanup.js`,
`simClock.js`, `llm/budget.js`, `technicalAnalyst.js`, `risk_mgmt/exit.js#evaluateExit`,
`graph/settle.js`, prompts, dashboard views. Existing tests (`test/backtest*.test.js`,
incl. leakcheck) do NOT cover: the same-day bar leak, the 500-row caps,
multi-ticker ordering, long-window queue limits.

**Fix plan, in order:**
- **A. Historical price-bar backfill.** **STATUS: merged as PR #69 (`031825d`, CI green); first live run 2026-09-20 FAILED: yfinance 429 on every ticker, then the D1 write cap (see "Live incident: first price backfill failed"). The Risk noted below materialized.** Before the first run this read: code written and tests added, NOT yet
  run live. Built: `yfinance.js#fetchHistoricalBars` (`period1`/`period2`, one
  request per ticker, ignores the shared 429 cooldown but records a fresh one),
  batched `insertPriceBars`, `ingest.js#backfillHistoricalPriceBars`, a
  `backfill_prices` branch on the `BACKFILL` consumer (nothing saved = failed job;
  a partial fill names the missing tickers), `POST /backfill-prices` and a
  dashboard form on `/dashboard/backfill` (confirm page, progress panel, "Last
  price backfill" panel). The */15 cron path (`fetchDailyBars`, `range=5d`) is
  unchanged. **Risk:** Workers Observability for `ingest` (2026-09-20) showed
  yfinance 429s for AAPL, MSFT and TSLA on every attempt, so MSFT's zero bars is
  not MSFT-specific; suspected cause (unproven) is Yahoo rate-limiting Cloudflare's
  shared egress IPs, and the historical call may 429 too. If it does, the fallback
  is another daily-bar source or seeding bars by hand. Unverified until a real run:
  that `to`'s own bar is included (`period2` = 23:59:59 of `to`). Original spec:
  add an opt-in way to fetch and store
  daily bars over a long range (yfinance `range` e.g. 1y/2y, or
  `period1`/`period2` on the chart endpoint; batched D1 inserts via `db.batch`
  like the news backfill; must not change the `*/15` cron's 5d default). Run it
  for AAPL/MSFT/TSLA over the backfilled news span (>= 2026-06-22, ideally the
  full year the owner backfills). Also find out why MSFT has zero bars (yfinance
  cooldown KV, Workers logs, or a direct call). Design the owner-facing trigger
  after checking how `POST /backfill` is wired in `src/index.js` and the ingest
  Worker.
- **A2. Replace Yahoo as the price-bar source, then re-run the backfill (NEXT).** Recommended provider: Tiingo (owner has NOT confirmed; alternative Twelve Data); limits, gold/oil/forex coverage and open questions are in "Price data sources". Do not retry the Yahoo backfill. Blocked on: (a) an API key stored as a secret on the `ingest` Worker (the owner creates the key; never paste it in chat), and (b) the D1 daily write cap resetting at 00:00 UTC or a plan upgrade. Scope: a provider adapter behind the same `fetchHistoricalBars` contract so `backfillHistoricalPriceBars`, `insertPriceBars`, `POST /backfill-prices` and the dashboard form stay as merged; a watchlist-symbol to provider-symbol map; a distinct `source` value on stored bars; a fix so a failed terminal `job_progress` write cannot leave a job `queued` forever (see Other remaining work #8). First run small (3 tickers, ~1 month), then the full span.
- **B. Remove the 500-row caps.** Keyset-paginate `getNewsItemsInRange` in
  `onSignalRunner` (or stream day by day); lift or paginate
  `getRealizedReturnsInRange`; add tests with >500 items.
- **C. Same-day bar leak.** Change `getPriceBarsAsOf` semantics (compare on the
  date part with strict `<` for an intraday `asOf`, i.e. use the prior close, or
  define availability at market close); extend the leak-check test to intraday
  `asOf`.
- **D. Metrics.** Position-weighted daily equity curve for BOTH on and off, same
  horizon and universe; fix Sharpe periods; baseline returns null if the entry
  bar is too far after `testStart`.
- **E. Walk and preflight.** Day-major multi-ticker walk; as-of predicates in
  `commitThesis` for backtest runs; a preflight price-coverage check in
  `runManualBacktest` that fails fast BEFORE any LLM call; validate
  `testStart < testEnd`.
- **F. Small first backtest.** 1 ticker, 2–3 weeks, before any long run. Ask the
  owner whether to set `BACKTEST_MAX_LLM_CALLS` for that run (standing decision
  is uncapped, but the wasted-call risk in finding 1 was found), and measure queue
  wall time and subrequests.

### Other remaining work
1. **Live verification** (not yet observed): a backtest surviving past the old
   30s cutoff and long-window queue limits, a real ANALYZE crash-and-retry,
   Queues/D1 ops per day against real Observability numbers (Queues free cap
   10K/day), the atomic-commit behavior on real live decisions, and re-verify
   fresh TSLA `pipeline_checkpoints` on the `*/15` cron.
2. **~427 pre-fix news items never analyzed** — leave or re-enqueue (owner hasn't
   answered).
3. **Check whether the backfill path enqueues ANALYZE**, before/after big
   backfills, given the Queues cap.
4. **`BACKTEST_DAILY_WRITE_BUDGET`** proposed (40K), not approved, not built.
5. **Optional:** the owner runs the remaining historical backfill in ~90-day
   slices up to ~1 year (no code needed).
6. **Dashboard environment selector** (`?env=`), left over from M4.
7. **D1 daily write cap** (hit 2026-09-20 ~22:03 UTC; see the incident section). Decide wait vs upgrading the Workers plan. After 00:00 UTC, check that the `*/15` ingest and ANALYZE recovered and whether anything from the blocked window needs re-running.
8. **Job stuck `queued` when the terminal progress write fails.** Progress writes are best-effort by design, so a failed write is only a logged warning and the dashboard polls the row forever. Needs a dashboard-side stale/timeout state and/or a non-D1 fallback record of the terminal state (KV has its own 1K writes/day cap).
9. **New instruments: gold, oil, forex** (owner request, 2026-09-20/21). Design and source questions are in "Price data sources". Nothing built.
10. Whether `wrangler.dashboard.toml`'s `[observability.logs]` is enabled on the
   live dashboard Worker (config drift once observed; status unverified).

## Known Gaps / Backlog
- **Entity resolution:** SEC-backed name matching exists
  (`entity_resolution.js#buildCompanyNameIndex`/`matchTickersByName`, gated by
  `config.entityResolutionUseNameIndex`) and is wired into RSS/scrape/GDELT. It
  defaulted **on** on 09-17 and was flipped **back to off** on 09-19 (commit
  `cd25317`); Step 0 suspected it of the CPU-limit failures, unconfirmed. Never
  validated against live SEC data plus real headline traffic. Opt in with
  `ENTITY_RESOLUTION_USE_NAME_INDEX=true`.
- **News sources:** Finnhub `/company-news` (free, 60 req/min) replaced GDELT on
  09-18 and is now live-verified by the backfill. `gdelt.js` and its tests are
  kept, unwired (its response shape was never confirmed; it rate-limited hard).
  RSS and HTML-scrape are live-only and can't backfill (no from/to).
  HTML-scrape does tag-stripping only; Reuters/WSJ return bot-challenge 401s;
  pages with no published-time meta fall back to fetch time and are unsafe for
  point-in-time use.
- **yfinance** is unofficial, daily bars only, and returns 429 on every call from Workers (live cron and the historical backfill, 2026-09-20) —
  see Next steps, A2. **EDGAR** gives only reported `us-gaap` tags (no non-GAAP),
  paced at 110ms. Ingestion pacing exists per adapter but there is no shared
  cross-vendor limiter, and `ingestPriceBars`/`ingestFundamentals` fetch the full
  watchlist with no delta fetching.
- **Untuned placeholders:** `MAX_PORTFOLIO_RISK_PCT` (0.20) and
  `config.maxPositionHoldDays` (10). No correlation check in portfolio sign-off.
- **Exit logic** only fires time-based exits for a ticker until price bars exist
  before its position opens. `alphaReturn` is always `null` (no benchmark series
  ingested). Reflection failures are logged and swallowed; the position stays closed.
- **`debates` table** has no write path (`trade_decisions.debate_id` is always null).
- **Backtest harness:** the math layer, no-signal baseline, signal-on runner and
  the persisted end-to-end run are built but have the defects listed in Current
  Status (audit, 2026-09-20). Every run spends real Gemini quota (several calls
  per news item plus one per position close), so it is manual only and must never
  be wired into `scheduled()`. Backfill news via `POST /backfill?from=&to=` (and,
  once built, prices) first: runs read only what is in D1.
- **CI:** no lockfile-sync job (fine with one `package.json`).
