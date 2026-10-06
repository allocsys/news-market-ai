"use client";

// Typed API client + TanStack Query hooks.
//
// Every fetch goes through this app's own /api/* routes (relative), which run
// in the same Worker: the session gate in server/gateway.mjs, then the private
// backend over the BACKEND service binding (or mock data in local dev when no
// backend is configured). The session cookie is attached automatically
// by the browser (same-origin).
//
// 401 responses trigger a redirect to /login via the global error handler.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  Position,
  TradeDecision,
  LlmCallPreview,
  LlmCallDetail,
  PipelineCheckpoint,
  TickerStageRow,
  BacktestRun,
  PauseFlags,
  IngestionHealth,
  JobProgress,
  DecisionStats,
  PriceBar,
  EnvId,
} from "./types";

// ============================================================
// Low-level fetch wrapper
// ============================================================
class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin", // send our session cookie
    headers: {
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });

  if (res.status === 401) {
    // Redirect to login — the global auth provider will pick this up too,
    // but doing it here keeps individual queries from each having to handle it.
    if (typeof window !== "undefined" && window.location.pathname !== "/login") {
      window.location.href = "/login?from=" + encodeURIComponent(window.location.pathname + window.location.search);
    }
    throw new ApiError("unauthorized", 401);
  }

  // Every non-2xx is an error, 400 included: the Worker answers validation
  // failures ({ error }) with a 400, and a write that resolved "successfully"
  // on one would show a false success toast.
  if (!res.ok) {
    let msg = `request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {
      /* not JSON */
    }
    throw new ApiError(msg, res.status);
  }

  // 200 with empty body? return null
  const text = await res.text();
  if (!text) return null as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

// ============================================================
// Response shapes — match the original /api/* contract
// ============================================================
export interface OverviewResponse {
  openPositions: Position[];
  closedPositions: Position[];
  decisionStats: DecisionStats;
  totalExposurePct: number;
  snapshotError: string | null;
  health: IngestionHealth | null;
  healthError: string | null;
  checkpoints: PipelineCheckpoint[];
  pipelineError: string | null;
  latestDecision: TradeDecision | null;
  latestDecisionError: string | null;
  resolvedEnv: EnvId;
  envError: string | null;
}

export interface SnapshotResponse {
  openPositions: Position[];
  closedPositions: Position[];
  decisionStats: DecisionStats;
  totalExposurePct: number;
  error: string | null;
  resolvedEnv: EnvId;
  envError: string | null;
}

export interface ActivityResponse {
  decisionStats: DecisionStats;
  error: string | null;
  resolvedEnv: EnvId;
  envError: string | null;
}

export interface ChartsResponse {
  priceBarsByTicker: Record<string, PriceBar[]>;
  error: string | null;
  resolvedEnv: EnvId;
  envError: string | null;
}

export interface HealthResponse {
  health: IngestionHealth;
  error: string | null;
}

export interface DecisionsResponse {
  decisions: TradeDecision[];
  error: string | null;
  resolvedEnv: EnvId;
  envError: string | null;
}

export interface PositionsResponse {
  openPositions: Position[];
  openPositionsError: string | null;
  closedPositions: Position[];
  closedPositionsError: string | null;
  totalExposurePct: number;
  resolvedEnv: EnvId;
  envError: string | null;
}

export interface PipelineResponse {
  checkpoints: PipelineCheckpoint[];
  tickerStages: TickerStageRow[];
  error: string | null;
  resolvedEnv: EnvId;
  envError: string | null;
}

export interface LlmCallsResponse {
  calls: LlmCallPreview[];
  nextBeforeId: number | null;
  error: string | null;
  resolvedEnv: EnvId;
  envError: string | null;
}

export interface BacktestRunsResponse {
  backtestRuns: BacktestRun[];
  error: string | null;
  replayJobs: JobProgress[];
  replayError: string | null;
}

export interface BacktestRunDetailResponse {
  run: BacktestRun | null;
  positions: Position[];
  positionsError: string | null;
  truncated: boolean;
  error: string | null;
  activeJob?: JobProgress | null;
}

export interface JobResponse {
  job: JobProgress | null;
  error?: string;
}

// ============================================================
// Query hooks — one per view
// ============================================================

// Reusable 30s auto-refresh (matches the original dashboard's interval)
const REFRESH_MS = 30_000;

interface QueryOpts {
  env?: string;
  // Decisions
  decisionStatus?: string;
  decisionLimit?: number;
  // LLM
  llmSource?: string;
  llmStatus?: string;
  llmLimit?: number;
  llmTicker?: string;
  llmBefore?: number | null;
  // Activity
  activityDays?: number;
  // Positions
  positionsLimit?: number;
  // Jobs
  jobType?: "backfill" | "backfill_prices" | "backtest" | "replay";
}

function envParam(env?: string): string {
  if (!env || env === "live") return "";
  return `?env=${encodeURIComponent(env)}`;
}
function withEnv(env: string | undefined, extra: Record<string, string | number | undefined | null>): string {
  const params = new URLSearchParams();
  if (env && env !== "live") params.set("env", env);
  for (const [k, v] of Object.entries(extra)) {
    if (v == null || v === "") continue;
    params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

// --- Overview ---
export function useOverview(env?: string) {
  return useQuery({
    queryKey: ["overview", env ?? "live"],
    queryFn: () => apiFetch<OverviewResponse>(`/api/overview${envParam(env)}`),
    refetchInterval: REFRESH_MS,
    retry: 1,
  });
}

// --- Snapshot ---
export function useSnapshot(env?: string) {
  return useQuery({
    queryKey: ["snapshot", env ?? "live"],
    queryFn: () => apiFetch<SnapshotResponse>(`/api/snapshot${envParam(env)}`),
    refetchInterval: REFRESH_MS,
    retry: 1,
  });
}

// --- Activity ---
export function useActivity(env?: string, days: number = 14) {
  return useQuery({
    queryKey: ["activity", env ?? "live", days],
    queryFn: () =>
      apiFetch<ActivityResponse>(`/api/activity${withEnv(env, { activityDays: days })}`),
    refetchInterval: REFRESH_MS,
    retry: 1,
  });
}

// --- Charts ---
export function useCharts(env?: string) {
  return useQuery({
    queryKey: ["charts", env ?? "live"],
    queryFn: () => apiFetch<ChartsResponse>(`/api/charts${envParam(env)}`),
    refetchInterval: REFRESH_MS,
    retry: 1,
  });
}

// --- Health ---
export function useHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: () => apiFetch<HealthResponse>(`/api/health`),
    refetchInterval: REFRESH_MS,
    retry: 1,
  });
}

// --- Decisions ---
export function useDecisions(opts: QueryOpts = {}) {
  const { env, decisionStatus, decisionLimit } = opts;
  return useQuery({
    queryKey: ["decisions", env ?? "live", decisionStatus ?? "all", decisionLimit ?? 20],
    queryFn: () =>
      apiFetch<DecisionsResponse>(
        `/api/decisions${withEnv(env, {
          decisionStatus: decisionStatus === "all" ? undefined : decisionStatus,
          decisionLimit,
        })}`,
      ),
    refetchInterval: REFRESH_MS,
    retry: 1,
  });
}

// --- Positions ---
export function usePositions(env?: string, limit: number = 50) {
  return useQuery({
    queryKey: ["positions", env ?? "live", limit],
    queryFn: () =>
      apiFetch<PositionsResponse>(`/api/positions${withEnv(env, { positionsLimit: limit })}`),
    refetchInterval: REFRESH_MS,
    retry: 1,
  });
}

// --- Pipeline ---
export function usePipeline(env?: string) {
  return useQuery({
    queryKey: ["pipeline", env ?? "live"],
    queryFn: () => apiFetch<PipelineResponse>(`/api/pipeline${envParam(env)}`),
    refetchInterval: REFRESH_MS,
    retry: 1,
  });
}

// --- LLM calls list ---
export function useLlmCalls(opts: QueryOpts = {}) {
  const { env, llmSource, llmStatus, llmLimit, llmTicker, llmBefore } = opts;
  return useQuery({
    queryKey: [
      "llm-calls",
      env ?? "live",
      llmSource ?? "all",
      llmStatus ?? "all",
      llmLimit ?? 50,
      llmTicker ?? "",
      llmBefore ?? null,
    ],
    queryFn: () =>
      apiFetch<LlmCallsResponse>(
        `/api/llm-calls${withEnv(env, {
          llmSource: llmSource === "all" ? undefined : llmSource,
          llmStatus: llmStatus === "all" ? undefined : llmStatus,
          llmLimit,
          llmTicker,
          llmBefore,
        })}`,
      ),
    refetchInterval: REFRESH_MS,
    retry: 1,
  });
}

// --- LLM call detail ---
export function useLlmCallDetail(id: number | null, env?: string) {
  return useQuery({
    queryKey: ["llm-call", id, env ?? "live"],
    queryFn: () => {
      if (id == null) return null;
      return apiFetch<LlmCallDetail & { resolvedEnv: EnvId; envError: string | null }>(
        `/api/llm-calls/${id}${envParam(env)}`,
      );
    },
    enabled: id != null,
    retry: 1,
  });
}

// --- Backtest runs ---
export function useBacktestRuns() {
  return useQuery({
    queryKey: ["backtest-runs"],
    queryFn: () => apiFetch<BacktestRunsResponse>(`/api/backtest-runs`),
    refetchInterval: REFRESH_MS,
    retry: 1,
  });
}

// --- Backtest run detail ---
export function useBacktestRunDetail(id: string | null) {
  return useQuery({
    queryKey: ["backtest-run", id],
    queryFn: () => {
      if (!id) return null;
      return apiFetch<BacktestRunDetailResponse>(`/api/backtest-runs/${id}`);
    },
    enabled: Boolean(id),
    // Poll while the run still has an in-flight job (progress bar), and once more after it ends so the final result replaces the bar.
    refetchInterval: (query) => (query.state.data?.activeJob ? 5_000 : false),
    retry: 1,
  });
}

// --- Active job (live progress panel) ---
export function useActiveJob(type: QueryOpts["jobType"], env?: string) {
  return useQuery({
    queryKey: ["job-active", type, env ?? "live"],
    queryFn: () => {
      if (!type) return { job: null };
      return apiFetch<JobResponse>(`/api/jobs/active${withEnv(env, { type })}`);
    },
    enabled: Boolean(type),
    refetchInterval: 5_000, // tight poll for live progress
    retry: 1,
  });
}

// --- Latest finished job (backfill page) ---
export function useLatestJob(type: "backfill" | "backfill_prices") {
  return useQuery({
    queryKey: ["job-latest", type],
    queryFn: () => apiFetch<JobResponse>(`/api/jobs/latest?type=${type}`),
    retry: 1,
  });
}

// --- Controls (pause flags) ---
export type ControlsResponse = PauseFlags;
export function useControls() {
  return useQuery({
    queryKey: ["controls"],
    queryFn: () => apiFetch<ControlsResponse>(`/api/controls`),
    refetchInterval: REFRESH_MS,
    retry: 1,
  });
}

// --- Tickers (search palette universe; env-aware) ---
export interface TickersResponse {
  tickers: string[];
  error: string | null;
  resolvedEnv: EnvId;
  envError: string | null;
}
export function useTickers(env?: string) {
  return useQuery({
    queryKey: ["tickers", env ?? "live"],
    queryFn: () => apiFetch<TickersResponse>(`/api/tickers${envParam(env)}`),
    staleTime: 60_000,
    retry: 1,
  });
}

// --- Watchlist (configured tickers, in order) ---
export interface WatchlistResponse {
  tickers: string[];
}
export function useWatchlist() {
  return useQuery({
    queryKey: ["watchlist"],
    queryFn: () => apiFetch<WatchlistResponse>(`/api/watchlist`),
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

// --- Live ticker selection (which watchlist tickers the live pipeline runs) ---
export interface ActiveTickersResponse {
  watchlist: string[];
  active: string[];
  disabled: string[];
  meta: Record<string, { updatedAt?: string | null; updatedBy?: string | null }>;
  error: string | null;
}
export function useActiveTickers() {
  return useQuery({
    queryKey: ["active-tickers"],
    queryFn: () => apiFetch<ActiveTickersResponse>(`/api/active-tickers`),
    refetchInterval: REFRESH_MS,
    retry: 1,
  });
}

// --- News replay: ingested news items for one ticker on one UTC day ---
export interface ReplayNewsItem {
  id: string;
  publishedAt: string | null;
  title: string | null;
}
export interface ReplayNewsResponse {
  ticker: string;
  date: string;
  items: ReplayNewsItem[];
}
export function useReplayNews(q: { ticker: string; date: string } | null) {
  return useQuery({
    queryKey: ["replay-news", q?.ticker ?? "", q?.date ?? ""],
    queryFn: () => {
      const qs = new URLSearchParams({ ticker: q!.ticker, date: q!.date });
      return apiFetch<ReplayNewsResponse>(`/api/backtest/replay/news?${qs.toString()}`);
    },
    enabled: q != null,
    staleTime: 60_000,
    retry: false,
  });
}

// ============================================================
// Mutations — POST endpoints
// ============================================================

export function useLogin() {
  return useMutation({
    mutationFn: async ({ username, password }: { username: string; password: string }) => {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
        credentials: "same-origin",
      });
      const body = await res.json().catch(() => ({ error: "invalid response" }));
      if (!res.ok) throw new Error(body?.error ?? `login failed (${res.status})`);
      return body as { ok: boolean; user?: { username: string }; mock?: boolean };
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
    },
    onSettled: () => {
      qc.clear();
      if (typeof window !== "undefined") window.location.href = "/login";
    },
  });
}

export function usePostBackfill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { from: string; to: string }) => {
      return apiFetch<{ accepted: boolean; id: string }>("/api/backfill", {
        method: "POST",
        body: JSON.stringify(vars),
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["job-active"] }),
  });
}

export function usePostBackfillPrices() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { from: string; to: string; tickers?: string[] }) => {
      return apiFetch<{ accepted: boolean; id: string }>("/api/backfill-prices", {
        method: "POST",
        body: JSON.stringify(vars),
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["job-active"] }),
  });
}

export function usePostBacktestRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      testStart: string;
      testEnd: string;
      tickers?: string[];
      enableLlmLog?: boolean;
      /** This run only: turn the price-impact gate off (gateway maps it to skipNoPriceImpact=0). */
      disableGate?: boolean;
    }) => {
      return apiFetch<{ accepted: boolean; id: string }>("/api/backtest/run", {
        method: "POST",
        body: JSON.stringify(vars),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["backtest-runs"] });
      qc.invalidateQueries({ queryKey: ["job-active"] });
    },
  });
}

export function usePostBacktestAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { id: string; action: "cancel" | "pause" | "resume" }) => {
      return apiFetch<{ accepted: boolean }>(`/api/backtest/${vars.id}/${vars.action}`, {
        method: "POST",
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["backtest-runs"] });
      qc.invalidateQueries({ queryKey: ["backtest-run"] });
      qc.invalidateQueries({ queryKey: ["job-active"] });
    },
  });
}

export function usePostControlsSet() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { key: string; paused: boolean }) => {
      return apiFetch<{ accepted: boolean }>("/api/controls/set", {
        method: "POST",
        body: JSON.stringify(vars),
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["controls"] }),
  });
}

export function usePostActiveTickers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { tickers: string[] }) => {
      return apiFetch<ActiveTickersResponse>("/api/controls/tickers", {
        method: "POST",
        body: JSON.stringify(vars),
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["active-tickers"] }),
  });
}

// Both maintenance routes are bounded per call and answer with counts; the
// shapes vary, so the result is read defensively by the caller.
export type MaintenanceResult = { accepted?: boolean } & Record<string, unknown>;

export function usePostBacktestCleanup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { olderThanDays: number }) => {
      return apiFetch<MaintenanceResult>("/api/backtest/cleanup", {
        method: "POST",
        body: JSON.stringify(vars),
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["backtest-runs"] }),
  });
}

export function usePostBacktestPurge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      return apiFetch<MaintenanceResult>("/api/backtest/purge", { method: "POST" });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["backtest-runs"] }),
  });
}

export function usePostReplayRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      ticker: string;
      newsItemIds: string[];
      asOf?: string;
      enableLlmLog?: boolean;
    }) => {
      return apiFetch<{ accepted: boolean; id: string }>("/api/backtest/replay/run", {
        method: "POST",
        body: JSON.stringify(vars),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["backtest-runs"] });
      qc.invalidateQueries({ queryKey: ["job-active"] });
    },
  });
}

export { ApiError };
