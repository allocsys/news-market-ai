"use client";

import { Loader2, BarChart3 } from "lucide-react";
import { useCharts } from "@/lib/api";
import { SectionHeading, Pill, EmptyState, ErrorState } from "../primitives";
import { Sparkline } from "../charts";
import type { ViewProps } from "./types";

export function ChartsView({ env }: ViewProps) {
  const charts = useCharts(env);

  if (charts.isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading charts…
      </div>
    );
  }
  if (charts.isError || !charts.data) {
    return <ErrorState message={charts.error?.message ?? "Failed to load charts"} />;
  }

  const entries = Object.entries(charts.data.priceBarsByTicker);
  if (entries.length === 0) {
    return (
      <EmptyState
        icon={BarChart3}
        title="No charts"
        message="Charts appear when there are open positions to track."
      />
    );
  }

  return (
    <div className="space-y-5">
      <section>
        <SectionHeading
          title="Price sparklines"
          description="Last 30 daily closes per open-position ticker"
        />
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {entries.map(([ticker, bars]) => {
            const values = bars.map((b) => b.close);
            const last = values[values.length - 1];
            const first = values[0];
            const change = (last - first) / first;
            const up = change >= 0;
            return (
              <div key={ticker} className="rounded-xl border border-border bg-card p-4 card-hairline">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-mono text-base font-semibold">{ticker}</p>
                    <p className="font-mono text-xs text-muted-foreground nums">${last.toFixed(2)}</p>
                  </div>
                  <Pill tone={up ? "long" : "short"} size="sm">
                    {up ? "+" : ""}{(change * 100).toFixed(2)}%
                  </Pill>
                </div>
                <div className="mt-3">
                  <Sparkline
                    values={values}
                    width={320}
                    height={64}
                    className="w-full"
                    stroke={up ? "var(--long)" : "var(--short)"}
                    fill={up ? "color-mix(in oklch, var(--long) 14%, transparent)" : "color-mix(in oklch, var(--short) 14%, transparent)"}
                  />
                </div>
                <div className="mt-2 flex items-center justify-between text-[10px] text-muted-foreground">
                  <span>{bars[0]?.date ?? "—"}</span>
                  <span>30-day</span>
                  <span>{bars[bars.length - 1]?.date ?? "—"}</span>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
