// Shared structured I/O types -- the equivalent of TradingAgents' own
// schemas.py (plan.md Adopted Pattern #4). Every agent reads/writes against
// these instead of ad-hoc object shapes, so stages compose without
// prompt-string gluing and D1 rows can be validated on the way in and out.
//
// Every scored/classified type below carries a mandatory `justification`
// field (plan.md Adopted Pattern #5) -- critical for debugging a bad trade
// after the fact.

import { z } from "zod";

export const NormalizedNewsItem = z.object({
  id: z.string(),
  source: z.string(),
  url: z.string().url(),
  publishedAt: z.string(), // ISO8601 UTC -- exact public timestamp, not ingestion time
  ingestedAt: z.string(),
  tickers: z.array(z.string()),
  title: z.string(),
  body: z.string(),
  raw: z.unknown().optional(),
});

export const SentimentBand = z.enum([
  "strongly_negative",
  "negative",
  "neutral",
  "positive",
  "strongly_positive",
]);

export const AnalystOpinion = z.object({
  agent: z.enum(["news_event", "sentiment", "technical"]),
  newsItemId: z.string(),
  eventType: z.string().optional(),
  entities: z.array(z.string()).default([]),
  sentiment: SentimentBand.optional(),
  summary: z.string(),
  justification: z.string(),
  modelUsed: z.string().optional(),
});

export const DebateSide = z.object({
  stance: z.enum(["bull", "bear"]),
  argument: z.string(),
  justification: z.string(),
});

export const DebateVerdict = z.object({
  ticker: z.string(),
  asOf: z.string(),
  bull: DebateSide,
  bear: DebateSide,
  direction: z.enum(["long", "short", "flat"]),
  confidence: z.number().min(0).max(1),
  timeHorizon: z.enum(["intraday", "days", "weeks", "months"]),
  justification: z.string(),
});

export const TradeThesis = z.object({
  ticker: z.string(),
  asOf: z.string(),
  direction: z.enum(["long", "short", "flat"]),
  instrument: z.string(),
  rationale: z.string(),
  debateId: z.string().optional(),
});

// Deliberately has NO `justification` requirement tied to LLM reasoning --
// this is produced by deterministic rules (src/agents/risk_mgmt/risk.js),
// never an LLM call. `reason` documents which rule fired, not a model's
// free-text explanation.
export const RiskDecision = z.object({
  tradeThesisId: z.string(),
  approved: z.boolean(),
  positionSizePct: z.number().min(0).max(1),
  stopLossPct: z.number().min(0).optional(),
  takeProfitPct: z.number().min(0).optional(),
  reason: z.string(),
});
