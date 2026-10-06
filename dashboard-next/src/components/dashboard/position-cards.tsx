"use client";

import { cn } from "@/lib/utils";
import { TrendingUp, TrendingDown } from "lucide-react";
import type { Position } from "@/lib/types";
import { DirectionPill, CloseReasonPill, Pill } from "./primitives";
import { fmtUsd, signedPct, fmtRelative } from "@/lib/format";

function ExcursionCell({
  label,
  value,
  tooltip,
  tone,
}: {
  label: string;
  value: number | null | undefined;
  tooltip: string;
  tone: "auto";
}) {
  const isPos = (value ?? 0) >= 0;
  const cls = value == null ? "text-muted-foreground" : isPos ? "text-[color:var(--long)]" : "text-[color:var(--short)]";
  return (
    <div title={tooltip} className="min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("font-mono text-xs font-medium nums", cls)}>
        {value == null ? "—" : signedPct(value, 1)}
      </div>
    </div>
  );
}

export function OpenPositionCard({ position, onClick }: { position: Position; onClick?: () => void }) {
  const longCount = position.direction === "long";
  const accentBar = longCount ? "bg-[color:var(--long)]" : position.direction === "short" ? "bg-[color:var(--short)]" : "bg-muted-foreground";
  return (
    <button
      type="button"
      onClick={onClick}
      className="group block w-full overflow-hidden rounded-xl border border-border bg-card text-left card-hairline transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-stretch">
        <div className={cn("w-1 shrink-0", accentBar)} aria-hidden />
        <div className="min-w-0 flex-1 p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-mono text-base font-semibold tracking-tight">{position.ticker}</span>
                <DirectionPill direction={position.direction} size="sm" />
              </div>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Opened {fmtRelative(position.openedAt)}
              </p>
            </div>
            <div className="text-right">
              <div className="font-mono text-base font-semibold nums">
                {(position.positionSizePct * 100).toFixed(1)}%
              </div>
              <div className="text-[10px] text-muted-foreground">of book</div>
            </div>
          </div>
          <dl className="mt-3 grid grid-cols-3 gap-2">
            <div>
              <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">Entry</dt>
              <dd className="font-mono text-xs font-medium nums">{fmtUsd(position.entryPrice)}</dd>
            </div>
            <ExcursionCell
              label="MAE"
              value={position.maePct}
              tooltip="Worst gross return seen while open (negative = adverse)."
              tone="auto"
            />
            <ExcursionCell
              label="MFE"
              value={position.mfePct}
              tooltip="Best gross return seen while open."
              tone="auto"
            />
          </dl>
        </div>
      </div>
    </button>
  );
}

export function ClosedPositionCard({ position, onClick }: { position: Position; onClick?: () => void }) {
  if (!position.closedAt) return null;
  const realized = position.realizedReturn ?? 0;
  const profitable = realized > 0;
  const accentBar = profitable ? "bg-[color:var(--long)]" : realized < 0 ? "bg-[color:var(--short)]" : "bg-muted-foreground";

  return (
    <button
      type="button"
      onClick={onClick}
      className="group block w-full overflow-hidden rounded-xl border border-border bg-card text-left card-hairline transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-stretch">
        <div className={cn("w-1 shrink-0", accentBar)} aria-hidden />
        <div className="min-w-0 flex-1 p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-mono text-base font-semibold tracking-tight">{position.ticker}</span>
                <DirectionPill direction={position.direction} size="sm" />
              </div>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Closed {fmtRelative(position.closedAt)}
              </p>
            </div>
            <div className="text-right">
              <div
                className={cn(
                  "flex items-center gap-1 font-mono text-base font-semibold nums",
                  profitable ? "text-[color:var(--long)]" : "text-[color:var(--short)]",
                )}
              >
                {profitable ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
                {signedPct(realized, 1)}
              </div>
              <div className="text-[10px] text-muted-foreground">
                {position.returnIsNet ? "net" : "gross"}
              </div>
            </div>
          </div>
          <dl className="mt-3 grid grid-cols-3 gap-2">
            <div>
              <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">Entry</dt>
              <dd className="font-mono text-xs font-medium nums">{fmtUsd(position.entryPrice)}</dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">Exit</dt>
              <dd className="font-mono text-xs font-medium nums">{fmtUsd(position.exitPrice)}</dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">Reason</dt>
              <dd className="mt-0.5">
                <CloseReasonPill reason={position.closeReason} />
              </dd>
            </div>
          </dl>
        </div>
      </div>
    </button>
  );
}

/** Compact row variant for tables / dense lists */
export function PositionRow({ position }: { position: Position }) {
  const realized = position.realizedReturn;
  return (
    <div className="flex items-center gap-3 px-3 py-2 text-sm">
      <span className="font-mono font-medium">{position.ticker}</span>
      <DirectionPill direction={position.direction} size="sm" />
      <span className="font-mono text-xs nums text-muted-foreground">
        {(position.positionSizePct * 100).toFixed(1)}%
      </span>
      {position.entryPrice != null && (
        <span className="font-mono text-xs nums text-muted-foreground">
          @ {fmtUsd(position.entryPrice)}
        </span>
      )}
      {realized != null && (
        <span
          className={cn(
            "ml-auto font-mono text-xs font-medium nums",
            realized > 0 ? "text-[color:var(--long)]" : realized < 0 ? "text-[color:var(--short)]" : "text-muted-foreground",
          )}
        >
          {signedPct(realized, 1)}
        </span>
      )}
    </div>
  );
}
