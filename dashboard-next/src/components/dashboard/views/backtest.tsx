"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  ChevronRight,
  Play,
  Pause,
  Square,
  Trash2,
  AlertTriangle,
  FlaskConical,
  Loader2,
} from "lucide-react";
import {
  useBacktestRuns,
  useActiveJob,
  usePostBacktestRun,
  usePostBacktestAction,
  usePostBacktestCleanup,
  usePostBacktestPurge,
  useWatchlist,
  type MaintenanceResult,
} from "@/lib/api";
import { ReplayPanel } from "./replay";
import type { BacktestRun } from "@/lib/types";
import { SectionHeading, StatusBadge, Pill, MiniStat, EmptyState, ErrorState } from "../primitives";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { backtestStatusLabel, pauseReasonLabel, fmtDate, fmtTime, fmtPct } from "@/lib/format";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import type { ViewProps } from "./types";

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

// Toast for the bulk-maintenance routes. Both are bounded per call and answer
// with counts ({ scanned, totalDeleted, processed } / { scanned, purged, ... });
// cleanup reports a failed candidate lookup as `error` inside a 200.
function reportMaintenance(what: string, r: MaintenanceResult | null) {
  if (!r) {
    toast.success(`${what} done`);
    return;
  }
  if (typeof r.error === "string" && r.error) {
    toast.error(`${what}: ${r.error}`);
    return;
  }
  const num = (k: string) => (typeof r[k] === "number" ? (r[k] as number) : null);
  const scanned = num("scanned");
  const purged = num("purged");
  const deleted = num("totalDeleted");
  if (scanned === 0) {
    toast.success(`${what}: nothing matched`);
    return;
  }
  const parts: string[] = [];
  if (purged != null) parts.push(`${purged} run${purged === 1 ? "" : "s"} deleted`);
  else if (scanned != null) parts.push(`${scanned} run${scanned === 1 ? "" : "s"} cleaned`);
  if (deleted != null) parts.push(`${deleted} row${deleted === 1 ? "" : "s"} removed`);
  const processed = Array.isArray(r.processed) ? (r.processed as { complete?: boolean }[]) : [];
  const more = processed.some((p) => p.complete === false);
  toast.success(`${what}: ${parts.join(", ") || "done"}${more ? ". Some runs were cut short; run it again to finish." : ""}`);
}

const RANGE_PRESETS = [
  { label: "7d", days: 7 },
  { label: "14d", days: 14 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
];

export function BacktestView({ onNavigate }: ViewProps) {
  const [showNewRun, setShowNewRun] = useState(true);
  const [showRecent, setShowRecent] = useState(true);
  const [showMaintenance, setShowMaintenance] = useState(false);
  const [showReplay, setShowReplay] = useState(false);
  const [cleanupDays, setCleanupDays] = useState("30");

  const runs = useBacktestRuns();
  const activeJob = useActiveJob("backtest");
  const runMutation = usePostBacktestRun();
  const actionMutation = usePostBacktestAction();
  const cleanup = usePostBacktestCleanup();
  const purge = usePostBacktestPurge();

  const runCleanup = () => {
    const n = Number(cleanupDays);
    if (!Number.isFinite(n) || n <= 0) {
      toast.error("Enter a number of days greater than 0");
      return;
    }
    cleanup.mutate(
      { olderThanDays: n },
      {
        onSuccess: (r) => reportMaintenance("Clean up", r),
        onError: (e) => toast.error(`Clean up failed: ${e.message}`),
      },
    );
  };
  const runPurge = () => {
    purge.mutate(undefined, {
      onSuccess: (r) => reportMaintenance("Delete", r),
      onError: (e) => toast.error(`Delete failed: ${e.message}`),
    });
  };

  if (runs.isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading backtests…
      </div>
    );
  }
  if (runs.isError || !runs.data) {
    return <ErrorState message={runs.error?.message ?? "Failed to load backtest runs"} />;
  }

  const allRuns = runs.data.backtestRuns;
  const completeRuns = allRuns.filter((r) => r.status === "complete");

  return (
    <div className="space-y-5">
      {/* Active backtest progress banner */}
      {activeJob.data?.job && activeJob.data.job.status === "running" && (
        <section className="overflow-hidden rounded-xl border border-[color:var(--info)]/25 bg-[color:var(--info)]/5 p-4">
          <div className="flex items-center gap-2">
            <span className="live-dot inline-block h-2 w-2 rounded-full bg-[color:var(--info)]" />
            <span className="text-xs font-semibold uppercase tracking-wide text-[color:var(--info)]">
              Backtest running
            </span>
            <button
              type="button"
              onClick={() => onNavigate("backtest", { backtestId: activeJob.data.job!.id })}
              className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-[color:var(--info)] hover:underline"
            >
              Open timeline <ChevronRight className="h-3 w-3" />
            </button>
          </div>
          <p className="mt-2 text-sm">{activeJob.data.job.detail}</p>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-[color:var(--info)] transition-all"
              style={{ width: `${activeJob.data.job.percent}%` }}
            />
          </div>
        </section>
      )}

      {/* New backtest run */}
      <Collapsible open={showNewRun} onOpenChange={setShowNewRun}>
        <section className="rounded-xl border border-border bg-card">
          <CollapsibleTrigger asChild>
            <button type="button" className="flex w-full items-center gap-2 px-4 py-3 text-left">
              <FlaskConical className="h-4 w-4 text-muted-foreground" aria-hidden />
              <span className="font-display text-base font-semibold">New backtest run</span>
              <ChevronRight className={cn("ml-auto h-4 w-4 text-muted-foreground transition-transform", showNewRun && "rotate-90")} />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="space-y-4 border-t border-border p-4">
              <BacktestForm
                onSubmitted={(id) => {
                  toast.success("Backtest started");
                  if (id) onNavigate("backtest", { backtestId: id });
                }}
                mutation={runMutation}
              />
            </div>
          </CollapsibleContent>
        </section>
      </Collapsible>

      {/* Compare runs (if 2+ complete) */}
      {completeRuns.length >= 2 && (
        <section>
          <SectionHeading title="Compare runs" description="Side-by-side headline metrics" />
          <div className="mt-3 overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full min-w-[640px] text-xs">
              <thead className="border-b border-border bg-muted/30">
                <tr>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">Run</th>
                  <th className="px-3 py-2 text-right font-medium text-muted-foreground">Strategy</th>
                  <th className="px-3 py-2 text-right font-medium text-muted-foreground">Buy & hold</th>
                  <th className="px-3 py-2 text-right font-medium text-muted-foreground">Delta</th>
                  <th className="px-3 py-2 text-right font-medium text-muted-foreground">Sharpe</th>
                  <th className="px-3 py-2 text-right font-medium text-muted-foreground">Win rate</th>
                  <th className="px-3 py-2 text-right font-medium text-muted-foreground">Max DD</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {completeRuns.map((r) => (
                  <tr key={r.id} className="hover:bg-accent/40">
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        onClick={() => onNavigate("backtest", { backtestId: r.id })}
                        className="font-mono text-left text-[11px] hover:underline"
                      >
                        {r.tickers.slice(0, 3).join(",")}{r.tickers.length > 3 ? ` +${r.tickers.length - 3}` : ""}
                      </button>
                      <p className="text-[10px] text-muted-foreground">{fmtDate(r.testStart)} → {fmtDate(r.testEnd)}</p>
                    </td>
                    <td className="px-3 py-2 text-right font-mono nums text-[color:var(--long)]">
                      {r.result ? fmtPct(r.result.overall.on.cumulativeReturn, 2) : "—"}
                    </td>
                    <td className="px-3 py-2 text-right font-mono nums text-muted-foreground">
                      {r.result ? fmtPct(r.result.overall.off.cumulativeReturn, 2) : "—"}
                    </td>
                    <td className="px-3 py-2 text-right font-mono nums">
                      {r.result ? (
                        <span className={r.result.overall.delta.cumulativeReturn >= 0 ? "text-[color:var(--long)]" : "text-[color:var(--short)]"}>
                          {fmtPct(r.result.overall.delta.cumulativeReturn, 2)}
                        </span>
                      ) : "—"}
                    </td>
                    <td className="px-3 py-2 text-right font-mono nums">
                      {r.result ? r.result.overall.on.sharpeRatio.toFixed(2) : "—"}
                    </td>
                    <td className="px-3 py-2 text-right font-mono nums">
                      {r.result ? fmtPct(r.result.overall.on.winRate, 0) : "—"}
                    </td>
                    <td className="px-3 py-2 text-right font-mono nums text-[color:var(--short)]">
                      {r.result ? fmtPct(r.result.overall.on.maxDrawdown, 2) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Recent runs */}
      <Collapsible open={showRecent} onOpenChange={setShowRecent}>
        <section className="rounded-xl border border-border bg-card">
          <CollapsibleTrigger asChild>
            <button type="button" className="flex w-full items-center gap-2 px-4 py-3 text-left">
              <span className="font-display text-base font-semibold">Recent runs</span>
              <Pill tone="muted" size="sm">{allRuns.length} total</Pill>
              <ChevronRight className={cn("ml-auto h-4 w-4 text-muted-foreground transition-transform", showRecent && "rotate-90")} />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="divide-y divide-border border-t border-border">
              {allRuns.map((r) => (
                <BacktestRunRow
                  key={r.id}
                  run={r}
                  onNavigate={onNavigate}
                  actionMutation={actionMutation}
                />
              ))}
            </ul>
          </CollapsibleContent>
        </section>
      </Collapsible>

      {/* News replay */}
      <Collapsible open={showReplay} onOpenChange={setShowReplay}>
        <section className="rounded-xl border border-border bg-card">
          <CollapsibleTrigger asChild>
            <button type="button" className="flex w-full items-center gap-2 px-4 py-3 text-left">
              <FlaskConical className="h-4 w-4 text-muted-foreground" aria-hidden />
              <span className="font-display text-base font-semibold">News replay</span>
              <Pill tone="muted" size="sm">{(runs.data.replayJobs ?? []).length}</Pill>
              <ChevronRight className={cn("ml-auto h-4 w-4 text-muted-foreground transition-transform", showReplay && "rotate-90")} />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="border-t border-border p-4">
              <ReplayPanel replayJobs={runs.data.replayJobs ?? []} replayError={runs.data.replayError ?? null} />
            </div>
          </CollapsibleContent>
        </section>
      </Collapsible>

      {/* Maintenance */}
      <Collapsible open={showMaintenance} onOpenChange={setShowMaintenance}>
        <section className="rounded-xl border border-border bg-card">
          <CollapsibleTrigger asChild>
            <button type="button" className="flex w-full items-center gap-2 px-4 py-3 text-left">
              <Trash2 className="h-4 w-4 text-muted-foreground" aria-hidden />
              <span className="font-display text-base font-semibold">Maintenance</span>
              <ChevronRight className={cn("ml-auto h-4 w-4 text-muted-foreground transition-transform", showMaintenance && "rotate-90")} />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="space-y-3 border-t border-border p-4">
              <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-3 sm:flex-row sm:items-center">
                <div className="flex-1">
                  <p className="text-sm font-medium">Clean up old runs</p>
                  <p className="text-xs text-muted-foreground">
                    Bulk-delete trade-level data for terminal runs older than N days.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    value={cleanupDays}
                    onChange={(e) => setCleanupDays(e.target.value)}
                    min={1}
                    className="w-20 rounded-md border border-border bg-card px-2 py-1.5 text-sm font-mono nums"
                    aria-label="Older than days"
                  />
                  <span className="text-xs text-muted-foreground">days</span>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="outline" size="sm">Clean up</Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Clean up old runs?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This will delete trade-level data for terminal runs older than {cleanupDays || "?"} days (a bounded batch per click). Run summaries are kept, but their trade timelines will be empty. This cannot be undone.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          onClick={runCleanup}
                        >
                          Clean up
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-[color:var(--short)]/25 bg-[color:var(--short)]/5 p-3">
                <div>
                  <p className="text-sm font-medium text-[color:var(--short)]">Delete failed & cancelled runs</p>
                  <p className="text-xs text-muted-foreground">
                    Permanently remove all runs that did not complete.
                  </p>
                </div>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="outline" size="sm" className="border-[color:var(--short)]/40 text-[color:var(--short)]">
                      Delete all
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete failed & cancelled runs?</AlertDialogTitle>
                      <AlertDialogDescription>
                        All runs with status &quot;failed&quot; or &quot;cancelled&quot; will be permanently removed, including their error logs.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        onClick={runPurge}
                      >
                        Delete
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>
          </CollapsibleContent>
        </section>
      </Collapsible>
    </div>
  );
}

interface BacktestFormProps {
  onSubmitted: (id?: string) => void;
  mutation: ReturnType<typeof usePostBacktestRun>;
}

function BacktestForm({ onSubmitted, mutation }: BacktestFormProps) {
  const watchlistQuery = useWatchlist();
  const watchlist = (watchlistQuery.data?.tickers ?? []).map((ticker) => ({ ticker }));
  const [tickers, setTickers] = useState<string[]>([]);
  const [testStart, setTestStart] = useState(() => daysAgo(30));
  const [testEnd, setTestEnd] = useState(() => daysAgo(0));
  const [enableLlmLog, setEnableLlmLog] = useState(false);
  const [disableGate, setDisableGate] = useState(false);

  const toggleTicker = (t: string) => {
    setTickers((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  };

  const submit = () => {
    mutation.mutate(
      { testStart, testEnd, tickers, enableLlmLog, disableGate },
      {
        onSuccess: (data) => onSubmitted(data.id),
        onError: (e) => toast.error(`Failed: ${e.message}`),
      },
    );
  };

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Tickers</p>
        <div className="flex flex-wrap gap-2">
          {watchlist.map((t) => (
            <label
              key={t.ticker}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition-colors",
                tickers.includes(t.ticker)
                  ? "border-primary bg-primary/15 text-primary"
                  : "border-border bg-muted/40 text-muted-foreground hover:text-foreground",
              )}
            >
              <Checkbox
                checked={tickers.includes(t.ticker)}
                onCheckedChange={() => toggleTicker(t.ticker)}
                className="h-3.5 w-3.5"
              />
              <span className="font-mono">{t.ticker}</span>
            </label>
          ))}
        </div>
        <p className="mt-1 text-[10px] text-muted-foreground">Leave empty to backtest the full watchlist.</p>
      </div>

      <div>
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Test window</p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="test-start" className="mb-1 block text-[10px] text-muted-foreground">From</label>
            <input
              id="test-start"
              type="date"
              value={testStart}
              onChange={(e) => setTestStart(e.target.value)}
              className="w-full rounded-md border border-border bg-card px-2.5 py-1.5 text-sm font-mono"
            />
          </div>
          <div>
            <label htmlFor="test-end" className="mb-1 block text-[10px] text-muted-foreground">To</label>
            <input
              id="test-end"
              type="date"
              value={testEnd}
              onChange={(e) => setTestEnd(e.target.value)}
              className="w-full rounded-md border border-border bg-card px-2.5 py-1.5 text-sm font-mono"
            />
          </div>
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          {RANGE_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => {
                const end = new Date();
                const start = new Date(end.getTime() - p.days * 24 * 60 * 60 * 1000);
                const fmt = (d: Date) => d.toISOString().slice(0, 10);
                setTestStart(fmt(start));
                setTestEnd(fmt(end));
              }}
              className="rounded-md border border-border bg-muted/40 px-2 py-0.5 font-mono text-[10px] text-muted-foreground hover:text-foreground"
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <label className="flex cursor-pointer items-center gap-2">
        <Checkbox checked={enableLlmLog} onCheckedChange={(v) => v !== "indeterminate" && setEnableLlmLog(!!v)} className="h-3.5 w-3.5" />
        <span className="text-xs">Enable LLM call logging for this run</span>
        <span className="text-[10px] text-muted-foreground">(spends extra D1 writes)</span>
      </label>

      <label className="flex cursor-pointer items-center gap-2">
        <Checkbox checked={disableGate} onCheckedChange={(v) => v !== "indeterminate" && setDisableGate(!!v)} className="h-3.5 w-3.5" />
        <span className="text-xs">Disable price-impact gate</span>
        <span className="text-[10px] text-muted-foreground">(this run only; unchecked = gate on)</span>
      </label>

      <div className="flex items-start gap-2 rounded-lg border border-[color:var(--paused)]/25 bg-[color:var(--paused)]/8 px-3 py-2 text-xs">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[color:var(--paused)]" aria-hidden />
        <p className="text-muted-foreground">
          Backtests spend real Gemini quota. A 30-day window with 3 tickers typically costs 200-400 Gemini calls.
        </p>
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" type="button">Cancel</Button>
        <Button size="sm" type="button" onClick={submit} disabled={mutation.isPending}>
          {mutation.isPending ? (
            <>
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              Submitting…
            </>
          ) : (
            <>
              <Play className="mr-1 h-3 w-3" />
              {tickers.length === 0 && watchlist.length > 0 ? `Run backtest (all ${watchlist.length} tickers)` : "Run backtest"}
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

function BacktestRunRow({
  run,
  onNavigate,
  actionMutation,
}: {
  run: BacktestRun;
  onNavigate: ViewProps["onNavigate"];
  actionMutation: ReturnType<typeof usePostBacktestAction>;
}) {
  const [open, setOpen] = useState(false);
  const variant =
    run.status === "complete" ? "approved" :
    run.status === "failed" ? "rejected" :
    run.status === "paused" ? "paused" :
    run.status === "running" ? "info" : "neutral";

  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/40"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-semibold">{run.tickers.join(",")}</span>
            <StatusBadge variant={variant} label={backtestStatusLabel(run.status)} />
            {run.pausedReason && (
              <Pill tone="paused" size="sm">{pauseReasonLabel(run.pausedReason)}</Pill>
            )}
          </div>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {fmtDate(run.testStart)} → {fmtDate(run.testEnd)}
          </p>
        </div>
        <ChevronRight className={cn("h-4 w-4 text-muted-foreground transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="space-y-3 border-t border-border bg-muted/20 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-mono text-[11px] text-muted-foreground">{run.id}</span>
            <button
              type="button"
              onClick={() => onNavigate("backtest", { backtestId: run.id })}
              className="text-primary hover:underline"
            >
              View timeline →
            </button>
            <span className="text-muted-foreground">·</span>
            <button
              type="button"
              onClick={() => onNavigate("llm", { ticker: run.tickers[0] })}
              className="text-primary hover:underline"
            >
              LLM calls →
            </button>
          </div>

          {run.error && (
            <div className="rounded-lg border border-[color:var(--short)]/30 bg-[color:var(--short)]/8 px-3 py-2 text-xs">
              <p className="font-medium text-[color:var(--short)]">Run failed</p>
              <p className="mt-0.5 text-muted-foreground break-words">{run.error}</p>
            </div>
          )}

          {run.status === "complete" && run.result && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <MiniStat
                value={fmtPct(run.result.overall.on.cumulativeReturn, 2)}
                label="Strategy return"
                sub={`vs ${fmtPct(run.result.overall.off.cumulativeReturn, 2)} b&h`}
              />
              <MiniStat
                value={run.result.overall.on.sharpeRatio.toFixed(2)}
                label="Sharpe"
                sub={`vs ${run.result.overall.off.sharpeRatio.toFixed(2)} b&h`}
              />
              <MiniStat
                value={fmtPct(run.result.overall.on.winRate, 0)}
                label="Win rate"
                sub={`${run.result.gate?.n ?? 0} trades`}
              />
              <MiniStat
                value={fmtPct(run.result.overall.on.maxDrawdown, 2)}
                label="Max drawdown"
              />
            </div>
          )}

          {run.status === "paused" && (
            <div className="flex flex-wrap items-center gap-2">
              <Pill tone="paused" size="sm">{pauseReasonLabel(run.pausedReason!)}</Pill>
              {run.resumeAfter && (
                <span className="text-[11px] text-muted-foreground">
                  resume after {fmtTime(run.resumeAfter)}
                </span>
              )}
            </div>
          )}

          {(run.status === "running" || run.status === "paused") && (
            <div className="flex flex-wrap gap-2">
              {run.status === "paused" ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => actionMutation.mutate({ id: run.id, action: "resume" })}
                >
                  <Play className="mr-1 h-3 w-3" />
                  Resume
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => actionMutation.mutate({ id: run.id, action: "pause" })}
                >
                  <Pause className="mr-1 h-3 w-3" />
                  Pause
                </Button>
              )}
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button size="sm" variant="outline" className="border-[color:var(--short)]/40 text-[color:var(--short)]">
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
                      onClick={() => actionMutation.mutate({ id: run.id, action: "cancel" })}
                    >
                      Terminate
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          )}
        </div>
      )}
    </li>
  );
}
