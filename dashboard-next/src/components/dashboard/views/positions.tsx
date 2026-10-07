"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronUp, Wallet, Activity, Loader2 } from "lucide-react";
import { usePositions } from "@/lib/api";
import { resolveRiskLimits, exposureFraction, describeGroupCapOverrides } from "@/lib/risk";
import { SectionHeading, MiniStat, Pill, EmptyState, ErrorState } from "../primitives";
import { OpenPositionCard, ClosedPositionCard } from "../position-cards";
import { DonutChart, Gauge } from "../charts";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { fmtPct } from "@/lib/format";
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
  // Trailing and break-even stops are protective exits that often lock in a gain, so they get their own slice instead of hiding in "Other".
  const closedTrail = closed.filter((p) => p.closeReason === "trailing_stop" || p.closeReason === "breakeven_stop").length;
  const closedTime = closed.filter((p) => p.closeReason === "time_based").length;
  const closedOther = closed.length - closedTp - closedSl - closedTrail - closedTime;
  // Win rate from what each position actually returned (a stop can win and a target can lose after costs), over closes that have a return.
  const returned = closed.filter((p) => typeof p.realizedReturn === "number");
  const wins = returned.filter((p) => (p.realizedReturn as number) > 0).length;

  const limits = resolveRiskLimits(d.riskLimits);
  // The API sends exposure in percent units; limits and fmtPct work in fractions.
  const exposure = exposureFraction(d.totalExposurePct);
  const groupCapOverrides = describeGroupCapOverrides(limits);
  const exposurePctOfCeiling = (exposure / limits.maxPortfolioRiskPct) * 100;
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
        <div className="mt-3 flex flex-col items-center gap-4 sm:flex-row sm:items-start sm:gap-6">
          <Gauge
            size={180}
            value={exposurePctOfCeiling}
            min={0}
            max={100}
            valueLabel={fmtPct(exposure, 1)}
            label={`of ${fmtPct(limits.maxPortfolioRiskPct, 0)} ceiling`}
            accent={
              exposureTone === "short"
                ? "var(--short)"
                : exposureTone === "paused"
                  ? "var(--paused)"
                  : "var(--primary)"
            }
          />
          {/* w-full: in the stacked (mobile) layout items-center shrinks a flex-1 child to its content width, which is what left the tiles floating in a narrow centered block */}
          <div className="grid w-full grid-cols-2 gap-3 sm:w-auto sm:flex-1 sm:grid-cols-4">
            <MiniStat value={open.length} label="Open positions" sub={`${longCount} long · ${shortCount} short`} />
            <MiniStat value={fmtPct(exposure, 1)} label="Gross exposure" sub="sum of position sizes" />
            <MiniStat
              value={fmtPct(limits.maxPortfolioStopRiskPct, 2)}
              label="Loss-at-stop ceiling"
              sub="max portfolio stop risk"
            />
            <MiniStat
              value={fmtPct(limits.maxGroupExposurePct, 0)}
              label="Group cap"
              sub={groupCapOverrides ? `default · ${groupCapOverrides}` : "same-direction per group"}
            />
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
                      { value: closedTrail, color: "var(--info)", label: "Trailing / break-even" },
                      { value: closedTime, color: "var(--paused)", label: "Time exit" },
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
                  <MiniStat value={closedTp} label="Take profit" sub="hit the target" />
                  <MiniStat value={closedSl} label="Stop loss" sub="hit the stop" />
                  <MiniStat
                    value={returned.length > 0 ? `${((wins / returned.length) * 100).toFixed(0)}%` : "—"}
                    label="Win rate"
                    sub={`${returned.length} closed with a return`}
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
