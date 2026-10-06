"use client";

import { useState, useMemo } from "react";
import { cn } from "@/lib/utils";
import { Filter, ChevronRight, Loader2 } from "lucide-react";
import { useDecisions } from "@/lib/api";
import type { TradeDecisionStatus } from "@/lib/types";
import { SectionHeading, EmptyState, Pill, StatusBadge, ErrorState } from "../primitives";
import { VerdictCard } from "../verdict-card";
import { StackedBar } from "../charts";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { decisionStatusLabel, fmtRelative, fmtTime } from "@/lib/format";
import type { ViewProps } from "./types";

const STATUS_OPTIONS: (TradeDecisionStatus | "all")[] = [
  "all",
  "opened",
  "rejected",
  "superseded",
  "held",
  "pending_entry",
  "skipped_no_price_data",
  "skipped_no_fill",
  "skipped_irrelevant",
];

const LIMIT_OPTIONS = [10, 20, 50, 100];

const STATUS_VARIANT: Record<TradeDecisionStatus, "approved" | "rejected" | "neutral" | "paused" | "info"> = {
  opened: "approved",
  rejected: "rejected",
  superseded: "neutral",
  held: "paused",
  pending_entry: "info",
  skipped_no_price_data: "neutral",
  skipped_no_fill: "neutral",
  skipped_irrelevant: "neutral",
};

export function DecisionsView({ tickerFilter, onNavigate, env }: ViewProps & { tickerFilter?: string }) {
  const [status, setStatus] = useState<TradeDecisionStatus | "all">("all");
  const [limit, setLimit] = useState(20);
  const [filtersOpen, setFiltersOpen] = useState(Boolean(tickerFilter));

  const decisions = useDecisions({
    env,
    decisionStatus: status === "all" ? undefined : status,
    decisionLimit: limit,
  });

  const filtered = useMemo(() => {
    if (!decisions.data) return [];
    let out = decisions.data.decisions;
    if (tickerFilter) out = out.filter((d) => d.ticker === tickerFilter);
    return out;
  }, [decisions.data, tickerFilter]);

  if (decisions.isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading decisions…
      </div>
    );
  }
  if (decisions.isError || !decisions.data) {
    return <ErrorState message={decisions.error?.message ?? "Failed to load decisions"} />;
  }

  // Visible-slice stats
  const vTotal = filtered.length;
  const vOpened = filtered.filter((d) => d.status === "opened").length;
  const vRejected = filtered.filter((d) => d.status === "rejected").length;
  const vLong = filtered.filter((d) => d.thesis.direction === "long").length;
  const vShort = filtered.filter((d) => d.thesis.direction === "short").length;
  const vNeutral = vTotal - vLong - vShort;

  return (
    <div className="space-y-5">
      {/* Filters */}
      <Collapsible open={filtersOpen} onOpenChange={setFiltersOpen}>
        <div className="rounded-xl border border-border bg-card">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm"
            >
              <Filter className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
              <span className="font-medium">Filters</span>
              {(status !== "all" || tickerFilter) && (
                <Pill tone="info" size="sm">
                  {status !== "all" ? decisionStatusLabel(status) : "all statuses"}
                  {tickerFilter ? ` · ${tickerFilter}` : ""}
                </Pill>
              )}
              <span className="ml-auto text-xs text-muted-foreground">
                {filtered.length} shown
              </span>
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="space-y-3 border-t border-border p-4">
              <div>
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Status</p>
                <div className="no-scrollbar flex flex-wrap gap-1">
                  {STATUS_OPTIONS.map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      onClick={() => setStatus(opt)}
                      className={cn(
                        "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                        status === opt
                          ? "border-primary bg-primary/15 text-primary"
                          : "border-border bg-muted/40 text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {opt === "all" ? "All" : decisionStatusLabel(opt)}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Rows</p>
                <div className="flex items-center gap-1">
                  {LIMIT_OPTIONS.map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      onClick={() => setLimit(opt)}
                      className={cn(
                        "rounded-md border px-2.5 py-1 font-mono text-xs nums transition-colors",
                        limit === opt
                          ? "border-primary bg-primary/15 text-primary"
                          : "border-border bg-muted/40 text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {opt}
                    </button>
                  ))}
                  {tickerFilter && (
                    <button
                      type="button"
                      onClick={() => onNavigate("decisions")}
                      className="ml-auto text-xs text-primary hover:underline"
                    >
                      Clear ticker filter
                    </button>
                  )}
                </div>
              </div>
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>

      {/* Visible-slice summary */}
      <section>
        <SectionHeading title="Decisions" description="Visible-slice outcomes & directions" />
        <div className="mt-3 space-y-3 rounded-xl border border-border bg-card p-4">
          <div>
            <div className="mb-1 flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Outcome ({vTotal} shown)</span>
            </div>
            <StackedBar
              segments={[
                { value: vOpened, color: "var(--long)", label: "Opened" },
                { value: vRejected, color: "var(--short)", label: "Rejected" },
                { value: Math.max(0, vTotal - vOpened - vRejected), color: "var(--muted-foreground)", label: "Other" },
              ]}
            />
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Direction ({vTotal} shown)</span>
            </div>
            <StackedBar
              segments={[
                { value: vLong, color: "var(--long)", label: "Long" },
                { value: vShort, color: "var(--short)", label: "Short" },
                { value: vNeutral, color: "var(--muted-foreground)", label: "Neutral" },
              ]}
            />
          </div>
        </div>
      </section>

      {/* Decision feed */}
      <section>
        <SectionHeading title="Feed" description="Newest first; tap a card to see full verdict" />
        {filtered.length === 0 ? (
          <div className="mt-3">
            <EmptyState
              title="No decisions match"
              message="Try widening the status filter or clearing the ticker filter."
              action={
                <button
                  type="button"
                  onClick={() => onNavigate("decisions")}
                  className="text-sm text-primary hover:underline"
                >
                  Clear filters
                </button>
              }
            />
          </div>
        ) : (
          <ul className="mt-3 space-y-3">
            {filtered.map((d, i) => (
              <li key={`${d.ticker}-${i}`} className="animate-fade-up" style={{ animationDelay: `${i * 30}ms` }}>
                <DecisionCard decision={d} onNavigateLlm={() => onNavigate("llm", { ticker: d.ticker })} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function DecisionCard({
  decision,
  onNavigateLlm,
}: {
  decision: import("@/lib/types").TradeDecision;
  onNavigateLlm: () => void;
}) {
  const [open, setOpen] = useState(false);
  const variant = STATUS_VARIANT[decision.status];

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card card-hairline">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/40"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-base font-semibold">{decision.ticker}</span>
            <StatusBadge variant={variant} label={decisionStatusLabel(decision.status)} />
          </div>
          <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
            {decision.thesis.rationale ?? "—"}
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {fmtRelative(decision.createdAt)} · {fmtTime(decision.createdAt).split(" ")[0]}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className="font-mono text-sm font-semibold nums">
            {decision.riskDecision.positionSizePct > 0
              ? `${(decision.riskDecision.positionSizePct * 100).toFixed(1)}%`
              : "—"}
          </span>
          <span className="text-[10px] text-muted-foreground">size</span>
        </div>
        <ChevronRight
          className={cn("h-4 w-4 text-muted-foreground transition-transform", open && "rotate-90")}
          aria-hidden
        />
      </button>

      {open && (
        <div className="space-y-3 border-t border-border p-4">
          <VerdictCard decision={decision} />
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">Portfolio:</span>
            <span>{decision.portfolioDecision.reason}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">Risk:</span>
            <span>{decision.riskDecision.reason}</span>
          </div>
          <button
            type="button"
            onClick={onNavigateLlm}
            className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            View LLM calls for {decision.ticker} <ChevronRight className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  );
}
