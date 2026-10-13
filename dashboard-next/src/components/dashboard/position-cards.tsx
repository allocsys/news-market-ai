"use client";

import { cn } from "@/lib/utils";
import { TrendingUp, TrendingDown } from "lucide-react";
import type { Position } from "@/lib/types";
import { DirectionPill, CloseReasonPill, Pill } from "./primitives";
import { fmtUsd, signedPct, fmtRelative } from "@/lib/format";
import type { PostmortemPosition } from "@/lib/api";
import { PostmortemTagPill } from "./postmortem-card";

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

/**
 * Range bar for a closed trade: zero in the middle, worst drawdown (MAE) fills left in red,
 * best run-up (MFE) fills right in green, and the dot is where the trade actually closed.
 * A dot far left of the green fill = gave back a winner; a dot at the red edge = stopped at the low.
 * All inputs are fractions (0.02 = 2%). MAE/MFE are gross, the dot is the card's own return figure.
 */
function ExcursionBar({
  mae,
  mfe,
  realized,
}: {
  mae: number | null | undefined;
  mfe: number | null | undefined;
  realized: number | null | undefined;
}) {
  const lo = Math.min(mae ?? 0, 0);
  const hi = Math.max(mfe ?? 0, 0);
  const scale = Math.max(Math.abs(lo), hi, Math.abs(realized ?? 0), 0.005);
  const pos = (v: number) => Math.max(0, Math.min(100, 50 + (v / scale) * 50));
  const dotLeft = realized == null ? null : pos(realized);
  const dotColor = (realized ?? 0) > 0 ? "var(--long)" : "var(--short)";

  return (
    <div className="mt-3">
      <div className="relative h-2 rounded-full bg-muted">
        {lo < 0 && (
          <div
            className="absolute inset-y-0 rounded-l-full"
            style={{ left: `${pos(lo)}%`, width: `${50 - pos(lo)}%`, background: "var(--short)", opacity: 0.6 }}
          />
        )}
        {hi > 0 && (
          <div
            className="absolute inset-y-0 rounded-r-full"
            style={{ left: "50%", width: `${pos(hi) - 50}%`, background: "var(--long)", opacity: 0.6 }}
          />
        )}
        <div className="absolute -inset-y-0.5 left-1/2 w-px bg-border" aria-hidden />
        {dotLeft != null && (
          <div
            className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card"
            style={{ left: `${dotLeft}%`, background: dotColor }}
            aria-hidden
          />
        )}
      </div>
      <div className="mt-1.5 flex items-center justify-between font-mono text-[11px] nums">
        <span title="Worst gross return seen while open (negative = adverse).">
          <span className="text-muted-foreground">MAE </span>
          <span className={mae == null ? "text-muted-foreground" : "text-[color:var(--short)]"}>
            {mae == null ? "—" : signedPct(mae, 1)}
          </span>
        </span>
        <span title="Best gross return seen while open.">
          <span className="text-muted-foreground">MFE </span>
          <span className={mfe == null ? "text-muted-foreground" : "text-[color:var(--long)]"}>
            {mfe == null ? "—" : signedPct(mfe, 1)}
          </span>
        </span>
      </div>
    </div>
  );
}

export function OpenPositionCard({ position, onClick, postmortem }: { position: Position; onClick?: () => void; postmortem?: PostmortemPosition | null }) {
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
                {postmortem && <PostmortemTagPill tag={postmortem.tag} stage={postmortem.stage} />}
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
  const hasExcursion = position.maePct != null || position.mfePct != null;

  return (
    <button
      type="button"
      onClick={onClick}
      className="group block w-full overflow-hidden rounded-xl border border-border bg-card text-left card-hairline transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-stretch">
        <div className={cn("w-1 shrink-0", accentBar)} aria-hidden />
        <div className="min-w-0 flex-1 p-3">
          {/* One header: who + why it closed on the left, result on the right */}
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-mono text-base font-semibold tracking-tight">{position.ticker}</span>
                <DirectionPill direction={position.direction} size="sm" />
                <CloseReasonPill reason={position.closeReason} />
              </div>
              <p className="mt-1.5 truncate font-mono text-[11px] text-muted-foreground nums">
                {fmtUsd(position.entryPrice)} → {fmtUsd(position.exitPrice)} · {fmtRelative(position.closedAt)}
              </p>
            </div>
            <div className="shrink-0 text-right">
              <div
                className={cn(
                  "flex items-center justify-end gap-1 font-mono text-base font-semibold nums",
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
          {hasExcursion && (
            <ExcursionBar mae={position.maePct} mfe={position.mfePct} realized={position.realizedReturn} />
          )}
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
