"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronUp, Wallet, Activity, Loader2 } from "lucide-react";
import { usePositions } from "@/lib/api";
import { resolveRiskLimits, exposureFraction, describeGroupCapOverrides } from "@/lib/risk";
import { SectionHeading, MiniStat, Pill, EmptyState, ErrorState } from "../primitives";
import { OpenPositionCard, ClosedPositionCard } from "../position-cards";
import { Gauge } from "../charts";
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
            <div className="border-t border-border p-4 space-y-6">
              {/* Close reasons */}
              <div>
                <div className="flex items-center justify-between gap-4 mb-3">
                  <p className="text-xs font-medium text-muted-foreground">Close reasons (last 20)</p>
                  <div className="flex gap-1.5">
                    {open.length > 0 ? (
                      <>
                        <Pill tone="long" size="sm">{longCount} long</Pill>
                        <Pill tone="short" size="sm">{shortCount} short</Pill>
                      </>
                    ) : (
                      <span className="text-xs text-muted-foreground">None open</span>
                    )}
                  </div>
                </div>

                {closed.length > 0 ? (
                  <>
                    <div className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full mb-3">
                      {closedTp > 0 && <div className="bg-[var(--long)]" style={{ flex: closedTp }} />}
                      {closedSl > 0 && <div className="bg-[var(--short)]" style={{ flex: closedSl }} />}
                      {closedTrail > 0 && <div className="bg-[var(--info)]" style={{ flex: closedTrail }} />}
                      {closedTime > 0 && <div className="bg-[var(--paused)]" style={{ flex: closedTime }} />}
                      {closedOther > 0 && <div className="bg-[var(--muted-foreground)]" style={{ flex: closedOther }} />}
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs">
                      {closedTp > 0 && <div className="flex items-center gap-1.5"><div className="h-2 w-2 rounded-full bg-[var(--long)]" />Take profit <span className="text-muted-foreground">{closedTp}</span></div>}
                      {closedSl > 0 && <div className="flex items-center gap-1.5"><div className="h-2 w-2 rounded-full bg-[var(--short)]" />Stop loss <span className="text-muted-foreground">{closedSl}</span></div>}
                      {closedTrail > 0 && <div className="flex items-center gap-1.5"><div className="h-2 w-2 rounded-full bg-[var(--info)]" />Trailing/BE <span className="text-muted-foreground">{closedTrail}</span></div>}
                      {closedTime > 0 && <div className="flex items-center gap-1.5"><div className="h-2 w-2 rounded-full bg-[var(--paused)]" />Time exit <span className="text-muted-foreground">{closedTime}</span></div>}
                      {closedOther > 0 && <div className="flex items-center gap-1.5"><div className="h-2 w-2 rounded-full bg-[var(--muted-foreground)]" />Other <span className="text-muted-foreground">{closedOther}</span></div>}
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">No closed positions yet</p>
                )}
              </div>

              {/* Exit quality */}
              <div>
                <p className="mb-3 text-xs font-medium text-muted-foreground">Exit quality</p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <MiniStat
                    value={returned.length > 0 ? fmtPct(wins / returned.length, 0) : "—"}
                    label="Win rate"
                    sub={`${returned.length} closed with return`}
                  />
                  <MiniStat
                    value={returned.length > 0 ? fmtPct(returned.filter(p => (p.realizedReturn as number) > 0).reduce((acc, p) => acc + (p.realizedReturn as number), 0) / wins || 0, 1) : "—"}
                    label="Avg win"
                    sub="mean realized"
                  />
                  <MiniStat
                    value={returned.length > 0 ? fmtPct(returned.filter(p => (p.realizedReturn as number) <= 0).reduce((acc, p) => acc + Math.abs(p.realizedReturn as number), 0) / (returned.length - wins) || 0, 1) : "—"}
                    label="Avg loss"
                    sub="mean realized"
                  />
                  <MiniStat
                    value={(() => {
                      const avgW = wins > 0 ? returned.filter(p => (p.realizedReturn as number) > 0).reduce((acc, p) => acc + (p.realizedReturn as number), 0) / wins : 0;
                      const avgL = (returned.length - wins) > 0 ? returned.filter(p => (p.realizedReturn as number) <= 0).reduce((acc, p) => acc + Math.abs(p.realizedReturn as number), 0) / (returned.length - wins) : 0;
                      return (avgW > 0 && avgL > 0) ? (avgW / avgL).toFixed(2) : "—";
                    })()}
                    label="Payoff"
                    sub="avg win ÷ avg loss"
                  />
                </div>
                {returned.length > 0 && returned.length < 10 && (
                  <p className="mt-3 text-xs text-muted-foreground italic">Small sample, treat as noisy.</p>
                )}
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
