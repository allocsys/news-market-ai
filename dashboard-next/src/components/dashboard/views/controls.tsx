"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { Pause, Play, AlertTriangle, ChevronDown, Loader2 } from "lucide-react";
import { useControls, usePostControlsSet } from "@/lib/api";
import { WATCHLIST } from "@/lib/mock-data";
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
  const [activeTickers, setActiveTickers] = useState<string[]>(WATCHLIST.map((w) => w.ticker));

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
    setFlag.mutate({ key, paused: !flags[key] });
  };

  const toggleTicker = (t: string) => {
    setActiveTickers((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
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

      {/* Live tickers */}
      <Collapsible>
        <section className="rounded-xl border border-border bg-card">
          <CollapsibleTrigger asChild>
            <button type="button" className="flex w-full items-center gap-2 px-4 py-3 text-left">
              <span className="font-display text-base font-semibold">Live tickers</span>
              <Pill tone="muted" size="sm">
                {activeTickers.length} of {WATCHLIST.length} active
              </Pill>
              <ChevronDown className="ml-auto h-4 w-4 text-muted-foreground" />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="space-y-3 border-t border-border p-4">
              <div className="flex flex-wrap gap-2">
                {WATCHLIST.map((t) => (
                  <label
                    key={t.ticker}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition-colors",
                      activeTickers.includes(t.ticker)
                        ? "border-primary bg-primary/15 text-primary"
                        : "border-border bg-muted/40 text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <Checkbox
                      checked={activeTickers.includes(t.ticker)}
                      onCheckedChange={() => toggleTicker(t.ticker)}
                      className="h-3.5 w-3.5"
                    />
                    <span className="font-mono">{t.ticker}</span>
                  </label>
                ))}
              </div>
              {activeTickers.length < WATCHLIST.length && (
                <button
                  type="button"
                  onClick={() => setActiveTickers(WATCHLIST.map((w) => w.ticker))}
                  className="text-xs text-primary hover:underline"
                >
                  Select all
                </button>
              )}
              <p className="text-[11px] text-muted-foreground">
                Affects new ingestion and analysis only. Open positions, pending entries, and in-flight backtests are not affected.
              </p>
              <div className="flex justify-end">
                <Button size="sm">Save selection</Button>
              </div>
            </div>
          </CollapsibleContent>
        </section>
      </Collapsible>
    </div>
  );
}
