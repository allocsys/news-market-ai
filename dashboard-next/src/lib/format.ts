// Formatters and helpers — single source of truth for the dashboard's
// number/time/percentage rendering. Mirrors src/dashboard/helpers.js
// from the original Cloudflare Workers project, but typed.

import type { Direction, TradeDecisionStatus, BacktestStatus, PauseReason } from "./types";

/** HTML-escape (used anywhere we render user/data strings into markup). */
export function escapeHtml(value: unknown): string {
  const s = value == null ? "" : String(value);
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/** ISO → "YYYY-MM-DD HH:MM:SS UTC". Empty string for null/undefined. */
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}

/** ISO → relative short ("3m", "2h", "5d"). Falls back to fmtTime for >30d. */
export function fmtRelative(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const diff = now - d.getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const dd = Math.floor(h / 24);
  if (dd < 30) return `${dd}d`;
  return fmtTime(iso);
}

/** ISO → "HH:MM UTC" (compact for tight UI). */
export function fmtTimeShort(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** ISO → "YYYY-MM-DD". */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Fraction → percentage string. 0.0523 → "5.2%". */
export function fmtPct(fraction: number | null | undefined, digits = 1): string {
  if (fraction == null || Number.isNaN(fraction)) return "—";
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** Signed percentage. 0.012 → "+1.2%", -0.005 → "-0.5%". */
export function signedPct(fraction: number | null | undefined, digits = 1): string {
  if (fraction == null || Number.isNaN(fraction)) return "—";
  const v = fraction * 100;
  const sign = v > 0 ? "+" : v < 0 ? "" : "";
  return `${sign}${v.toFixed(digits)}%`;
}

/** Money. 182.45 → "$182.45". */
export function fmtUsd(v: number | null | undefined, digits = 2): string {
  if (v == null || Number.isNaN(v)) return "—";
  return `$${v.toFixed(digits)}`;
}

/** Compact number: 12345 → "12.3k", 1234567 → "1.2M". */
export function fmtCompact(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Share as percentage: (3, 12) → "25%". */
export function fmtShare(count: number, total: number, digits = 0): string {
  if (!total || total <= 0) return "—";
  return `${((count / total) * 100).toFixed(digits)}%`;
}

/** Duration ms → "1.2s" or "423ms". */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Pretty print a backtest id: keep last 8 chars + ellipsis. */
export function shortId(id: string | null | undefined): string {
  if (!id) return "—";
  if (id.length <= 16) return id;
  return `${id.slice(0, 10)}…${id.slice(-4)}`;
}

/** Direction → display label. */
export function directionLabel(d: Direction | null | undefined): string {
  if (d === "long") return "Long";
  if (d === "short") return "Short";
  if (d === "neutral") return "Neutral";
  return "—";
}

/** Trade-decision status → friendly label. */
export function decisionStatusLabel(s: TradeDecisionStatus): string {
  const map: Record<TradeDecisionStatus, string> = {
    opened: "Opened",
    rejected: "Rejected",
    superseded: "Superseded",
    skipped_no_price_data: "Skipped · no price",
    held: "Held",
    pending_entry: "Pending entry",
    skipped_no_fill: "Skipped · no fill",
    skipped_irrelevant: "Skipped · irrelevant",
  };
  return map[s] ?? s;
}

/** Backtest status → friendly label. */
export function backtestStatusLabel(s: BacktestStatus): string {
  const map: Record<BacktestStatus, string> = {
    running: "Running",
    paused: "Paused",
    complete: "Complete",
    failed: "Failed",
    cancelled: "Cancelled",
  };
  return map[s] ?? s;
}

/** Pause reason → friendly label. */
export function pauseReasonLabel(r: PauseReason): string {
  const map: Record<PauseReason, string> = {
    operator: "Paused by you",
    d1_write_budget: "Daily D1 write budget reached",
    gemini_daily_cap: "All Gemini keys at daily limit",
    platform_limit: "Cloudflare platform limit hit",
    quota_threshold: "Daily quota threshold reached",
  };
  return map[r] ?? r;
}

/** Close reason → friendly label. */
export function closeReasonLabel(r: string | null | undefined): string {
  if (!r) return "—";
  const map: Record<string, string> = {
    take_profit: "Take profit",
    stop_loss: "Stop loss",
    flipped: "Flipped",
    replaced: "Replaced",
    time_based: "Time exit",
    breakeven_stop: "Break-even",
    trailing_stop: "Trailing stop",
  };
  return map[r] ?? r.replace(/_/g, " ");
}

/** Stage key → friendly label. */
export function stageLabel(stage: string): string {
  return stage
    .split(/[_\s]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Build a backtest run label for the env selector / list rows. */
export function runLabel(run: {
  tickers: string[];
  testStart: string;
  testEnd: string;
  status?: string;
}): string {
  const tickers = run.tickers.slice(0, 3).join(",") + (run.tickers.length > 3 ? ` +${run.tickers.length - 3}` : "");
  const date = fmtDate(run.testStart) === fmtDate(run.testEnd) ? fmtDate(run.testStart) : `${fmtDate(run.testStart)} → ${fmtDate(run.testEnd)}`;
  return `${tickers} · ${date}`;
}

/** Truncate with ellipsis (length-aware). */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/** Format a confidence value (0..1) as a percentage with no sign. */
export function fmtConfidence(c: number | null | undefined): string {
  if (c == null || Number.isNaN(c)) return "—";
  return `${Math.round(c * 100)}%`;
}
