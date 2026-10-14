"use client";

import { useCallback, useEffect, useState } from "react";
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
import { JobProgressCard } from "../job-progress";
import type { BacktestRun } from "@/lib/types";
import { SectionHeading, StatusBadge, Pill, MiniStat, ErrorState } from "../primitives";
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
import { daysAgo, RANGE_PRESETS, presetRange } from "@/lib/date-range";
import type { ViewProps } from "./types";

// TEMPORARY presets for A/B testing - remove when done
interface BacktestPresetState {
  name: string;
  intradayTechnical: boolean;
  independenceNote: boolean;
  rangeLocationFilter: boolean;
  entryConfirmation: boolean;
  rangeFilterDays: string;
  rangeFilterEdgePct: string;
  entryConfirmMovePct: string;
  entryConfirmHours: string;
  breakEvenTriggerR: string;
  trailActivationR: string;
  trailDistanceR: string;
  trailRemovesTarget: boolean;
}

const BACKTEST_PRESETS: readonly BacktestPresetState[] = [
  {
    name: "Baseline",
    intradayTechnical: false,
    independenceNote: false,
    rangeLocationFilter: false,
    entryConfirmation: false,
    rangeFilterDays: "",
    rangeFilterEdgePct: "",
    entryConfirmMovePct: "",
    entryConfirmHours: "",
    breakEvenTriggerR: "",
    trailActivationR: "",
    trailDistanceR: "",
    trailRemovesTarget: false,
  },
  {
    name: "Trail",
    intradayTechnical: false,
    independenceNote: false,
    rangeLocationFilter: false,
    entryConfirmation: false,
    rangeFilterDays: "",
    rangeFilterEdgePct: "",
    entryConfirmMovePct: "",
    entryConfirmHours: "",
    breakEvenTriggerR: "0.4",
    trailActivationR: "0.5",
    trailDistanceR: "0.25",
    trailRemovesTarget: true,
  },
  {
    name: "Trail + Range",
    intradayTechnical: false,
    independenceNote: false,
    rangeLocationFilter: true,
    entryConfirmation: false,
    rangeFilterDays: "10",
    rangeFilterEdgePct: "0.2",
    entryConfirmMovePct: "",
    entryConfirmHours: "",
    breakEvenTriggerR: "0.4",
    trailActivationR: "0.5",
    trailDistanceR: "0.25",
    trailRemovesTarget: true,
  },
  {
    name: "Trail + Confirm",
    intradayTechnical: false,
    independenceNote: false,
    rangeLocationFilter: false,
    entryConfirmation: true,
    rangeFilterDays: "",
    rangeFilterEdgePct: "",
    entryConfirmMovePct: "0.005",
    entryConfirmHours: "6",
    breakEvenTriggerR: "0.4",
    trailActivationR: "0.5",
    trailDistanceR: "0.25",
    trailRemovesTarget: true,
  },
  {
    name: "Trail + Both",
    intradayTechnical: false,
    independenceNote: false,
    rangeLocationFilter: true,
    entryConfirmation: true,
    rangeFilterDays: "10",
    rangeFilterEdgePct: "0.2",
    entryConfirmMovePct: "0.005",
    entryConfirmHours: "6",
    breakEvenTriggerR: "0.4",
    trailActivationR: "0.5",
    trailDistanceR: "0.25",
    trailRemovesTarget: true,
  },
  {
    name: "Range only",
    intradayTechnical: false,
    independenceNote: false,
    rangeLocationFilter: true,
    entryConfirmation: false,
    rangeFilterDays: "10",
    rangeFilterEdgePct: "0.2",
    entryConfirmMovePct: "",
    entryConfirmHours: "",
    breakEvenTriggerR: "",
    trailActivationR: "",
    trailDistanceR: "",
    trailRemovesTarget: false,
  },
  {
    name: "Confirm only",
    intradayTechnical: false,
    independenceNote: false,
    rangeLocationFilter: false,
    entryConfirmation: true,
    rangeFilterDays: "",
    rangeFilterEdgePct: "",
    entryConfirmMovePct: "0.005",
    entryConfirmHours: "6",
    breakEvenTriggerR: "",
    trailActivationR: "",
    trailDistanceR: "",
    trailRemovesTarget: false,
  },
  {
    name: "Range N14",
    intradayTechnical: false,
    independenceNote: false,
    rangeLocationFilter: true,
    entryConfirmation: false,
    rangeFilterDays: "14",
    rangeFilterEdgePct: "0.2",
    entryConfirmMovePct: "",
    entryConfirmHours: "",
    breakEvenTriggerR: "",
    trailActivationR: "",
    trailDistanceR: "",
    trailRemovesTarget: false,
  },
  {
    name: "Range edge .15",
    intradayTechnical: false,
    independenceNote: false,
    rangeLocationFilter: true,
    entryConfirmation: false,
    rangeFilterDays: "10",
    rangeFilterEdgePct: "0.15",
    entryConfirmMovePct: "",
    entryConfirmHours: "",
    breakEvenTriggerR: "",
    trailActivationR: "",
    trailDistanceR: "",
    trailRemovesTarget: false,
  },
  {
    name: "Range edge .25",
    intradayTechnical: false,
    independenceNote: false,
    rangeLocationFilter: true,
    entryConfirmation: false,
    rangeFilterDays: "10",
    rangeFilterEdgePct: "0.25",
    entryConfirmMovePct: "",
    entryConfirmHours: "",
    breakEvenTriggerR: "",
    trailActivationR: "",
    trailDistanceR: "",
    trailRemovesTarget: false,
  },
  {
    name: "Confirm 3h",
    intradayTechnical: false,
    independenceNote: false,
    rangeLocationFilter: false,
    entryConfirmation: true,
    rangeFilterDays: "",
    rangeFilterEdgePct: "",
    entryConfirmMovePct: "0.005",
    entryConfirmHours: "3",
    breakEvenTriggerR: "",
    trailActivationR: "",
    trailDistanceR: "",
    trailRemovesTarget: false,
  },
  {
    name: "Confirm 12h",
    intradayTechnical: false,
    independenceNote: false,
    rangeLocationFilter: false,
    entryConfirmation: true,
    rangeFilterDays: "",
    rangeFilterEdgePct: "",
    entryConfirmMovePct: "0.005",
    entryConfirmHours: "12",
    breakEvenTriggerR: "",
    trailActivationR: "",
    trailDistanceR: "",
    trailRemovesTarget: false,
  },
  {
    name: "Confirm 0.3%",
    intradayTechnical: false,
    independenceNote: false,
    rangeLocationFilter: false,
    entryConfirmation: true,
    rangeFilterDays: "",
    rangeFilterEdgePct: "",
    entryConfirmMovePct: "0.003",
    entryConfirmHours: "6",
    breakEvenTriggerR: "",
    trailActivationR: "",
    trailDistanceR: "",
    trailRemovesTarget: false,
  },
  {
    name: "Confirm 0.8%",
    intradayTechnical: false,
    independenceNote: false,
    rangeLocationFilter: false,
    entryConfirmation: true,
    rangeFilterDays: "",
    rangeFilterEdgePct: "",
    entryConfirmMovePct: "0.008",
    entryConfirmHours: "6",
    breakEvenTriggerR: "",
    trailActivationR: "",
    trailDistanceR: "",
    trailRemovesTarget: false,
  },
  {
    name: "Trail only wide",
    intradayTechnical: false,
    independenceNote: false,
    rangeLocationFilter: false,
    entryConfirmation: false,
    rangeFilterDays: "",
    rangeFilterEdgePct: "",
    entryConfirmMovePct: "",
    entryConfirmHours: "",
    breakEvenTriggerR: "0.6",
    trailActivationR: "0.8",
    trailDistanceR: "0.4",
    trailRemovesTarget: true,
  },
] as const;

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

export function BacktestView({ onNavigate }: ViewProps) {
  const [showNewRun, setShowNewRun] = useState(true);
  const [showRecent, setShowRecent] = useState(true);
  const [showMaintenance, setShowMaintenance] = useState(false);
  const [showReplay, setShowReplay] = useState(false);
  const [cleanupDays, setCleanupDays] = useState("30");
  // TEMPORARY: a run picked via "Seed new run from this"; `n` re-triggers the form even for the same run.
  const [seedRequest, setSeedRequest] = useState<{ run: BacktestRun; n: number } | null>(null);

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
      {activeJob.data?.job && (activeJob.data.job.status === "running" || activeJob.data.job.status === "queued") && (
        <JobProgressCard
          job={activeJob.data.job}
          label="Backtest"
          action={
            <button
              type="button"
              onClick={() => onNavigate("backtest", { backtestId: activeJob.data.job!.id })}
              className="inline-flex items-center gap-1 text-xs font-medium text-[color:var(--info)] hover:underline"
            >
              Open timeline <ChevronRight className="h-3 w-3" />
            </button>
          }
        />
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
                seedCandidates={completeRuns}
                seedRequest={seedRequest}
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
                  onUseAsSeed={(run) => {
                    setSeedRequest((prev) => ({ run, n: (prev?.n ?? 0) + 1 }));
                    setShowNewRun(true);
                    toast.success(`New run will be seeded from ${run.id.slice(-6)}`);
                  }}
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
  /** TEMPORARY: complete runs that can serve as a seed. */
  seedCandidates: BacktestRun[];
  seedRequest: { run: BacktestRun; n: number } | null;
}

function BacktestForm({ onSubmitted, mutation, seedCandidates, seedRequest }: BacktestFormProps) {
  const watchlistQuery = useWatchlist();
  const watchlist = (watchlistQuery.data?.tickers ?? []).map((ticker) => ({ ticker }));
  const [tickers, setTickers] = useState<string[]>([]);
  const [testStart, setTestStart] = useState(() => daysAgo(30));
  const [testEnd, setTestEnd] = useState(() => daysAgo(0));
  const [enableLlmLog, setEnableLlmLog] = useState(false);
  const [disableGate, setDisableGate] = useState(false);
  const [enableMacro, setEnableMacro] = useState(false);
  const [mergedVerdict, setMergedVerdict] = useState(false);
  // Decision switches for this run only (default off; never the live switches).
  const [intradayTechnical, setIntradayTechnical] = useState(false);
  const [independenceNote, setIndependenceNote] = useState(false);
  const [rangeLocationFilter, setRangeLocationFilter] = useState(false);
  const [entryConfirmation, setEntryConfirmation] = useState(false);
  // Optional numeric params of those two switches (blank = the default); the backend validates the bounds.
  const [rangeFilterDays, setRangeFilterDays] = useState("");
  const [rangeFilterEdgePct, setRangeFilterEdgePct] = useState("");
  const [entryConfirmMovePct, setEntryConfirmMovePct] = useState("");
  const [entryConfirmHours, setEntryConfirmHours] = useState("");
  // Exit knobs for this run only, in R (blank = default 0 = off). Never the live knobs.
  const [breakEvenTriggerR, setBreakEvenTriggerR] = useState("");
  const [trailActivationR, setTrailActivationR] = useState("");
  const [trailDistanceR, setTrailDistanceR] = useState("");
  const [trailRemovesTarget, setTrailRemovesTarget] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // TEMPORARY tuning aid: reuse another complete run's LLM-stage output ("" = a normal, fresh run).
  const [seedFromRunId, setSeedFromRunId] = useState("");

  // The backend needs the same start date as the source and tickers it covered, so picking a seed fills both.
  const applySeed = useCallback((run: BacktestRun) => {
    setSeedFromRunId(run.id);
    setTestStart(run.testStart.slice(0, 10));
    setTickers(run.tickers);
  }, []);
  // Apply each new seed request once, during render (setState in an effect trips the react-hooks lint).
  const [handledSeed, setHandledSeed] = useState<typeof seedRequest>(null);
  if (seedRequest !== handledSeed) {
    setHandledSeed(seedRequest);
    if (seedRequest) applySeed(seedRequest.run);
  }

  // Compute active preset based on current form state
  const currentState = {
    intradayTechnical,
    independenceNote,
    rangeLocationFilter,
    entryConfirmation,
    rangeFilterDays,
    rangeFilterEdgePct,
    entryConfirmMovePct,
    entryConfirmHours,
    breakEvenTriggerR,
    trailActivationR,
    trailDistanceR,
    trailRemovesTarget,
  };

  const activePreset = BACKTEST_PRESETS.find((p) => {
    return (
      p.intradayTechnical === currentState.intradayTechnical &&
      p.independenceNote === currentState.independenceNote &&
      p.rangeLocationFilter === currentState.rangeLocationFilter &&
      p.entryConfirmation === currentState.entryConfirmation &&
      p.rangeFilterDays === currentState.rangeFilterDays &&
      p.rangeFilterEdgePct === currentState.rangeFilterEdgePct &&
      p.entryConfirmMovePct === currentState.entryConfirmMovePct &&
      p.entryConfirmHours === currentState.entryConfirmHours &&
      p.breakEvenTriggerR === currentState.breakEvenTriggerR &&
      p.trailActivationR === currentState.trailActivationR &&
      p.trailDistanceR === currentState.trailDistanceR &&
      p.trailRemovesTarget === currentState.trailRemovesTarget
    );
  });
  const activePresetName = activePreset ? activePreset.name : "Custom";

  // Summary builder for active settings
  const summaryParts: string[] = [];
  if (breakEvenTriggerR || trailActivationR || trailDistanceR) {
    summaryParts.push(`trail ${breakEvenTriggerR || "0"}/${trailActivationR || "0"}/${trailDistanceR || "0"}`);
  } else {
    summaryParts.push("trail OFF");
  }
  summaryParts.push(`range ${rangeLocationFilter ? `ON (${rangeFilterDays||"10"}d/${rangeFilterEdgePct||"0.2"})` : "OFF"}`);
  summaryParts.push(`confirm ${entryConfirmation ? `ON (${entryConfirmMovePct||"0.005"}/${entryConfirmHours||"6"}h)` : "OFF"}`);
  if (intradayTechnical) summaryParts.push("intraday ON");
  if (independenceNote) summaryParts.push("independence ON");
  if (seedFromRunId) summaryParts.push(`seed ${seedFromRunId.slice(-6)}`);
  const activeSummary = summaryParts.join(" | ");

  const applyPreset = (p: BacktestPresetState) => {
    setIntradayTechnical(p.intradayTechnical);
    setIndependenceNote(p.independenceNote);
    setRangeLocationFilter(p.rangeLocationFilter);
    setEntryConfirmation(p.entryConfirmation);
    setRangeFilterDays(p.rangeFilterDays);
    setRangeFilterEdgePct(p.rangeFilterEdgePct);
    setEntryConfirmMovePct(p.entryConfirmMovePct);
    setEntryConfirmHours(p.entryConfirmHours);
    setBreakEvenTriggerR(p.breakEvenTriggerR);
    setTrailActivationR(p.trailActivationR);
    setTrailDistanceR(p.trailDistanceR);
    setTrailRemovesTarget(p.trailRemovesTarget);
  };

  const toggleTicker = (t: string) => {
    setTickers((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  };

  const reset = () => {
    setTickers([]);
    setTestStart(daysAgo(30));
    setTestEnd(daysAgo(0));
    setEnableLlmLog(false);
    setDisableGate(false);
    setEnableMacro(false);
    setMergedVerdict(false);
    setIntradayTechnical(false);
    setIndependenceNote(false);
    setRangeLocationFilter(false);
    setEntryConfirmation(false);
    setRangeFilterDays("");
    setRangeFilterEdgePct("");
    setEntryConfirmMovePct("");
    setEntryConfirmHours("");
    setBreakEvenTriggerR("");
    setTrailActivationR("");
    setTrailDistanceR("");
    setTrailRemovesTarget(false);
    setSeedFromRunId("");
  };

  const knobFields: [string, string][] = [
    ["Break-even trigger", breakEvenTriggerR],
    ["Trail activation", trailActivationR],
    ["Trail distance", trailDistanceR],
  ];
  // Blank = leave at default; otherwise a number from 0 to 10 (the backend enforces the same bounds).
  const knobNumber = (raw: string) => {
    const t = raw.trim();
    return t === "" ? undefined : Number(t);
  };
  const knobInvalid = (raw: string) => {
    const n = knobNumber(raw);
    return n !== undefined && (!Number.isFinite(n) || n < 0 || n > 10);
  };

  const paramFields: string[] = [rangeFilterDays, rangeFilterEdgePct, entryConfirmMovePct, entryConfirmHours];
  // Blank = default; otherwise a positive number (the backend enforces the exact bounds and rejects the run if they are off).
  const paramInvalid = (raw: string) => {
    const n = knobNumber(raw);
    return n !== undefined && (!Number.isFinite(n) || n <= 0);
  };

  // ISO dates (YYYY-MM-DD) compare correctly as strings.
  const requestSubmit = () => {
    if (!testStart || !testEnd) {
      toast.error("Pick both a start and an end date");
      return;
    }
    if (testStart >= testEnd) {
      toast.error("The start date must be before the end date");
      return;
    }
    if (knobFields.some(([, raw]) => knobInvalid(raw))) {
      toast.error("Exit knobs must be numbers from 0 to 10 (or blank)");
      return;
    }
    if (paramFields.some(paramInvalid)) {
      toast.error("Range filter / entry confirmation values must be positive numbers (or blank)");
      return;
    }
    setConfirmOpen(true);
  };

  const submit = () => {
    mutation.mutate(
      {
        testStart,
        testEnd,
        tickers,
        enableLlmLog,
        disableGate,
        enableMacro,
        mergedVerdict,
        intradayTechnical,
        independenceNote,
        rangeLocationFilter,
        entryConfirmation,
        rangeFilterDays: knobNumber(rangeFilterDays),
        rangeFilterEdgePct: knobNumber(rangeFilterEdgePct),
        entryConfirmMovePct: knobNumber(entryConfirmMovePct),
        entryConfirmHours: knobNumber(entryConfirmHours),
        breakEvenTriggerR: knobNumber(breakEvenTriggerR),
        trailActivationR: knobNumber(trailActivationR),
        trailDistanceR: knobNumber(trailDistanceR),
        trailRemovesTarget: trailRemovesTarget ? 1 : undefined,
        seedFromRunId: seedFromRunId || undefined,
      },
      {
        onSuccess: (data) => onSubmitted(data.id),
        onError: (e) => toast.error(`Failed: ${e.message}`),
      },
    );
  };

  return (
    <div className="space-y-4">
      {/* TEMPORARY Presets row */}
      <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Presets:</span>
            <span className="rounded-md bg-primary/10 px-2 py-0.5 font-mono text-xs font-medium text-primary">
              {activePresetName}
            </span>
          </div>
          <p className="font-mono text-[11px] text-muted-foreground">{activeSummary}</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {BACKTEST_PRESETS.map((preset) => {
            const isActive = activePresetName === preset.name;
            return (
              <Button
                key={preset.name}
                type="button"
                variant={isActive ? "default" : "outline"}
                size="sm"
                onClick={() => applyPreset(preset)}
                className="h-7 px-2.5 text-xs"
              >
                {preset.name}
              </Button>
            );
          })}
        </div>
      </div>

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
                const r = presetRange(p.days);
                setTestStart(r.from);
                setTestEnd(r.to);
              }}
              className="rounded-md border border-border bg-muted/40 px-2 py-0.5 font-mono text-[10px] text-muted-foreground hover:text-foreground"
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* TEMPORARY seed picker */}
      <div>
        <label htmlFor="seed-from-run" className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Seed from run (temporary tuning aid)
        </label>
        <select
          id="seed-from-run"
          value={seedFromRunId}
          onChange={(e) => {
            const run = seedCandidates.find((r) => r.id === e.target.value);
            if (run) applySeed(run);
            else setSeedFromRunId("");
          }}
          className="w-full rounded-md border border-border bg-card px-2.5 py-1.5 text-sm font-mono"
        >
          <option value="">None: fresh LLM run</option>
          {seedCandidates.map((r) => (
            <option key={r.id} value={r.id}>
              {`${r.id.slice(-6)} · ${r.tickers.join(",")} · ${fmtDate(r.testStart)} → ${fmtDate(r.testEnd)} · ${r.result?.gate?.n ?? 0} trades`}
            </option>
          ))}
        </select>
        <p className="mt-1 text-[10px] text-muted-foreground">
          {seedFromRunId
            ? "Reuses that run's analyst, debate and trader output, so only the filters, entry confirmation, fills and exits differ. Start date and tickers were set from the source. The LLM-stage boxes (price-impact gate, macro, merged verdict, intraday, evidence rule) must match the source or the backend refuses the run. Fixes one LLM draw: confirm a winner with fresh runs."
            : "Optional. Pick a complete run to compare presets on identical LLM output (spends almost no Gemini quota)."}
        </p>
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

      <label className="flex cursor-pointer items-center gap-2">
        <Checkbox checked={enableMacro} onCheckedChange={(v) => v !== "indeterminate" && setEnableMacro(!!v)} className="h-3.5 w-3.5" />
        <span className="text-xs">Include macro context (XAUUSD)</span>
        <span className="text-[10px] text-muted-foreground">(FRED + COT; this run only, unchecked = off; ignores the live switch)</span>
      </label>

      <label className="flex cursor-pointer items-center gap-2">
        <Checkbox checked={mergedVerdict} onCheckedChange={(v) => v !== "indeterminate" && setMergedVerdict(!!v)} className="h-3.5 w-3.5" />
        <span className="text-xs">Merged verdict (1 call instead of 3)</span>
        <span className="text-[10px] text-muted-foreground">(this run only; one judge call replaces bull + bear + judge; run twice to compare)</span>
      </label>

      <label className="flex cursor-pointer items-center gap-2">
        <Checkbox checked={intradayTechnical} onCheckedChange={(v) => v !== "indeterminate" && setIntradayTechnical(!!v)} className="h-3.5 w-3.5" />
        <span className="text-xs">Intraday price for the technical analyst</span>
        <span className="text-[10px] text-muted-foreground">(this run only, unchecked = off; ignores the live switch)</span>
      </label>

      <label className="flex cursor-pointer items-center gap-2">
        <Checkbox checked={independenceNote} onCheckedChange={(v) => v !== "indeterminate" && setIndependenceNote(!!v)} className="h-3.5 w-3.5" />
        <span className="text-xs">Evidence rule in judge prompts</span>
        <span className="text-[10px] text-muted-foreground">(this run only, unchecked = off; ignores the live switch)</span>
      </label>

      <label className="flex cursor-pointer items-center gap-2">
        <Checkbox checked={rangeLocationFilter} onCheckedChange={(v) => v !== "indeterminate" && setRangeLocationFilter(!!v)} className="h-3.5 w-3.5" />
        <span className="text-xs">Range-location filter</span>
        <span className="text-[10px] text-muted-foreground">(this run only, unchecked = off; blocks longs near the N-day high / shorts near the N-day low unless breakout)</span>
      </label>

      <label className="flex cursor-pointer items-center gap-2">
        <Checkbox checked={entryConfirmation} onCheckedChange={(v) => v !== "indeterminate" && setEntryConfirmation(!!v)} className="h-3.5 w-3.5" />
        <span className="text-xs">Entry confirmation</span>
        <span className="text-[10px] text-muted-foreground">(this run only, unchecked = off; waits for a bar close in the trade direction before opening)</span>
      </label>

      <div>
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Filter / confirmation values (optional, this run only)</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {([
            ["param-range-days", "Range days", rangeFilterDays, setRangeFilterDays, "10"],
            ["param-range-edge", "Range edge (fraction)", rangeFilterEdgePct, setRangeFilterEdgePct, "0.2"],
            ["param-confirm-move", "Confirm move (fraction)", entryConfirmMovePct, setEntryConfirmMovePct, "0.005"],
            ["param-confirm-hours", "Confirm wait (hours)", entryConfirmHours, setEntryConfirmHours, "6"],
          ] as const).map(([id, label, value, set, placeholder]) => (
            <div key={id}>
              <label htmlFor={id} className="mb-1 block text-[10px] text-muted-foreground">{label}</label>
              <input
                id={id}
                type="text"
                inputMode="decimal"
                placeholder={`default ${placeholder}`}
                value={value}
                onChange={(e) => set(e.target.value)}
                className={cn(
                  "w-full rounded-md border bg-card px-2.5 py-1.5 text-sm font-mono",
                  paramInvalid(value) ? "border-destructive" : "border-border",
                )}
              />
            </div>
          ))}
        </div>
        <p className="mt-1 text-[10px] text-muted-foreground">Blank = default. Only used when the matching box above is checked; the values used are recorded on the run.</p>
      </div>

      <div>
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Exit knobs (this run only)</p>
        <div className="grid grid-cols-3 gap-3">
          {knobFields.map(([label, value], i) => {
            const set = [setBreakEvenTriggerR, setTrailActivationR, setTrailDistanceR][i];
            const id = ["knob-be", "knob-trail-act", "knob-trail-dist"][i];
            return (
              <div key={id}>
                <label htmlFor={id} className="mb-1 block text-[10px] text-muted-foreground">{label} (R)</label>
                <input
                  id={id}
                  type="text"
                  inputMode="decimal"
                  placeholder="0 = off"
                  value={value}
                  onChange={(e) => set(e.target.value)}
                  className={cn(
                    "w-full rounded-md border bg-card px-2.5 py-1.5 text-sm font-mono",
                    knobInvalid(value) ? "border-destructive" : "border-border",
                  )}
                />
              </div>
            );
          })}
        </div>
        <label className="mt-2 flex cursor-pointer items-center gap-2">
          <Checkbox checked={trailRemovesTarget} onCheckedChange={(v) => v !== "indeterminate" && setTrailRemovesTarget(!!v)} className="h-3.5 w-3.5" />
          <span className="text-xs">Trailing removes take-profit target</span>
        </label>
        <p className="mt-1 text-[10px] text-muted-foreground">R = the position&apos;s initial stop distance. Blank = off. Ignores the live Exit knobs; the values used are recorded on the run.</p>
      </div>

      <div className="flex items-start gap-2 rounded-lg border border-[color:var(--paused)]/25 bg-[color:var(--paused)]/8 px-3 py-2 text-xs">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[color:var(--paused)]" aria-hidden />
        <p className="text-muted-foreground">
          Backtests spend real Gemini quota. A 30-day window with 3 tickers typically costs 200-400 Gemini calls.
        </p>
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" type="button" onClick={reset} disabled={mutation.isPending}>Reset</Button>
        <Button size="sm" type="button" onClick={requestSubmit} disabled={mutation.isPending}>
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

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Start this backtest?</AlertDialogTitle>
            <AlertDialogDescription>
              {tickers.length === 0 ? `All ${watchlist.length} watchlist tickers` : `${tickers.length} ticker${tickers.length === 1 ? "" : "s"} (${tickers.join(", ")})`}
              {" "}from {testStart} to {testEnd}.{" "}
              {seedFromRunId
                ? `Seeded from ${seedFromRunId.slice(-6)}: only the post-LLM stages run again, plus one reflection call per closed position.`
                : "This spends real Gemini quota."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={submit}>Start backtest</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function BacktestRunRow({
  run,
  onNavigate,
  actionMutation,
  onUseAsSeed,
}: {
  run: BacktestRun;
  onNavigate: ViewProps["onNavigate"];
  actionMutation: ReturnType<typeof usePostBacktestAction>;
  onUseAsSeed: (run: BacktestRun) => void;
}) {
  const [open, setOpen] = useState(false);
  const act = (action: "resume" | "pause" | "cancel") =>
    actionMutation.mutate(
      { id: run.id, action },
      { onError: (e) => toast.error(`Could not ${action} the run: ${e.message}`) },
    );
  // The mutation is shared by every row, so only this row's own in-flight action disables its buttons.
  const busy = actionMutation.isPending && actionMutation.variables?.id === run.id;
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
            {run.status === "complete" && (
              <>
                <span className="text-muted-foreground">·</span>
                <button type="button" onClick={() => onUseAsSeed(run)} className="text-primary hover:underline">
                  Seed new run from this →
                </button>
              </>
            )}
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
                  disabled={busy}
                  onClick={() => act("resume")}
                >
                  <Play className="mr-1 h-3 w-3" />
                  Resume
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => act("pause")}
                >
                  <Pause className="mr-1 h-3 w-3" />
                  Pause
                </Button>
              )}
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button size="sm" variant="outline" disabled={busy} className="border-[color:var(--short)]/40 text-[color:var(--short)]">
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
                      onClick={() => act("cancel")}
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
