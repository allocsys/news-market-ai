# Bug: "Too many API requests by single Worker invocation" (subrequest limit)

**Status:** FIXED, DEPLOYED, AND CONFIRMED. Fix (1) implemented and pushed (commits e49e976, 81258ba). Confirmed live in the deployed worker via `cf_workers_get_worker_code` (grep hit on `edgarFactsLookbackDays` and `latestByKey`). Confirmed working via `cf_workers_observability_query`: the 16:34 UTC cron run (requestId 9abd4710..., the last run that previously would have hit the fan-out) completed with outcome "ok", wallTimeMs 12537, no "Too many API requests" bursts -- only routine/pre-existing transient noise (yfinance 429, GDELT DOC API abort). No non-"ok" invocations for news-market-ai in the window checked afterward (16:35-18:00 UTC). Fixes (2)/(3) from "Proposed fix" below remain NOT implemented (deferred; (1) alone removed the fan-out that caused this).
**Worker version observed on:** `b1be5622-ca43-4786-9b3c-c22f11228c1f` (post-`400d337f`, i.e. after the Gemini-cascade/fiscal_year fixes described elsewhere in this doc's history — those two remain fixed).

## Symptom

Cloudflare's platform error

> Too many API requests by single Worker invocation. To configure this limit, refer to https://developers.cloudflare.com/workers/wrangler/configuration/#limits

fires ~1046–1047 times inside single scheduled invocations, recurring on multiple `*/15 * * * *` cron ticks (observed at 15:32, 15:49, 16:17, 16:34 UTC on 2026-09-17). This is a *different* failure mode from the previously-fixed Gemini-cascade `exceededCpu`/silent-165s-hang bug — that one is confirmed still fixed (no `exceededCpu` outcomes in the same window besides one older/stale invocation already known from last session).

Sample log lines from one burst (all same `requestId`/`traceId`, i.e. one invocation):

```
ticker: TSLA, tag: NetIncomeLoss, fiscalPeriod: Q2, fiscalYear: 2026
ticker: TSLA, tag: NetIncomeLoss, fiscalPeriod: Q1, fiscalYear: 2026
ticker: TSLA, tag: NetIncomeLoss, fiscalPeriod: FY, fiscalYear: 2025
ticker: TSLA, tag: NetIncomeLoss, fiscalPeriod: Q3, fiscalYear: 2025
ticker: TSLA, tag: NetIncomeLoss, fiscalPeriod: Q2, fiscalYear: 2025
ticker: TSLA, tag: NetIncomeLoss, fiscalPeriod: Q1, fiscalYear: 2025
ticker: TSLA, tag: NetIncomeLoss, fiscalPeriod: FY, fiscalYear: 2024
... (1047 total in this burst)
```

The repeated ticker/tag with many different `fiscalPeriod`/`fiscalYear` combinations per burst is the key clue: this is per-*fact-row* fan-out, not per-ticker or per-tag fan-out.

## Root cause

`src/ingestion/sources/edgar_fundamentals.js`:

- `fetchFacts()` makes exactly **one** outbound `fetch()` per `(ticker, tag)` pair against SEC EDGAR's `companyfacts` endpoint (correctly throttled via `edgarMinRequestIntervalMs`, one subrequest each — this part is fine and not the problem).
- But it then iterates **every unit/entry EDGAR has ever reported for that tag** (`for (const [unit, entries] of Object.entries(concept.units ?? {})) for (const entry of entries ?? [])`) with **no date/period filtering, no "latest only" cutoff, and no limit** — despite the function being named `fetchLatest`. For a mature ticker like TSLA, `NetIncomeLoss` alone has 10+ years of quarterly + annual (`FY`/`Q1`/`Q2`/`Q3`) filings, i.e. dozens of rows, and this is repeated for every `(ticker × tag)` combination in the watchlist (default tags: `Revenues`, `EarningsPerShareDiluted`, `NetIncomeLoss`).
- All of these rows flow into one `facts[]` array, which `ingestFundamentals()` (`src/storage/d1.js` call site) chunks into batches of `FUNDAMENTALS_INSERT_CHUNK_SIZE = 200` and writes via `insertFundamentalFacts()` → `db.batch(batch)`, where `batch` is 200 individually-bound `INSERT ... ON CONFLICT DO UPDATE` statements.
- Each statement inside a D1 `db.batch()` call counts toward the Worker's per-invocation subrequest budget, same as outbound `fetch()` calls do. With the full (unfiltered) historical time series being re-fetched and re-upserted on **every 15-minute cron run**, for **every ticker in the watchlist**, total subrequests (EDGAR fetches + D1 batch statements) blow past Cloudflare's per-invocation subrequest cap well before all chunks finish.
- Once the cap is hit, every subsequent subrequest attempt (each remaining chunk's `db.batch()`, and any later ingestion stage's calls) immediately throws the same "Too many API requests" error. There's no early-exit/backoff — `ingestFundamentals()`'s per-chunk `try/catch` just logs `"fundamentals ingestion -- skipping one chunk of fact inserts"` and moves to the next chunk, which also fails — so the error repeats for the remainder of the run instead of failing fast once.

This also explains a loose end from the D1-state check two sessions ago: `analyst_opinions`/`debates`/`trade_decisions` stuck at 0 is *plausibly* explained by these runs burning their entire subrequest budget on fundamentals ingestion (or on the Gemini cascade, in the older bug) before ever reaching the later pipeline stages — needs re-verification once this is fixed, per the existing checkpoint note.

## Why this wasn't the earlier "subrequest cap starving Gemini" bug

The checkpoint's older fixed bug was about the subrequest cap being *exhausted before Gemini calls*, already patched. This is a **new, separate** source of subrequest exhaustion — historical EDGAR fact fan-out — surfaced only now, likely because it was previously masked by the Gemini-cascade `exceededCpu` runs terminating the invocation early (via platform wall-clock kill) before fundamentals ingestion's later chunks got far enough to hit the cap themselves. With the Gemini cascade fixed, runs now live long enough to reach and blow through the fundamentals subrequest budget instead.

## Proposed fix (not yet implemented)

1. **Filter to "latest" per fiscal period, not full history**, in `fetchFacts()`/`fetchLatest()`: e.g. keep only the most-recently-filed entry per `(ticker, tag, fiscalYear, fiscalPeriod, form)`, or better, only entries with `filed` within some recent lookback window (matching the function's actual name/intent). This alone should cut the fact-row count by an order of magnitude or more per run.
2. Independent of (1), **avoid one-subrequest-per-row on D1 batch inserts** where possible, or at minimum track a running subrequest budget across `ingestFundamentals()`'s chunk loop and stop cleanly (log + return) once close to the platform limit, rather than continuing to attempt (and fail) every remaining chunk.
3. Since full history doesn't change intraday, consider only re-fetching/re-upserting fundamentals on a much longer cadence (e.g. daily) instead of every 15-minute cron tick, independent of (1)/(2).

## Next steps

- Get sign-off, then implement (1) at minimum (highest leverage, smallest change).
- Redeploy, then re-pull `cf_workers_observability_query` (`view=invocations`, `outcome != ok`, narrow timeframe) across a few subsequent cron runs to confirm the "Too many API requests" bursts stop.
- Re-check D1 state (`fundamental_facts`, `analyst_opinions`, `debates`, `trade_decisions`) once clean runs are confirmed.
