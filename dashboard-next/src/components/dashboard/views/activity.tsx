"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";
import { useActivity } from "@/lib/api";
import { SectionHeading, MiniStat, ErrorState } from "../primitives";
import { DailyStackedBar } from "../charts";
import type { ViewProps } from "./types";

const DAYS_OPTIONS = [7, 14, 30, 60];

const STATUS_COLORS: Record<string, string> = {
  opened: "var(--long)",
  rejected: "var(--short)",
  superseded: "var(--muted-foreground)",
  held: "var(--paused)",
  pending_entry: "var(--info)",
  skipped_no_price_data: "var(--muted-foreground)",
  skipped_no_fill: "var(--muted-foreground)",
  skipped_irrelevant: "var(--muted-foreground)",
};

export function ActivityView({ env }: ViewProps) {
  const [days, setDays] = useState(14);
  const activity = useActivity(env, days);

  if (activity.isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading activity…
      </div>
    );
  }
  if (activity.isError || !activity.data) {
    return <ErrorState message={activity.error?.message ?? "Failed to load activity"} />;
  }

  const d = activity.data;
  // Slice to the window
  const now = new Date("2026-10-06T00:00:00Z");
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const sliced = d.decisionStats.daily.filter((row) => new Date(row.day) >= cutoff);

  const windowTotal = sliced.reduce((s, row) => s + row.count, 0);
  const totals = d.decisionStats.totals;
  const allTimeTotal = Object.values(totals).reduce((s, n) => s + n, 0);
  const allApproved = totals.opened ?? 0;
  const allRejected = totals.rejected ?? 0;
  const approvalRate = allTimeTotal > 0 ? (allApproved / allTimeTotal) * 100 : 0;

  return (
    <div className="space-y-5">
      <div>
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Window</p>
        <div className="flex gap-1">
          {DAYS_OPTIONS.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              className={cn(
                "rounded-md border px-2.5 py-1 font-mono text-xs nums transition-colors",
                days === d
                  ? "border-primary bg-primary/15 text-primary"
                  : "border-border bg-muted/40 text-muted-foreground hover:text-foreground",
              )}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      <section>
        <SectionHeading title="Summary" description="Window and all-time" />
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <MiniStat value={windowTotal} label={`Decisions in last ${days}d`} sub="window total" />
          <MiniStat value={allApproved} label="Approved (all-time)" sub="opened positions" />
          <MiniStat value={allRejected} label="Rejected (all-time)" sub="risk / portfolio" />
          <MiniStat value={`${approvalRate.toFixed(0)}%`} label="Approval rate" sub="all-time" />
        </div>
      </section>

      <section>
        <SectionHeading title="Daily decisions" description={`Stacked by status · last ${days} days`} />
        <div className="mt-3 rounded-xl border border-border bg-card p-4">
          <DailyStackedBar data={sliced} colorMap={STATUS_COLORS} height={160} />
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1.5">
            {Object.entries(STATUS_COLORS).map(([status, color]) => {
              const inWindow = sliced.filter((d) => d.status === status).reduce((s, d) => s + d.count, 0);
              if (inWindow === 0) return null;
              return (
                <div key={status} className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: color }} />
                  <span className="text-[11px] text-muted-foreground capitalize">{status.replace(/_/g, " ")}</span>
                  <span className="font-mono text-[11px] nums">{inWindow}</span>
                </div>
              );
            })}
          </div>
        </div>
      </section>
    </div>
  );
}
