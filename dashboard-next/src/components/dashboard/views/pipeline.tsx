"use client";

import { useMemo } from "react";
import { Loader2 } from "lucide-react";
import { usePipeline } from "@/lib/api";
import { SectionHeading, StatusDot, Pill, EmptyState, ErrorState } from "../primitives";
import { fmtRelative, stageLabel } from "@/lib/format";
import type { ViewProps } from "./types";

const STAGE_ORDER = ["ingested", "analysed", "debated", "trade_decided", "exit_check"];

export function PipelineView({ env }: ViewProps) {
  const pipeline = usePipeline(env);

  // Aggregate by stage for the distribution panel
  const stageDistribution = useMemo(() => {
    if (!pipeline.data) return [];
    const map = new Map<string, number>();
    for (const row of pipeline.data.tickerStages) {
      map.set(row.stage, (map.get(row.stage) ?? 0) + row.count);
    }
    const arr = Array.from(map.entries()).map(([stage, count]) => ({ stage, count }));
    arr.sort((a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage));
    return arr;
  }, [pipeline.data]);

  const byTicker = useMemo(() => {
    if (!pipeline.data) return [];
    const map = new Map<string, typeof pipeline.data.tickerStages>();
    for (const row of pipeline.data.tickerStages) {
      if (!map.has(row.ticker)) map.set(row.ticker, []);
      map.get(row.ticker)!.push(row);
    }
    return Array.from(map.entries()).map(([ticker, rows]) => ({
      ticker,
      rows: rows.slice().sort((a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage)),
      total: rows.reduce((s, r) => s + r.count, 0),
      lastUpdated: rows.reduce((max, r) => (r.updated_at > max ? r.updated_at : max), rows[0]?.updated_at ?? ""),
    }));
  }, [pipeline.data]);

  if (pipeline.isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading pipeline…
      </div>
    );
  }
  if (pipeline.isError || !pipeline.data) {
    return <ErrorState message={pipeline.error?.message ?? "Failed to load pipeline"} />;
  }

  const d = pipeline.data;

  const maxStageCount = Math.max(1, ...stageDistribution.map((s) => s.count));

  return (
    <div className="space-y-5">
      <section>
        <SectionHeading title="Stage distribution" description="Pipeline activity across all tickers" />
        <div className="mt-3 space-y-2 rounded-xl border border-border bg-card p-4">
          {stageDistribution.map((s) => (
            <div key={s.stage} className="flex items-center gap-3">
              <span className="w-28 shrink-0 text-xs text-muted-foreground">
                {stageLabel(s.stage)}
              </span>
              <div className="h-6 flex-1 overflow-hidden rounded-md bg-muted/30">
                <div
                  className="h-full rounded-md bg-primary/60 transition-all"
                  style={{ width: `${(s.count / maxStageCount) * 100}%` }}
                />
              </div>
              <span className="w-12 shrink-0 text-right font-mono text-xs nums">
                {s.count}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section>
        <SectionHeading title="Recent checkpoints" description="Latest activity per ticker" />
        <div className="mt-3 overflow-hidden rounded-xl border border-border bg-card">
          <ul className="divide-y divide-border">
            {d.checkpoints.slice(0, 12).map((c, i) => (
              <li key={i} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                <StatusDot status={c.status === "ok" ? "ok" : "stale"} />
                <span className="font-mono font-medium">{c.ticker}</span>
                <span className="text-muted-foreground">{c.lastStageLabel ?? stageLabel(c.stage)}</span>
                <span className="ml-auto font-mono text-[11px] nums text-muted-foreground">
                  {fmtRelative(c.updated_at)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section>
        <SectionHeading title="By ticker" description="Stage counts per ticker" />
        {byTicker.length === 0 ? (
          <div className="mt-3">
            <EmptyState title="No pipeline activity" message="Run an ingestion to see checkpoints here." />
          </div>
        ) : (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {byTicker.map(({ ticker, rows, total, lastUpdated }) => (
              <div key={ticker} className="rounded-xl border border-border bg-card p-3 card-hairline">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-base font-semibold">{ticker}</span>
                    <Pill tone="muted" size="sm">{total} actions</Pill>
                  </div>
                  <span className="text-[10px] text-muted-foreground">
                    {fmtRelative(lastUpdated)}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {rows.map((r, i) => (
                    <span
                      key={i}
                      className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-[10px]"
                    >
                      <span className="text-muted-foreground">{stageLabel(r.stage)}</span>
                      <span className="font-mono nums font-medium">{r.count}</span>
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
