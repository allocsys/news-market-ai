"use client";

import { useState, useEffect } from "react";
import { useDash } from "@/lib/dash/store";
import {
  DECISIONS, OPEN_POSITIONS, CLOSED_POSITIONS, TOTAL_EXPOSURE_PCT,
  fmtPct, fmtRelativeTime,
} from "@/lib/dash/mock-data";
import { StatCard } from "../shared/stat-card";
import { Panel, PageHeader } from "../shared/primitives";
import { StatusBadge } from "../shared/status-badge";
import { DonutChart, DonutLegend } from "../shared/donut-chart";
import { GaugeChart } from "../shared/gauge-chart";
import { DataTable, type Column } from "../shared/data-table";
import { EmptyState } from "../shared/empty-state";
import { Briefcase } from "lucide-react";
import type { Position } from "@/lib/dash/types";

export function SnapshotView() {
  const tickerFilter = useDash((s) => s.tickerFilter);
  const tick = tickerFilter;

  const openPositions = tick ? OPEN_POSITIONS.filter((p) => p.ticker === tick) : OPEN_POSITIONS;
  const closedPositions = tick ? CLOSED_POSITIONS.filter((p) => p.ticker === tick) : CLOSED_POSITIONS;
  const decisions = tick ? DECISIONS.filter((d) => d.ticker === tick) : DECISIONS;

  const longCount = openPositions.filter((p) => p.direction === "long").length;
  const shortCount = openPositions.filter((p) => p.direction === "short").length;
  const composition = [
    { label: "Long", value: longCount, color: "var(--chart-2)" },
    { label: "Short", value: shortCount, color: "var(--chart-4)" },
  ];

  const exposurePct = openPositions.reduce((s, p) => s + p.sizePct, 0);
  const exposureFrac = Math.min(exposurePct / 100, 1);
  const exposureAccent = exposurePct < 50 ? "var(--chart-2)" : exposurePct < 80 ? "var(--chart-3)" : "var(--chart-4)";

  const approved = decisions.filter((d) => d.status === "approved").length;
  const rejected = decisions.filter((d) => d.status === "rejected").length;
  const approvalRate = decisions.length ? approved / decisions.length : 0;
  const approval = [
    { label: "Approved", value: approved, color: "var(--chart-2)" },
    { label: "Rejected", value: rejected, color: "var(--chart-4)" },
  ];

  const cols: Column<Position>[] = [
    {
      key: "ticker", header: "Ticker", mobileFullWidth: true,
      cell: (p) => <span className="font-medium">{p.ticker}</span>,
      rawValue: (p) => p.ticker,
    },
    {
      key: "direction", header: "Dir",
      cell: (p) => <StatusBadge kind={p.direction} />,
      rawValue: (p) => p.direction,
    },
    {
      key: "size", header: "Size",
      cell: (p) => <span className="tabular">{p.sizePct}%</span>,
      rawValue: (p) => p.sizePct,
    },
    {
      key: "entry", header: "Entry",
      cell: (p) => <span className="tabular">${p.entry.toFixed(2)}</span>,
      rawValue: (p) => p.entry,
    },
    {
      key: "exit", header: "Exit",
      cell: (p) => p.exit ? <span className="tabular">${p.exit.toFixed(2)}</span> : <span className="text-muted-foreground">—</span>,
      rawValue: (p) => p.exit,
    },
    {
      key: "pnl", header: "P&L",
      cell: (p) => p.pnlPct == null ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        <span className={p.pnlPct >= 0 ? "text-emerald-500 tabular" : "text-red-500 tabular"}>
          {fmtPct(p.pnlPct)}
        </span>
      ),
      rawValue: (p) => p.pnlPct,
    },
    {
      key: "closed", header: "Closed",
      cell: (p) => p.closed ? fmtRelativeTime(p.closed) : <span className="text-muted-foreground">open</span>,
      rawValue: (p) => p.closed,
    },
    {
      key: "reason", header: "Exit reason",
      cell: (p) => p.exitReason ? <span className="text-xs capitalize">{p.exitReason.replace("_", " ")}</span> : <span className="text-muted-foreground">—</span>,
      rawValue: (p) => p.exitReason,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={tick ? `Snapshot · ${tick}` : "Snapshot"}
        description={
          tick
            ? `Live book state scoped to ${tick}: open exposure, all-time approval, recently closed for this ticker.`
            : "Live state of the book right now: open positions, total exposure, and the all-time approval rate of trade decisions. All three panels re-read on each refresh."
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
        <StatCard value={`${openPositions.length}`} label="Open positions" sub={`${longCount} long · ${shortCount} short`} accent="blue" />
        <StatCard value={`${exposurePct.toFixed(1)}%`} label="Total exposure" sub={exposurePct < 50 ? "conservative" : exposurePct < 80 ? "moderate" : "high"} accent={exposurePct < 50 ? "emerald" : exposurePct < 80 ? "amber" : "red"} />
        <StatCard value={`${(approvalRate * 100).toFixed(0)}%`} label="Approval rate" sub={`${approved} of ${decisions.length}`} accent="emerald" />
        <StatCard value={`${closedPositions.length}`} label="Recently closed" sub={closedPositions[0]?.closed ? `last ${fmtRelativeTime(closedPositions[0].closed)}` : "—"} accent="purple" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 md:gap-4">
        <Panel title="Book composition" subtitle="Open positions by direction">
          <div className="flex items-center gap-4">
            <DonutChart segments={composition} centerValue={String(openPositions.length)} centerLabel="open" size={130} />
            <DonutLegend segments={composition} className="flex-1" />
          </div>
        </Panel>
        <Panel title="Open exposure" subtitle="Sum of position size %">
          <GaugeChart value={exposureFrac} valueLabel={`${exposurePct.toFixed(1)}%`} label="total exposure" accent={exposureAccent} />
          <div className="text-[11px] text-muted-foreground text-center -mt-2">
            {exposurePct < 50 ? "Below conservative band — room to add risk." : exposurePct < 80 ? "Moderate band — flag for review at next decision tick." : "High band — new entries throttled."}
          </div>
        </Panel>
        <Panel title="Decision outcomes" subtitle="All-time, all statuses">
          <div className="flex items-center gap-4">
            <DonutChart segments={approval} centerValue={`${(approvalRate * 100).toFixed(0)}%`} centerLabel="approval" size={130} />
            <DonutLegend segments={approval} className="flex-1" />
          </div>
        </Panel>
      </div>

      <Panel
        title="Recently closed"
        subtitle="Last 6 closed positions"
        count={closedPositions.length}
      >
        {closedPositions.length === 0 ? (
          <EmptyState
            icon={<Briefcase className="size-5" />}
            title="No closed positions yet"
            description={`No positions have closed${tick ? ` for ${tick}` : ""}. Open positions will appear here once they exit.`}
          />
        ) : (
          <DataTable
            columns={cols}
            rows={closedPositions.slice(0, 6)}
            filename={`closed-positions${tick ? `-${tick}` : ""}`}
          />
        )}
      </Panel>
    </div>
  );
}
