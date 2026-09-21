"use client";

import {
  INGESTION_SOURCES, fmtRelativeTime,
} from "@/lib/dash/mock-data";
import { Panel, PageHeader } from "../shared/primitives";
import { StatusBadge } from "../shared/status-badge";
import { DataTable, type Column } from "../shared/data-table";
import { DonutChart, DonutLegend } from "../shared/donut-chart";
import { HeartPulse } from "lucide-react";
import { EmptyState } from "../shared/empty-state";
import type { IngestionSource } from "@/lib/dash/types";

const STALE_HOURS = 26;

export function HealthView() {
  const fresh = INGESTION_SOURCES.filter((s) => s.fresh).length;
  const stale = INGESTION_SOURCES.length - fresh;
  const segments = [
    { label: "Fresh", value: fresh, color: "var(--chart-2)" },
    { label: "Stale", value: stale, color: "var(--chart-3)" },
  ];

  const cols: Column<IngestionSource>[] = [
    {
      key: "source", header: "Source", mobileFullWidth: true,
      cell: (s) => <span className="font-mono text-xs">{s.source}</span>,
      rawValue: (s) => s.source,
    },
    {
      key: "label", header: "Label",
      cell: (s) => s.label,
      rawValue: (s) => s.label,
    },
    {
      key: "rows", header: "Rows",
      cell: (s) => <span className="tabular">{s.rows.toLocaleString()}</span>,
      rawValue: (s) => s.rows,
    },
    {
      key: "last", header: "Last ingested",
      cell: (s) => <span className="text-xs text-muted-foreground tabular">{fmtRelativeTime(s.lastIngested)}</span>,
      rawValue: (s) => s.lastIngested,
    },
    {
      key: "fresh", header: "Status",
      cell: (s) => <StatusBadge kind={s.fresh ? "ok" : "stale"} label={s.fresh ? "Fresh" : "Stale"} />,
      rawValue: (s) => (s.fresh ? "fresh" : "stale"),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Health"
        description={`Per-source ingestion freshness. "Stale" means no rows in the last ${STALE_HOURS} hours. If any source goes stale, the Overview's alert strip will flag it.`}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 md:gap-4">
        <Panel title="Fresh vs stale" subtitle={`${INGESTION_SOURCES.length} ingestion sources`}>
          <div className="flex items-center gap-4">
            <DonutChart
              segments={segments}
              centerValue={`${Math.round((fresh / INGESTION_SOURCES.length) * 100)}%`}
              centerLabel="fresh"
              size={130}
            />
            <DonutLegend segments={segments} className="flex-1" />
          </div>
        </Panel>

        <Panel title="Quick stats" className="lg:col-span-2">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="rounded-lg border border-border bg-card p-3">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Total sources</div>
              <div className="text-xl font-semibold tabular mt-1">{INGESTION_SOURCES.length}</div>
            </div>
            <div className="rounded-lg border border-border bg-card p-3">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Fresh</div>
              <div className="text-xl font-semibold tabular text-emerald-500 mt-1">{fresh}</div>
            </div>
            <div className="rounded-lg border border-border bg-card p-3">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Stale</div>
              <div className="text-xl font-semibold tabular text-amber-500 mt-1">{stale}</div>
            </div>
            <div className="rounded-lg border border-border bg-card p-3">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Total rows</div>
              <div className="text-xl font-semibold tabular mt-1">
                {INGESTION_SOURCES.reduce((s, x) => s + x.rows, 0).toLocaleString()}
              </div>
            </div>
          </div>
        </Panel>
      </div>

      <Panel title="Per-source freshness" flush>
        <div className="p-4">
          {stale > 0 && (
            <div className="mb-3 flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs">
              <HeartPulse className="size-4 text-amber-500 shrink-0 mt-0.5" />
              <div>
                <div className="font-medium text-amber-700 dark:text-amber-300">
                  {stale} source{stale > 1 ? "s are" : " is"} stale.
                </div>
                <div className="text-muted-foreground mt-0.5">
                  Trigger a backfill from the Operations menu to refresh — note that news backfills consume Finnhub API quota.
                </div>
              </div>
            </div>
          )}
          <DataTable
            columns={cols}
            rows={INGESTION_SOURCES}
            filename="ingestion-health"
            emptyState={
              <EmptyState
                icon={<HeartPulse className="size-5" />}
                title="No ingestion sources"
                description="The dashboard backend hasn't registered any ingestion sources yet."
              />
            }
          />
        </div>
      </Panel>
    </div>
  );
}
