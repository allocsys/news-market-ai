// Data-fetching layer for the dashboard, extracted from routes.js (plan.md
// Step 1). One function per dashboard section, each returning a plain
// JSON-serializable shape -- no HTML. `routes.js`'s SSR handlers and
// `api.js`'s /api/* JSON handlers both call these same functions, so there
// is exactly one place each section's D1 reads happen, not two copies that
// could drift.
import { getIngestionHealth, getRecentPriceBars } from "../storage/inputs_view.js";
import { getRecentBacktestRuns, getBacktestRun, getActiveBacktestRunId } from "../storage/sim_registry.js";
import { RunStore, readOnly } from "../storage/run_store.js";
import { parseDashboardParams, BACKTEST_ID_RE, PRICE_CHART_TICKER_LIMIT, STALE_INGESTION_HOURS, PIPELINE_STALE_HOURS } from "./helpers.js";
import { computeRealizedReturn } from "../shared/returns.js";

/**
 * Read-only RunStore over LIVE_DB (run_id 'live'): every state-schema panel
 * (positions, decisions, checkpoints, the LLM-call log, job progress). The
 * dashboard API never writes, so the handle is wrapped in readOnly() -- a
 * write method reaching D1 through it throws instead of running. Inputs
 * panels (price charts, ingestion health) read readOnly(env.INPUTS_DB). As of
 * M4 nothing here touches the old `DB` binding; the environment selector
 * (reading a backtest's run_id off SIM_DB) is the next M4 step.
 */
export function liveReadStore(env) {
  return new RunStore(readOnly(env.LIVE_DB), "live");
}

/**
 * M4b environment selector. `envParam` is helpers.js#parseEnvParam's output
 * (already format-checked -- either "live" or something matching
 * BACKTEST_ID_RE), so this only has to confirm a well-formed backtest id
 * actually exists in the SIM_DB registry before trusting it as a RunStore
 * run_id. An unknown id, a malformed one, or a registry lookup failure all
 * fall back to 'live' rather than erroring the whole page -- `envError`
 * carries why, so the UI can say so, but every panel still renders.
 *
 * `anchor`, non-null only for a resolved backtest, is the timestamp
 * getDecisionStats should treat as "now". A backtest's trade_decisions carry
 * a WALL-CLOCK created_at stamped when the run wrote them (graph/pipeline.js;
 * the simulated date lives in as_of, not created_at), so they all fall
 * between the registry's startedAt and finishedAt -- also wall clock. A run
 * finished weeks ago would sit entirely outside a now-relative window, so
 * the window is anchored at the run's own end instead. Prefers finishedAt;
 * falls back to startedAt for a still-running or failed-with-no-finishedAt
 * run so the window isn't simply empty. Consequence: the per-day activity
 * buckets (grouped on created_at) show the days the run EXECUTED, not the
 * simulated trading days it covered.
 */
export async function resolveEnv(env, envParam) {
  const live = () => ({ store: liveReadStore(env), resolvedEnv: "live", anchor: null, envError: null });
  if (!envParam || envParam === "live") return live();
  if (!BACKTEST_ID_RE.test(envParam)) return { ...live(), envError: `unknown environment "${envParam}" -- showing live` };

  const { data: run, error } = await safe(() => getBacktestRun(readOnly(env.SIM_DB), envParam));
  if (error) return { ...live(), envError: `couldn't verify backtest "${envParam}" (${error}) -- showing live` };
  if (!run) return { ...live(), envError: `backtest "${envParam}" not found -- showing live` };

  return {
    store: new RunStore(readOnly(env.SIM_DB), envParam),
    resolvedEnv: envParam,
    anchor: run.finishedAt || run.startedAt,
    envError: null,
  };
}

/**
 * The newest in-flight job of `type` for GET /api/jobs/active, or null.
 *
 * backfill / backfill_prices jobs live under run_id 'live', so resolveEnv's
 * store answers directly. A BACKTEST job lives under its OWN run_id in SIM_DB
 * (M3) -- so with no specific `?env=<backtest id>` (the case after a form
 * submit: the 303 lands on /dashboard/backtest with no env), asking the live
 * store, as this used to, could never find one and the page showed no progress
 * bar. Instead find the newest active backtest run id across SIM_DB and read
 * that run's job row. An explicit backtest `?env=` keeps its old meaning (that
 * run's own job), and 'live' with type=backtest means "any backtest".
 */
export async function getActiveJob(env, type, envParam) {
  if (type === "backtest" && (!envParam || envParam === "live")) {
    const db = readOnly(env.SIM_DB);
    const runId = await getActiveBacktestRunId(db);
    return runId ? new RunStore(db, runId).getActiveJob("backtest") : null;
  }
  const { store } = await resolveEnv(env, envParam);
  return store.getActiveJob(type);
}

/**
 * Wraps a single D1 query promise so a rejection becomes { data: null, error }
 * instead of throwing through the caller, so one panel's failed fetch shows
 * an inline error rather than blanking or 500ing the whole page/response.
 * Callers await this instead of the raw query and never need their own
 * try/catch.
 */
async function safe(promiseOrFn) {
  try {
    // A function is invoked inside the try, so a synchronous failure while
    // building the query (a missing binding, readOnly() refusing) is reported
    // as that panel's error instead of throwing through the caller.
    return { data: await (typeof promiseOrFn === "function" ? promiseOrFn() : promiseOrFn), error: null };
  } catch (err) {
    console.error("dashboard panel query failed", { message: err.message });
    return { data: null, error: err.message || "failed to load" };
  }
}

export async function getSnapshotData(env, params) {
  const { store, resolvedEnv, anchor, envError } = await resolveEnv(env, params.env);
  const [openPositionsResult, closedPositionsResult, decisionStatsResult, exposureResult] = await Promise.all([
    safe(() => store.listOpenPositions({ limit: params.positionsLimit })),
    safe(() => store.listRecentlyClosedPositions({ limit: 20 })),
    safe(() => store.getDecisionStats({ days: params.activityDays, anchor })),
    safe(() => store.getOpenExposureTotal()),
  ]);
  // The stat grid is one combined panel drawn from all four queries, so a
  // failure in any of them is reported as one error for the section --
  // there's no meaningful way to show a "half stat grid".
  const error = openPositionsResult.error || closedPositionsResult.error || decisionStatsResult.error || exposureResult.error || null;
  return {
    openPositions: openPositionsResult.data ?? [],
    closedPositions: closedPositionsResult.data ?? [],
    decisionStats: decisionStatsResult.data ?? { daily: [], totals: {} },
    totalExposurePct: (exposureResult.data?.totalPct ?? 0) * 100,
    error,
    resolvedEnv,
    envError,
  };
}

export async function getActivityData(env, params) {
  const { store, resolvedEnv, anchor, envError } = await resolveEnv(env, params.env);
  const decisionStatsResult = await safe(() => store.getDecisionStats({ days: params.activityDays, anchor }));
  return { decisionStats: decisionStatsResult.data ?? { daily: [], totals: {} }, error: decisionStatsResult.error, resolvedEnv, envError };
}

export async function getChartsData(env, params) {
  const { store, resolvedEnv, envError } = await resolveEnv(env, params.env);
  const openPositionsResult = await safe(() => store.listOpenPositions({ limit: params.positionsLimit }));
  let priceBarsByTicker = {};
  const error = openPositionsResult.error;
  if (!error) {
    const openPositions = openPositionsResult.data ?? [];
    const chartTickers = [...new Set(openPositions.map((p) => p.ticker))].slice(0, PRICE_CHART_TICKER_LIMIT);
    const entries = await Promise.all(
      chartTickers.map(async (ticker) => {
        // Price bars are shared market data, not scoped to an environment --
        // always INPUTS_DB regardless of which run's open positions picked
        // the ticker.
        const result = await safe(() => getRecentPriceBars(readOnly(env.INPUTS_DB), { ticker, limit: 30 }));
        return [ticker, result];
      })
    );
    // A single ticker's price-bar fetch failing shouldn't blank the whole
    // grid -- skip that cell rather than erroring the whole Charts section.
    priceBarsByTicker = Object.fromEntries(
      entries.filter(([, result]) => !result.error).map(([ticker, result]) => [ticker, result.data])
    );
  }
  return { priceBarsByTicker, error, resolvedEnv, envError };
}

export async function getHealthData(env) {
  const healthResult = await safe(() => getIngestionHealth(readOnly(env.INPUTS_DB)));
  return { health: healthResult.data, error: healthResult.error };
}

export async function getDecisionsData(env, params) {
  const { store, resolvedEnv, envError } = await resolveEnv(env, params.env);
  const decisionsResult = await safe(() =>
    store.listRecentTradeDecisions({ limit: params.decisionLimit, status: params.decisionStatus === "all" ? undefined : params.decisionStatus })
  );
  return { decisions: decisionsResult.data ?? [], error: decisionsResult.error, resolvedEnv, envError };
}

export async function getPositionsData(env, params) {
  const { store, resolvedEnv, envError } = await resolveEnv(env, params.env);
  const [openPositionsResult, closedPositionsResult, exposureResult] = await Promise.all([
    safe(() => store.listOpenPositions({ limit: params.positionsLimit })),
    safe(() => store.listRecentlyClosedPositions({ limit: 20 })),
    safe(() => store.getOpenExposureTotal()),
  ]);
  // Open and closed positions are two sub-panels on one page that must fail
  // independently -- each gets its own error, not one shared one. The
  // exposure aggregate failing folds into the open-positions error, since
  // the exposure gauge lives in that same sub-panel.
  return {
    openPositions: openPositionsResult.data ?? [],
    openPositionsError: openPositionsResult.error || exposureResult.error || null,
    closedPositions: closedPositionsResult.data ?? [],
    closedPositionsError: closedPositionsResult.error,
    totalExposurePct: (exposureResult.data?.totalPct ?? 0) * 100,
    resolvedEnv,
    envError,
  };
}

export async function getPipelineData(env, params = {}) {
  const { store, resolvedEnv, envError } = await resolveEnv(env, params.env);
  const checkpointsResult = await safe(() => store.listRecentCheckpoints({ limit: 30 }));
  return { checkpoints: checkpointsResult.data ?? [], error: checkpointsResult.error, resolvedEnv, envError };
}

/**
 * Composes getSnapshotData + getHealthData + getPipelineData + the single
 * latest trade decision (getDecisionsData with decisionLimit 1) for the
 * Overview command-center page -- REUSES those four functions rather than
 * re-reading D1 (plan.md "Dashboard: Scoped UX Adoption" item 5). The
 * prototype's mock data assumed two computed fields the real rows don't
 * carry, added here (not in the renderer, so the view stays a pure template):
 *   - health.<source>.fresh: same staleness rule healthRow() already applies
 *     (helpers.js), lastIngestedAt vs STALE_INGESTION_HOURS (26h) -- missing
 *     lastIngestedAt counts as stale, same default healthRow uses.
 *   - checkpoint.status ('ok' | 'stale') and checkpoint.lastStageLabel (the
 *     raw `stage` value humanized, e.g. "exit_check" -> "Exit Check"), from
 *     `updated_at` vs PIPELINE_STALE_HOURS (2h -- see helpers.js's own
 *     comment on why this is a much tighter window than ingestion staleness).
 *     There is no per-checkpoint failure signal recorded anywhere upstream,
 *     so 'error' is not produced despite being a plausible third status --
 *     only 'ok'/'stale' are real today; a checkpoint that simply stops
 *     appearing is what a crashed run looks like here (see pipeline.js's
 *     own note).
 *
 * resolveEnv is invoked three times internally (once inside each of
 * getSnapshotData/getPipelineData/getDecisionsData) rather than once shared --
 * a small registry-lookup duplication, not a duplicated PANEL read, which is
 * what this function's contract actually promises. resolvedEnv/envError are
 * read off getSnapshotData's result; all three calls resolve identically for
 * a given `params.env` so this is just picking one, not preferring it.
 *
 * Each composed section keeps its OWN error (snapshotError/healthError/
 * pipelineError/latestDecisionError) rather than folding into one shared
 * error the way getSnapshotData's stat-grid does -- Overview's panels are
 * independent widgets on one page (alert strip, stat cards, pipeline pulse,
 * latest-decision panel), so one panel's failure shouldn't blank the others.
 */
export async function getOverviewData(env, params) {
  const [snapshot, health, pipelineResult, latestDecisionResult] = await Promise.all([
    getSnapshotData(env, params),
    getHealthData(env),
    getPipelineData(env, params),
    getDecisionsData(env, { ...params, decisionLimit: 1, decisionStatus: "all" }),
  ]);

  const now = Date.now();
  const withFresh = (stat) => ({
    ...stat,
    fresh: Boolean(stat?.lastIngestedAt) && now - new Date(stat.lastIngestedAt).getTime() <= STALE_INGESTION_HOURS * 3600 * 1000,
  });
  const healthWithFresh = health.health
    ? { news: withFresh(health.health.news), priceBars: withFresh(health.health.priceBars), fundamentals: withFresh(health.health.fundamentals) }
    : null;

  const humanizeStage = (stage) => (stage ? String(stage).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "Unknown");
  const checkpointsWithStatus = pipelineResult.checkpoints.map((c) => {
    const stale = !c.updated_at || now - new Date(c.updated_at).getTime() > PIPELINE_STALE_HOURS * 3600 * 1000;
    return { ...c, status: stale ? "stale" : "ok", lastStageLabel: humanizeStage(c.stage) };
  });

  return {
    openPositions: snapshot.openPositions,
    closedPositions: snapshot.closedPositions,
    decisionStats: snapshot.decisionStats,
    totalExposurePct: snapshot.totalExposurePct,
    snapshotError: snapshot.error,
    health: healthWithFresh,
    healthError: health.error,
    checkpoints: checkpointsWithStatus,
    pipelineError: pipelineResult.error,
    latestDecision: latestDecisionResult.decisions[0] ?? null,
    latestDecisionError: latestDecisionResult.error,
    resolvedEnv: snapshot.resolvedEnv,
    envError: snapshot.envError ?? pipelineResult.envError ?? latestDecisionResult.envError ?? null,
  };
}

export async function getBacktestRunsData(env) {
  // The registry lives on SIM_DB (M3); the dashboard API never writes, so the handle is read-only.
  const backtestRunsResult = await safe(getRecentBacktestRuns(readOnly(env.SIM_DB), { limit: 10 }));
  return { backtestRuns: backtestRunsResult.data ?? [], error: backtestRunsResult.error };
}

/**
 * One backtest run for the trade-timeline page (GET /api/backtest-runs/:id): the
 * registry row (params, status, result -- whose `portfolio.series` is the daily
 * equity data the chart draws) plus every position of that run with the
 * decision that opened it and its realized return.
 *
 * `run` is null both when the id is unknown AND when the registry lookup threw;
 * `error` tells them apart (null = simply not found), so the route can answer
 * 404 vs 500. A failing positions query does NOT null the run: the summary and
 * equity curve still render, with `positionsError` shown in the table's place.
 * `id` must already be BACKTEST_ID_RE-shaped (the route checks) -- this never
 * falls back to 'live' the way resolveEnv does, because "show me live instead"
 * would be a wrong answer for a page that is about one specific run.
 *
 * `realizedReturn` is computed here (shared/returns.js, the same function
 * graph/settle.js records reflections with) and is null for a position that is
 * still open or has no exit price -- never a guess.
 */
export async function getBacktestRunDetailData(env, id, { positionsLimit = 500 } = {}) {
  const db = readOnly(env.SIM_DB);
  const { data: run, error } = await safe(() => getBacktestRun(db, id));
  if (error || !run) return { run: null, positions: [], positionsError: null, truncated: false, error: error ?? null };

  const positionsResult = await safe(() => new RunStore(db, id).listPositionsWithDecisions({ limit: positionsLimit }));
  const positions = (positionsResult.data?.positions ?? []).map((p) => ({ ...p, realizedReturn: computeRealizedReturn(p) }));
  return { run, positions, positionsError: positionsResult.error, truncated: positionsResult.data?.truncated ?? false, error: null };
}

/** LLM-call log page: newest-first list (previews only) under the page's filters. `params` is helpers.js#parseLlmParams's output. */
export async function getLlmCallsData(env, params) {
  const { store, resolvedEnv, envError } = await resolveEnv(env, params.env);
  const result = await safe(() =>
    store.getRecentLlmCalls({
      limit: params.llmLimit,
      source: params.llmSource === "all" ? undefined : params.llmSource,
      status: params.llmStatus === "all" ? undefined : params.llmStatus,
      ticker: params.llmTicker || undefined,
      jobId: params.llmJob || undefined,
      runId: params.llmRun || undefined,
      beforeId: params.llmBefore ?? undefined,
    })
  );
  return { calls: result.data?.calls ?? [], nextBeforeId: result.data?.nextBeforeId ?? null, error: result.error, resolvedEnv, envError };
}

/** One call in full: complete prompt, raw response, cascade attempts. `call` is null when the id doesn't exist (including: it exists, but under a different environment than `envParam` resolved to -- env_run_id-scoped, same as the list above). */
export async function getLlmCallData(env, id, envParam) {
  const { store, resolvedEnv, envError } = await resolveEnv(env, envParam);
  const result = await safe(() => store.getLlmCall(id));
  return { call: result.data, error: result.error, resolvedEnv, envError };
}

export { parseDashboardParams };
