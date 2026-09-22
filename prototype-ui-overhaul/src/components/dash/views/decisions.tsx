"use client";

import { useState, useMemo } from "react";
import { useDash } from "@/lib/dash/store";
import { DECISIONS, fmtPct, fmtRelativeTime } from "@/lib/dash/mock-data";
import { Panel, PageHeader, FilterPills } from "../shared/primitives";
import { StatusBadge } from "../shared/status-badge";
import { DonutChart, DonutLegend } from "../shared/donut-chart";
import { DataTable, type Column } from "../shared/data-table";
import { EmptyState } from "../shared/empty-state";
import { ChevronRight, GitPullRequestArrow } from "lucide-react";
import type { Decision } from "@/lib/dash/types";

const STATUS_PILLS = [
  { value: "all", label: "All" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
];

const ROW_PILLS = [
  { value: "10", label: "10" },
  { value: "20", label: "20" },
  { value: "50", label: "50" },
  { value: "100", label: "100" },
];

export function DecisionsView() {
  const tickerFilter = useDash((s) => s.tickerFilter);
  const tick = tickerFilter;
  const [status, setStatus] = useState("all");
  const [rows, setRows] = useState("20");
  const [expanded, setExpanded] = useState<string | null>(null);

  const filtered = useMemo(() => {
    let list = DECISIONS;
    if (tick) list = list.filter((d) => d.ticker === tick);
    if (status !== "all") list = list.filter((d) => d.status === status);
    return list.slice(0, parseInt(rows, 10));
  }, [tick, status, rows]);

  const approved = filtered.filter((d) => d.status === "approved").length;
  const rejected = filtered.length - approved;
  const directionLong = filtered.filter((d) => d.direction === "long").length;
  const directionShort = filtered.length - directionLong;

  const approval = [
    { label: "Approved", value: approved, color: "var(--chart-2)" },
    { label: "Rejected", value: rejected, color: "var(--chart-4)" },
  ];
  const direction = [
    { label: "Long", value: directionLong, color: "var(--chart-2)" },
    { label: "Short", value: directionShort, color: "var(--chart-4)" },
  ];

  const cols: Column<Decision>[] = [
    {
      key: "expand", header: "",
      cell: (d) => (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((p) => (p === d.id ? null : d.id));
          }}
          className="size-6 grid place-items-center rounded hover:bg-muted"
          aria-label="Toggle reasoning"
        >
          <ChevronRight
            className={`size-3.5 transition-transform ${expanded === d.id ? "rotate-90" : ""}`}
          />
        </button>
      ),
      className: "w-8",
      hideOnMobile: true,
    },
    {
      key: "ticker", header: "Ticker", mobileFullWidth: true,
      cell: (d) => <span className="font-medium">{d.ticker}</span>,
      rawValue: (d) => d.ticker,
    },
    {
      key: "direction", header: "Dir",
      cell: (d) => <StatusBadge kind={d.direction} />,
      rawValue: (d) => d.direction,
    },
    {
      key: "status", header: "Status",
      cell: (d) => <StatusBadge kind={d.status} />,
      rawValue: (d) => d.status,
    },
    {
      key: "size", header: "Size",
      cell: (d) => <span className="tabular">{d.sizePct > 0 ? `${d.sizePct}%` : "—"}</span>,
      rawValue: (d) => d.sizePct,
    },
    {
      key: "confidence", header: "Confidence",
      cell: (d) => <span className="tabular">{d.confidence.toFixed(2)}</span>,
      rawValue: (d) => d.confidence,
    },
    {
      key: "agent", header: "Agent",
      cell: (d) => <span className="text-xs font-mono text-muted-foreground">{d.agent}</span>,
      rawValue: (d) => d.agent,
    },
    {
      key: "when", header: "When",
      cell: (d) => <span className="text-xs text-muted-foreground tabular">{fmtRelativeTime(d.when)}</span>,
      rawValue: (d) => d.when,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={tick ? `Decisions · ${tick}` : "Decisions"}
        description={
          tick
            ? `Trade decisions for ${tick}. Click any row to expand the LLM reasoning (analyst / bull / bear / verdict / trader).`
            : "Recent trade decisions from the pipeline. Click any row to expand the full LLM reasoning (analyst, bull/bear, verdict, trader)."
        }
        actions={
          <>
            <FilterPills pills={ROW_PILLS} value={rows} onChange={setRows} ariaLabel="Rows per page" />
            <FilterPills pills={STATUS_PILLS} value={status} onChange={setStatus} ariaLabel="Status filter" />
          </>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 md:gap-4">
        <Panel title="Approval outcomes" subtitle={`${filtered.length} decisions in current filter`}>
          <div className="flex items-center gap-4">
            <DonutChart
              segments={approval}
              centerValue={`${filtered.length ? Math.round((approved / filtered.length) * 100) : 0}%`}
              centerLabel="approval"
              size={130}
            />
            <DonutLegend segments={approval} className="flex-1" />
          </div>
        </Panel>
        <Panel title="Direction split" subtitle="Long vs short across current filter">
          <div className="flex items-center gap-4">
            <DonutChart
              segments={direction}
              centerValue={String(filtered.length)}
              centerLabel="decisions"
              size={130}
            />
            <DonutLegend segments={direction} className="flex-1" />
          </div>
        </Panel>
      </div>

      <Panel title="Decision log" subtitle="Click any row to expand LLM reasoning" count={filtered.length} flush>
        {filtered.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={<GitPullRequestArrow className="size-5" />}
              title="No decisions match this filter"
              description={`Try clearing the ${tick ? "ticker filter or " : ""}status pill to see more decisions.`}
            />
          </div>
        ) : (
          <>
            <DataTable
              columns={cols}
              rows={filtered}
              filename={`decisions${tick ? `-${tick}` : ""}-${status}`}
            />
            {expanded && (
              <ExpandedReasoning
                decision={filtered.find((d) => d.id === expanded)!}
              />
            )}
          </>
        )}
      </Panel>
    </div>
  );
}

function ExpandedReasoning({ decision }: { decision: Decision }) {
  if (!decision) return null;
  return (
    <div className="border-t border-border p-4 bg-muted/20 animate-slide-up">
      <div className="space-y-3 max-w-3xl">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
            Analyst · {decision.reasoning.analyst.sentiment}
          </div>
          <div className="text-sm">{decision.reasoning.analyst.note}</div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-emerald-500 mb-1">Bull case</div>
            <div className="text-sm">{decision.reasoning.bull}</div>
          </div>
          <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-red-500 mb-1">Bear case</div>
            <div className="text-sm">{decision.reasoning.bear}</div>
          </div>
        </div>
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Verdict</div>
          <div className="text-sm font-medium">{decision.reasoning.verdict}</div>
        </div>
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-primary mb-1">Trader action</div>
          <div className="text-sm">{decision.reasoning.trader}</div>
        </div>
      </div>
    </div>
  );
}
