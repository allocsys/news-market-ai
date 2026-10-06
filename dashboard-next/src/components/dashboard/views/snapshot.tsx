"use client";

import { Loader2, TrendingUp } from "lucide-react";
import { useSnapshot } from "@/lib/api";
import { SectionHeading, DirectionPill, CloseReasonPill, Pill, EmptyState, ErrorState } from "../primitives";
import { fmtUsd, signedPct, fmtTime, fmtRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ViewProps } from "./types";

export function SnapshotView({ env }: ViewProps) {
  const snapshot = useSnapshot(env);

  if (snapshot.isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading exits…
      </div>
    );
  }
  if (snapshot.isError || !snapshot.data) {
    return <ErrorState message={snapshot.error?.message ?? "Failed to load snapshot"} />;
  }

  const closed = snapshot.data.closedPositions;

  return (
    <div className="space-y-5">
      <section>
        <SectionHeading
          title="Recent exits"
          description={`${closed.length} closed positions, newest first`}
          action={<Pill tone="muted" size="sm">last 20</Pill>}
        />
        {closed.length === 0 ? (
          <div className="mt-3">
            <EmptyState icon={TrendingUp} title="No closed positions yet" />
          </div>
        ) : (
          <div className="mt-3 overflow-hidden rounded-xl border border-border bg-card">
            <div className="hidden border-b border-border bg-muted/30 px-4 py-2 text-[10px] uppercase tracking-wide text-muted-foreground sm:grid sm:grid-cols-12">
              <div className="col-span-3">Ticker</div>
              <div className="col-span-2">Size</div>
              <div className="col-span-2">Entry</div>
              <div className="col-span-2">Exit</div>
              <div className="col-span-2">Reason</div>
              <div className="col-span-1 text-right">P&L</div>
            </div>
            <ul className="divide-y divide-border">
              {closed.map((p, i) => {
                const realized = p.realizedReturn ?? 0;
                const profitable = realized > 0;
                return (
                  <li key={i} className="grid grid-cols-12 items-center gap-2 px-3 py-2.5 text-xs sm:px-4">
                    <div className="col-span-5 flex items-center gap-2 sm:col-span-3">
                      <span className="font-mono font-semibold">{p.ticker}</span>
                      <DirectionPill direction={p.direction} size="sm" />
                    </div>
                    <div className="col-span-3 hidden font-mono nums text-muted-foreground sm:block">
                      {(p.positionSizePct * 100).toFixed(1)}%
                    </div>
                    <div className="col-span-3 hidden font-mono nums text-muted-foreground sm:block">
                      {fmtUsd(p.entryPrice)}
                    </div>
                    <div className="col-span-3 hidden font-mono nums text-muted-foreground sm:block">
                      {fmtUsd(p.exitPrice)}
                    </div>
                    <div className="col-span-3 flex items-center sm:col-span-2">
                      <CloseReasonPill reason={p.closeReason} />
                    </div>
                    <div className={cn(
                      "col-span-4 text-right font-mono font-medium nums sm:col-span-2",
                      profitable ? "text-[color:var(--long)]" : realized < 0 ? "text-[color:var(--short)]" : "text-muted-foreground",
                    )}>
                      {signedPct(realized, 1)}
                    </div>
                    <div className="col-span-12 mt-1 flex items-center justify-end gap-2 text-[10px] text-muted-foreground sm:col-span-12 sm:mt-0 sm:justify-start">
                      <span title={fmtTime(p.closedAt)}>closed {fmtRelative(p.closedAt)}</span>
                      <span>·</span>
                      <span title={fmtTime(p.openedAt)}>opened {fmtRelative(p.openedAt)}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}
