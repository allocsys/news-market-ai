"use client";

import { cn } from "@/lib/utils";
import {
  ArrowUpRight,
  ArrowDownRight,
  Minus,
  CheckCircle2,
  XCircle,
  CircleDashed,
  Pause as PauseIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Direction } from "@/lib/types";

// ============================================================
// Direction pill — long/short/neutral
// ============================================================
export function DirectionPill({
  direction,
  className,
  size = "md",
}: {
  direction: Direction | null | undefined;
  className?: string;
  size?: "sm" | "md";
}) {
  if (direction === "long") {
    return (
      <Pill tone="long" size={size} className={className}>
        <ArrowUpRight className={size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5"} />
        Long
      </Pill>
    );
  }
  if (direction === "short") {
    return (
      <Pill tone="short" size={size} className={className}>
        <ArrowDownRight className={size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5"} />
        Short
      </Pill>
    );
  }
  return (
    <Pill tone="neutral" size={size} className={className}>
      <Minus className={size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5"} />
      Neutral
    </Pill>
  );
}

// ============================================================
// Generic Pill — the visual primitive every other pill uses
// ============================================================
type PillTone = "long" | "short" | "neutral" | "approved" | "rejected" | "neutral-pos" | "paused" | "info" | "muted";

const toneClasses: Record<PillTone, string> = {
  long: "bg-[color:var(--long)]/12 text-[color:var(--long)] border-[color:var(--long)]/25",
  short: "bg-[color:var(--short)]/12 text-[color:var(--short)] border-[color:var(--short)]/25",
  neutral: "bg-muted text-muted-foreground border-border",
  approved: "bg-[color:var(--long)]/12 text-[color:var(--long)] border-[color:var(--long)]/25",
  rejected: "bg-[color:var(--short)]/12 text-[color:var(--short)] border-[color:var(--short)]/25",
  "neutral-pos": "bg-muted text-foreground border-border",
  paused: "bg-[color:var(--paused)]/12 text-[color:var(--paused)] border-[color:var(--paused)]/25",
  info: "bg-[color:var(--info)]/12 text-[color:var(--info)] border-[color:var(--info)]/25",
  muted: "bg-muted text-muted-foreground border-transparent",
};

export function Pill({
  children,
  tone = "neutral",
  size = "md",
  className,
}: {
  children: React.ReactNode;
  tone?: PillTone;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border font-medium whitespace-nowrap",
        size === "sm" ? "px-2 py-0.5 text-[10px] leading-tight" : "px-2.5 py-1 text-xs",
        toneClasses[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

// ============================================================
// Status badge — for trade decisions, backtests, jobs
// ============================================================
type StatusVariant = "approved" | "rejected" | "neutral" | "paused" | "info";

export function StatusBadge({
  variant,
  label,
  icon: Icon,
  className,
}: {
  variant: StatusVariant;
  label: string;
  icon?: LucideIcon;
  className?: string;
}) {
  const tone: PillTone =
    variant === "approved" ? "approved" : variant === "rejected" ? "rejected" : variant === "paused" ? "paused" : variant === "info" ? "info" : "neutral-pos";
  return (
    <Pill tone={tone} className={className}>
      {Icon && <Icon className="h-3 w-3" />}
      {label}
    </Pill>
  );
}

// ============================================================
// Close reason pill
// ============================================================
export function CloseReasonPill({ reason }: { reason: string | null | undefined }) {
  if (!reason) return <Pill tone="muted">—</Pill>;
  const friendly = reason.replace(/_/g, " ");
  const tone: PillTone =
    reason === "take_profit" || reason === "trailing_stop" ? "approved" : reason === "stop_loss" ? "rejected" : "neutral-pos";
  return (
    <Pill tone={tone} size="sm" className="capitalize">
      {friendly}
    </Pill>
  );
}

// ============================================================
// Live status dot — pulsing for "running" / "live"
// ============================================================
export function StatusDot({
  status,
  className,
}: {
  status: "live" | "running" | "paused" | "complete" | "failed" | "cancelled" | "stale" | "ok";
  className?: string;
}) {
  const colorMap: Record<string, string> = {
    live: "bg-[color:var(--long)]",
    running: "bg-[color:var(--info)]",
    ok: "bg-[color:var(--long)]",
    paused: "bg-[color:var(--paused)]",
    complete: "bg-muted-foreground",
    failed: "bg-[color:var(--short)]",
    cancelled: "bg-muted-foreground",
    stale: "bg-[color:var(--paused)]",
  };
  const pulse = status === "live" || status === "running";
  return (
    <span
      className={cn(
        "inline-block h-2 w-2 rounded-full",
        colorMap[status] ?? "bg-muted-foreground",
        pulse && "live-dot",
        className,
      )}
      aria-hidden
    />
  );
}

// ============================================================
// Stat card — for headline numbers
// ============================================================
export function StatCard({
  value,
  label,
  sub,
  tone = "default",
  className,
}: {
  value: React.ReactNode;
  label: string;
  sub?: React.ReactNode;
  tone?: "default" | "long" | "short" | "paused" | "info";
  className?: string;
}) {
  const valueColor =
    tone === "long"
      ? "text-[color:var(--long)]"
      : tone === "short"
        ? "text-[color:var(--short)]"
        : tone === "paused"
          ? "text-[color:var(--paused)]"
          : tone === "info"
            ? "text-[color:var(--info)]"
            : "text-foreground";
  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-card p-4 card-hairline",
        className,
      )}
    >
      <div className={cn("font-mono text-2xl font-semibold tracking-tight nums", valueColor)}>
        {value}
      </div>
      <div className="mt-1 text-xs font-medium text-muted-foreground">{label}</div>
      {sub && <div className="mt-0.5 text-[11px] text-muted-foreground/80">{sub}</div>}
    </div>
  );
}

// ============================================================
// Mini stat — smaller variant for inline rows
// ============================================================
export function MiniStat({
  value,
  label,
  sub,
  className,
}: {
  value: React.ReactNode;
  label: string;
  sub?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-lg border border-border bg-muted/40 p-3", className)}>
      <div className="font-mono text-base font-semibold tracking-tight nums">{value}</div>
      <div className="mt-0.5 text-[11px] text-muted-foreground">{label}</div>
      {sub && <div className="mt-0.5 text-[10px] text-muted-foreground/80">{sub}</div>}
    </div>
  );
}

// ============================================================
// Section heading — consistent rhythm
// ============================================================
export function SectionHeading({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-3", className)}>
      <div className="min-w-0">
        <h2 className="font-display text-lg font-semibold tracking-tight">{title}</h2>
        {description && (
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

// ============================================================
// Empty / error states
// ============================================================
export function EmptyState({
  icon: Icon = CircleDashed,
  title,
  message,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  message?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-muted/20 px-4 py-10 text-center">
      <Icon className="h-8 w-8 text-muted-foreground/60" aria-hidden />
      <p className="mt-3 text-sm font-medium">{title}</p>
      {message && <p className="mt-1 text-xs text-muted-foreground">{message}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-xl border border-[color:var(--short)]/30 bg-[color:var(--short)]/8 px-4 py-3 text-sm"
    >
      <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--short)]" aria-hidden />
      <div className="min-w-0">
        <p className="font-medium text-[color:var(--short)]">Something went wrong</p>
        <p className="mt-0.5 text-xs text-muted-foreground break-words">{message}</p>
      </div>
    </div>
  );
}

// ============================================================
// Helper exports of common icons
// ============================================================
export const Icons = {
  CheckCircle: CheckCircle2,
  XCircle,
  CircleDashed,
  Pause: PauseIcon,
};
