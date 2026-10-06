"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronUp, Wallet, Activity, Loader2 } from "lucide-react";
import { usePositions } from "@/lib/api";
import { RISK_CEILINGS } from "@/lib/mock-data";
import { SectionHeading, StatCard, MiniStat, Pill, EmptyState, ErrorState } from "../primitives";
import { OpenPositionCard, ClosedPositionCard } from "../position-cards";
import { DonutChart, Gauge, Sparkline } from "../charts";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { fmtPct, signedPct } from "@/lib/format";
import type { ViewProps } from "./types";

const POSITIONS_LIMIT_OPTIONS = [10, 25, 50, 100];

export function PositionsView({ env }: ViewProps) {
  const [openLimit, setOpenLimit] = useState(50);
  const [showCharts, setShowCharts] = useState(false);
  const positions = usePositions(env, openLimit);

  if (positions.isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading positions…
      </div>
    );
  }

  if (positions.isError || !positions.data) {
    return <ErrorState message={positions.error?.message ?? "Failed to load positions"} />;
  }

  const d = positions.data;
  const open = d.openPositions;
  const closed = d.closedPositions;

  const longCount = open.filter((p) => p.direction === "long").length;
  const shortCount = open.filter((p) => p.direction === "short").length;

  const closedTp = closed.filter((p) => p.closeReason === "take_profit").length;
  const closedSl = closed.filter((p) => p.closeReason === "stop_loss").length;
  const closedOther = closed.length - closedTp - closedSl;

  const exposurePctOfCeiling = (d.totalExposurePct / RISK_CEILINGS.maxPortfolioRiskPct) * 100;
  const exposureTone = exposurePctOfCeiling > 80 ? "short" : exposurePctOfCeiling > 50 ? "paused" : "default";

  return (
    <div className="space-y-5">
      {d.openPositionsError && <ErrorState message={d.openPositionsError} />}

      {/* Exposure hero */}
      <section className="rounded-2xl border border-border bg-card p-5 card-hairline">
        <div className="flex items-center gap-2">
          <Wallet className="h-4 w-4 text-muted-foreground" aria-hidden />
          <h2 className="font-display text-lg font-semibold tracking-tight">Open exposure</h2>
          <Pill tone={exposureTone === "short" ? "short" : exposureTone === "paused" ? "paused" : "long"} size="sm">
            {exposurePctOfCeiling > 80 ? "high" : exposurePctOfCeiling > 50 ? "moderate" : "low"}
          </Pill>
        </div>
        <div className="mt-4 flex flex-col items-center gap-6 sm:flex-row sm:items-start">
          <Gauge
            value={exposurePctOfCeiling}
            min={0}
            max={100}
            valueLabel={fmtPct(d.totalExposurePct, 1)}
            label={`of ${fmtPct(RISK_CEILINGS.maxPortfolioRiskPct, 0)} ceiling`}
            accent={
              exposureTone === "short"
                ? "var(--short)"
                : exposureTone === "paused"
                  ? "var(--paused)"
                  : "var(--primary)"
            }
          />
          <div className="grid flex-1 grid-cols-2 gap-3 sm:grid-cols-4">
            <MiniStat value={open.length} label="Open positions" sub={`${longCount} long · ${shortCount} short`} />
            <MiniStat value={fmtPct(d.totalExposurePct, 1)} label="Gross exposure" sub="sum of position sizes" />
            <MiniStat
              value={fmtPct(RISK_CEILINGS.maxPortfolioStopRiskPct, 2)}
              label="Loss-at-stop ceiling"
              sub="max portfolio stop risk"
            />
            <MiniStat value={fmtPct(RISK_CEILINGS.maxGroupExposurePct, 0)} label="Group cap" sub="same-direction per group" />
          </div>
        </div>
      </section>

      {/* Open positions */}
      <section>
        <SectionHeading
          title="Open positions"
          description={`${open.length} open · sorted by opened-at`}
          action={<LimitPicker value={openLimit} options={POSITIONS_LIMIT_OPTIONS} onChange={setOpenLimit} label="rows" />}
        />
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {open.slice(0, openLimit).map((p, i) => (
            <OpenPositionCard key={`${p.ticker}-${i}`} position={p} />
          ))}
        </div>
        {open.length === 0 && (
          <EmptyState
            icon={Wallet}
            title="No open positions"
            message="When the pipeline opens a position it will appear here."
          />
        )}
      </section>

      {/* Recently closed */}
      <section>
        <SectionHeading
          title="Recently closed"
          description={`${closed.length} closed in the last 20 exits`}
        />
        {d.closedPositionsError ? (
          <ErrorState message={d.closedPositionsError} />
        ) : (
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {closed.map((p, i) => (
              <ClosedPositionCard key={`${p.ticker}-${i}`} position={p} />
            ))}
          </div>
        )}
      </section>

      {/* Charts & exit quality (collapsible) */}
      <Collapsible open={showCharts} onOpenChange={setShowCharts}>
        <section className="rounded-xl border border-border bg-card">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center gap-2 px-4 py-3 text-left"
            >
              <Activity className="h-4 w-4 text-muted-foreground" aria-hidden />
              <span className="text-sm font-medium">Charts and exit stats</span>
              <Pill tone="muted" size="sm">{closed.length} closed</Pill>
              <span className="ml-auto">
                {showCharts ? (
                  <ChevronUp className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                )}
              </span>
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="space-y-4 border-t border-border p-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <p className="mb-2 text-xs font-medium text-muted-foreground">Open direction</p>
                  <DonutChart
                    segments={[
                      { value: longCount, color: "var(--long)", label: "Long" },
                      { value: shortCount, color: "var(--short)", label: "Short" },
                    ]}
                    centerValue={open.length}
                    centerLabel="open"
                    size={120}
                  />
                </div>
                <div>
                  <p className="mb-2 text-xs font-medium text-muted-foreground">Close reasons (last 20)</p>
                  <DonutChart
                    segments={[
                      { value: closedTp, color: "var(--long)", label: "Take profit" },
                      { value: closedSl, color: "var(--short)", label: "Stop loss" },
                      { value: closedOther, color: "var(--muted-foreground)", label: "Other" },
                    ]}
                    centerValue={closed.length}
                    centerLabel="closed"
                    size={120}
                  />
                </div>
              </div>

              <div>
                <p className="mb-2 text-xs font-medium text-muted-foreground">Exit quality</p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <MiniStat value={closedTp} label="Take profit" sub="winning exits" />
                  <MiniStat value={closedSl} label="Stop loss" sub="losing exits" />
                  <MiniStat
                    value={closedTp + closedSl > 0 ? `${((closedTp / (closedTp + closedSl)) * 100).toFixed(0)}%` : "—"}
                    label="TP / SL ratio"
                    sub="win rate (closed)"
                  />
                  <MiniStat
                    value={fmtPct(open.length + closed.length > 0 ? open.length / (open.length + closed.length) : 0, 0)}
                    label="Still open"
                    sub="of total"
                  />
                </div>
              </div>
            </div>
          </CollapsibleContent>
        </section>
      </Collapsible>
    </div>
  );
}

function LimitPicker({
  value,
  options,
  onChange,
  label,
}: {
  value: number;
  options: number[];
  onChange: (v: number) => void;
  label: string;
}) {
  return (
    <div className="flex items-center gap-1 rounded-md border border-border bg-card p-0.5 text-xs">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => onChange(opt)}
          className={cn(
            "rounded px-2 py-0.5 font-mono nums transition-colors",
            opt === value
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {opt}
        </button>
      ))}
      <span className="ml-1 text-[10px] text-muted-foreground">{label}</span>
    </div>
  );
}
