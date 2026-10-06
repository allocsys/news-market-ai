// Query-param parsing and constants shared by the dashboard's JSON API
// (src/dashboard/api.js, data.js), the gateway Worker (src/dashboard-worker.js)
// and the login page. The old server-rendered HTML renderers that used to live
// here were removed when the Next.js app (dashboard-next/) replaced the SSR UI.

import { TRADE_DECISION_STATUS } from "../shared/constants.js";

const ESCAPE_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

export const ACTIVITY_DAYS_OPTIONS = [7, 14, 30, 60];
// Filter options come from the store's real vocabulary (shared/constants.js), so a new
// status can't silently drop out of the filter the way 'approved' did after M2 renamed it 'opened'.
export const DECISION_STATUS_OPTIONS = ["all", ...Object.values(TRADE_DECISION_STATUS)];
export const DECISION_LIMIT_OPTIONS = [10, 20, 50, 100];
export const POSITIONS_LIMIT_OPTIONS = [10, 25, 50, 100];
export const STALE_INGESTION_HOURS = 26;
export const PRICE_CHART_TICKER_LIMIT = 8;
// Pipeline checkpoints update on the */15 cron, far more often than the daily-ish
// ingestion sources STALE_INGESTION_HOURS was tuned for -- a ticker whose last
// checkpoint hasn't moved in 2h most likely has a stuck/crashed run, not just a
// quiet news day. Used by data.js#getOverviewData to flag a checkpoint "stale".
export const PIPELINE_STALE_HOURS = 2;

function pickFromOptions(raw, options, fallback) {
  const parsed = Number.isNaN(Number(raw)) ? raw : Number(raw);
  return options.includes(parsed) ? parsed : fallback;
}

// M4b environment selector. Shape matches index.js#newJobId("backtest"):
// `backtest-<ms timestamp>-<base36 suffix>`. This is a FORMAT check only --
// `raw` still has to be looked up against the SIM_DB registry (data.js#resolveEnv)
// to confirm the run actually exists; a well-formed but unknown id also falls
// back to live there. Exported so data.js's resolver uses the identical pattern
// rather than a second copy that could drift.
export const BACKTEST_ID_RE = /^backtest-\d+-[a-z0-9]+$/;

/** `?env=` -- "live" (default) or a plausibly-shaped backtest id. Anything else silently falls back to "live" here; existence of a well-formed id is checked downstream in data.js#resolveEnv, not here (this function has no DB access). */
export function parseEnvParam(searchParams) {
  const sp = searchParams ?? new URLSearchParams();
  const raw = (sp.get("env") ?? "").trim();
  if (raw === "" || raw === "live") return "live";
  return BACKTEST_ID_RE.test(raw) ? raw : "live";
}

export function parseDashboardParams(searchParams) {
  const sp = searchParams ?? new URLSearchParams();
  return {
    activityDays: pickFromOptions(sp.get("activityDays"), ACTIVITY_DAYS_OPTIONS, 14),
    decisionStatus: DECISION_STATUS_OPTIONS.includes(sp.get("decisionStatus")) ? sp.get("decisionStatus") : "all",
    decisionLimit: pickFromOptions(sp.get("decisionLimit"), DECISION_LIMIT_OPTIONS, 20),
    positionsLimit: pickFromOptions(sp.get("positionsLimit"), POSITIONS_LIMIT_OPTIONS, 50),
    env: parseEnvParam(sp),
  };
}

// ---- LLM calls page ----
// Its own param set, parsed separately from parseDashboardParams. Every param is
// validated here -- llmTicker/llmJob/llmRun end up in SQL bind values (never
// interpolated), but bounding them keeps junk out of the query.
export const LLM_SOURCE_OPTIONS = ["all", "pipeline", "backtest", "exit_check", "replay"];
export const LLM_STATUS_OPTIONS = ["all", "ok", "error"];
export const LLM_LIMIT_OPTIONS = [25, 50, 100];
const LLM_DEFAULTS = { llmSource: "all", llmStatus: "all", llmLimit: 50, env: "live" };

function cleanId(raw) {
  const s = (raw ?? "").trim();
  return s.length > 0 && s.length <= 200 ? s : "";
}

export function parseLlmParams(searchParams) {
  const sp = searchParams ?? new URLSearchParams();
  const ticker = (sp.get("llmTicker") ?? "").trim().toUpperCase();
  const before = Number(sp.get("llmBefore"));
  return {
    llmSource: LLM_SOURCE_OPTIONS.includes(sp.get("llmSource")) ? sp.get("llmSource") : LLM_DEFAULTS.llmSource,
    llmStatus: LLM_STATUS_OPTIONS.includes(sp.get("llmStatus")) ? sp.get("llmStatus") : LLM_DEFAULTS.llmStatus,
    llmLimit: pickFromOptions(sp.get("llmLimit"), LLM_LIMIT_OPTIONS, LLM_DEFAULTS.llmLimit),
    llmTicker: /^[A-Z0-9.\-]{1,12}$/.test(ticker) ? ticker : "",
    llmJob: cleanId(sp.get("llmJob")),
    llmRun: cleanId(sp.get("llmRun")),
    llmBefore: Number.isInteger(before) && before > 0 ? before : null,
    env: parseEnvParam(sp),
  };
}
