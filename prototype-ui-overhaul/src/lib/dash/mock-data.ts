import type {
  ActivityDay,
  BacktestRun,
  BacktestTrade,
  Decision,
  EquityPoint,
  IngestionSource,
  JobProgress,
  LlmCall,
  NavItem,
  PipelineCheckpoint,
  PipelineStage,
  Position,
  Ticker,
  ViewId,
} from "./types";

const now = Date.now();
const day = 86400_000;
const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();
const hoursAgo = (h: number) => iso(-h * 3600_000);
const daysAgo = (d: number) => iso(-d * day);

function sparkline(seed: number, n = 30, drift = 0.0006, vol = 0.012): number[] {
  let v = 100;
  let s = seed;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    s = (s * 9301 + 49297) % 233280;
    const r = (s / 233280 - 0.5) * 2;
    v = v * (1 + drift + r * vol);
    out.push(Number(v.toFixed(2)));
  }
  return out;
}

// === Navigation config (11 sections incl. Overview) ===
export const NAV_ITEMS: NavItem[] = [
  { id: "overview", label: "Overview", icon: "LayoutDashboard", group: "monitor", mobileNav: true },
  { id: "snapshot", label: "Snapshot", icon: "Wallet", group: "monitor", mobileNav: true },
  { id: "activity", label: "Activity", icon: "BarChart3", group: "monitor" },
  { id: "decisions", label: "Decisions", icon: "GitPullRequestArrow", group: "monitor", mobileNav: true },
  { id: "positions", label: "Positions", icon: "Briefcase", group: "monitor", mobileNav: true },
  { id: "charts", label: "Charts", icon: "LineChart", group: "monitor" },
  { id: "pipeline", label: "Pipeline", icon: "Workflow", group: "ops" },
  { id: "llm", label: "LLM Calls", icon: "BrainCircuit", group: "ops" },
  { id: "backfill", label: "Backfill", icon: "DatabaseBackup", group: "ops" },
  { id: "backtest", label: "Backtest", icon: "FlaskConical", group: "ops" },
  { id: "health", label: "Health", icon: "HeartPulse", group: "system", mobileNav: true },
];

export const MOBILE_NAV_IDS: ViewId[] = NAV_ITEMS.filter((n) => n.mobileNav).map((n) => n.id);

// === Tickers (universe) ===
export const TICKERS: Ticker[] = [
  { symbol: "AAPL", name: "Apple Inc.", price: 232.18, changePct: 1.42, currency: "USD", sparkline: sparkline(7) },
  { symbol: "MSFT", name: "Microsoft Corp.", price: 431.07, changePct: 0.84, currency: "USD", sparkline: sparkline(11) },
  { symbol: "NVDA", name: "NVIDIA Corp.", price: 128.74, changePct: 3.18, currency: "USD", sparkline: sparkline(13, 30, 0.001, 0.018) },
  { symbol: "TSLA", name: "Tesla Inc.", price: 258.42, changePct: -2.11, currency: "USD", sparkline: sparkline(17, 30, -0.0006, 0.022) },
  { symbol: "GOOGL", name: "Alphabet Inc.", price: 167.21, changePct: 0.53, currency: "USD", sparkline: sparkline(19) },
  { symbol: "AMZN", name: "Amazon.com Inc.", price: 198.74, changePct: -0.71, currency: "USD", sparkline: sparkline(23) },
  { symbol: "META", name: "Meta Platforms", price: 568.92, changePct: 1.87, currency: "USD", sparkline: sparkline(29) },
  { symbol: "AMD", name: "Advanced Micro Devices", price: 162.31, changePct: -1.04, currency: "USD", sparkline: sparkline(31, 30, -0.0002, 0.02) },
];

// === Open + Closed positions ===
export const OPEN_POSITIONS: Position[] = [
  { id: "pos-1", ticker: "AAPL", direction: "long", sizePct: 18, opened: daysAgo(4), closed: null, entry: 224.30, exit: null, pnlPct: 3.51, status: "open", basedOn: "dec-1024" },
  { id: "pos-2", ticker: "NVDA", direction: "long", sizePct: 22, opened: daysAgo(2), closed: null, entry: 121.40, exit: null, pnlPct: 6.03, status: "open", basedOn: "dec-1031" },
  { id: "pos-3", ticker: "MSFT", direction: "long", sizePct: 14, opened: daysAgo(6), closed: null, entry: 426.10, exit: null, pnlPct: 1.17, status: "open", basedOn: "dec-1019" },
  { id: "pos-4", ticker: "AMD", direction: "short", sizePct: 8, opened: daysAgo(3), closed: null, entry: 168.50, exit: null, pnlPct: -2.32, status: "open", basedOn: "dec-1028" },
  { id: "pos-5", ticker: "META", direction: "long", sizePct: 11, opened: daysAgo(1), closed: null, entry: 558.30, exit: null, pnlPct: 1.90, status: "open", basedOn: "dec-1035" },
];

export const CLOSED_POSITIONS: Position[] = [
  { id: "pos-c1", ticker: "GOOGL", direction: "long", sizePct: 12, opened: daysAgo(12), closed: daysAgo(5), entry: 162.10, exit: 167.20, pnlPct: 3.15, status: "closed", exitReason: "target", basedOn: "dec-991" },
  { id: "pos-c2", ticker: "TSLA", direction: "short", sizePct: 9, opened: daysAgo(9), closed: daysAgo(6), entry: 263.20, exit: 268.10, pnlPct: -1.86, status: "closed", exitReason: "stop", basedOn: "dec-1003" },
  { id: "pos-c3", ticker: "AMZN", direction: "long", sizePct: 10, opened: daysAgo(15), closed: daysAgo(8), entry: 194.30, exit: 201.50, pnlPct: 3.71, status: "closed", exitReason: "target", basedOn: "dec-982" },
  { id: "pos-c4", ticker: "NVDA", direction: "long", sizePct: 18, opened: daysAgo(22), closed: daysAgo(14), entry: 102.10, exit: 124.40, pnlPct: 21.84, status: "closed", exitReason: "signal_off", basedOn: "dec-951" },
  { id: "pos-c5", ticker: "AMD", direction: "short", sizePct: 7, opened: daysAgo(18), closed: daysAgo(11), entry: 158.20, exit: 152.40, pnlPct: 3.67, status: "closed", exitReason: "target", basedOn: "dec-963" },
  { id: "pos-c6", ticker: "MSFT", direction: "long", sizePct: 15, opened: daysAgo(20), closed: daysAgo(13), entry: 410.20, exit: 422.80, pnlPct: 3.07, status: "closed", exitReason: "signal_off", basedOn: "dec-955" },
];

// === Decisions ===
function makeDecision(
  i: number,
  ticker: string,
  direction: "long" | "short",
  status: "approved" | "rejected",
  confidence: number,
  daysOffset: number,
  sizePct: number,
): Decision {
  return {
    id: `dec-${1036 - i}`,
    ticker,
    direction,
    status,
    sizePct,
    confidence,
    when: daysAgo(daysOffset),
    agent: "trader-deep_think",
    reasoning: {
      analyst: {
        sentiment: direction === "long" ? "bullish" : "bearish",
        note:
          direction === "long"
            ? `News sentiment net-positive on ${ticker}; analyst upgrades ticked up 3 days running.`
            : `News sentiment net-negative on ${ticker}; recent guidance cut weighs on near-term multiple.`,
      },
      bull:
        direction === "long"
          ? `Momentum + macro tailwind; risk-on regime favors high-beta names like ${ticker}.`
          : `Bear-case oversimplified; ${ticker} balance sheet absorbs a guidance miss.`,
      bear:
        direction === "long"
          ? `Sector breadth weakening; ${ticker} could lag if 10y yield breaks 4.3%.`
          : `Multiple compression risk; ${ticker} downside overshoot likely if guidance misses again.`,
      verdict:
        status === "approved"
          ? `Approve ${direction} ${sizePct}% — confidence ${confidence.toFixed(2)} above threshold.`
          : `Reject — confidence ${confidence.toFixed(2)} below threshold; defer to next pipeline tick.`,
      trader:
        status === "approved"
          ? `Sized ${sizePct}% of book; stop at -3.5%, take-profit at +8%, signal-off at confidence < 0.55.`
          : `Held cash; logged reasoning to LLM call audit for the next re-run.`,
    },
  };
}

export const DECISIONS: Decision[] = [
  makeDecision(0, "NVDA", "long", "approved", 0.78, 0, 22),
  makeDecision(1, "META", "long", "approved", 0.71, 0.4, 11),
  makeDecision(2, "TSLA", "short", "rejected", 0.42, 0.8, 0),
  makeDecision(3, "AMD", "short", "approved", 0.66, 1, 8),
  makeDecision(4, "AAPL", "long", "approved", 0.82, 1.2, 18),
  makeDecision(5, "MSFT", "long", "approved", 0.74, 2.1, 14),
  makeDecision(6, "AMZN", "long", "rejected", 0.48, 2.6, 0),
  makeDecision(7, "GOOGL", "long", "approved", 0.69, 3, 9),
  makeDecision(8, "NVDA", "long", "approved", 0.85, 3.4, 18),
  makeDecision(9, "TSLA", "short", "approved", 0.63, 4, 7),
  makeDecision(10, "META", "long", "rejected", 0.51, 4.5, 0),
  makeDecision(11, "AMD", "long", "approved", 0.77, 5, 12),
  makeDecision(12, "MSFT", "long", "approved", 0.73, 5.7, 15),
  makeDecision(13, "AAPL", "long", "rejected", 0.49, 6, 0),
  makeDecision(14, "AMZN", "long", "approved", 0.72, 6.4, 10),
  makeDecision(15, "NVDA", "long", "approved", 0.80, 7, 16),
  makeDecision(16, "GOOGL", "short", "rejected", 0.44, 7.6, 0),
  makeDecision(17, "TSLA", "long", "approved", 0.68, 8, 9),
  makeDecision(18, "META", "long", "approved", 0.75, 8.5, 13),
  makeDecision(19, "AMD", "short", "approved", 0.71, 9, 6),
  makeDecision(20, "MSFT", "long", "rejected", 0.50, 9.5, 0),
  makeDecision(21, "AAPL", "long", "approved", 0.79, 10, 17),
  makeDecision(22, "NVDA", "long", "rejected", 0.46, 11, 0),
  makeDecision(23, "AMZN", "long", "approved", 0.74, 12, 11),
  makeDecision(24, "GOOGL", "long", "approved", 0.70, 13, 12),
  makeDecision(25, "TSLA", "short", "rejected", 0.43, 14, 0),
];

// === LLM calls ===
export const LLM_CALLS: LlmCall[] = Array.from({ length: 42 }).map((_, i): LlmCall => {
  const ticker = TICKERS[i % TICKERS.length].symbol;
  const status: "ok" | "error" = i % 9 === 0 ? "error" : "ok";
  const fellBack = i % 5 === 0;
  return {
    id: `llm-${1042 - i}`,
    ticker,
    agent: i % 3 === 0 ? "analyst-quick_think" : i % 3 === 1 ? "trader-deep_think" : "exit_check",
    source: i % 4 === 0 ? "backtest" : i % 4 === 1 ? "exit_check" : "pipeline",
    status,
    requestedModel: "gemini-2.5-pro",
    answeredBy: fellBack ? "gemini-2.5-flash" : "gemini-2.5-pro",
    fellBackFrom: fellBack ? "gemini-2.5-pro" : undefined,
    tookMs: 800 + Math.floor(Math.random() * 4200),
    when: hoursAgo(i * 0.6),
    promptPreview: `Run pipeline for ${ticker}. News batch size=18, price bars=30d, fundamentals snapshot from EDGAR. Decide long/short/hold with confidence and size.`,
    responsePreview: status === "ok"
      ? `{"decision":"long","confidence":0.78,"size":22,"stop":-3.5,"tp":+8,"reasoning":"momentum+macro"}`
      : `{"error":"rate_limited","detail":"all keys in cooldown, retried 3x"}`,
    promptTokens: 3200 + (i % 5) * 200,
    responseTokens: status === "ok" ? 600 + (i % 7) * 80 : 24,
    runId: i % 4 === 0 ? `run-${1042 - i}` : undefined,
    backtestId: i % 4 === 0 ? "backtest-1784215" : undefined,
    cascade: fellBack
      ? [
          { model: "gemini-2.5-pro", key: "key-1", outcome: "error", detail: "429 rate_limited" },
          { model: "gemini-2.5-flash", key: "key-3", outcome: "ok" },
        ]
      : [{ model: "gemini-2.5-pro", key: `key-${(i % 4) + 1}`, outcome: "ok" }],
  };
});

// === Pipeline stages + checkpoints ===
export const PIPELINE_STAGES: PipelineStage[] = [
  { stage: "ingest_news", label: "Ingest news", count: 1284, avgMs: 220, lastAt: hoursAgo(0.1) },
  { stage: "ingest_prices", label: "Ingest prices", count: 980, avgMs: 180, lastAt: hoursAgo(0.2) },
  { stage: "fundamentals", label: "Fundamentals", count: 612, avgMs: 410, lastAt: hoursAgo(0.3) },
  { stage: "analyst_quick", label: "Analyst (quick)", count: 612, avgMs: 1400, lastAt: hoursAgo(0.4) },
  { stage: "debate", label: "Bull/bear debate", count: 412, avgMs: 2200, lastAt: hoursAgo(0.5) },
  { stage: "trader_deep", label: "Trader (deep)", count: 412, avgMs: 3800, lastAt: hoursAgo(0.6) },
  { stage: "exit_check", label: "Exit check", count: 38, avgMs: 1600, lastAt: hoursAgo(0.7) },
];

export const PIPELINE_CHECKPOINTS: PipelineCheckpoint[] = [
  { ticker: "AAPL", lastStage: "trader_deep", lastStageLabel: "Trader (deep)", updatedAt: hoursAgo(0.4), status: "ok" },
  { ticker: "NVDA", lastStage: "trader_deep", lastStageLabel: "Trader (deep)", updatedAt: hoursAgo(0.2), status: "ok" },
  { ticker: "MSFT", lastStage: "debate", lastStageLabel: "Bull/bear debate", updatedAt: hoursAgo(0.5), status: "ok" },
  { ticker: "META", lastStage: "analyst_quick", lastStageLabel: "Analyst (quick)", updatedAt: hoursAgo(0.6), status: "ok" },
  { ticker: "TSLA", lastStage: "ingest_news", lastStageLabel: "Ingest news", updatedAt: hoursAgo(28), status: "stale" },
  { ticker: "AMD", lastStage: "fundamentals", lastStageLabel: "Fundamentals", updatedAt: hoursAgo(1.2), status: "ok" },
  { ticker: "GOOGL", lastStage: "trader_deep", lastStageLabel: "Trader (deep)", updatedAt: hoursAgo(1.0), status: "ok" },
  { ticker: "AMZN", lastStage: "exit_check", lastStageLabel: "Exit check", updatedAt: hoursAgo(2.0), status: "ok" },
];

// === Ingestion health ===
export const INGESTION_SOURCES: IngestionSource[] = [
  { source: "finnhub_news", label: "Finnhub news", rows: 12840, lastIngested: hoursAgo(0.2), fresh: true },
  { source: "tiingo_prices", label: "Tiingo prices", rows: 9820, lastIngested: hoursAgo(0.3), fresh: true },
  { source: "edgar_fundamentals", label: "SEC EDGAR fundamentals", rows: 612, lastIngested: hoursAgo(0.5), fresh: true },
  { source: "rss_feeds", label: "RSS feeds", rows: 4120, lastIngested: hoursAgo(28), fresh: false },
  { source: "gdelt", label: "GDELT events", rows: 18900, lastIngested: hoursAgo(0.7), fresh: true },
];

// === Activity (decisions per day) ===
function buildActivity(days: number): ActivityDay[] {
  const out: ActivityDay[] = [];
  let s = 13;
  for (let i = days - 1; i >= 0; i--) {
    s = (s * 9301 + 49297) % 233280;
    const total = Math.floor(2 + (s / 233280) * 8);
    s = (s * 9301 + 49297) % 233280;
    const approved = Math.floor((s / 233280) * (total + 1));
    out.push({
      date: new Date(now - i * day).toISOString().slice(0, 10),
      approved,
      rejected: Math.max(0, total - approved),
    });
  }
  return out;
}

export const ACTIVITY_7D = buildActivity(7);
export const ACTIVITY_14D = buildActivity(14);
export const ACTIVITY_30D = buildActivity(30);
export const ACTIVITY_60D = buildActivity(60);

// === Backtest runs ===
export const BACKTEST_RUNS: BacktestRun[] = [
  {
    id: "backtest-1784215",
    label: "Tech conviction Q3",
    tickers: ["AAPL", "MSFT", "NVDA"],
    testStart: daysAgo(90),
    testEnd: daysAgo(0),
    graceDays: 5,
    status: "complete",
    createdAt: daysAgo(2),
    updatedAt: hoursAgo(2),
    signalOnReturn: 18.42,
    buyHoldReturn: 7.31,
    winRate: 0.62,
    tradesOpened: 14,
    tradesClosed: 12,
  },
  {
    id: "backtest-1784089",
    label: "Semis long-only stress",
    tickers: ["NVDA", "AMD", "TSLA"],
    testStart: daysAgo(60),
    testEnd: daysAgo(0),
    graceDays: 3,
    status: "complete",
    createdAt: daysAgo(5),
    updatedAt: daysAgo(5),
    signalOnReturn: 11.27,
    buyHoldReturn: 4.18,
    winRate: 0.55,
    tradesOpened: 9,
    tradesClosed: 9,
  },
  {
    id: "backtest-1784021",
    tickers: ["META", "GOOGL", "AMZN"],
    testStart: daysAgo(120),
    testEnd: daysAgo(0),
    graceDays: 5,
    status: "complete",
    createdAt: daysAgo(8),
    updatedAt: daysAgo(8),
    signalOnReturn: -3.21,
    buyHoldReturn: 5.92,
    winRate: 0.41,
    tradesOpened: 11,
    tradesClosed: 11,
  },
  {
    id: "backtest-1784408",
    label: "Running: full universe",
    tickers: ["AAPL", "MSFT", "NVDA", "META", "GOOGL", "AMZN", "TSLA", "AMD"],
    testStart: daysAgo(180),
    testEnd: daysAgo(0),
    graceDays: 5,
    status: "running",
    createdAt: hoursAgo(0.4),
    updatedAt: hoursAgo(0.05),
    signalOnReturn: 0,
    buyHoldReturn: 0,
    winRate: 0,
    tradesOpened: 0,
    tradesClosed: 0,
  },
];

// === Equity curve for backtest-1784215 ===
export function buildEquityCurve(runId: string, days = 90): EquityPoint[] {
  const out: EquityPoint[] = [];
  let sig = 0;
  let bh = 0;
  let s = runId.length + 7;
  for (let i = 0; i < days; i++) {
    s = (s * 9301 + 49297) % 233280;
    const r = (s / 233280 - 0.48) * 2;
    sig += r * 0.4 + 0.05;
    bh += r * 0.3 + 0.04;
    out.push({
      date: new Date(now - (days - i - 1) * day).toISOString().slice(0, 10),
      signal: Number(sig.toFixed(2)),
      buyHold: Number(bh.toFixed(2)),
    });
  }
  return out;
}

export const BACKTEST_TRADES: BacktestTrade[] = [
  { id: "bt-t1", ticker: "AAPL", direction: "long", sizePct: 16, opened: daysAgo(85), closed: daysAgo(78), entry: 210.4, exit: 224.1, pnlPct: 6.50, closeReason: "target", basedOn: "dec-612", why: "Momentum + analyst upgrade; signal-off triggered at confidence 0.52." },
  { id: "bt-t2", ticker: "NVDA", direction: "long", sizePct: 22, opened: daysAgo(80), closed: daysAgo(40), entry: 102.1, exit: 124.4, pnlPct: 21.84, closeReason: "signal_off", basedOn: "dec-651", why: "Held through earnings; exited when trader confidence dropped below 0.55." },
  { id: "bt-t3", ticker: "MSFT", direction: "long", sizePct: 14, opened: daysAgo(70), closed: daysAgo(64), entry: 410.2, exit: 405.1, pnlPct: -1.24, closeReason: "stop", basedOn: "dec-690", why: "Hit -3.5% stop after Fed minutes spooked high-beta." },
  { id: "bt-t4", ticker: "AAPL", direction: "long", sizePct: 18, opened: daysAgo(58), closed: daysAgo(50), entry: 218.3, exit: 232.1, pnlPct: 6.32, closeReason: "target", basedOn: "dec-731", why: "iPhone launch cycle upgrade; take-profit at +8%." },
  { id: "bt-t5", ticker: "NVDA", direction: "short", sizePct: 9, opened: daysAgo(46), closed: daysAgo(44), entry: 130.2, exit: 134.1, pnlPct: -2.99, closeReason: "stop", basedOn: "dec-772", why: "Counter-trend short; stopped out after positive pre-announce." },
  { id: "bt-t6", ticker: "MSFT", direction: "long", sizePct: 15, opened: daysAgo(40), closed: daysAgo(20), entry: 422.8, exit: 438.2, pnlPct: 3.64, closeReason: "signal_off", basedOn: "dec-812", why: "Azure print solid; exited when bull/bear debate flipped bearish." },
  { id: "bt-t7", ticker: "AAPL", direction: "long", sizePct: 18, opened: daysAgo(20), closed: null, entry: 224.3, exit: null, pnlPct: 3.51, closeReason: "still_open", basedOn: "dec-1024", why: "Open position carried into current live book." },
  { id: "bt-t8", ticker: "NVDA", direction: "long", sizePct: 22, opened: daysAgo(2), closed: null, entry: 121.4, exit: null, pnlPct: 6.03, closeReason: "still_open", basedOn: "dec-1031", why: "Open position carried into current live book." },
];

// === Jobs in flight ===
export const JOBS: JobProgress[] = [
  {
    id: "job-1",
    kind: "backtest",
    status: "running",
    phase: "Trader (deep) · 5 / 8 tickers",
    done: 5,
    total: 8,
    startedAt: hoursAgo(0.4),
    updatedAt: hoursAgo(0.05),
    triggeredBy: "admin",
  },
  {
    id: "job-2",
    kind: "backfill_news",
    status: "complete",
    phase: "Backfill complete",
    done: 7,
    total: 7,
    startedAt: hoursAgo(0.6),
    updatedAt: hoursAgo(0.5),
    triggeredBy: "admin",
  },
];

// === Helpers ===
export const TOTAL_EXPOSURE_PCT = OPEN_POSITIONS.reduce((s, p) => s + p.sizePct, 0);
export const APPROVAL_RATE =
  DECISIONS.length > 0
    ? DECISIONS.filter((d) => d.status === "approved").length / DECISIONS.length
    : 0;

export function fmtPct(n: number, digits = 2): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

export function fmtRelativeTime(isoStr: string): string {
  const diff = Date.now() - new Date(isoStr).getTime();
  if (diff < 0) return "just now";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
