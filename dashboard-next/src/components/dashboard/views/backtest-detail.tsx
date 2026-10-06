"use client";

import { ChevronLeft, Play, Pause, Square, TrendingUp, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useBacktestRunDetail, usePostBacktestAction } from "@/lib/api";
import { JobProgressCard } from "../job-progress";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { SectionHeading, StatusBadge, Pill, MiniStat, EmptyState, ErrorState } from "../primitives";
import { EquityCurve } from "../charts";
import { OpenPositionCard } from "../position-cards";
import { fmtPct, fmtDate, fmtTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import type { ViewProps } from "./types";

export function BacktestDetailView({
  backtestId,
  onClose,
}: ViewProps & { backtestId: string | null; onClose: () => void }) {
  const run = useBacktestRunDetail(backtestId);
  const actionMutation = usePostBacktestAction();

  if (!backtestId) {
    return (
      <div className="space-y-5">
        <Button variant="ghost" size="sm" onClick={onClose} className="gap-1">
          <ChevronLeft className="h-4 w-4" />
          Back to backtests
        </Button>
        <EmptyState icon={TrendingUp} title="No run selected" message="Pick a run from the backtest list." />
      </div>
    );
  }

  if (run.isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading run…
      </div>
    );
  }

  if (run.isError || !run.data || !run.data.run) {
    return (
      <div className="space-y-5">
        <Button variant="ghost" size="sm" onClick={onClose} className="gap-1">
          <ChevronLeft className="h-4 w-4" />
          Back to backtests
        </Button>
        {run.isError ? (
          <ErrorState message={run.error?.message ?? "Failed to load run"} />
        ) : (
          <EmptyState
            icon={TrendingUp}
            title="Run not found"
            message="This backtest may have been deleted or its id is invalid."
            action={
              <Button variant="outline" size="sm" onClick={onClose}>
                Back to backtests
              </Button>
            }
          />
        )}
      </div>
    );
  }

  const r = run.data.run;
  const positions = run.data.positions;
  const result = r.result;
  const series = result?.portfolio.series;
  const summary = series
    ? (() => {
        const onTotal = series.on.reduce((s, v) => s + v, 0);
        const offTotal = series.off.reduce((s, v) => s + v, 0);
        return {
          opened: positions.length,
          closed: positions.filter((p) => p.closedAt).length,
          stillOpen: positions.filter((p) => !p.closedAt).length,
          onReturn: onTotal,
          offReturn: offTotal,
          from: series.dates[0],
          to: series.dates[series.dates.length - 1],
        };
      })()
    : null;

  const variant =
    r.status === "complete" ? "approved" :
    r.status === "failed" ? "rejected" :
    r.status === "paused" ? "paused" :
    r.status === "running" ? "info" : "neutral";

  const act = (action: "cancel" | "pause" | "resume") =>
    actionMutation.mutate(
      { id: r.id, action },
      {
        onSuccess: () => run.refetch(),
        onError: (e) => toast.error(`Failed: ${e.message}`),
      },
    );
  const activeJob = run.data.activeJob ?? null;

  return (
    <div className="space-y-5">
      <Button variant="ghost" size="sm" onClick={onClose} className="-ml-2 gap-1">
        <ChevronLeft className="h-4 w-4" />
        Back to backtests
      </Button>

      <section className="rounded-2xl border border-border bg-card p-5 card-hairline">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-display text-xl font-semibold tracking-tight">
            {r.tickers.join(", ")}
          </h1>
          <StatusBadge variant={variant} label={r.status} />
          {r.pausedReason && <Pill tone="paused" size="sm">{r.pausedReason}</Pill>}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {fmtDate(r.testStart)} → {fmtDate(r.testEnd)} · <span className="font-mono">{r.id}</span>
        </p>
      </section>

      {activeJob && (activeJob.status === "running" || activeJob.status === "queued") && (
        <JobProgressCard job={activeJob} label="Backtest">
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => act("pause")} disabled={actionMutation.isPending}>
              <Pause className="mr-1 h-3 w-3" />
              Pause
            </Button>
            <TerminateButton onConfirm={() => act("cancel")} disabled={actionMutation.isPending} />
          </div>
        </JobProgressCard>
      )}

      {result && (
        <section>
          <SectionHeading title="Headline metrics" description="Strategy vs buy & hold" />
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <MiniStat value={summary?.opened ?? 0} label="Positions opened" />
            <MiniStat value={summary?.closed ?? 0} label="Closed" sub={`${summary?.stillOpen ?? 0} still open`} />
            <MiniStat
              value={result.overall.on.winRate != null ? fmtPct(result.overall.on.winRate, 0) : "—"}
              label="Win rate"
              sub={`${result.gate?.n ?? 0} trades`}
            />
            <MiniStat
              value={fmtPct(result.overall.on.cumulativeReturn, 2)}
              label="Strategy return"
              sub={`vs ${fmtPct(result.overall.off.cumulativeReturn, 2)} b&h`}
            />
            <MiniStat
              value={fmtPct(result.overall.off.cumulativeReturn, 2)}
              label="Buy & hold"
              sub="benchmark"
            />
            <MiniStat
              value={result.overall.on.sharpeRatio.toFixed(2)}
              label="Sharpe"
              sub={`vs ${result.overall.off.sharpeRatio.toFixed(2)}`}
            />
          </div>
        </section>
      )}

      {series && (
        <section>
          <SectionHeading
            title="Equity curve"
            description="Cumulative return: strategy vs buy & hold"
            action={
              <div className="flex items-center gap-3 text-[10px]">
                <span className="flex items-center gap-1">
                  <span className="h-2 w-3 rounded-sm bg-primary" />
                  Strategy
                </span>
                <span className="flex items-center gap-1">
                  <span className="h-0.5 w-3 rounded-sm bg-muted-foreground" />
                  Buy & hold
                </span>
              </div>
            }
          />
          <div className="mt-3 rounded-xl border border-border bg-card p-4">
            <EquityCurve
              dates={series.dates}
              onValues={series.on}
              offValues={series.off}
              positions={positions
                .filter((p) => p.closedAt && p.openedAt)
                .map((p) => ({
                  date: p.openedAt.slice(0, 10),
                  direction: p.direction ?? "neutral",
                  profit: (p.realizedReturn ?? 0) > 0,
                }))}
              height={240}
            />
          </div>
        </section>
      )}

      {r.status === "paused" && (
        <section className="rounded-xl border border-[color:var(--paused)]/25 bg-[color:var(--paused)]/8 p-4">
          <p className="text-sm font-medium text-[color:var(--paused)]">
            {r.pausedReason && r.pausedReason.replace(/_/g, " ")}
          </p>
          {r.resumeAfter && (
            <p className="mt-1 text-xs text-muted-foreground">
              resume_after: {fmtTime(r.resumeAfter)}
            </p>
          )}
          <div className="mt-3 flex gap-2">
            <Button size="sm" variant="outline" onClick={() => act("resume")} disabled={actionMutation.isPending}>
              <Play className="mr-1 h-3 w-3" />
              Resume
            </Button>
            <TerminateButton onConfirm={() => act("cancel")} disabled={actionMutation.isPending} />
          </div>
        </section>
      )}

      {r.status === "failed" && r.error && (
        <section className="rounded-xl border border-[color:var(--short)]/30 bg-[color:var(--short)]/8 p-4">
          <p className="text-sm font-medium text-[color:var(--short)]">Run failed</p>
          <p className="mt-1 text-xs text-muted-foreground break-words">{r.error}</p>
        </section>
      )}

      <section>
        <SectionHeading title="Positions" description={`${positions.length} positions in this run`} />
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {positions.map((p, i) => (
            <OpenPositionCard key={i} position={p} />
          ))}
        </div>
      </section>
    </div>
  );
}

function TerminateButton({ onConfirm, disabled }: { onConfirm: () => void; disabled?: boolean }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          className="border-[color:var(--short)]/40 text-[color:var(--short)]"
        >
          <Square className="mr-1 h-3 w-3" />
          Terminate
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Terminate this run?</AlertDialogTitle>
          <AlertDialogDescription>
            All partial data for this backtest will be deleted. The run cannot be resumed.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={onConfirm}
          >
            Terminate
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
