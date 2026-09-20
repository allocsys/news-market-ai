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

## Backtest / Live Isolation — REDESIGN (verified 2026-09-19; prod D1 wiped the same day)
**Status (2026-09-20): implemented and merged (M1–M5).** What follows is the
original problem statement (which describes the pre-split system) and the design
as built.
**Problem:** backtest and live runs share the same D1 tables and nothing marks
which run wrote a row. Verified by reading the code and running read-only
queries against production D1 (`news_market_ai`, 2026-09-19 ~04:35Z).
**Prod D1 was wiped later that day at the owner's request (no backup), so the
numbers below are historical evidence of why the design changed.**

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

### Design: environments (rewrite, D1 only — agreed 2026-09-19, built in M1–M5)
Backtest was bolted onto live (shared tables, then proposed row tags) and each
fix still left a path to leak. The rewrite makes isolation structural: **one
engine, run inside an environment; an environment owns its state, and its Worker
holds no binding to any other environment's state.** No Durable Objects; D1 only.
This supersedes the earlier `run_scope` tagging proposal and its "reject a
second D1" note.

**Three D1 databases**
| DB | Holds | Written by |
|---|---|---|
| `inputs` | `news_items`, `news_item_revisions`, `news_item_tickers`, `price_bars`, `fundamental_facts`: shared, append-only, point-in-time through the existing `asOf` filters | `ingest` only (the Step 5 gap -- `backend` also holding `inputs` write access for `backfill` -- closed 2026-09-20) |
| `live` | run state with `run_id = 'live'`: `positions`, `trade_decisions`, `decision_memory`, `pipeline_checkpoints`, `llm_calls`, `job_progress` | `llm` (live) |
| `sim` | the same tables with `run_id` = backtest id, plus `backtest_runs` (registry) | `backtest` |

**Schema and access**
- One state schema, `migrations/state/`, applied to both `live` and `sim`
  (`migrations/inputs/` for `inputs`). `run_id NOT NULL` is part of every
  primary/unique key, so `ticker|asOf` thesis ids can no longer collide across
  runs, and an identical window re-run gets a new `run_id` and really executes.
  CI fails if the `live` and `sim` schemas differ.
- `RunStore(db, runId)` is the only code that runs SQL on state tables; every
  method filters `run_id`, and delete-by-run refuses `'live'`. The scope-less
  functions in `storage/d1.js` are deleted, not adapted. Input reads go through
  a separate `InputsView(db)` (`asOf` required, as today).

**Workers and bindings**
- `ingest`: `inputs` read/write. Enqueues ANALYZE. Since the Step 5 follow-up
  (2026-09-20) also consumes `BACKFILL` and narrowly binds `live` (rw,
  `job_progress` reporting only -- see that follow-up's own note).
- `llm` (live only): `live` read/write, `inputs` read-only. Consumes `ANALYZE`
  and `exit_check`.
- `backtest` (new: `wrangler.backtest.toml`, own `BACKTEST` queue + DLQ): `sim`
  read/write, `inputs` read-only, its own KV namespace (`backtest-CACHE_KV`) for
  cooldowns. **No `live` binding and no live KV.**
- `backend`: read-only handles to all three for the dashboard API; runs the
  migrations for all three; enqueues backtest jobs.
- `dashboard`: unchanged, except views take an environment (`live` by default);
  backtest pages read the `sim` registry.
- Enforcement is config first, code second: CI fails if `wrangler.backtest.toml`
  binds the `live` DB; `readOnly(db)` rejects anything but SELECT (tested).
  D1 bindings can't be made read-only, so the `inputs` guard is the one that is
  code, not config.

**Engine ports.** The pipeline receives `{ clock, inputs, store, enqueue }` and
never calls `Date.now()`. Live: real clock and queues. Backtest: `SimClock`
(end clamped to real now, throws on a future time) and a recording enqueue, so a
backtest cannot trigger live work. This replaces PR #44 (walk clamp + guard).

**Atomic portfolio commit (also fixes "Overlapping open positions").** D1 runs a
`batch` as one transaction (sequential, all-or-nothing; verified against the
docs, see caveats), so check-and-write goes in one batch with the checks inside
the SQL:
1. Predicate P = no open position for this ticker with a later `opened_at` AND
   (open risk of *other* tickers) + new risk <= `MAX_PORTFOLIO_RISK_PCT`.
2. `UPDATE positions` closing this ticker's older open positions as `replaced`
   `WHERE P`; `INSERT` the new position `WHERE P`; insert the decision row either
   way, with the outcome (opened / rejected / superseded) recorded.
3. Backstop: partial unique index on `(run_id, ticker) WHERE closed_at IS NULL`,
   so a bug fails loudly instead of double-opening.
Latest `asOf` wins, so a late-finishing older article can't open or close
anything out of order. **Decided 2026-09-19:** the ceiling is checked against
other tickers' exposure, because a ticker's new position replaces its old one
(a behavior change from today).

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
  *Implemented (M3 7/N):* `src/llm/budget.js`; one counter per run on
  `config.llmBudget`, charged at `callStructured`. It counts logical calls, not
  cascade HTTP attempts. **Owner decided (2026-09-19): no cap** -- leave
  `BACKTEST_MAX_LLM_CALLS` unset (backtests uncapped); the mechanism stays in
  code. Known risk: an uncapped runaway backtest can burn the shared Gemini
  quota that live also uses. A redelivered queue message starts a fresh counter.
- **Failed runs are cleaned up: delete the data, keep the error log.**
  *Implemented (M3 8/N):* when a run ends `failed`, the `backtest` Worker
  (`src/backtest/cleanup.js`, called after the failure is recorded) deletes its
  positions, decisions, memory, checkpoints and non-error `llm_calls`, in chunks
  (`RunStore.deleteRun`, 500 rows/table/chunk, at most 20 chunks per run). It
  **keeps** the `backtest_runs` row (status `failed` + the error, which now ends
  in `[while processing <ticker> <day>]` when the failure was mid-walk), the
  run's `llm_calls` rows with `status='error'`, and its single `job_progress`
  row. **Complete runs are never auto-deleted**; cleanup refuses anything whose
  registry row is not `failed`, and always refuses `live`. It is best-effort:
  an error is logged, never retried, and never changes the ack. If cut short at
  the chunk cap, the leftover rows simply remain (logged). Cost: D1 deletes count
  as rows written, so a run that fails late pays roughly double its writes
  against the 100K/day cap. A redelivered message for a run whose registry row is
  already `complete` or `failed` is acked and skipped (it would otherwise restart
  the walk from scratch once the checkpoints are gone); a `running` row still
  resumes from checkpoints.
- The `*/15` cron was disabled by the owner on 2026-09-19 and was meant to stay
  off until M4, but `wrangler.toml` still declared it so deploys kept re-enabling
  it; the owner decided on 2026-09-20 to leave it on now that M4a has the
  dashboard reading `live`/`inputs` too (see "Cron state" under Milestones).

**Free-plan budgets** (the account is on Workers Free; limits from Cloudflare's
docs, checked 2026-09-19). All of these are per account, not per DB, Worker or
namespace, so three D1s and a second KV isolate state but add no quota.
- D1: 5M rows read and 100K rows written per day across every DB in the account;
  an indexed column counts as an extra row written. When exhausted, all queries
  error until 00:00 UTC, live's included. Storage: 500 MB per DB, 5 GB per
  account. Databases: 10 per account (7 with the three new ones, other projects'
  DBs included).
- **Backtest write cap (proposed):** the `backtest` Worker records
  `meta.rows_written` per run in `backtest_runs` and refuses to start a run when
  the day's total would pass `BACKTEST_DAILY_WRITE_BUDGET` (proposed default 40K,
  leaving live 60K). It runs with `LLM_LOG_ENABLED=false` (`llm_calls` is ~4 rows
  per call) unless a run opts in.
- KV: 1K writes, 1K lists and 100K reads per day. Cooldown keys are written only
  on rate-limit events.
- Queues: 10K ops per day. A backtest is one message on `BACKTEST`; the
  `SimClock` walk runs inside the consumer and never fans out per day.
- Workers: 50 queries per invocation on Free. Whether each statement in a `batch`
  counts is unconfirmed, so M1 measures it and `commitThesis` stays at 3
  statements.
- Concurrent backtests share `sim`: `run_id` prevents collisions but writes
  contend and the DB grows; delete-by-run must chunk.
- No cross-DB joins or transactions. None needed today: the only JOIN in the code
  is `news_item_revisions` with `news_item_tickers`, both in `inputs`.
- Backfill is still a write to `inputs`. It stays an explicit ingest job; a
  backtest over an un-backfilled window fails fast instead of fetching.
- D1 `batch`, verified against Cloudflare's docs 2026-09-19: statements run
  sequentially and non-concurrently as one transaction, and the whole batch rolls
  back on any error. A guarded statement that matches no rows is not an error, so
  the `WHERE P` design works. There is no `BEGIN`/`COMMIT` and no reading a
  result mid-batch. **Not stated in the docs:** that concurrent batches from
  different Workers serialize (a third-party source says each DB is one SQLite
  writer). The M1 concurrency tests are the proof; the partial unique index is
  the backstop.

**Milestones** (one PR each, squash-merge)
- **M1** Provision `inputs`/`live`/`sim` (`ensure-d1-database`) and
  `backtest-CACHE_KV` (`ensure-kv-namespace`), split migrations, `RunStore`,
  `readOnly`, `commitThesis`; tests: out-of-order `asOf`, concurrent same-ticker
  commits, ceiling race, run isolation, and a measurement of how many queries a
  `batch` counts toward the 50-per-invocation Free limit.
- **M2** Engine ports: `pipeline.js`, `settle.js`, `exit_check.js`, memory reads
  via `RunStore`/`InputsView`; split `storage/d1.js`.
- **M3** `backtest` Worker + queue, `SimClock`, runner rewrite (walk-forward,
  signal on/off), delete-by-run, CI checks (no live binding, equal schemas).
- **M4** Cut live over to `live`/`inputs` (empty; fresh ingest), dashboard and
  backend read paths, environment selector.
  - **M4a — dashboard read paths (done, PR pending):** every dashboard panel now
    reads `readOnly(LIVE_DB)` through `RunStore` (`run_id = 'live'`: positions,
    exposure, decisions, decision stats, pipeline checkpoints, plus the LLM log and
    jobs from M2b) or `readOnly(INPUTS_DB)` (ingestion health, price charts). Nothing
    in `src/` reads the old `DB` binding any more, and `storage/d1.js` is deleted.
    The reads are `RunStore.listOpenPositions / getOpenExposureTotal /
    listRecentlyClosedPositions / listRecentTradeDecisions / listRecentCheckpoints /
    getDecisionStats` and `inputs_view.js#getIngestionHealth / getRecentPriceBars`;
    all are `run_id`-scoped, deliberately not asOf-gated (dashboard-only), and must
    not feed an agent prompt. `safe()` in `dashboard/data.js` now also catches a
    failure while *building* a query. Tests: the two hand-written DB fakes in
    `dashboard_api`/`dashboard_worker` are gone (real sqlite LIVE_DB/INPUTS_DB/SIM_DB
    instead), a poisoned old `DB` proves nothing reads it, a decoy run in the same
    LIVE_DB proves run scoping through every route. **Left in M4:** the environment
    selector (a `?env=` reading a backtest's `run_id` off SIM_DB; note
    `getDecisionStats`' "last N days" window is wall-clock relative, so it needs an
    anchor for a finished backtest). The cron question below is now resolved.
- **M5 — remove the old DB from code and config (done 2026-09-20, PR #57, merge
  commit `205e4da`; the post-merge run passed test, migrate and all five deploy
  jobs):** the `DB`
  binding (`news_market_ai`) is gone from `wrangler.toml`, `wrangler.ingest.toml`
  and `wrangler.llm.toml`; `db:migrate:{local,remote}` are deleted and the `:all`
  chains now run inputs, live and sim only; `deploy.yml` lost its four "Ensure D1
  database exists" steps; `test/cron_fanout.test.js` lost `FakeIngestDb`; and
  `.github/actions/ensure-d1-database` is deleted. That action defaulted to the
  name `news_market_ai` and would have re-created an empty database on the first
  deploy after the resource was deleted. `test/ci_env_isolation.test.js` used to
  read the legacy id from `wrangler.toml`'s `DB` block, so it now pins the
  placeholder constant instead, and gained two guards: no wrangler config binds
  the legacy DB or carries a placeholder D1 id, and CI/npm scripts never
  reference it. **The owner deletes the actual Cloudflare `news_market_ai` D1
  resource out of band** -- nothing in the repo does. PR #44 was already closed
  (unmerged, 2026-09-19, superseded by the SimClock isolation design). The root
  `migrations/0001-0012` (the retired pre-split schema) are deleted too; nothing
  read them (tests and CI use only `migrations/{inputs,state,sim}`), and a test
  keeps `migrations/` free of root-level `.sql` files. Code comments that cited
  them by name (`config.js`, `exit.js`, `edgar_fundamentals.js`, `status.js`,
  `inputs_view.js`) now point at `migrations/{state,inputs}/` instead; git
  history has the old files.
Since M2/M2b the engine, ingest and LLM Workers already read and write
`live`/`inputs`; M4a moved the last readers (the dashboard) over, and M5 removed
the old DB's binding.
**Cron state (observed 2026-09-19, decided 2026-09-20):** the owner had disabled
the `*/15` trigger out of band, but `wrangler.toml` still declared
`crons = ["*/15 * * * *"]` and every `backend` deploy re-applied it. Workers
Observability showed it firing every 15 minutes from at least 18:45Z (deploy #287
logged `schedule: */15 * * * *`), so live ingest had been running against the
new DBs regardless of the intended pause. The owner decided (2026-09-20) to
leave it on: `wrangler.toml` is unchanged and the cron continues to fire on its
existing schedule with no code change required.

**M1 code — done on `m1/state-store-foundation`, no PR yet (2026-09-19):**
`migrations/inputs/`, `migrations/state/`, `migrations/sim/` (the split
described above); `test/helpers/sqlite_d1.js` (a real `node:sqlite`-backed D1
adapter, not a hand-written fake, so the migration SQL and RunStore's own
queries actually run); `src/storage/run_store.js` (`RunStore`, `readOnly`,
`commitThesis`); `src/storage/inputs_view.js` (re-exports the unchanged
inputs readers/writers from `d1.js` under the new import path). 433 old tests
still pass; +28 new (`run_store.test.js`, `sqlite_d1_adapter.test.js`,
`inputs_view.test.js`) covering out-of-order `asOf`, the risk-ceiling
rejection (incl. the "own replaced position isn't double-counted" case), the
partial-unique-index backstop, run isolation, `deleteRun`'s `'live'` refusal,
and a local count confirming `commitThesis` stays at exactly 3 prepared
statements. **Still open:** whether Cloudflare counts each statement inside
a `batch()` toward the 50-queries-per-invocation Free cap is NOT settled by
this — `node:sqlite` has no such cap to measure against, so this needs a real
deployment to check. Not yet done: provisioning the three D1s / KV namespace,
pushing the branch, opening the PR.

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
**Impact:** every non-AAPL live thesis saw 0.58–0.89 open exposure against the
0.20 ceiling and was rejected (6 rejections on 09-18: EVR, GOOGL, INTC, MSFT, NVDA,
SKHY; per-decision causation not replayed).
**Decision:** fixed by the atomic portfolio commit in the environment design
above (latest `asOf` wins, one open position per ticker enforced in SQL plus a
unique-index backstop), built in M1, live from M4. Options (b) per-ticker ordered
processing and (c) a per-ticker ceiling cap were dropped.

**Data repair: not needed.** At the owner's request all 14 data tables in prod D1
(`news_market_ai`) were emptied on 2026-09-19, with no backup; schema and
`d1_migrations` were kept. Re-ingesting enqueues ANALYZE for every fetched item
(LLM spend), and the overlap bug will re-accumulate until M4.

## Deployment: Cloudflare Workers + D1 + KV (free tier)
| Resource | Free limit | Implication |
|---|---|---|
| Workers | 100K requests/day, 10ms CPU/invocation | CPU time excludes `fetch()` wait, so LLM-calling steps barely touch the budget |
| D1 | 5GB storage, 5M rows read/day, 100K rows written/day (hard-enforced) | Batch inserts, dedupe before writing |
| KV | 1GB storage, 100K reads/day, 1K writes/day | Only for low-frequency state (LLM key/model cooldowns) |
| Queues | 10K ops/day | ~5 guaranteed messages per 15-min tick at 3 tickers, plus one ANALYZE per new item; re-check before growing the watchlist |

**Architecture (built 2026-09-19):** five Workers connected by queues (`backtest`
was added in M3), each binding only the D1s it needs -- `inputs`,
`live` or `sim`; the old single `news_market_ai` DB was removed in M5 -- with
only `backend` running migrations, and all sharing one `CACHE_KV` except
`backtest`, which has its own.
- **`dashboard`** (`wrangler.dashboard.toml`, `src/dashboard-worker.js`) — the only
  public Worker: login, session cookie, server-rendered UI. Reaches `backend`
  through a service binding. Holds the dashboard login secrets.
- **`backend`** (`wrangler.toml`, `src/index.js`) — private (no workers.dev, no
  routes). JSON `/api/*`, `POST /backfill`, `POST /backtest/run`, the `*/15` cron
  `scheduled()` (pure fan-out: per-ticker `ingest_ticker` + one `ingest_feeds`
  onto `INGEST`, one `exit_check` onto `LLM_JOBS`), D1 migrations. Holds NO
  vendor key and has no `queue()` export (Step 5 follow-up, 2026-09-20 --
  `backfill`'s consumer, formerly here on `JOBS`, moved to `ingest`).
- **`ingest`** (`wrangler.ingest.toml`) — `INGEST` consumer (`max_batch_size` 10)
  and, since the Step 5 follow-up, `BACKFILL` consumer (`max_batch_size` 1) too.
  Fetches Finnhub/yfinance/EDGAR/RSS/scrape, writes D1, enqueues one `analyze`
  per item (per item×ticker for general feeds) onto `ANALYZE`. The sole holder
  of `FINNHUB_API_KEY`; also narrowly binds `LIVE_DB` (rw, `job_progress`
  reporting only, for the backfill branch).
- **`llm`** (`wrangler.llm.toml`) — the live Gemini caller: holds `GEMINI_API_KEYS`
  and the live `gemini:cooldown:*` KV keys. Binds `LIVE_DB` (rw) and `INPUTS_DB`
  (read-only by convention). Consumes `ANALYZE` (`max_batch_size` 5,
  `max_concurrency` 2 = the Gemini throttle; failures **retry**, since the
  pipeline is checkpoint-resumable) and `LLM_JOBS` (`exit_check` only since M3;
  batch 1, concurrency 1; failures are logged and acked).
- **`backtest`** (`wrangler.backtest.toml`, `src/backtest-worker.js`) — private;
  consumes `BACKTEST` (batch 1, concurrency 1, DLQ): one message is one full
  signal-on/off run. Binds `SIM_DB` (rw), `INPUTS_DB` (read-only by convention)
  and its own `CACHE_KV` namespace, and **no `LIVE_DB`** (pinned by
  `test/ci_env_isolation.test.js`). Holds its own copy of `GEMINI_API_KEYS`, never
  `FINNHUB_API_KEY`.

Every queue has a DLQ (`max_retries` 3). D1 is the structured layer; KV holds
cooldown state and light config.

**CI/CD** (`.github/workflows/deploy.yml`): `test` → `migrate` (push/dispatch,
gated on `migrations/**`) → one deploy job per Worker (`deploy`=backend,
`deploy-dashboard`, `deploy-ingest`, `deploy-llm`, `deploy-backtest`), each with its own
`dorny/paths-filter` output and `concurrency` group; `workflow_dispatch` runs
all. Provisioning is idempotent via `.github/actions/ensure-{kv-namespace,queue}`
(look up by name, create if missing, never commit ids; `ensure-kv-namespace` takes
a `wrangler-config` input so each Worker's job patches its own file). D1 ids are
committed directly (since M1), so there is no D1 provisioning step and
`ensure-d1-database` was deleted in M5. Worker jobs use `needs: [changes, migrate]` with `if: always() &&
(needs.migrate.result == 'success' || needs.migrate.result == 'skipped')`.
Deploy path filters live in `.github/path-filters.yml`, and each target is
diffed against its own last successful deploy.

**Per-Worker secrets:** each deploy job fails fast on its own required secrets
and pushes them with `wrangler secret put --config <its file>`. `dashboard`:
`DASHBOARD_USERNAME/PASSWORD`, `JWT_SECRET`, `SESSION_TTL_SECONDS`. `backend`:
none (Step 5 follow-up, 2026-09-20). `ingest`: `FINNHUB_API_KEY` (+
`EDGAR_USER_AGENT`/`EDGAR_CIK_MAP` vars) -- the only holder of that secret now.
`llm` and `backtest`: `GEMINI_API_KEYS`. Repo-wide:
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
(in the state schema, `migrations/state/`, since M2b; scoped by `env_run_id`, so
each environment only sees and prunes its own rows), shown at `/dashboard/llm` (filters: source/status/ticker/
backtest/run) and `/dashboard/llm/:id`.
- **One choke point:** `agents/utils/structured.js#callStructured` writes the row.
  Context (`source`, `jobId`, `runId`, `ticker`, and the `store` the row is
  written through) rides on `config.llmLog`
  (`storage/llm_calls.js#withLlmLogContext`), set by `llm-worker.js`,
  `runPipelineForTicker` and `checkOpenPositionExits`. No store on the context
  means logging is a silent no-op. Note `runId` here is the PIPELINE run
  (column `run_id`); the environment is the store's run id (`env_run_id`).
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
- **Step 5 — `ingest` Worker (PR #31).** `INGEST` consumer moved out. **Gap
  closed in a follow-up (2026-09-20):** `backend` used to still hold
  `FINNHUB_API_KEY` because `backfill` called Finnhub and `JOBS` allowed one
  consumer. Fixed by renaming `JOBS` to `BACKFILL` and moving its consumer to
  `ingest` (which also gained a narrow `LIVE_DB` binding, rw, for
  `job_progress` reporting only) -- `backend` now holds no vendor key at all
  and has no `queue()` export.
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
  its wrangler file's "Secrets" comment.
- **Config drift:** `wrangler.dashboard.toml` enables `[observability.logs]` but the
  live dashboard Worker had logs off. The toml is the intended state; re-enable.
- **Live pipeline produced no analysis after the M4 cutover (found 2026-09-20,
  fixed on `fix/ingest-enqueue-new-items-only`).** `LIVE_DB` was empty (no
  decisions, positions, checkpoints or LLM calls) while `INPUTS_DB` held 427 news
  items, and `llm` ran only `exit_check`. Cause: every `ingest_ticker` tick threw
  `batch message count of 163 exceeds limit of 100 (10206)` from
  `ANALYZE.sendBatch` (Cloudflare Queues caps a batch at 100 messages / 256 KB);
  the handler caught it, logged it and acked, so nothing ever reached ANALYZE.
  **Second trap, fixed together:** `ingestTickerData`/`ingestFeedNews` returned
  every fetched item, not just new ones (Finnhub returns a trailing window and
  `insertNewsItem` said nothing about conflicts), so chunking alone would have
  re-enqueued ~160 items per ticker every 15 minutes. Now `insertNewsItem` returns
  `{ inserted, newTickers }` (from D1 `meta.changes`), the ingest functions return
  `{ fetched, fresh }` (an item is fresh for a ticker when its `news_items` row or
  its `(item, ticker)` association is new), and `ingestion/enqueue.js#sendInChunks`
  sends in chunks of at most 100 messages / 200 KB, continues past a failed chunk
  and reports it. **Open consequences:** (1) the items ingested before the fix
  are stored but were never analyzed and are no longer detected as new; analyzing
  them is LLM spend and the owner's call. (2) A queue failure after the D1 write is
  logged (count + `ticker:runId` labels) but not retried, since a re-run would see
  those items as already stored. (3) The per-tick cost of re-running
  `insertNewsItem` over the whole trailing window (3-4 D1 statements per item) is
  unchanged; if it shows up in CPU or D1 numbers, pre-filter existing ids with one
  batched `SELECT` per ticker.

## Repo Structure
```
src/index.js          # `backend` Worker (wrangler.toml) -- JSON API, /backfill
                      # (enqueues onto BACKFILL), /backtest/run (enqueues onto
                      # BACKTEST), cron scheduler. No queue consumer, no
                      # vendor key (Step 5 follow-up, 2026-09-20)
src/dashboard-worker.js  # `dashboard` Worker (wrangler.dashboard.toml) -- login,
                      # session, SSR UI; calls `backend` via service binding
src/ingest-worker.js  # `ingest` Worker (wrangler.ingest.toml) -- INGEST and
                      # BACKFILL consumers
src/llm-worker.js     # `llm` Worker (wrangler.llm.toml) -- ANALYZE + exit_check on
                      # {inputs, live store}; a stray backtest message on
                      # LLM_JOBS is rejected (logged, job marked failed, acked, no
                      # work done -- backtests run on `backtest`); holds
                      # GEMINI_API_KEYS, as does `backtest`
src/backtest-worker.js  # `backtest` Worker (wrangler.backtest.toml) -- BACKTEST
                      # consumer; binds only SIM_DB + INPUTS_DB + its own CACHE_KV
ingestion/           # Finnhub, GDELT (unwired), EDGAR, RSS, HTML-scrape, yfinance adapters
  ingest.js           # scheduled-ingestion entry point (split out of index.js in M2)
  enqueue.js          # chunked ANALYZE sendBatch (Queues caps a batch at 100 messages / 256 KB)
  errors.js           # typed vendor error taxonomy (Pattern 11)
  date_window.js       # point-in-time cutoff/boundary helpers
  market_data_validator.js  # sanity-check vendor data before agents see it (Pattern 9)
storage/             # run_store.js (RunStore, state-DB access), inputs_view.js
                      # (input-side D1 access), sim_registry.js (the backtest_runs
                      # registry, SIM_DB only); llm_calls.js and jobs.js hold pure
                      # helpers only (M2b) -- their SQL is RunStore's. The old d1.js
                      # is gone (M4a).
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
migrations/          # inputs/, state/, sim/ -- the three environment schemas
                      # (the pre-split root 0001-0012 were deleted in M5)
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
CI and deploys are green across all five Workers.

Backtest/live isolation is built (three D1s, `backtest` Worker, `RunStore`;
M1–M5 merged). The behaviors in item 2 below have not been observed live end to
end, and live produced no analysis at all until the ingest enqueue fix (see
"Live pipeline produced no analysis" under Post-split follow-ups).

**Remaining work:**
1. **Overlapping open positions per ticker** (live) — fixed structurally: the
   atomic portfolio commit plus a one-open-position-per-ticker unique index,
   live since M4. Not yet observed in practice, since live had no decisions to
   overlap.
2. **Live verification** of: a backtest surviving past the old 30s cutoff (Step 3),
   a real ANALYZE crash-and-retry (Step 4), ops/day against real Observability
   numbers (Step 4), and the full ingest → analyze → llm flow producing decisions.
3. **Step 5's gap: CLOSED (2026-09-20).** `backfill`'s Finnhub calls (and the
   `FINNHUB_API_KEY` they needed) moved from `backend` to `ingest`, on a new
   `BACKFILL` queue (renamed from `JOBS`) -- `backend` now holds no vendor
   key and has no `queue()` export.
4. **`restless-manager-6789` investigated (2026-09-20), not this repo's:**
   created 2026-07-10 (before this project existed), last modified 2026-07-13,
   deployed via a direct API call rather than `wrangler`/CI. Holds its own
   `ADMIN_SECRET`/`BOT_TOKEN` secrets and its own D1/KV -- left alone;
   deleting it (if warranted) is the owner's call, not something this repo's
   tooling should touch.
5. **Loose end:** dashboard UI/UX not screenshot-reviewed.
6. Old stuck backtest row `backtest-1789756783629-bxavoi` is now `failed` in D1.
7. **New, found while verifying the ingest-enqueue fix live (2026-09-20):**
   `price_bars` (INPUTS_DB) holds only 5 rows, all AAPL, none newer than
   09-18 -- `yfinance chart API returned 429` for AAPL/MSFT/TSLA repeatedly in
   ingest logs. This is now the binding constraint on live trading: of the
   first 10 post-fix `trade_decisions`, 7 are `skipped_no_price_data` and the
   other 3 `rejected` -- none opened, because there is no current price bar
   to size against. The ingest-enqueue fix (see "Live pipeline produced no
   analysis" above) unblocked ANALYZE messages from reaching the LLM, but a
   fresh price bar is a separate, still-unmet precondition for a position to
   ever open. Not yet investigated: whether this is yfinance rate-limiting
   this account specifically, a cooldown misconfiguration, or an upstream
   yfinance change.

**M1 defect found while starting M2 (2026-09-19), fixed in the first M2 PR:**
`commitThesis`'s close-old statement did not exclude the row the same batch
inserts, so a checkpoint-resumed / queue-retried re-run of the portfolio
stage closed its own just-opened position as `replaced` while the decision
row still said `opened`. Now guarded by `id != ?`; `commitThesis` also takes
`exitPrice` (recorded on the replaced position, which `settle.js` needs).
Tests: re-run idempotency, older-thesis re-run after a newer replace, exit price.

**M1 bindings wired 2026-09-19:** `wrangler.toml` (backend) now binds
INPUTS_DB/LIVE_DB/SIM_DB alongside the old DB; `wrangler.llm.toml` binds
LIVE_DB (rw) + INPUTS_DB (ro by convention); `wrangler.ingest.toml` binds
INPUTS_DB (rw). Real database_ids committed directly rather than through
the usual `REPLACE_WITH_D1_DATABASE_ID` + `ensure-d1-database` placeholder
pattern -- see next paragraph for why. No `wrangler.backtest.toml` yet
(M3) so the KV namespace (`news-market-ai-backtest-CACHE_KV`,
`f14e4607af5843599eac863b6adb508b`) isn't bound anywhere yet either. Not
yet done: `package.json`/`deploy.yml` migrate steps for the three new DBs
(they were migrated by hand for M1 -- see that section); engine code
(pipeline.js etc.) still reads/writes the old single `DB` binding until
M2's port lands.

**CI bug found 2026-09-19, fixed same day:**
`.github/actions/ensure-d1-database`'s patch step used to do
(`sed -i "s/database_id = \".*\"/.../" "$CONFIG_FILE"`), which matched and
overwrote **every** `database_id = "..."` line in the target file, not
only the one belonging to its own `database-name` input. Invisible with
one `[[d1_databases]]` block per file (every prior use of this action);
now that `wrangler.toml`/`wrangler.llm.toml`/`wrangler.ingest.toml` each
have multiple blocks, calling this action against any of them (e.g. to
re-resolve the old `DB` binding's id on a fresh checkout) would have
stomped INPUTS_DB/LIVE_DB/SIM_DB's real ids with whatever single id it
resolved. Was not triggered before the fix -- CI's
`migrate`/`deploy`/`deploy-ingest`/`deploy-llm` jobs only ever called this
action for the single old `DB` binding, and INPUTS_DB/LIVE_DB/SIM_DB's ids
are committed directly (not placeholders), so there was nothing for it to
patch there yet. **Fixed** by replacing the global sed with an awk pass
scoped to the specific `[[d1_databases]]` block whose `database_name`
matches `inputs.database-name`, leaving every other block's id untouched.

**M2 code — done on `m2/engine-port-run-store`, pushed, no PR yet (2026-09-19):**
Engine now runs on `{inputs, store}` instead of the old scope-less `d1.js`.
`shared/constants.js` gained `MAX_PORTFOLIO_RISK_PCT` and `TRADE_DECISION_STATUS`
(`opened`/`rejected`/`superseded`/`skipped_no_price_data` — the M1 design's
`approved` is renamed `opened` to match); `portfolio_manager` imports the shared
constant instead of a local copy. `RunStore` gained
`getUnsettledReplacedPositions` (see design note below). `storage/inputs_view.js`
now holds the input-side functions directly (no longer just a re-export);
`storage/d1.js` is LEGACY — kept only for the dashboard's old-DB reads and the
`backtest_runs` registry functions, everything else deleted rather than adapted,
per the M1 rule. `checkpointer.js`, `memory.js`, `reflection.js`, `settle.js`,
`exit_check.js` and `pipeline.js` all take `{inputs, store}` now.
`ingestion/ingest.js` was split out of the old scheduler; `runScheduledIngestion`
is deleted (was dead code per the Known Gaps note, confirmed unused). `ingest-worker`
and `index.js`'s backfill path both use `env.INPUTS_DB`; the job reporter stayed on
`env.DB` until M2b (below) moved `job_progress` to the state schema. `llm-worker` builds
its `{inputs, store}` context per message (`inputs = readOnly(env.INPUTS_DB)`,
`store = new RunStore(env.LIVE_DB, "live")`); a `backtest` message on `LLM_JOBS`
now fails loudly — starts the job row, logs, `reporter.fail("backtests move to the
backtest Worker in M3")`, acks, does no work — instead of running against live
state. `POST /backtest/run` returns a 503 JSON body before any job row is written
or anything enqueued (the old enqueue block is deleted, not gated). `src/backtest/*`
is ported onto the new signature: `runManualBacktest(env, config, {inputs, store,
registryDb}, params)`. A few stale comments referencing the old `d1.js` functions
were fixed in passing.

**Design note (for the PR body):** `settlePositionOutcome` logs and swallows a
failed reflection by design — the position stays closed, there's just no
reflection recorded. So `getUnsettledReplacedPositions` only recovers a hard
crash or queue retry landing between the `commitThesis` batch and the settle
step; it is not a retry path for a thrown reflection error, and shouldn't be
treated as one later.

**M2 tests:** new `test/helpers/engine_ctx.js` builds `{inputs, store}` (plus
`inputsDb`/`stateDb`) on real `node:sqlite`, with `seedNews`/`seedBar`/`stateRows`
helpers and `STATE_DIR`/`INPUTS_DIR`/`SIM_DIR` exports, so tests run against real
SQL instead of hand-written fakes. Rewritten on top of it, assertions unchanged:
`backtest_on_signal_runner`, `backtest_run` (`registryDb = createTestD1([SIM_DIR])`),
`checkpoint_resume` (technical analyst now actually runs — 7 LLM calls,
`EXPECTED_LABELS` includes `analyst:technical` — plus a new env-scoped checkpoint
case), `exit_logic` (+ run-id isolation), `positions_pointintime` (+ run-id
isolation), `memory_pointintime`. Updated for the new bindings/contract:
`index_backtest_enqueue` (503 contract — nothing enqueued, no `job_progress`
row), `dashboard_worker` (503 pass-through), `ingest_worker`/`queue_consumer`
(`INPUTS_DB`), `ingestion_wiring`/`entity_resolution_wiring` (import path moved
to `ingestion/ingest.js`), `fundamentals`/`price_bars`/`technical`/
`portfolio_manager`/`inputs_view` (updated paths/headers only), `llm_worker`
(real `LIVE_DB`/`INPUTS_DB` via an `engineBindings()` helper; the backtest-rejection
test used the OLD-DB schema — the root `migrations/` dir — for
`job_progress` until M2b; the state schema already had `job_progress` with a
`run_id` column from M1, the test just hadn't been pointed at it). New `test/replaced_settle.test.js` (7 cases):
`getUnsettledReplacedPositions` returns replaced-and-unsettled positions with
`exitPrice`, excludes already-settled ones, matches on `closedAt`/`ticker`/
`'replaced'` exactly, and requires `closedAt`; a pipeline retry after a
commit-before-settle crash (injected by making `store.getUnsettledReplacedPositions`
throw once) settles the replaced position exactly once; `TRADE_DECISION_STATUS`
values; `skipped_no_price_data` when no bar exists. The SQL outcomes for
superseded/opened/rejected stay pinned in `test/run_store.test.js`, unchanged.
Full suite: 470/470 pass.

**M2b (done — branch `m2b/llm-calls-job-progress-to-state-db`):** `llm_calls` and
`job_progress` moved onto the state DB via `RunStore`; wiring only, no schema
change (both tables already had `env_run_id`/`run_id` from M1). All SQL for them
now lives in `RunStore` (`insertLlmCall`/`pruneLlmCalls`/`getRecentLlmCalls`/
`getLlmCall`, scoped by `env_run_id`; `insertQueuedJob`/`markJobRunning`/
`updateJobProgress`/`completeJob`/`failJob`/`getJob`/`getActiveJob`, scoped by
`run_id`, PK `(run_id, id)`). `storage/llm_calls.js` and `storage/jobs.js` keep
only pure helpers (row building/clipping/redaction, value normalizers, row→API
mappers, the idle cutoff) which `RunStore` imports, plus the best-effort
`recordLlmCall`/`createJobReporter` wrappers. Interface changes:
`recordLlmCall(config, entry)` (was `(env, config, entry)`) writes through
`config.llmLog.store`; `createJobReporter(store, opts)` takes a `RunStore`. The
`store` reaches `config.llmLog` in `runPipelineForTicker` and
`checkOpenPositionExits` (so the reflection at a position close logs to the right
environment), not through a new `callStructured` parameter, to leave the eight
agents untouched. Consumers: `llm-worker` (backtest-rejection job row, retention
prune) and `index.js` (backfill `queued` row + consumer progress) use
`RunStore(LIVE_DB, "live")` and no longer touch `env.DB`; the dashboard API reads
jobs and LLM calls through `dashboard/data.js#liveReadStore`, a
`readOnly(LIVE_DB)`-wrapped live store. **Decision:** backfill jobs and the
rejected-backtest row live under `run_id = 'live'` (the `llm` Worker has no
`SIM_DB`; a real backtest's jobs get their own run id in the backtest Worker, M3),
so `/api/jobs/*` and `/api/llm-calls*` are live-only until the M4 env selector.
(M4a moved every other dashboard panel off the old `env.DB` too.) Tests: the two
hand-written fakes (`FakeLlmDb`, `FakeJobDb`) are gone; `storage_jobs`,
`llm_call_log`, `dashboard_llm`, `dashboard_api`, `dashboard_worker`,
`llm_worker`, `queue_consumer`, `index_backfill`, `index_backtest_enqueue` and
`checkpoint_resume` now run on real sqlite state DBs (new helpers
`test/helpers/job_db.js`, `broken_db.js`), with new cases for env/run isolation
(a second environment's rows are invisible to and unpruned by live, including by
id), the read-only dashboard handle, and best-effort behavior when `LIVE_DB` is
down. Full suite: 487/487 pass. Unblocks M5 deleting the old `DB` binding on the
engine side; the dashboard's remaining old-DB reads are M4's.

**Still open, carried from M1:** whether the `package.json`/`deploy.yml` migrate
steps for the three new D1s land in M2 or M3; `BACKTEST_DAILY_WRITE_BUDGET`
(proposed 40K) is not yet approved by the owner; whether each statement inside a
D1 `batch()` counts individually toward the 50-queries-per-invocation Free cap is
still unmeasured — needs a real deploy, not `node:sqlite`.

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
