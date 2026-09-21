// Domain types for the news-market-ai dashboard prototype

export type ViewId =
  | "overview"
  | "snapshot"
  | "activity"
  | "charts"
  | "health"
  | "decisions"
  | "positions"
  | "pipeline"
  | "llm"
  | "backfill"
  | "backtest"
  | "settings";

export type DecisionStatus = "approved" | "rejected";
export type Direction = "long" | "short";
export type PositionStatus = "open" | "closed";
export type ExitReason = "target" | "stop" | "signal_off" | "timeout" | "manual";
export type LlmCallStatus = "ok" | "error";
export type LlmSource = "pipeline" | "backtest" | "exit_check";
export type JobStatus = "running" | "complete" | "failed" | "stale";
export type UserRole = "admin" | "operator" | "viewer";

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  initials: string;
  hue: string; // tailwind color class fragment e.g. "blue", "emerald"
  lastActive: string;
  twoFactor: boolean;
}

export interface AuditEntry {
  id: string;
  userId: string;
  username: string;
  action: string;
  target: string;
  at: string; // ISO
  ip: string;
}

export interface Ticker {
  symbol: string;
  name: string;
  price: number;
  changePct: number;
  currency: string;
  sparkline: number[];
}

export interface Decision {
  id: string;
  ticker: string;
  direction: Direction;
  status: DecisionStatus;
  sizePct: number;
  confidence: number;
  when: string; // ISO
  agent: string;
  reasoning: {
    analyst: { sentiment: "bullish" | "bearish" | "neutral"; note: string };
    bull: string;
    bear: string;
    verdict: string;
    trader: string;
  };
}

export interface Position {
  id: string;
  ticker: string;
  direction: Direction;
  sizePct: number;
  opened: string; // ISO
  closed: string | null;
  entry: number;
  exit: number | null;
  pnlPct: number | null;
  status: PositionStatus;
  exitReason?: ExitReason;
  basedOn: string; // decision id
}

export interface LlmCall {
  id: string;
  ticker: string;
  agent: string;
  source: LlmSource;
  status: LlmCallStatus;
  requestedModel: string;
  answeredBy: string;
  fellBackFrom?: string;
  tookMs: number;
  when: string; // ISO
  promptPreview: string;
  responsePreview: string;
  promptTokens: number;
  responseTokens: number;
  runId?: string;
  backtestId?: string;
  cascade: { model: string; key: string; outcome: "ok" | "error"; detail?: string }[];
}

export interface PipelineStage {
  stage: string;
  label: string;
  count: number;
  avgMs: number;
  lastAt: string;
}

export interface PipelineCheckpoint {
  ticker: string;
  lastStage: string;
  lastStageLabel: string;
  updatedAt: string;
  status: "ok" | "stale" | "error";
}

export interface IngestionSource {
  source: string;
  label: string;
  rows: number;
  lastIngested: string;
  fresh: boolean;
}

export interface BacktestRun {
  id: string;
  label?: string;
  tickers: string[];
  testStart: string;
  testEnd: string;
  graceDays: number;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  signalOnReturn: number;
  buyHoldReturn: number;
  winRate: number;
  tradesOpened: number;
  tradesClosed: number;
}

export interface BacktestTrade {
  id: string;
  ticker: string;
  direction: Direction;
  sizePct: number;
  opened: string;
  closed: string | null;
  entry: number;
  exit: number | null;
  pnlPct: number | null;
  closeReason: ExitReason | "still_open";
  basedOn: string;
  why: string;
}

export interface EquityPoint {
  date: string;
  signal: number; // cumulative % with signal ON
  buyHold: number; // cumulative % buy & hold
}

export interface JobProgress {
  id: string;
  kind: "backfill_news" | "backfill_prices" | "backtest";
  status: JobStatus;
  phase: string;
  done: number;
  total: number;
  startedAt: string;
  updatedAt: string;
  triggeredBy: string;
}

export interface ActivityDay {
  date: string;
  approved: number;
  rejected: number;
}

export interface NavItem {
  id: ViewId;
  label: string;
  icon: string; // lucide icon name
  group: "monitor" | "ops" | "system";
  mobileNav?: boolean; // shown in mobile bottom bar
}
