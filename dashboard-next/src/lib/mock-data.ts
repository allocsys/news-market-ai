// Mock data layer for the news-market-ai dashboard redesign prototype.
// All shapes mirror the /api/* JSON documented in src/dashboard/api.js
// of the original Cloudflare Workers project. No backend is contacted.

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
  PriceBar,
  JobProgress,
  DecisionStats,
  EnvId,
} from "./types";

const NOW = Date.UTC(2026, 9, 6, 11, 32, 0); // 2026-10-06 11:32 UTC
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const isoAhead = (msAhead: number) => new Date(NOW + msAhead).toISOString();
const day = 24 * 60 * 60 * 1000;

export const NOW_ISO = new Date(NOW).toISOString();

// === Watchlist (drives ticker pickers) ===
export const WATCHLIST = [
  { ticker: "AAPL", query: "AAPL", group: "equity", name: "Apple Inc." },
  { ticker: "MSFT", query: "MSFT", group: "equity", name: "Microsoft Corp." },
  { ticker: "TSLA", query: "TSLA", group: "equity", name: "Tesla Inc." },
  { ticker: "USO", query: "USO", group: "energy", name: "US Oil Fund" },
  { ticker: "XAUUSD", query: "XAUUSD", group: "gold", name: "Gold spot" },
];

// === Risk ceilings (from shared/constants.js) ===
export const RISK_CEILINGS = {
  maxPortfolioRiskPct: 0.2, // 20% gross exposure
  maxPortfolioStopRiskPct: 0.0075, // 0.75% loss-at-stop
  maxGroupExposurePct: 0.1, // 10% per group
  fallbackStopLossPct: 0.03, // 3%
};

// === Open positions (Book) ===
export const OPEN_POSITIONS: Position[] = [
  {
    ticker: "AAPL",
    direction: "long",
    positionSizePct: 0.045,
    entryPrice: 226.34,
    maePct: -0.012,
    mfePct: 0.023,
    openedAt: iso(2 * day + 3 * 3600 * 1000),
  },
  {
    ticker: "MSFT",
    direction: "long",
    positionSizePct: 0.03,
    entryPrice: 415.78,
    maePct: -0.004,
    mfePct: 0.011,
    openedAt: iso(1 * day + 7 * 3600 * 1000),
  },
  {
    ticker: "TSLA",
    direction: "short",
    positionSizePct: 0.025,
    entryPrice: 248.92,
    maePct: 0.018, // adverse for a short is upward
    mfePct: -0.029,
    openedAt: iso(18 * 3600 * 1000),
  },
  {
    ticker: "XAUUSD",
    direction: "long",
    positionSizePct: 0.06,
    entryPrice: 2658.4,
    maePct: -0.005,
    mfePct: 0.008,
    openedAt: iso(3 * day + 2 * 3600 * 1000),
  },
];

// === Closed positions (Recent exits / Book) ===
export const CLOSED_POSITIONS: Position[] = [
  {
    ticker: "AAPL",
    direction: "long",
    positionSizePct: 0.04,
    entryPrice: 219.4,
    exitPrice: 232.1,
    maePct: -0.008,
    mfePct: 0.058,
    realizedReturn: 0.051,
    grossReturn: 0.058,
    returnIsNet: true,
    openedAt: iso(10 * day),
    closedAt: iso(2 * day),
    closeReason: "take_profit",
  },
  {
    ticker: "MSFT",
    direction: "long",
    positionSizePct: 0.03,
    entryPrice: 410.2,
    exitPrice: 418.7,
    maePct: -0.011,
    mfePct: 0.022,
    realizedReturn: 0.018,
    grossReturn: 0.021,
    returnIsNet: true,
    openedAt: iso(8 * day),
    closedAt: iso(3 * day),
    closeReason: "trailing_stop",
  },
  {
    ticker: "TSLA",
    direction: "short",
    positionSizePct: 0.025,
    entryPrice: 252.4,
    exitPrice: 256.1,
    maePct: 0.022,
    mfePct: -0.014,
    realizedReturn: -0.017,
    grossReturn: -0.015,
    returnIsNet: true,
    openedAt: iso(7 * day),
    closedAt: iso(4 * day),
    closeReason: "stop_loss",
  },
  {
    ticker: "USO",
    direction: "long",
    positionSizePct: 0.035,
    entryPrice: 78.2,
    exitPrice: 80.05,
    maePct: -0.006,
    mfePct: 0.028,
    realizedReturn: 0.019,
    grossReturn: 0.024,
    returnIsNet: true,
    openedAt: iso(12 * day),
    closedAt: iso(5 * day),
    closeReason: "time_based",
  },
  {
    ticker: "XAUUSD",
    direction: "long",
    positionSizePct: 0.05,
    entryPrice: 2632.0,
    exitPrice: 2651.8,
    maePct: -0.009,
    mfePct: 0.018,
    realizedReturn: 0.005,
    grossReturn: 0.008,
    returnIsNet: true,
    openedAt: iso(15 * day),
    closedAt: iso(6 * day),
    closeReason: "take_profit",
  },
  {
    ticker: "AAPL",
    direction: "short",
    positionSizePct: 0.02,
    entryPrice: 231.5,
    exitPrice: 228.9,
    maePct: 0.014,
    mfePct: -0.022,
    realizedReturn: 0.008,
    grossReturn: 0.011,
    returnIsNet: true,
    openedAt: iso(20 * day),
    closedAt: iso(9 * day),
    closeReason: "flipped",
  },
];

export const TOTAL_EXPOSURE_PCT = OPEN_POSITIONS.reduce(
  (sum, p) => sum + (p.positionSizePct || 0),
  0,
);

// === Decision stats (Activity + Overview) ===
function buildDecisionStats(): DecisionStats {
  const statuses = ["opened", "rejected", "superseded", "held", "skipped_irrelevant"] as const;
  const daily: { day: string; status: string; count: number }[] = [];
  for (let d = 30; d >= 0; d--) {
    const date = new Date(NOW - d * day);
    const pad = (n: number) => String(n).padStart(2, "0");
    const dayStr = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
    for (const status of statuses) {
      const seed = (d + status.length) % 7;
      const count = status === "opened" ? 2 + (seed % 4) : status === "rejected" ? 1 + (seed % 3) : seed % 2;
      if (count > 0) daily.push({ day: dayStr, status, count });
    }
  }
  const totals = daily.reduce<Record<string, number>>((acc, d) => {
    acc[d.status] = (acc[d.status] ?? 0) + d.count;
    return acc;
  }, {});
  return { daily, totals };
}

export const DECISION_STATS = buildDecisionStats();

// === Trade decisions (Decisions / Signals) ===
const SAMPLE_OPINIONS = [
  {
    agent: "news_event" as const,
    summary:
      "Apple announced a new on-device AI model line at its 2026 fall event, with deeper Siri integration and broader language support.",
    justification:
      "The launch broadens the install base for AI services and is likely to drive services revenue in 2027. Press cycle is broadly positive; no regulatory overhang flagged in the article.",
    eventType: "product_launch",
  },
  {
    agent: "sentiment" as const,
    summary:
      "Press tone is strongly positive (4/5). Tech press and analyst notes lead with upgrades; sell-side price targets lifted median by ~3%.",
    justification:
      "Five-band classifier returns 'positive-4'. No contradiction between headline tone and analyst commentary. Social signal omitted (volume below threshold).",
    sentiment: "positive-4",
  },
  {
    agent: "price_impact" as const,
    summary:
      "Direct price impact expected — channel is 'product_launch', direction 'up', confidence 0.78.",
    justification:
      "Last 3 comparable Apple launches produced a +1.2% to +3.5% same-week move. No split or guidance update in the article that would dilute the signal.",
  },
  {
    agent: "technical" as const,
    summary:
      "AAPL closed above its 20-day MA with rising 14-day RSI (62). Volume +18% vs 30-day mean.",
    justification:
      "Trend is up; momentum confirms. No bearish divergence on the daily. Stop can sit below the 20-day MA at ~219.4.",
  },
];

const SAMPLE_DEBATE = {
  bull: {
    argument:
      "Product cycle is real and tied to revenue. Services attach lifts gross margin over 2-3 quarters. No regulatory or supply-chain overhang in the article.",
    justification:
      "Cited the same-week move on prior launches and the median sell-side target lift (~3%). Risk-reward favours a long.",
  },
  bear: {
    argument:
      "Hardware launch price moves tend to fade within 5 trading days. Services revenue uplift is back-loaded and may already be in the price after the recent +6% run.",
    justification:
      "The 14-day RSI at 62 plus a +6% five-day move leaves limited near-term room. A failure to hold 226 would invalidate the structure.",
  },
  direction: "long" as const,
  confidence: 0.78,
  timeHorizon: "5-10 trading days",
  justification:
    "The bull case rests on a real product cycle with revenue follow-through; the bear case is mostly about entry timing. Net: open a small long with a tight stop.",
};

export const TRADE_DECISIONS: TradeDecision[] = [
  {
    ticker: "AAPL",
    status: "opened",
    thesis: {
      direction: "long",
      instrument: "AAPL",
      rationale:
        "On-device AI launch broadens the install base and lifts services revenue. Trend and momentum confirm; enter on the break above 226 with a stop below the 20-day MA.",
      timeHorizon: "5-10 trading days",
    },
    portfolioDecision: { reason: "Within gross exposure ceiling (4.5% of 20%); group equity at 7.5% of 10% cap." },
    riskDecision: { positionSizePct: 0.045, reason: "ATR-based stop at 2.6% → 0.75% loss-at-stop, within ceiling." },
    opinions: SAMPLE_OPINIONS,
    debate: SAMPLE_DEBATE,
    createdAt: iso(2 * day + 3 * 3600 * 1000),
  },
  {
    ticker: "TSLA",
    status: "opened",
    thesis: {
      direction: "short",
      instrument: "TSLA",
      rationale:
        "Delivery miss vs consensus, with inventory build cited. RSI broke below 50 on rising volume. Short into the gap with a stop above 252.4.",
      timeHorizon: "3-7 trading days",
    },
    portfolioDecision: { reason: "Group equity at 7.5% of 10% cap — short adds 2.5%, stays within." },
    riskDecision: { positionSizePct: 0.025, reason: "Vol-scaled: TSLA ATR is 2x AAPL, so size is half." },
    opinions: [
      {
        agent: "news_event",
        summary: "Tesla reported Q3 deliveries below consensus; inventory days rose.",
        justification: "Cited article carries a delivery number and inventory ratio. No guidance cut.",
        eventType: "earnings_miss",
      },
      {
        agent: "sentiment",
        summary: "Tone is negative (3/5); analyst downgrades concentrated on the auto segment.",
        justification: "Five-band classifier returns 'negative-3'.",
        sentiment: "negative-3",
      },
      {
        agent: "price_impact",
        summary: "Direct impact, direction down, confidence 0.71.",
        justification: "Earnings misses produced a -2% to -6% same-week move on prior 4 instances.",
      },
      {
        agent: "technical",
        summary: "Broke below 50-day MA on +22% volume. RSI 47, falling.",
        justification: "Momentum confirms the breakdown. Stop above the prior swing high.",
      },
    ],
    debate: {
      bull: {
        argument: " valuation floor around 200-day MA + possible Fed rate cut tailwind for growth.",
        justification: "Long-term holders may defend the line; covers tend to happen fast.",
      },
      bear: {
        argument: "Miss is real, inventory days rising, and the chart broke structure.",
        justification: "Asymmetric risk to the downside in the next 3-5 sessions.",
      },
      direction: "short",
      confidence: 0.71,
      timeHorizon: "3-7 trading days",
      justification: "Bull case is mostly valuation/optionality; bear case is concrete and price-confirming.",
    },
    createdAt: iso(18 * 3600 * 1000),
  },
  {
    ticker: "MSFT",
    status: "rejected",
    thesis: {
      direction: "neutral",
      instrument: null,
      rationale: "Article is a personal-finance piece mentioning MSFT in passing. No price impact.",
      timeHorizon: null,
    },
    portfolioDecision: { reason: "Pipeline skipped at price-impact gate; no position taken." },
    riskDecision: { positionSizePct: 0, reason: "Not opened." },
    opinions: [
      {
        agent: "news_event",
        summary: "Personal finance blog listing dividend stocks; mentions MSFT in a list.",
        justification: "No event, no guidance, no analyst action.",
        eventType: "noise",
      },
      {
        agent: "sentiment",
        summary: "Neutral (2/5).",
        justification: "Generic positive phrasing, no signal.",
        sentiment: "neutral-2",
      },
      {
        agent: "price_impact",
        summary: "Relevance: none. No price direction.",
        justification: "Article type is personal-finance; no impact expected.",
      },
      {
        agent: "technical",
        summary: "Not evaluated (skipped after price-impact gate).",
        justification: "Stage skipped.",
      },
    ],
    debate: {
      bull: { argument: "—", justification: "Skipped." },
      bear: { argument: "—", justification: "Skipped." },
      direction: "neutral",
      confidence: 0.4,
      timeHorizon: "n/a",
      justification: "Article has no price impact; pipeline skipped at the gate.",
    },
    createdAt: iso(5 * 3600 * 1000),
  },
  {
    ticker: "XAUUSD",
    status: "opened",
    thesis: {
      direction: "long",
      instrument: "XAUUSD",
      rationale:
        "Fed minutes signalled a dovish tilt; real yields fell 6bp. Gold broke above 2655 resistance on rising volume.",
      timeHorizon: "5-10 trading days",
    },
    portfolioDecision: { reason: "Gold group cap is 15%; this position uses 6% of it." },
    riskDecision: { positionSizePct: 0.06, reason: "Per-ticker cap 15%; ATR stop at 1.4% → 0.6% loss-at-stop." },
    opinions: [
      {
        agent: "news_event",
        summary: "Fed minutes: 'several participants noted the case for cutting rates sooner'.",
        justification: "Direct macro trigger. Real yields fell 6bp on the release.",
        eventType: "central_bank",
      },
      {
        agent: "sentiment",
        summary: "Positive (4/5) on gold-specific commentary.",
        justification: "CTA and macro strategist notes leaned long.",
        sentiment: "positive-4",
      },
      {
        agent: "price_impact",
        summary: "Direct, direction up, confidence 0.82.",
        justification: "Comparable dovish-minute releases produced +0.6% to +1.8% same-week moves.",
      },
      {
        agent: "technical",
        summary: "Closed above 2655 with rising RSI (64) and ATR expansion.",
        justification: "Breakout with volume confirmation.",
      },
    ],
    debate: {
      bull: {
        argument: "Macro tailwind (real yields), technical confirmation, and a soft-landing setup all favour upside.",
        justification: "Multiple confirming factors.",
      },
      bear: {
        argument: "Gold is overbought on the daily and may need a retest of 2640 before continuing.",
        justification: "Short-term pullback risk.",
      },
      direction: "long",
      confidence: 0.82,
      timeHorizon: "5-10 trading days",
      justification: "Bull factors dominate; enter with a loose stop below 2640.",
    },
    createdAt: iso(3 * day + 2 * 3600 * 1000),
  },
  {
    ticker: "USO",
    status: "rejected",
    thesis: {
      direction: "neutral",
      instrument: null,
      rationale: "OPEC+ sources indicate no production change. Article carries no new price-impact signal.",
      timeHorizon: null,
    },
    portfolioDecision: { reason: "Pipeline skipped; no position taken." },
    riskDecision: { positionSizePct: 0, reason: "Not opened." },
    opinions: [
      {
        agent: "news_event",
        summary: "OPEC+ meeting concluded with no production change.",
        justification: "Outcome was widely expected; no surprise.",
        eventType: "policy_update",
      },
      {
        agent: "sentiment",
        summary: "Neutral (2/5).",
        justification: "Press tone flat.",
        sentiment: "neutral-2",
      },
      {
        agent: "price_impact",
        summary: "Relevance: none.",
        justification: "Expected outcome; no surprise to price.",
      },
      {
        agent: "technical",
        summary: "Not evaluated.",
        justification: "Stage skipped.",
      },
    ],
    debate: {
      bull: { argument: "—", justification: "Skipped." },
      bear: { argument: "—", justification: "Skipped." },
      direction: "neutral",
      confidence: 0.35,
      timeHorizon: "n/a",
      justification: "No price impact; skipped at the gate.",
    },
    createdAt: iso(8 * 3600 * 1000),
  },
  {
    ticker: "AAPL",
    status: "superseded",
    thesis: {
      direction: "long",
      instrument: "AAPL",
      rationale: "Earlier thesis from 4 days ago superseded by a stronger, newer signal.",
      timeHorizon: "5-10 trading days",
    },
    portfolioDecision: { reason: "Newer AAPL thesis opened; this one marked superseded." },
    riskDecision: { positionSizePct: 0.04, reason: "Original sizing of the prior thesis." },
    opinions: SAMPLE_OPINIONS,
    debate: SAMPLE_DEBATE,
    createdAt: iso(6 * day),
  },
];

// === LLM call previews (LLM Calls list) ===
export const LLM_CALLS: LlmCallPreview[] = [
  {
    id: 2847,
    ticker: "AAPL",
    label: "Analyst team",
    source: "pipeline",
    status: "ok",
    modelUsed: "gemini-3.6-flash",
    requestedModel: "gemini-3.6-flash",
    durationMs: 4280,
    createdAt: iso(2 * day + 3 * 3600 * 1000 + 2 * 60 * 1000),
    promptPreview:
      "You are a financial analyst team. Evaluate the following news item for ticker AAPL, dated 2026-10-04. Article: Apple announced a new on-device AI model line...",
    responsePreview:
      '{"news_event":{"summary":"Apple announced a new on-device AI model line...","eventType":"product_launch"},"sentiment":{"band":"positive-4"...',
    error: null,
    errorStage: null,
  },
  {
    id: 2846,
    ticker: "AAPL",
    label: "Bull researcher",
    source: "pipeline",
    status: "ok",
    modelUsed: "gemini-3.6-flash",
    requestedModel: "gemini-3.6-flash",
    durationMs: 3120,
    createdAt: iso(2 * day + 3 * 3600 * 1000 + 3 * 60 * 1000),
    promptPreview:
      "Argue the bull case for AAPL given the analyst team output above. Cite price-impact evidence and any technical confirmation...",
    responsePreview:
      '{"argument":"Product cycle is real and tied to revenue. Services attach lifts gross margin over 2-3 quarters...","justification":"Cited the same-week move..."',
    error: null,
    errorStage: null,
  },
  {
    id: 2845,
    ticker: "AAPL",
    label: "Bear researcher",
    source: "pipeline",
    status: "ok",
    modelUsed: "gemini-3.6-flash",
    requestedModel: "gemini-3.6-flash",
    durationMs: 2980,
    createdAt: iso(2 * day + 3 * 3600 * 1000 + 4 * 60 * 1000),
    promptPreview:
      "Argue the bear case against AAPL. Reference valuation, recent run-up, and any tactical resistance...",
    responsePreview:
      '{"argument":"Hardware launch price moves tend to fade within 5 trading days. Services revenue uplift is back-loaded...","justification":"14-day RSI at 62..."}',
    error: null,
    errorStage: null,
  },
  {
    id: 2844,
    ticker: "AAPL",
    label: "Research manager",
    source: "pipeline",
    status: "ok",
    modelUsed: "gemini-3.6-flash",
    requestedModel: "gemini-3.6-flash",
    durationMs: 3520,
    createdAt: iso(2 * day + 3 * 3600 * 1000 + 5 * 60 * 1000),
    promptPreview:
      "Reconcile the bull and bear cases into a verdict. Provide direction, confidence (0..1), time horizon, and a justification...",
    responsePreview:
      '{"direction":"long","confidence":0.78,"timeHorizon":"5-10 trading days","justification":"The bull case rests on a real product cycle..."}',
    error: null,
    errorStage: null,
  },
  {
    id: 2843,
    ticker: "AAPL",
    label: "Trader",
    source: "pipeline",
    status: "ok",
    modelUsed: "gemini-3.6-flash",
    requestedModel: "gemini-3.6-flash",
    durationMs: 2410,
    createdAt: iso(2 * day + 3 * 3600 * 1000 + 6 * 60 * 1000),
    promptPreview:
      "Translate the verdict into a trade thesis: instrument, rationale, entry plan, stop level...",
    responsePreview:
      '{"direction":"long","instrument":"AAPL","rationale":"On-device AI launch broadens the install base...","timeHorizon":"5-10 trading days"}',
    error: null,
    errorStage: null,
  },
  {
    id: 2842,
    ticker: "TSLA",
    label: "Analyst team",
    source: "pipeline",
    status: "ok",
    modelUsed: "gemini-3.1-flash-lite",
    requestedModel: "gemini-3.6-flash",
    durationMs: 2980,
    createdAt: iso(18 * 3600 * 1000 + 2 * 60 * 1000),
    promptPreview:
      "You are a financial analyst team. Evaluate the following news for TSLA: Tesla reported Q3 deliveries below consensus...",
    responsePreview:
      '{"news_event":{"summary":"Tesla reported Q3 deliveries below consensus; inventory days rose.","eventType":"earnings_miss"}...}',
    error: null,
    errorStage: null,
  },
  {
    id: 2841,
    ticker: "TSLA",
    label: "Trader",
    source: "pipeline",
    status: "ok",
    modelUsed: "gemini-3.6-flash",
    requestedModel: "gemini-3.6-flash",
    durationMs: 2120,
    createdAt: iso(18 * 3600 * 1000 + 7 * 60 * 1000),
    promptPreview: "Translate the verdict into a trade thesis for TSLA...",
    responsePreview: '{"direction":"short","instrument":"TSLA","rationale":"Delivery miss vs consensus..."}',
    error: null,
    errorStage: null,
  },
  {
    id: 2840,
    ticker: "XAUUSD",
    label: "Analyst team",
    source: "pipeline",
    status: "ok",
    modelUsed: "gemini-3.6-flash",
    requestedModel: "gemini-3.6-flash",
    durationMs: 4720,
    createdAt: iso(3 * day + 2 * 3600 * 1000 + 90 * 1000),
    promptPreview:
      "Evaluate the following news for XAUUSD: Fed minutes signalled a dovish tilt, real yields fell 6bp...",
    responsePreview:
      '{"news_event":{"summary":"Fed minutes dovish tilt","eventType":"central_bank"}...}',
    error: null,
    errorStage: null,
  },
  {
    id: 2839,
    ticker: "MSFT",
    label: "Analyst team",
    source: "pipeline",
    status: "ok",
    modelUsed: "gemini-3.6-flash",
    requestedModel: "gemini-3.6-flash",
    durationMs: 1980,
    createdAt: iso(5 * 3600 * 1000 + 30 * 1000),
    promptPreview:
      "Evaluate the following news for MSFT: personal-finance blog mentions dividend stocks including MSFT...",
    responsePreview:
      '{"news_event":{"summary":"Personal finance blog","eventType":"noise"},"price_impact":{"relevance":"none"}}',
    error: null,
    errorStage: null,
  },
  {
    id: 2838,
    ticker: "AAPL",
    label: "Exit check",
    source: "exit_check",
    status: "ok",
    modelUsed: "gemini-3.6-flash",
    requestedModel: "gemini-3.6-flash",
    durationMs: 1820,
    createdAt: iso(2 * 3600 * 1000),
    promptPreview: "Check whether AAPL position opened 2026-10-04 has hit stop or take-profit levels...",
    responsePreview: '{"close":false,"reason":"No levels touched; holding."}',
    error: null,
    errorStage: null,
  },
  {
    id: 2837,
    ticker: "AAPL",
    label: "Bull researcher",
    source: "pipeline",
    status: "error",
    modelUsed: null,
    requestedModel: "gemini-3.6-flash",
    durationMs: 240,
    createdAt: iso(2 * day + 3 * 3600 * 1000 + 2 * 60 * 1000 + 12 * 1000),
    promptPreview: "Argue the bull case for AAPL given the analyst team output above...",
    responsePreview: null,
    error: "HTTP 429: rate limited on all 4 keys; cascade exhausted.",
    errorStage: "cascade",
  },
  {
    id: 2836,
    ticker: "MSFT",
    label: "Analyst team",
    source: "pipeline",
    status: "ok",
    modelUsed: "gemini-3.6-flash",
    requestedModel: "gemini-3.6-flash",
    durationMs: 2230,
    createdAt: iso(1 * day + 6 * 3600 * 1000),
    promptPreview: "Evaluate the following news for MSFT: Azure capacity expansion announced...",
    responsePreview: '{"news_event":{"summary":"Azure capacity expansion","eventType":"capex_announcement"}...}',
    error: null,
    errorStage: null,
  },
  {
    id: 2835,
    ticker: null,
    label: "Backtest runner",
    source: "backtest",
    status: "ok",
    modelUsed: "gemini-3.6-flash",
    requestedModel: "gemini-3.6-flash",
    durationMs: 8920,
    createdAt: iso(1 * day + 1 * 3600 * 1000),
    promptPreview: "Backtest 2026-09-01..2026-09-30, tickers [AAPL, MSFT, TSLA]. Continue from cursor...",
    responsePreview: '{"part":42,"itemsProcessed":37,"quotaUsage":{"d1Writes":412,"geminiCalls":148}}',
    error: null,
    errorStage: null,
  },
  {
    id: 2834,
    ticker: "USO",
    label: "Analyst team",
    source: "pipeline",
    status: "ok",
    modelUsed: "gemini-3.6-flash",
    requestedModel: "gemini-3.6-flash",
    durationMs: 2010,
    createdAt: iso(8 * 3600 * 1000),
    promptPreview: "Evaluate the following news for USO: OPEC+ meeting concluded with no production change...",
    responsePreview: '{"news_event":{"summary":"OPEC+ no production change","eventType":"policy_update"},"price_impact":{"relevance":"none"}}',
    error: null,
    errorStage: null,
  },
];

// === One LLM call detail (for the drawer) ===
export const LLM_CALL_DETAIL: LlmCallDetail = {
  ...LLM_CALLS[0],
  keyIndex: 2,
  promptChars: 4823,
  responseChars: 1942,
  runId: null,
  jobId: null,
  truncated: false,
  prompt: `You are a financial analyst team. Evaluate the following news item for ticker AAPL, dated 2026-10-04.

Article:
Apple announced a new on-device AI model line at its 2026 fall event, with deeper Siri integration and broader language support. The new models run entirely on the A19 Pro chip, removing cloud round-trips for the first time. Services revenue attached to the AI features is expected to scale through 2027.

Recent price context:
- AAPL closed 2026-10-03 at 226.34, up 1.8% over 5 days
- 20-day MA: 219.40
- 50-day MA: 211.20
- 14-day RSI: 62
- 30-day avg volume: 54.2M

Return a JSON object with these fields:
{
  "news_event": { "summary": "...", "eventType": "...", "justification": "..." },
  "sentiment": { "band": "negative-2|negative-1|neutral-2|positive-3|positive-4", "justification": "..." },
  "price_impact": { "relevance": "none|indirect|direct", "direction": "up|down|none", "channel": "...", "justification": "..." },
  "technical": { "summary": "...", "justification": "..." }
}

Be precise. Every claim must come from the article or the price context above. Do not speculate.`,
  response: `{
  "news_event": {
    "summary": "Apple announced a new on-device AI model line at its 2026 fall event, with deeper Siri integration and broader language support.",
    "eventType": "product_launch",
    "justification": "Article cites a specific product launch event with named features (on-device AI, Siri integration)."
  },
  "sentiment": {
    "band": "positive-4",
    "justification": "Press tone is strongly positive; analyst notes led with upgrades and median target lift of ~3%."
  },
  "price_impact": {
    "relevance": "direct",
    "direction": "up",
    "channel": "product_launch",
    "justification": "Last 3 comparable Apple launches produced a +1.2% to +3.5% same-week move."
  },
  "technical": {
    "summary": "AAPL closed above its 20-day MA with rising 14-day RSI (62). Volume +18% vs 30-day mean.",
    "justification": "Trend is up; momentum confirms. No bearish divergence on the daily."
  }
}`,
  attempts: [
    {
      model: "gemini-3.6-flash",
      keyIndex: 0,
      outcome: "skipped",
      status: "429",
      detail: "Rate limited; cooldown 60s.",
    },
    {
      model: "gemini-3.6-flash",
      keyIndex: 1,
      outcome: "skipped",
      status: "429",
      detail: "Rate limited; cooldown 60s.",
    },
    {
      model: "gemini-3.6-flash",
      keyIndex: 2,
      outcome: "ok",
      status: "200",
      detail: "Answered in 4.28s.",
    },
  ],
};

// === Pipeline checkpoints (Pipeline view) ===
export const PIPELINE_CHECKPOINTS: PipelineCheckpoint[] = [
  { ticker: "AAPL", stage: "exit_check", updated_at: iso(2 * 3600 * 1000), status: "ok", lastStageLabel: "Exit Check" },
  { ticker: "MSFT", stage: "exit_check", updated_at: iso(3 * 3600 * 1000), status: "ok", lastStageLabel: "Exit Check" },
  { ticker: "TSLA", stage: "exit_check", updated_at: iso(1 * 3600 * 1000), status: "ok", lastStageLabel: "Exit Check" },
  { ticker: "XAUUSD", stage: "exit_check", updated_at: iso(4 * 3600 * 1000), status: "ok", lastStageLabel: "Exit Check" },
  { ticker: "USO", stage: "trade_decided", updated_at: iso(8 * 3600 * 1000), status: "ok", lastStageLabel: "Trade Decided" },
  { ticker: "AAPL", stage: "trade_decided", updated_at: iso(2 * day + 3 * 3600 * 1000), status: "ok", lastStageLabel: "Trade Decided" },
  { ticker: "MSFT", stage: "ingested", updated_at: iso(6 * 3600 * 1000), status: "ok", lastStageLabel: "Ingested" },
  { ticker: "TSLA", stage: "trade_decided", updated_at: iso(18 * 3600 * 1000), status: "ok", lastStageLabel: "Trade Decided" },
  { ticker: "XAUUSD", stage: "trade_decided", updated_at: iso(3 * day + 2 * 3600 * 1000), status: "ok", lastStageLabel: "Trade Decided" },
];

export const TICKER_STAGES: TickerStageRow[] = [
  { ticker: "AAPL", stage: "ingested", count: 142, updated_at: iso(2 * 3600 * 1000) },
  { ticker: "AAPL", stage: "analysed", count: 138, updated_at: iso(2 * 3600 * 1000) },
  { ticker: "AAPL", stage: "debated", count: 89, updated_at: iso(2 * 3600 * 1000) },
  { ticker: "AAPL", stage: "trade_decided", count: 76, updated_at: iso(2 * 3600 * 1000) },
  { ticker: "AAPL", stage: "exit_check", count: 32, updated_at: iso(2 * 3600 * 1000) },
  { ticker: "MSFT", stage: "ingested", count: 118, updated_at: iso(3 * 3600 * 1000) },
  { ticker: "MSFT", stage: "analysed", count: 114, updated_at: iso(3 * 3600 * 1000) },
  { ticker: "MSFT", stage: "debated", count: 72, updated_at: iso(3 * 3600 * 1000) },
  { ticker: "MSFT", stage: "trade_decided", count: 61, updated_at: iso(3 * 3600 * 1000) },
  { ticker: "MSFT", stage: "exit_check", count: 24, updated_at: iso(3 * 3600 * 1000) },
  { ticker: "TSLA", stage: "ingested", count: 96, updated_at: iso(1 * 3600 * 1000) },
  { ticker: "TSLA", stage: "analysed", count: 92, updated_at: iso(1 * 3600 * 1000) },
  { ticker: "TSLA", stage: "debated", count: 58, updated_at: iso(1 * 3600 * 1000) },
  { ticker: "TSLA", stage: "trade_decided", count: 47, updated_at: iso(1 * 3600 * 1000) },
  { ticker: "TSLA", stage: "exit_check", count: 18, updated_at: iso(1 * 3600 * 1000) },
  { ticker: "USO", stage: "ingested", count: 64, updated_at: iso(8 * 3600 * 1000) },
  { ticker: "USO", stage: "analysed", count: 60, updated_at: iso(8 * 3600 * 1000) },
  { ticker: "USO", stage: "debated", count: 32, updated_at: iso(8 * 3600 * 1000) },
  { ticker: "USO", stage: "trade_decided", count: 28, updated_at: iso(8 * 3600 * 1000) },
  { ticker: "XAUUSD", stage: "ingested", count: 84, updated_at: iso(4 * 3600 * 1000) },
  { ticker: "XAUUSD", stage: "analysed", count: 80, updated_at: iso(4 * 3600 * 1000) },
  { ticker: "XAUUSD", stage: "debated", count: 51, updated_at: iso(4 * 3600 * 1000) },
  { ticker: "XAUUSD", stage: "trade_decided", count: 43, updated_at: iso(4 * 3600 * 1000) },
  { ticker: "XAUUSD", stage: "exit_check", count: 19, updated_at: iso(4 * 3600 * 1000) },
];

// === Backtest runs ===
const SERIES_DATES = (() => {
  const out: string[] = [];
  const start = Date.UTC(2026, 8, 1); // 2026-09-01
  for (let i = 0; i < 30; i++) {
    const d = new Date(start + i * day);
    const pad = (n: number) => String(n).padStart(2, "0");
    out.push(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`);
  }
  return out;
})();

function buildSeries(base: number, vol: number, drift: number, seed: number): number[] {
  // Deterministic pseudo-random for stable mock data
  const out: number[] = [];
  let v = 0;
  let s = seed;
  for (let i = 0; i < SERIES_DATES.length; i++) {
    s = (s * 9301 + 49297) % 233280;
    const r = s / 233280 - 0.5;
    v += drift + r * vol;
    out.push(Number((base + v).toFixed(4)));
  }
  return out;
}

export const BACKTEST_RUNS: BacktestRun[] = [
  {
    id: "backtest-1791040666352-ejwkgx",
    status: "running",
    tickers: ["AAPL"],
    testStart: "2026-09-01T00:00:00.000Z",
    testEnd: "2026-09-10T00:00:00.000Z",
    error: null,
  },
  {
    id: "backtest-1791023632932-u65p8e",
    status: "complete",
    tickers: ["AAPL"],
    testStart: "2026-09-01T00:00:00.000Z",
    testEnd: "2026-09-05T00:00:00.000Z",
    error: null,
    result: {
      overall: {
        on: { cumulativeReturn: 0.018, sharpeRatio: 1.42, winRate: 0.75, maxDrawdown: -0.012 },
        off: { cumulativeReturn: 0.011, sharpeRatio: 0.91, winRate: 0.6, maxDrawdown: -0.018 },
        delta: { cumulativeReturn: 0.007, sharpeRatio: 0.51, winRate: 0.15, maxDrawdown: 0.006 },
      },
      portfolio: {
        method: "daily-equity-curve-v3",
        days: 30,
        from: "2026-09-01",
        to: "2026-09-30",
        tickers: ["AAPL"],
        on: {
          avgExposure: 0.06,
          positionsTraded: 4,
          positionsIgnored: 2,
          openAtSpanEnd: 1,
        },
        series: {
          dates: SERIES_DATES,
          on: buildSeries(0, 0.008, 0.0008, 42),
          off: buildSeries(0, 0.008, 0.0003, 17),
        },
      },
      gate: {
        n: 4,
        mean: 0.018,
        lowerBound: -0.014,
        costBps: 5,
        openAtEnd: 1,
        unreplayable: 0,
      },
    },
  },
  {
    id: "backtest-1790860459100-zpv5ex",
    status: "complete",
    tickers: ["AAPL"],
    testStart: "2026-09-01T00:00:00.000Z",
    testEnd: "2026-09-03T00:00:00.000Z",
    error: null,
    result: {
      overall: {
        on: { cumulativeReturn: 0.004, sharpeRatio: 0.31, winRate: 0.5, maxDrawdown: -0.006 },
        off: { cumulativeReturn: 0.002, sharpeRatio: 0.18, winRate: 0.5, maxDrawdown: -0.008 },
        delta: { cumulativeReturn: 0.002, sharpeRatio: 0.13, winRate: 0, maxDrawdown: 0.002 },
      },
      portfolio: {
        method: "daily-equity-curve-v3",
        days: 3,
        from: "2026-09-01",
        to: "2026-09-03",
        tickers: ["AAPL"],
        on: { avgExposure: 0.03, positionsTraded: 1, positionsIgnored: 0, openAtSpanEnd: 0 },
        series: {
          dates: SERIES_DATES.slice(0, 3),
          on: [0, 0.002, 0.004],
          off: [0, 0.001, 0.002],
        },
      },
      gate: {
        n: 1,
        mean: 0.004,
        lowerBound: -0.018,
        costBps: 5,
        openAtEnd: 0,
        unreplayable: 0,
      },
    },
  },
  {
    id: "backtest-1790800000000-paused1",
    status: "paused",
    tickers: ["AAPL", "MSFT"],
    testStart: "2026-09-01T00:00:00.000Z",
    testEnd: "2026-09-30T00:00:00.000Z",
    error: null,
    pausedReason: "gemini_daily_cap",
    pausedAt: iso(6 * 3600 * 1000),
    resumeAfter: new Date(NOW + 8 * 3600 * 1000).toISOString(),
  },
  {
    id: "backtest-1790700000000-failed1",
    status: "failed",
    tickers: ["AAPL", "MSFT", "TSLA"],
    testStart: "2026-08-15T00:00:00.000Z",
    testEnd: "2026-09-15T00:00:00.000Z",
    error: "Gemini cascade exhausted: every model returned 404 (model unavailable).",
  },
];

// === Active job (running backtest progress panel) ===
export const ACTIVE_JOB: JobProgress = {
  id: "backtest-1791040666352-ejwkgx",
  type: "backtest",
  status: "running",
  percent: 25,
  done: 6,
  total: 24,
  phase: "Processing part 6/24",
  detail: "Ticker-days for AAPL · 2026-09-06",
  error: null,
  params: { testStart: "2026-09-01", testEnd: "2026-09-10", tickers: ["AAPL"] },
  createdAt: iso(5 * 3600 * 1000),
  updatedAt: iso(2 * 60 * 1000),
  finishedAt: null,
  stale: false,
};

// === Pause flags ===
export const PAUSE_FLAGS: PauseFlags = {
  flags: { ingestion: false, trading: false, llm: false, backtests: false },
  meta: {
    ingestion: { updatedAt: iso(2 * day), updatedBy: "owner" },
    trading: { updatedAt: iso(2 * day), updatedBy: "owner" },
    llm: { updatedAt: iso(3 * day), updatedBy: "owner" },
    backtests: { updatedAt: iso(1 * day), updatedBy: "owner" },
  },
  error: null,
};

// === Ingestion health ===
export const INGESTION_HEALTH: IngestionHealth = {
  news: { count: 12482, lastIngestedAt: iso(12 * 60 * 1000), fresh: true },
  priceBars: { count: 3842, lastIngestedAt: iso(8 * 60 * 1000), fresh: true },
  fundamentals: { count: 412, lastIngestedAt: iso(2 * day + 3 * 3600 * 1000), fresh: false },
};

// === Price bars (Charts view) ===
export const PRICE_BARS_BY_TICKER: Record<string, PriceBar[]> = Object.fromEntries(
  OPEN_POSITIONS.map((p, idx) => [
    p.ticker,
    buildSeries(p.entryPrice ?? 100, 0.012, 0.0005, 100 + idx * 7).map((v, i) => ({
      close: Number(v.toFixed(2)),
      date: SERIES_DATES[i],
    })),
  ]),
);

// === Environments for the env selector ===
export const ENVIRONMENTS: { id: EnvId; label: string; status: "live" | "running" | "paused" | "complete" | "failed" }[] = [
  { id: "live", label: "Live", status: "live" },
  {
    id: "backtest-1791040666352-ejwkgx",
    label: "AAPL · 2026-09-01 → 2026-09-10",
    status: "running",
  },
  {
    id: "backtest-1791023632932-u65p8e",
    label: "AAPL · 2026-09-01 → 2026-09-05",
    status: "complete",
  },
  {
    id: "backtest-1790800000000-paused1",
    label: "AAPL, MSFT · 2026-09-01 → 2026-09-30",
    status: "paused",
  },
];

// === Helper: build a backtest-detail positions list ===
export function buildBacktestPositions(runId: string): Position[] {
  if (runId === "backtest-1791023632932-u65p8e") {
    return CLOSED_POSITIONS.slice(0, 4);
  }
  return CLOSED_POSITIONS.slice(0, 2);
}

// === Last backfill job (for the Backfill page's "last run" panel) ===
export const LAST_BACKFILL_JOB: JobProgress = {
  id: "backfill-1791000000000-abc123",
  type: "backfill",
  status: "complete",
  percent: 100,
  done: 10025,
  total: 10025,
  phase: "Finished",
  detail: "10,025 items ingested across 13 parts.",
  error: null,
  params: { from: "2026-07-01", to: "2026-09-30" },
  createdAt: iso(3 * day),
  updatedAt: iso(2 * day + 18 * 3600 * 1000),
  finishedAt: iso(2 * day + 18 * 3600 * 1000),
  stale: false,
};

export const LAST_PRICE_BACKFILL_JOB: JobProgress = {
  id: "backfill-prices-1790900000000-def456",
  type: "backfill_prices",
  status: "complete",
  percent: 100,
  done: 150,
  total: 150,
  phase: "Finished",
  detail: "150 daily bars backfilled for AAPL, MSFT, TSLA, USO, XAUUSD.",
  error: null,
  params: { from: "2026-08-01", to: "2026-09-30", tickers: ["AAPL", "MSFT", "TSLA", "USO", "XAUUSD"] },
  createdAt: iso(5 * day),
  updatedAt: iso(5 * day + 4 * 3600 * 1000),
  finishedAt: iso(5 * day + 4 * 3600 * 1000),
  stale: false,
};
