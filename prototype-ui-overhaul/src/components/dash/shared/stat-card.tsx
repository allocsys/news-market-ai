"use client";

import { cn } from "@/lib/utils";

interface StatCardProps {
  value: string;
  label: string;
  sub?: string;
  accent?: "blue" | "emerald" | "amber" | "red" | "purple";
  className?: string;
}

const ACCENTS: Record<string, string> = {
  blue: "var(--chart-1)",
  emerald: "var(--chart-2)",
  amber: "var(--chart-3)",
  red: "var(--chart-4)",
  purple: "var(--chart-5)",
};

export function StatCard({ value, label, sub, accent = "blue", className }: StatCardProps) {
  const color = ACCENTS[accent];
  return (
    <div
      className={cn(
        "relative rounded-xl border border-border bg-card p-4 overflow-hidden",
        "transition-colors hover:border-foreground/20",
        className
      )}
    >
      <div className="absolute top-0 left-0 right-0 h-0.5" style={{ background: color }} aria-hidden />
      <div
        className="absolute -top-12 -right-12 size-32 rounded-full opacity-10 blur-2xl pointer-events-none"
        style={{ background: color }}
        aria-hidden
      />
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-1.5 text-2xl font-semibold tracking-tight tabular">{value}</div>
      {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

interface MiniStatsProps {
  items: { label: string; value: string; sub?: string; accent?: "blue" | "emerald" | "amber" | "red" | "purple" }[];
  cols?: number;
  className?: string;
}

export function MiniStats({ items, cols = 4, className }: MiniStatsProps) {
  return (
    <div
      className={cn("grid gap-3", className)}
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
    >
      {items.map((it) => (
        <div
          key={it.label}
          className="rounded-lg border border-border bg-card/60 p-3"
        >
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {it.label}
          </div>
          <div
            className="mt-1 text-lg font-semibold tabular"
            style={{
              color:
                it.accent === "emerald"
                  ? "var(--chart-2)"
                  : it.accent === "red"
                  ? "var(--chart-4)"
                  : it.accent === "amber"
                  ? "var(--chart-3)"
                  : "var(--foreground)",
            }}
          >
            {it.value}
          </div>
          {it.sub && <div className="text-[10px] text-muted-foreground mt-0.5">{it.sub}</div>}
        </div>
      ))}
    </div>
  );
}
