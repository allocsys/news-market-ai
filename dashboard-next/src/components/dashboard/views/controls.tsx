"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { Pause, Play, ChevronDown, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useControls, usePostControlsSet, useActiveTickers, usePostActiveTickers } from "@/lib/api";
import { SectionHeading, Pill, ErrorState } from "../primitives";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { fmtRelative } from "@/lib/format";
import type { ViewProps } from "./types";

const PAUSE_META = [
  { key: "ingestion" as const, label: "Ingestion", description: "Live news, price, and fundamentals fan-out (*/15 cron + queue consumers)" },
  { key: "trading" as const, label: "Trading", description: "Exit checks + analyze/decision pipeline. Resume places trades.", dangerous: true },
  { key: "llm" as const, label: "LLM calls", description: "Every Gemini-calling path. New backtest runs are also blocked.", dangerous: true },
  { key: "backtests" as const, label: "New backtests", description: "Starting new backtest runs. In-flight runs finish." },
];

export function ControlsView({}: ViewProps) {
  const controls = useControls();
  const setFlag = usePostControlsSet();

  if (controls.isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading controls…
      </div>
    );
  }
  if (controls.isError || !controls.data) {
    return <ErrorState message={controls.error?.message ?? "Failed to load controls"} />;
  }

  const flags = controls.data.flags;
  const meta = controls.data.meta;
  const pausedCount = Object.values(flags).filter(Boolean).length;

  const toggleFlag = (key: keyof typeof flags) => {
    setFlag.mutate(
      { key, paused: !flags[key] },
      { onError: (e) => toast.error(`Failed: ${e.message}`) },
    );
  };

  return (
    <div className="space-y-5">
      <section>
        <SectionHeading
          title="Pause switches"
          description="Independent kill switches for each subsystem"
          action={
            <Pill tone={pausedCount > 0 ? "paused" : "long"} size="md">
              {pausedCount === 0 ? "Everything is running" : `${pausedCount} of 4 paused`}
            </Pill>
          }
        />
      </section>

      <ul className="space-y-2">
        {PAUSE_META.map((m) => {
          const isPaused = flags[m.key];
          const m2 = meta[m.key];
          return (
            <li key={m.key} className="rounded-xl border border-border bg-card p-4 card-hairline">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-display text-base font-semibold">{m.label}</span>
                    <Pill tone={isPaused ? "paused" : "long"} size="sm">
                      {isPaused ? "Paused" : "Running"}
                    </Pill>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{m.description}</p>
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    Last changed {m2?.updatedAt ? fmtRelative(m2.updatedAt) : "—"} by {m2?.updatedBy ?? "—"}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {m.dangerous && !isPaused && (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="outline" size="sm" className="border-[color:var(--paused)]/40 text-[color:var(--paused)]">
                          <Pause className="mr-1 h-3 w-3" />
                          Pause
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Pause {m.label}?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This will halt the {m.description.toLowerCase()}. Confirm to proceed.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            className="bg-[color:var(--paused)] text-black hover:bg-[color:var(--paused)]/90"
                            onClick={() => toggleFlag(m.key)}
                          >
                            Pause
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
                  {m.dangerous && isPaused && (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="outline" size="sm" className="border-[color:var(--long)]/40 text-[color:var(--long)]">
                          <Play className="mr-1 h-3 w-3" />
                          Resume
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Resume {m.label}?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This will resume {m.description.toLowerCase()}. Resuming this subsystem may spend money or place trades.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction onClick={() => toggleFlag(m.key)}>Resume</AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
                  {!m.dangerous && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => toggleFlag(m.key)}
                      className={isPaused ? "border-[color:var(--long)]/40 text-[color:var(--long)]" : "border-[color:var(--paused)]/40 text-[color:var(--paused)]"}
                    >
                      {isPaused ? (
                        <>
                          <Play className="mr-1 h-3 w-3" />
                          Resume
                        </>
                      ) : (
                        <>
                          <Pause className="mr-1 h-3 w-3" />
                          Pause
                        </>
                      )}
                    </Button>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <LiveTickers />
    </div>
  );
}

/**
 * Which watchlist tickers the live pipeline fetches and analyzes. Reads the
 * backend's selection (GET /api/active-tickers) and saves the whole set
 * (POST /controls/tickers). `draft` holds unsaved edits; null = show what the
 * server has.
 */
function LiveTickers() {
  const active = useActiveTickers();
  const save = usePostActiveTickers();
  const [draft, setDraft] = useState<string[] | null>(null);

  if (active.isLoading) {
    return (
      <section className="flex items-center rounded-xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading live tickers…
      </section>
    );
  }
  if (active.isError || !active.data) {
    return <ErrorState message={active.error?.message ?? "Failed to load the live ticker selection"} />;
  }

  const watchlist = active.data.watchlist ?? [];
  if (watchlist.length === 0) return null;

  const serverActive = active.data.active ?? watchlist;
  const selected = draft ?? serverActive;
  const off = watchlist.filter((t) => !serverActive.includes(t));
  const dirty =
    draft != null && (draft.length !== serverActive.length || draft.some((t) => !serverActive.includes(t)));

  const toggleTicker = (t: string) => {
    setDraft((prev) => {
      const cur = prev ?? serverActive;
      return cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t];
    });
  };

  const onSave = () => {
    save.mutate(
      { tickers: selected },
      {
        onSuccess: () => {
          setDraft(null);
          toast.success("Live tickers saved");
        },
        onError: (e) => toast.error(`Failed: ${e.message}`),
      },
    );
  };

  return (
    <Collapsible defaultOpen={off.length > 0}>
      <section className="rounded-xl border border-border bg-card">
        <CollapsibleTrigger asChild>
          <button type="button" className="flex w-full items-center gap-2 px-4 py-3 text-left">
            <span className="font-display text-base font-semibold">Live tickers</span>
            <Pill tone="muted" size="sm">
              {serverActive.length} of {watchlist.length} active
            </Pill>
            <ChevronDown className="ml-auto h-4 w-4 text-muted-foreground" />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-3 border-t border-border p-4">
            {active.data.error && (
              <p className="text-xs text-[color:var(--paused)]">
                Could not read the ticker selection ({active.data.error}); showing every ticker as active.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {off.length === 0 ? "All tickers are active." : `Off: ${off.join(", ")}.`}
            </p>
            <div className="flex flex-wrap gap-2">
              {watchlist.map((t) => (
                <label
                  key={t}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition-colors",
                    selected.includes(t)
                      ? "border-primary bg-primary/15 text-primary"
                      : "border-border bg-muted/40 text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Checkbox
                    checked={selected.includes(t)}
                    onCheckedChange={() => toggleTicker(t)}
                    className="h-3.5 w-3.5"
                  />
                  <span className="font-mono">{t}</span>
                </label>
              ))}
            </div>
            {selected.length < watchlist.length && (
              <button
                type="button"
                onClick={() => setDraft(watchlist)}
                className="text-xs text-primary hover:underline"
              >
                Select all
              </button>
            )}
            <p className="text-[11px] text-muted-foreground">
              Affects new ingestion and analysis only. Open positions and pending entries keep being managed, and backtests are not affected.
              {selected.length === 0 && " Select at least one ticker (use the pause switches to stop everything)."}
            </p>
            <div className="flex justify-end gap-2">
              {dirty && (
                <Button variant="outline" size="sm" type="button" onClick={() => setDraft(null)}>
                  Reset
                </Button>
              )}
              <Button size="sm" type="button" onClick={onSave} disabled={!dirty || selected.length === 0 || save.isPending}>
                {save.isPending ? (
                  <>
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    Saving…
                  </>
                ) : (
                  "Save selection"
                )}
              </Button>
            </div>
          </div>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}
