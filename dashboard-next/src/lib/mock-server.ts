// Mock server — returns mock data for each /api/* endpoint when BACKEND_URL
// is unset. Lives on the server side (Next.js Route Handlers) so the same
// client-side fetch code works in both mock and real modes.

import {
  OPEN_POSITIONS,
  CLOSED_POSITIONS,
  DECISION_STATS,
  TOTAL_EXPOSURE_PCT,
  TRADE_DECISIONS,
  PIPELINE_CHECKPOINTS,
  TICKER_STAGES,
  BACKTEST_RUNS,
  LLM_CALLS,
  LLM_CALL_DETAIL,
  PAUSE_FLAGS,
  INGESTION_HEALTH,
  PRICE_BARS_BY_TICKER,
  ACTIVE_JOB,
  LAST_BACKFILL_JOB,
  LAST_PRICE_BACKFILL_JOB,
  ENVIRONMENTS,
  WATCHLIST,
  buildBacktestPositions,
} from "./mock-data";
import type {
  Position,
  TradeDecision,
  LlmCallPreview,
  LlmCallDetail,
  BacktestRun,
  PauseFlags,
  IngestionHealth,
  JobProgress,
} from "./types";

// Helpers local to mock mode
const STATUSES = ["opened", "rejected", "superseded", "held", "skipped_irrelevant"] as const;

function filterDecisions(params: URLSearchParams): TradeDecision[] {
  const status = params.get("decisionStatus") ?? "all";
  const limit = Number(params.get("decisionLimit") ?? 20);
  const ticker = params.get("decisionTicker");
  let out = TRADE_DECISIONS;
  if (status !== "all") out = out.filter((d) => d.status === status);
  if (ticker) out = out.filter((d) => d.ticker === ticker);
  return out.slice(0, limit);
}

function filterLlmCalls(params: URLSearchParams): { calls: LlmCallPreview[]; nextBeforeId: number | null } {
  const source = params.get("llmSource") ?? "all";
  const status = params.get("llmStatus") ?? "all";
  const limit = Number(params.get("llmLimit") ?? 50);
  const ticker = params.get("llmTicker");
  let out = LLM_CALLS;
  if (source !== "all") out = out.filter((c) => c.source === source);
  if (status !== "all") out = out.filter((c) => c.status === status);
  if (ticker) out = out.filter((c) => c.ticker === ticker);
  return { calls: out.slice(0, limit), nextBeforeId: null };
}

/**
 * Match a request path against the mock server. Returns `null` when no
 * matching mock handler exists (caller should 404).
 *
 * The path passed in is the path AFTER the `/api/` directory prefix has been
 * stripped by Next.js (since this code lives at `src/app/api/[...path]/route.ts`).
 * So a request to `/api/overview` arrives here as path `/overview`.
 */
export function mockResolve(
  method: string,
  path: string,
  params: URLSearchParams,
  body: Record<string, unknown> | null,
): { status: number; body: unknown; headers?: Record<string, string> } | null {
  // Strip trailing slash
  const p = path.replace(/\/$/, "");

  // GET endpoints
  if (method === "GET") {
    if (p === "/overview") {
      const latestDecision = TRADE_DECISIONS[0] ?? null;
      return {
        status: 200,
        body: {
          openPositions: OPEN_POSITIONS,
          closedPositions: CLOSED_POSITIONS.slice(0, 20),
          decisionStats: DECISION_STATS,
          totalExposurePct: TOTAL_EXPOSURE_PCT,
          snapshotError: null,
          health: INGESTION_HEALTH,
          healthError: null,
          checkpoints: PIPELINE_CHECKPOINTS,
          pipelineError: null,
          latestDecision,
          latestDecisionError: null,
          resolvedEnv: "live",
          envError: null,
        },
      };
    }
    if (p === "/snapshot") {
      return {
        status: 200,
        body: {
          openPositions: OPEN_POSITIONS,
          closedPositions: CLOSED_POSITIONS.slice(0, 20),
          decisionStats: DECISION_STATS,
          totalExposurePct: TOTAL_EXPOSURE_PCT,
          error: null,
          resolvedEnv: "live",
          envError: null,
        },
      };
    }
    if (p === "/activity") {
      return {
        status: 200,
        body: { decisionStats: DECISION_STATS, error: null, resolvedEnv: "live", envError: null },
      };
    }
    if (p === "/charts") {
      return {
        status: 200,
        body: { priceBarsByTicker: PRICE_BARS_BY_TICKER, error: null, resolvedEnv: "live", envError: null },
      };
    }
    if (p === "/health") {
      return { status: 200, body: { health: INGESTION_HEALTH, error: null } };
    }
    if (p === "/decisions") {
      const decisions = filterDecisions(params);
      return {
        status: 200,
        body: {
          decisions,
          error: null,
          resolvedEnv: "live",
          envError: null,
        },
      };
    }
    if (p === "/positions") {
      return {
        status: 200,
        body: {
          openPositions: OPEN_POSITIONS,
          openPositionsError: null,
          closedPositions: CLOSED_POSITIONS.slice(0, 20),
          closedPositionsError: null,
          totalExposurePct: TOTAL_EXPOSURE_PCT,
          resolvedEnv: "live",
          envError: null,
        },
      };
    }
    if (p === "/pipeline") {
      return {
        status: 200,
        body: {
          checkpoints: PIPELINE_CHECKPOINTS,
          tickerStages: TICKER_STAGES,
          error: null,
          resolvedEnv: "live",
          envError: null,
        },
      };
    }
    if (p === "/llm-calls") {
      const { calls, nextBeforeId } = filterLlmCalls(params);
      return {
        status: 200,
        body: { calls, nextBeforeId, error: null, resolvedEnv: "live", envError: null },
      };
    }
    if (p.startsWith("/llm-calls/")) {
      const idStr = p.slice("/api/llm-calls/".length);
      const id = Number(idStr);
      if (!Number.isFinite(id)) return { status: 400, body: { error: "llm call id must be a number" } };
      if (LLM_CALL_DETAIL.id !== id) {
        // For mock mode, return the one detail we have regardless (or 404)
        return { status: 404, body: { error: "llm call not found (mock mode has only one detail)" } };
      }
      return { status: 200, body: { ...LLM_CALL_DETAIL, resolvedEnv: "live", envError: null } };
    }
    if (p === "/backtest-runs") {
      return {
        status: 200,
        body: { backtestRuns: BACKTEST_RUNS, error: null, replayJobs: [], replayError: null },
      };
    }
    if (p.startsWith("/backtest-runs/")) {
      const id = p.slice("/api/backtest-runs/".length);
      const run = BACKTEST_RUNS.find((r) => r.id === id);
      if (!run) return { status: 404, body: { error: "backtest run not found" } };
      const positions = buildBacktestPositions(id);
      return {
        status: 200,
        body: { run, positions, positionsError: null, truncated: false, error: null },
      };
    }
    if (p === "/jobs/active") {
      const type = params.get("type");
      if (type === "backtest") return { status: 200, body: { job: ACTIVE_JOB } };
      if (type === "backfill") return { status: 200, body: { job: null } };
      if (type === "backfill_prices") return { status: 200, body: { job: null } };
      if (type === "replay") return { status: 200, body: { job: null } };
      return { status: 400, body: { error: "type must be one of: backfill, backfill_prices, backtest, replay" } };
    }
    if (p === "/jobs/latest") {
      const type = params.get("type");
      if (type === "backfill") return { status: 200, body: { job: LAST_BACKFILL_JOB } };
      if (type === "backfill_prices") return { status: 200, body: { job: LAST_PRICE_BACKFILL_JOB } };
      return { status: 400, body: { error: "type must be: backfill or backfill_prices" } };
    }
    if (p.startsWith("/jobs/")) {
      // No real per-id job lookup in mock mode
      return { status: 404, body: { error: "job not found (mock mode)" } };
    }
    if (p === "/tickers") {
      return {
        status: 200,
        body: { tickers: WATCHLIST.map((w) => w.ticker), error: null, resolvedEnv: "live", envError: null },
      };
    }
    if (p === "/watchlist") {
      return { status: 200, body: { tickers: WATCHLIST.map((w) => w.ticker) } };
    }
    if (p === "/controls") {
      return { status: 200, body: PAUSE_FLAGS };
    }
    if (p === "/active-tickers") {
      return {
        status: 200,
        body: {
          watchlist: WATCHLIST.map((w) => w.ticker),
          active: WATCHLIST.map((w) => w.ticker),
          disabled: [],
          meta: {},
          error: null,
        },
      };
    }
    if (p === "/backtest/replay/news") {
      const ticker = (params.get("ticker") ?? "").toUpperCase();
      const date = params.get("date") ?? "";
      return {
        status: 200,
        body: {
          ticker,
          date,
          items: [
            { id: "mock-news-1", publishedAt: `${date}T13:05:00.000Z`, title: `${ticker} mock headline one` },
            { id: "mock-news-2", publishedAt: `${date}T15:40:00.000Z`, title: `${ticker} mock headline two` },
          ],
        },
      };
    }
    if (p === "/envs") {
      return { status: 200, body: { envs: ENVIRONMENTS } };
    }
    return null;
  }

  // POST endpoints — mock acknowledges with a fake id and 200 (no real side-effect)
  if (method === "POST") {
    if (p === "/backfill" || p === "/backfill-prices") {
      return {
        status: 200,
        body: { accepted: true, id: `mock-${Date.now()}`, ...(body ?? {}) },
      };
    }
    if (p === "/backtest/run") {
      return { status: 200, body: { accepted: true, id: `backtest-mock-${Date.now()}`, ...(body ?? {}) } };
    }
    if (p.match(/^\/backtest\/[^/]+\/(cancel|pause|resume)$/)) {
      return { status: 200, body: { accepted: true } };
    }
    if (p === "/backtest/cleanup" || p === "/backtest/purge") {
      return { status: 200, body: { accepted: true } };
    }
    if (p === "/backtest/replay/run") {
      return { status: 200, body: { accepted: true, id: `replay-mock-${Date.now()}`, ...(body ?? {}) } };
    }
    if (p === "/controls/set" || p === "/controls/tickers") {
      return { status: 200, body: { accepted: true } };
    }
    return null;
  }

  return null;
}

// Type-only re-exports for the BFF route to use
export type {
  Position,
  TradeDecision,
  LlmCallPreview,
  LlmCallDetail,
  BacktestRun,
  PauseFlags,
  IngestionHealth,
  JobProgress,
};
