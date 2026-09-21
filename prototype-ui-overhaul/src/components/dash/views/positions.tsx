"use client";

import { useState, useMemo } from "react";
import { useDash } from "@/lib/dash/store";
import {
  OPEN_POSITIONS, CLOSED_POSITIONS, fmtPct, fmtRelativeTime,
} from "@/lib/dash/mock-data";
import { Panel, PageHeader, FilterPills } from "../shared/primitives";
import { StatusBadge } from "../shared/status-badge";
import { MiniStats } from "../shared/stat-card";
import { DonutChart, DonutLegend } from "../shared/donut-chart";
import { GaugeChart } from "../shared/gauge-chart";
import { DataTable, type Column } from "../shared/data-table";
import { EmptyState } from "../shared/empty-state";
import { Briefcase } from "lucide-react";
import type { Position } from "@/lib/dash/types";

const STATUS_PILLS = [
  { value: "all", label: "All" },
  { value: "long", label: "Long" },
  { value: "short", label: "Short" },
];

function positionCols(): Column<Position>[] {
  return [
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
      key: "opened", header: "Opened",
      cell: (p) => <span className="text-xs text-muted-foreground tabular">{fmtRelativeTime(p.opened)}</span>,
      rawValue: (p) => p.opened,
    },
    {
      key: "closed", header: "Closed",
      cell: (p) => p.closed ? <span className="text-xs text-muted-foreground tabular">{fmtRelativeTime(p.closed)}</span> : <span className="text-muted-foreground">open</span>,
      rawValue: (p) => p.closed,
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
        <span className={p.pnlPct >= 0 ? "text-emerald-500 tabular font-medium" : "text-red-500 tabular font-medium"}>
          {fmtPct(p.pnlPct)}
        </span>
      ),
      rawValue: (p) => p.pnlPct,
    },
    {
      key: "reason", header: "Exit reason",
      cell: (p) => p.exitReason ? <span className="text-xs capitalize">{p.exitReason.replace("_", " ")}</span> : <span className="text-muted-foreground">—</span>,
      rawValue: (p) => p.exitReason,
    },
  ];
}

export function PositionsView() {
  const tickerFilter = useDash((s) => s.tickerFilter);
  const tick = tickerFilter;
  const [dirFilter, setDirFilter] = useState("all");

  const openFiltered = useMemo(() => {
    let list = OPEN_POSITIONS;
    if (tick) list = list.filter((p) => p.ticker === tick);
    if (dirFilter !== "all") list = list.filter((p) => p.direction === dirFilter);
    return list;
  }, [tick, dirFilter]);

  const closedFiltered = useMemo(() => {
    let list = CLOSED_POSITIONS;
    if (tick) list = list.filter((p) => p.ticker === tick);
    if (dirFilter !== "all") list = list.filter((p) => p.direction === dirFilter);
    return list;
  }, [tick, dirFilter]);

  const longCount = openFiltered.filter((p) => p.direction === "long").length;
  const shortCount = openFiltered.length - longCount;
  const composition = [
    { label: "Long", value: longCount, color: "var(--chart-2)" },
    { label: "Short", value: shortCount, color: "var(--chart-4)" },
  ];

  const exposurePct = openFiltered.reduce((s, p) => s + p.sizePct, 0);
  const exposureFrac = Math.min(exposurePct / 100, 1);
  const exposureAccent = exposurePct < 50 ? "var(--chart-2)" : exposurePct < 80 ? "var(--chart-3)" : "var(--chart-4)";

  // Closed stats
  const closedWins = closedFiltered.filter((p) => (p.pnlPct ?? 0) > 0).length;
  const closedLosses = closedFiltered.length - closedWins;
  const exitReasons = closedFiltered.reduce<Record<string, number>>((acc, p) => {
    if (p.exitReason) acc[p.exitReason] = (acc[p.exitReason] ?? 0) + 1;
    return acc;
  }, {});
  const exitSegments = Object.entries(exitReasons).map(([k, v], i) => ({
    label: k.replace(/_/g, " "),
    value: v,
    color: `var(--chart-${(i % 5) + 1})`,
  }));

  const cols = positionCols();

  return (
    <div className="space-y-6">
      <PageHeader
        title={tick ? `Positions · ${tick}` : "Positions"}
        description={
          tick
            ? `Open and recently closed positions for ${tick}.`
            : "Open and recently closed positions. All exit reasons are LLM-decided (target, stop, signal_off, timeout, manual)."
        }
        actions={<FilterPills pills={STATUS_PILLS} value={dirFilter} onChange={setDirFilter} ariaLabel="Direction filter" />}
      />

      <Panel title="Open positions" count={openFiltered.length}>
        {openFiltered.length === 0 ? (
          <EmptyState
            icon={<Briefcase className="size-5" />}
            title="No open positions"
            description={`No open positions match this filter. The pipeline will open new ones when it approves a trade.`}
          />
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <div className="flex items-center gap-4 rounded-xl border border-border bg-card p-4">
                <DonutChart segments={composition} centerValue={String(openFiltered.length)} centerLabel="open" size={120} />
                <DonutLegend segments={composition} className="flex-1" />
              </div>
              <div className="rounded-xl border border-border bg-card p-4 flex flex-col items-center justify-center">
                <GaugeChart value={exposureFrac} valueLabel={`${exposurePct.toFixed(1)}%`} label="total exposure" accent={exposureAccent} />
              </div>
              <div className="rounded-xl border border-border bg-card p-4">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Open book stats</div>
                <MiniStats cols={2} items={[
                  { label: "Longs", value: String(longCount), accent: "emerald" },
                  { label: "Shorts", value: String(shortCount), accent: "red" },
                  { label: "Avg size", value: `${(openFiltered.reduce((s, p) => s + p.sizePct, 0) / openFiltered.length).toFixed(1)}%` },
                  { label: "Unrealized", value: fmtPct(openFiltered.reduce((s, p) => s + (p.pnlPct ?? 0), 0) / openFiltered.length) },
                ]} />
              </div>
            </div>
            <DataTable
              columns={cols}
              rows={openFiltered}
              filename={`open-positions${tick ? `-${tick}` : ""}`}
            />
          </div>
        )}
      </Panel>

      <Panel title="Recently closed" count={closedFiltered.length}>
        {closedFiltered.length === 0 ? (
          <EmptyState
            icon={<Briefcase className="size-5" />}
            title="No closed positions"
            description={`No closed positions match this filter.`}
          />
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="rounded-xl border border-border bg-card p-4">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Exit reasons</div>
                <div className="flex items-center gap-4">
                  <DonutChart segments={exitSegments} centerValue={String(closedFiltered.length)} centerLabel="exits" size={110} />
                  <DonutLegend segments={exitSegments} className="flex-1" />
                </div>
              </div>
              <div className="rounded-xl border border-border bg-card p-4">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Exit quality</div>
                <MiniStats cols={2} items={[
                  { label: "Wins", value: String(closedWins), accent: "emerald" },
                  { label: "Losses", value: String(closedLosses), accent: "red" },
                  { label: "Win rate", value: `${((closedWins / closedFiltered.length) * 100).toFixed(0)}%` },
                  { label: "Avg P&L", value: fmtPct(closedFiltered.reduce((s, p) => s + (p.pnlPct ?? 0), 0) / closedFiltered.length) },
                ]} />
              </div>
            </div>
            <DataTable
              columns={cols}
              rows={closedFiltered}
              filename={`closed-positions${tick ? `-${tick}` : ""}`}
            />
          </div>
        )}
      </Panel>
    </div>
  );
}
