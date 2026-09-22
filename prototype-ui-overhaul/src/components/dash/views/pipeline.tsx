"use client";

import { useDash } from "@/lib/dash/store";
import {
  PIPELINE_STAGES, PIPELINE_CHECKPOINTS, fmtRelativeTime,
} from "@/lib/dash/mock-data";
import { Panel, PageHeader } from "../shared/primitives";
import { StatusBadge } from "../shared/status-badge";
import { DataTable, type Column } from "../shared/data-table";
import { Workflow } from "lucide-react";
import { EmptyState } from "../shared/empty-state";
import type { PipelineCheckpoint } from "@/lib/dash/types";

export function PipelineView() {
  const tickerFilter = useDash((s) => s.tickerFilter);
  const tick = tickerFilter;
  const checkpoints = tick ? PIPELINE_CHECKPOINTS.filter((p) => p.ticker === tick) : PIPELINE_CHECKPOINTS;

  const maxCount = Math.max(...PIPELINE_STAGES.map((s) => s.count), 1);

  const cols: Column<PipelineCheckpoint>[] = [
    {
      key: "ticker", header: "Ticker", mobileFullWidth: true,
      cell: (p) => <span className="font-medium">{p.ticker}</span>,
      rawValue: (p) => p.ticker,
    },
    {
      key: "lastStage", header: "Last stage",
      cell: (p) => <span className="font-mono text-xs text-muted-foreground">{p.lastStage}</span>,
      rawValue: (p) => p.lastStage,
    },
    {
      key: "label", header: "Stage label",
      cell: (p) => p.lastStageLabel,
      rawValue: (p) => p.lastStageLabel,
    },
    {
      key: "updated", header: "Updated",
      cell: (p) => <span className="text-xs text-muted-foreground tabular">{fmtRelativeTime(p.updatedAt)}</span>,
      rawValue: (p) => p.updatedAt,
    },
    {
      key: "status", header: "Status",
      cell: (p) => <StatusBadge kind={p.status === "ok" ? "ok" : p.status === "stale" ? "stale" : "error"} />,
      rawValue: (p) => p.status,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={tick ? `Pipeline · ${tick}` : "Pipeline"}
        description="Per-ticker stage checkpoints across the 7-stage pipeline (ingest → fundamentals → analyst → debate → trader → exit_check). The distribution panel shows how many tickers are sitting at each stage right now."
      />

      <Panel title="Stage distribution" subtitle="How many tickers are at each pipeline stage">
        <div className="space-y-3">
          {PIPELINE_STAGES.map((stage) => {
            const pct = (stage.count / maxCount) * 100;
            return (
              <div key={stage.stage} className="grid grid-cols-12 gap-3 items-center">
                <div className="col-span-12 md:col-span-3">
                  <div className="font-mono text-xs text-muted-foreground">{stage.stage}</div>
                  <div className="text-sm font-medium">{stage.label}</div>
                </div>
                <div className="col-span-8 md:col-span-7">
                  <div className="h-7 rounded-md border border-border bg-muted/30 overflow-hidden">
                    <div
                      className="h-full bg-primary/70 rounded-md transition-all"
                      style={{ width: `${Math.max(pct, 2)}%` }}
                    >
                      <span className="text-[10px] text-white px-2 py-1 inline-block">
                        {stage.count.toLocaleString()} ticks
                      </span>
                    </div>
                  </div>
                </div>
                <div className="col-span-4 md:col-span-2 text-right">
                  <div className="text-xs tabular">{stage.avgMs}ms avg</div>
                  <div className="text-[10px] text-muted-foreground">{fmtRelativeTime(stage.lastAt)}</div>
                </div>
              </div>
            );
          })}
        </div>
      </Panel>

      <Panel title="Checkpoints" subtitle="Per-ticker last reached stage" count={checkpoints.length} flush>
        <div className="p-4">
          {checkpoints.length === 0 ? (
            <EmptyState
              icon={<Workflow className="size-5" />}
              title="No checkpoints for this filter"
              description={`No pipeline checkpoints for ${tick}. The ticker may not be in the active universe.`}
            />
          ) : (
            <DataTable columns={cols} rows={checkpoints} filename={`pipeline-checkpoints${tick ? `-${tick}` : ""}`} />
          )}
        </div>
      </Panel>
    </div>
  );
}
