"use client";

import { cn } from "@/lib/utils";

type StatusKind = "approved" | "rejected" | "open" | "closed" | "ok" | "error" | "stale" | "running" | "complete" | "failed" | "neutral" | "long" | "short";

const STYLE: Record<StatusKind, { label: string; className: string; dot: string }> = {
  approved: { label: "Approved", className: "text-[var(--chart-2)] bg-[var(--chart-2)]/10 border-[var(--chart-2)]/30", dot: "bg-[var(--chart-2)]" },
  rejected: { label: "Rejected", className: "text-[var(--chart-4)] bg-[var(--chart-4)]/10 border-[var(--chart-4)]/30", dot: "bg-[var(--chart-4)]" },
  open: { label: "Open", className: "text-[var(--chart-1)] bg-[var(--chart-1)]/10 border-[var(--chart-1)]/30", dot: "bg-[var(--chart-1)]" },
  closed: { label: "Closed", className: "text-muted-foreground bg-muted/40 border-border", dot: "bg-muted-foreground" },
  ok: { label: "OK", className: "text-[var(--chart-2)] bg-[var(--chart-2)]/10 border-[var(--chart-2)]/30", dot: "bg-[var(--chart-2)]" },
  error: { label: "Error", className: "text-[var(--chart-4)] bg-[var(--chart-4)]/10 border-[var(--chart-4)]/30", dot: "bg-[var(--chart-4)]" },
  stale: { label: "Stale", className: "text-[var(--chart-3)] bg-[var(--chart-3)]/10 border-[var(--chart-3)]/30", dot: "bg-[var(--chart-3)]" },
  running: { label: "Running", className: "text-[var(--chart-1)] bg-[var(--chart-1)]/10 border-[var(--chart-1)]/30", dot: "bg-[var(--chart-1)]" },
  complete: { label: "Complete", className: "text-[var(--chart-2)] bg-[var(--chart-2)]/10 border-[var(--chart-2)]/30", dot: "bg-[var(--chart-2)]" },
  failed: { label: "Failed", className: "text-[var(--chart-4)] bg-[var(--chart-4)]/10 border-[var(--chart-4)]/30", dot: "bg-[var(--chart-4)]" },
  neutral: { label: "—", className: "text-muted-foreground bg-muted/40 border-border", dot: "bg-muted-foreground" },
  long: { label: "Long", className: "text-[var(--chart-2)] bg-[var(--chart-2)]/10 border-[var(--chart-2)]/30", dot: "bg-[var(--chart-2)]" },
  short: { label: "Short", className: "text-[var(--chart-4)] bg-[var(--chart-4)]/10 border-[var(--chart-4)]/30", dot: "bg-[var(--chart-4)]" },
};

export function StatusBadge({ kind, label }: { kind: StatusKind; label?: string }) {
  const s = STYLE[kind];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
        s.className
      )}
    >
      <span className={cn("size-1.5 rounded-full", s.dot)} aria-hidden />
      {label ?? s.label}
    </span>
  );
}
