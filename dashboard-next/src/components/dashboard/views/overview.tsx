"use client";

import { cn } from "@/lib/utils";
import { AlertTriangle, ChevronRight, ArrowUpRight, ArrowDownRight, Loader2 } from "lucide-react";
import { useOverview, useActiveJob, useActiveTickers, useMacro } from "@/lib/api";
import { activeOrNull, hasEdgarTicker, hasMacroTicker } from "@/lib/ingest-scope";
import { resolveRiskLimits, exposureFraction } from "@/lib/risk";
import { StatCard, SectionHeading, StatusDot, Pill, DirectionPill, ErrorState, EmptyState } from "../primitives";
import { Sparkline, StackedBar } from "../charts";
import { VerdictCard } from "../verdict-card";
import {
  fmtPct,
  signedPct,
  fmtRelative,
  fmtTime,
  stageLabel,
} from "@/lib/format";
import type { ViewProps } from "./types";

export function OverviewView({ onNavigate, env }: ViewProps) {
  const overview = useOverview(env);
  const activeJob = useActiveJob("backtest", env);
  const activeTickers = useActiveTickers();
  const macro = useMacro();

  if (overview.isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading overview…
      </div>
    );
  }

  if (overview.isError || !overview.data) {
    return (
      <ErrorState message={overview.error?.message ?? "Failed to load overview"} />
    );
  }

  const d = overview.data;
  const openCount = d.openPositions.length;
  const closedCount = d.closedPositions.length;
  const longCount = d.openPositions.filter((p) => p.direction === "long").length;
  const shortCount = d.openPositions.filter((p) => p.direction === "short").length;

  const totalDecisions = Object.values(d.decisionStats.totals).reduce((s, n) => s + n, 0);
  const approved = d.decisionStats.totals.opened ?? 0;
  const rejected = d.decisionStats.totals.rejected ?? 0;
  const approvalRate = totalDecisions > 0 ? approved / totalDecisions : 0;

  const attentionItems: { label: string; tone: "warn" | "bad" | "info"; action?: string; onAction?: () => void }[] = [];
  if (d.health) {
    // null = selection unknown: keep the warning rather than hide it.
    const activeList = activeOrNull(activeTickers.data);
    if (d.health.fundamentals && !d.health.fundamentals.fresh && hasEdgarTicker(activeList)) {
      attentionItems.push({
        label: "Fundamentals ingestion stale (last 2d+)",
        tone: "warn",
        action: "View health",
        onAction: () => onNavigate("health"),
      });
    }
    // Macro is default-off: only alert when the switch is known to be on and XAUUSD is active.
    if (
      d.health.macro &&
      d.health.macro.fresh === false &&
      macro.data &&
      !macro.data.error &&
      macro.data.enabled &&
      hasMacroTicker(activeList)
    ) {
      attentionItems.push({
        label: "Macro (FRED + COT) ingestion stale",
        tone: "warn",
        action: "View health",
        onAction: () => onNavigate("health"),
      });
    }
    if (d.health.news && !d.health.news.fresh) {
      attentionItems.push({
        label: "News ingestion stale",
        tone: "bad",
        action: "View health",
        onAction: () => onNavigate("health"),
      });
    }
    if (d.health.priceBars && !d.health.priceBars.fresh) {
      attentionItems.push({
        label: "Price bars ingestion stale",
        tone: "bad",
        action: "View health",
        onAction: () => onNavigate("health"),
      });
    }
  }
  const staleCheckpoints = d.checkpoints.filter((c) => c.status === "stale");
  if (staleCheckpoints.length > 0) {
    attentionItems.push({
      label: `${staleCheckpoints.length} pipeline checkpoint${staleCheckpoints.length > 1 ? "s" : ""} stale`,
      tone: "warn",
      action: "View pipeline",
      onAction: () => onNavigate("pipeline"),
    });
  }

  const latestDecision = d.latestDecision;
  const limits = resolveRiskLimits(d.riskLimits);
  // The API sends exposure in percent units; limits and fmtPct work in fractions.
  const exposure = exposureFraction(d.totalExposurePct);
  const exposureTone = exposure > limits.maxPortfolioRiskPct * 0.8 ? "short" : "default";

  return (
    <div className="space-y-5">
      {/* Hero */}
      <section className="rounded-2xl border border-border bg-gradient-to-br from-card to-muted/30 p-5 card-hairline">
        <div className="flex items-center gap-2">
          <StatusDot status="live" />
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {env === "live" ? "Live environment" : "Backtest environment"}
          </span>
          <span className="ml-auto text-[11px] text-muted-foreground">
            Updated {fmtRelative(new Date().toISOString())}
          </span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div>
            <div className="font-mono text-4xl font-semibold tracking-tight nums">{openCount}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">Open positions</div>
            <div className="mt-1 flex items-center gap-1.5 text-[10px]">
              <span className="text-[color:var(--long)]">{longCount} long</span>
              <span className="text-muted-foreground">·</span>
              <span className="text-[color:var(--short)]">{shortCount} short</span>
            </div>
          </div>
          <div>
            <div className={cn("font-mono text-4xl font-semibold tracking-tight nums", exposureTone === "short" ? "text-[color:var(--short)]" : "text-[color:var(--long)]")}>
              {fmtPct(exposure, 1)}
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">Open exposure</div>
            <div className="mt-1 text-[10px] text-muted-foreground">
              of {fmtPct(limits.maxPortfolioRiskPct, 0)} ceiling
            </div>
          </div>
          <div>
            <div className="font-mono text-4xl font-semibold tracking-tight nums">{fmtPct(approvalRate, 0)}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">Approval rate</div>
            <div className="mt-1 text-[10px] text-muted-foreground">
              {approved} opened · {rejected} rejected
            </div>
          </div>
          <div>
            <div className="font-mono text-4xl font-semibold tracking-tight nums">{closedCount}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">Recently closed</div>
            <div className="mt-1 text-[10px] text-muted-foreground">last 20 exits</div>
          </div>
        </div>
      </section>

      {/* Active job progress */}
      {activeJob.data?.job && activeJob.data.job.status === "running" && (
        <section className="overflow-hidden rounded-xl border border-[color:var(--info)]/25 bg-[color:var(--info)]/5 p-4">
          <div className="flex items-center gap-2">
            <StatusDot status="running" />
            <span className="text-xs font-semibold uppercase tracking-wide text-[color:var(--info)]">
              Backtest in progress
            </span>
            <span className="ml-auto font-mono text-xs text-muted-foreground">
              part {activeJob.data.job.done ?? 0}/{activeJob.data.job.total ?? "?"}
            </span>
          </div>
          <p className="mt-2 text-sm">{activeJob.data.job.detail}</p>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-[color:var(--info)] transition-all"
              style={{ width: `${activeJob.data.job.percent}%` }}
            />
          </div>
          <button
            type="button"
            onClick={() => onNavigate("backtest")}
            className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-[color:var(--info)] hover:underline"
          >
            View backtest <ChevronRight className="h-3 w-3" />
          </button>
        </section>
      )}

      {/* Attention list */}
      {attentionItems.length > 0 && (
        <section>
          <SectionHeading
            title="Needs attention"
            description="Items stale, failed, or over a soft threshold"
          />
          <ul className="mt-3 space-y-2">
            {attentionItems.map((item, i) => (
              <li
                key={i}
                className="flex items-center gap-3 rounded-lg border border-[color:var(--paused)]/25 bg-[color:var(--paused)]/8 px-3 py-2.5"
              >
                <AlertTriangle className="h-4 w-4 text-[color:var(--paused)]" aria-hidden />
                <span className="flex-1 text-sm">{item.label}</span>
                {item.action && (
                  <button
                    type="button"
                    onClick={item.onAction}
                    className="inline-flex items-center gap-1 text-xs font-medium text-[color:var(--paused)] hover:underline"
                  >
                    {item.action} <ChevronRight className="h-3 w-3" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Latest decision */}
      {latestDecision ? (
        <section>
          <SectionHeading
            title="Latest decision"
            description={fmtRelative(latestDecision.createdAt)}
            action={
              <button
                type="button"
                onClick={() => onNavigate("decisions")}
                className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
              >
                All decisions <ChevronRight className="h-3 w-3" />
              </button>
            }
          />
          <div className="mt-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="font-mono text-base font-semibold">{latestDecision.ticker}</span>
              <DirectionPill direction={latestDecision.thesis.direction} size="sm" />
              <Pill tone="approved" size="sm">Opened</Pill>
              <span className="ml-auto text-[11px] text-muted-foreground">
                {fmtPct(latestDecision.riskDecision.positionSizePct, 1)} of book
              </span>
            </div>
            <VerdictCard decision={latestDecision} />
          </div>
        </section>
      ) : (
        <section>
          <SectionHeading title="Latest decision" description="No decisions yet" />
          <div className="mt-3">
            <EmptyState title="No decisions yet" message="When the pipeline runs, the most recent decision will appear here." />
          </div>
        </section>
      )}

      {/* Open positions sparkline */}
      <section>
        <SectionHeading
          title="Open book"
          description="Live positions with recent price action"
          action={
            <button
              type="button"
              onClick={() => onNavigate("positions")}
              className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              Full book <ChevronRight className="h-3 w-3" />
            </button>
          }
        />
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {d.openPositions.map((p) => {
            const longCount = p.direction === "long";
            return (
              <button
                key={p.ticker}
                type="button"
                onClick={() => onNavigate("positions")}
                className="flex items-center gap-3 rounded-lg border border-border bg-card p-3 text-left card-hairline transition-colors hover:bg-accent/40"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-semibold">{p.ticker}</span>
                    <DirectionPill direction={p.direction} size="sm" />
                  </div>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {fmtPct(p.positionSizePct, 1)} · entry ${p.entryPrice?.toFixed(2)}
                  </p>
                </div>
                <Sparkline
                  values={[p.entryPrice ?? 100, (p.entryPrice ?? 100) * (1 + (p.mfePct ?? 0)), (p.entryPrice ?? 100) * (1 + (p.maePct ?? 0) * 0.5), (p.entryPrice ?? 100) * (1 + ((p.mfePct ?? 0) + (p.maePct ?? 0)) / 2)]}
                  width={80}
                  height={28}
                  stroke={longCount ? "var(--long)" : "var(--short)"}
                  showArea={false}
                />
                <div className="text-right">
                  <div className={cn(
                    "flex items-center gap-0.5 font-mono text-xs font-medium nums",
                    (p.mfePct ?? 0) >= 0 ? "text-[color:var(--long)]" : "text-[color:var(--short)]",
                  )}>
                    {longCount ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                    {signedPct(p.mfePct, 1)}
                  </div>
                  <div className="text-[10px] text-muted-foreground">MFE</div>
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {/* Composition + exposure bars */}
      <section>
        <SectionHeading title="Book composition" description="Direction and exposure at a glance" />
        <div className="mt-3 space-y-3 rounded-xl border border-border bg-card p-4">
          <div>
            <div className="mb-1 flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Open positions direction</span>
              <span className="font-mono nums">{openCount}</span>
            </div>
            <StackedBar
              segments={[
                { value: longCount, color: "var(--long)", label: "Long" },
                { value: shortCount, color: "var(--short)", label: "Short" },
              ]}
            />
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Exposure vs ceiling</span>
              <span className="font-mono nums">
                {fmtPct(exposure, 1)} / {fmtPct(limits.maxPortfolioRiskPct, 0)}
              </span>
            </div>
            <StackedBar
              segments={[
                { value: exposure, color: "var(--primary)", label: "Used" },
                { value: Math.max(0, limits.maxPortfolioRiskPct - exposure), color: "var(--muted)", label: "Available" },
              ]}
            />
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Decisions outcome (all-time)</span>
              <span className="font-mono nums">{totalDecisions}</span>
            </div>
            <StackedBar
              segments={[
                { value: approved, color: "var(--long)", label: "Opened" },
                { value: rejected, color: "var(--short)", label: "Rejected" },
                { value: Math.max(0, totalDecisions - approved - rejected), color: "var(--muted-foreground)", label: "Other" },
              ]}
            />
          </div>
        </div>
      </section>

      {/* Pipeline pulse */}
      <section>
        <SectionHeading
          title="Pipeline pulse"
          description="Most recent checkpoints"
          action={
            <button
              type="button"
              onClick={() => onNavigate("pipeline")}
              className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              Full pipeline <ChevronRight className="h-3 w-3" />
            </button>
          }
        />
        <div className="mt-3 overflow-hidden rounded-xl border border-border bg-card">
          <ul className="divide-y divide-border">
            {d.checkpoints.slice(0, 6).map((c, i) => (
              <li key={i} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                <StatusDot status={c.status === "ok" ? "ok" : "stale"} />
                <span className="font-mono font-medium">{c.ticker}</span>
                <span className="text-muted-foreground">{c.lastStageLabel ?? stageLabel(c.stage)}</span>
                <span className="ml-auto font-mono text-[11px] nums text-muted-foreground">
                  {fmtRelative(c.updated_at)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}
