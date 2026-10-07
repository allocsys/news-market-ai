// Type definitions matching the news-market-ai dashboard API shapes.
// These mirror the JSON returned by the /api/* endpoints documented in
// src/dashboard/api.js of the original Cloudflare Workers project.

export type Direction = "long" | "short" | "neutral";
export type EnvId = "live" | string; // "live" or "backtest-<ms>-<base36>"

export type TradeDecisionStatus =
  | "opened"
  | "rejected"
  | "superseded"
  | "skipped_no_price_data"
  | "held"
  | "pending_entry"
  | "skipped_no_fill"
  | "skipped_irrelevant";

export type BacktestStatus =
  | "running"
  | "paused"
  | "complete"
  | "failed"
  | "cancelled";

export type PauseReason =
  | "operator"
  | "d1_write_budget"
  | "gemini_daily_cap"
  | "platform_limit"
  | "quota_threshold";

export type CloseReason =
  | "take_profit"
  | "stop_loss"
  | "flipped"
  | "replaced"
  | "time_based"
  | "breakeven_stop"
  | "trailing_stop"
  | string;

export interface Position {
  ticker: string;
  direction: Direction | null;
  positionSizePct: number; // fraction, 0.05 = 5%
  entryPrice: number | null;
  maePct: number | null;
  mfePct: number | null;
  openedAt: string;
  // closed-only fields:
  exitPrice?: number | null;
  realizedReturn?: number | null;
  grossReturn?: number | null;
  returnIsNet?: boolean;
  closedAt?: string;
  closeReason?: CloseReason;
}

export interface AnalystOpinion {
  agent: "news_event" | "sentiment" | "price_impact" | "technical";
  summary: string;
  justification: string;
  eventType?: string | null;
  sentiment?: string | null;
}

export interface DebateSide {
  argument: string;
  justification: string;
}

export interface Debate {
  bull: DebateSide;
  bear: DebateSide;
  direction: Direction;
  confidence: number; // 0..1
  timeHorizon: string;
  justification: string;
}

export interface Thesis {
  direction: Direction;
  instrument: string | null;
  rationale: string | null;
  timeHorizon: string | null;
}

export interface TradeDecision {
  ticker: string;
  status: TradeDecisionStatus;
  thesis: Thesis;
  portfolioDecision: { reason: string };
  riskDecision: { positionSizePct: number; reason: string };
  opinions: AnalystOpinion[];
  debate: Debate;
  createdAt: string;
}

export interface LlmCallPreview {
  id: number;
  ticker: string | null;
  label: string;
  source: "pipeline" | "backtest" | "exit_check" | "replay";
  status: "ok" | "error";
  modelUsed: string | null;
  requestedModel: string | null;
  durationMs: number | null;
  createdAt: string;
  promptPreview: string;
  responsePreview: string | null;
  error: string | null;
  errorStage: string | null;
}

export interface LlmCascadeAttempt {
  model: string;
  keyIndex: number | null;
  outcome: "ok" | "skipped" | "error";
  status: string | null;
  detail: string;
}

export interface LlmCallDetail extends LlmCallPreview {
  keyIndex: number | null;
  promptChars: number;
  responseChars: number;
  runId: string | null;
  jobId: string | null;
  prompt: string;
  response: string | null;
  truncated: boolean;
  attempts: LlmCascadeAttempt[];
}

export interface PipelineCheckpoint {
  ticker: string;
  stage: string;
  updated_at: string;
  status?: "ok" | "stale";
  lastStageLabel?: string;
}

export interface TickerStageRow {
  ticker: string;
  stage: string;
  count: number;
  updated_at: string;
}

export interface BacktestMetrics {
  cumulativeReturn: number; // fraction
  sharpeRatio: number;
  winRate: number; // fraction
  maxDrawdown: number; // fraction (negative)
}

export interface BacktestResult {
  overall: { on: BacktestMetrics; off: BacktestMetrics; delta: BacktestMetrics };
  perWindow?: unknown[];
  portfolio: {
    method: string;
    days: number;
    from: string;
    to: string;
    tickers: string[];
    on: {
      avgExposure: number;
      positionsTraded: number;
      positionsIgnored: number;
      openAtSpanEnd: number;
    };
    series: { dates: string[]; on: number[]; off: number[] };
  };
  gate: {
    n: number;
    mean: number;
    lowerBound: number;
    costBps: number;
    openAtEnd: number | null;
    unreplayable: number | null;
  } | null;
}

export interface BacktestRun {
  id: string;
  status: BacktestStatus;
  tickers: string[];
  testStart: string;
  testEnd: string;
  error: string | null;
  pausedReason?: PauseReason;
  pausedAt?: string;
  resumeAfter?: string | null;
  result?: BacktestResult;
}

export interface PauseFlags {
  flags: { ingestion: boolean; trading: boolean; llm: boolean; backtests: boolean };
  meta: {
    ingestion: { updatedAt: string | null; updatedBy: string | null };
    trading: { updatedAt: string | null; updatedBy: string | null };
    llm: { updatedAt: string | null; updatedBy: string | null };
    backtests: { updatedAt: string | null; updatedBy: string | null };
  };
  error: string | null;
}

export interface IngestionHealthSource {
  count: number;
  lastIngestedAt: string | null;
  fresh?: boolean;
}

export interface IngestionHealth {
  news: IngestionHealthSource | null;
  priceBars: IngestionHealthSource | null;
  fundamentals: IngestionHealthSource | null;
  /** XAUUSD macro observations (FRED + COT). Absent on a backend that predates the macro feature. */
  macro?: IngestionHealthSource | null;
}

export interface PriceBar {
  close: number;
  date?: string;
}

export interface JobProgress {
  id: string;
  type: "backfill" | "backfill_prices" | "backtest" | "replay";
  status: "queued" | "running" | "complete" | "failed" | "cancelled";
  percent: number;
  done: number | null;
  total: number | null;
  phase: string;
  detail: string;
  error: string | null;
  params: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  stale: boolean;
}

export interface DecisionDailyBucket {
  day: string;
  status: string;
  count: number;
}

export interface DecisionStats {
  daily: DecisionDailyBucket[];
  totals: Record<string, number>;
}
