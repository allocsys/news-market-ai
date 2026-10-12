"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { Pause, Play, ChevronDown, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useControls, usePostControlsSet, useActiveTickers, usePostActiveTickers, useMacro, usePostMacro, useKnobs, usePostKnobs, useSwitches, usePostSwitches, SWITCH_NAMES, type KnobName, type SwitchName } from "@/lib/api";
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
  const anyPaused = pausedCount > 0;
  const allPaused = pausedCount === PAUSE_META.length;

  const setAll = (paused: boolean) => {
    setFlag.mutate(
      { key: "all", paused },
      { onError: (e) => toast.error(`Failed: ${e.message}`) },
    );
  };

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

      {/* Master switches. Pausing everything stays one tap (kill switch); resuming asks first. */}
      <div className="flex flex-wrap gap-2">
        {!allPaused && (
          <Button
            variant="outline"
            className="min-w-[9rem] flex-1 border-[color:var(--paused)]/40 text-[color:var(--paused)]"
            onClick={() => setAll(true)}
            disabled={setFlag.isPending}
          >
            <Pause className="mr-1 h-3 w-3" />
            Pause all
          </Button>
        )}
        {anyPaused && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="outline"
                className="min-w-[9rem] flex-1 border-[color:var(--long)]/40 text-[color:var(--long)]"
                disabled={setFlag.isPending}
              >
                <Play className="mr-1 h-3 w-3" />
                Resume all
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Resume everything?</AlertDialogTitle>
                <AlertDialogDescription>
                  Ingestion, trading, LLM calls and backtests all start again. This may spend model quota and place trades.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => setAll(false)}>Resume all</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>

      <LiveTickers />
      <MacroSwitch />
      <DecisionSwitches />
      <LiveKnobs />
    </div>
  );
}

/**
 * Live XAUUSD macro context (FRED + CFTC COT). Reads GET /api/macro and flips
 * it with POST /controls/macro. Default OFF; turning it on starts the vendor
 * fetches and adds the macro block to the analysts' prompts. Backtests have
 * their own per-run option and ignore this switch.
 */
function MacroSwitch() {
  const macro = useMacro();
  const setMacro = usePostMacro();

  if (macro.isLoading) {
    return (
      <section className="flex items-center rounded-xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading macro context…
      </section>
    );
  }
  if (macro.isError || !macro.data) {
    return <ErrorState message={macro.error?.message ?? "Failed to load the macro context switch"} />;
  }

  const { enabled, updatedAt, updatedBy, hasFredKey, error } = macro.data;
  const set = (next: boolean) =>
    setMacro.mutate(
      { enabled: next },
      {
        onSuccess: () => toast.success(next ? "Macro context enabled" : "Macro context disabled"),
        onError: (e) => toast.error(`Failed: ${e.message}`),
      },
    );

  return (
    <section className="rounded-xl border border-border bg-card p-4 card-hairline">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-display text-base font-semibold">Macro context (XAUUSD)</span>
            <Pill tone={enabled ? "long" : "muted"} size="sm">
              {enabled ? "On" : "Off"}
            </Pill>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            FRED series and CFTC positioning for gold, added to the analysts' input. Off by default; backtests choose per run.
          </p>
          <p className="mt-1 text-[10px] text-muted-foreground">
            Last changed {updatedAt ? fmtRelative(updatedAt) : "—"} by {updatedBy ?? "—"}
          </p>
          {error && (
            <p className="mt-1 text-xs text-[color:var(--paused)]">
              Could not read the switch ({error}); treated as off.
            </p>
          )}
          {!hasFredKey && (
            <p className="mt-1 text-xs text-[color:var(--paused)]">
              FRED_API_KEY is not set on the backend, so turning this on would only fetch CFTC positioning.
            </p>
          )}
        </div>
        <div className="shrink-0">
          {enabled ? (
            <Button variant="outline" size="sm" onClick={() => set(false)} disabled={setMacro.isPending}>
              <Pause className="mr-1 h-3 w-3" />
              Turn off
            </Button>
          ) : (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="border-[color:var(--long)]/40 text-[color:var(--long)]"
                  disabled={setMacro.isPending}
                >
                  <Play className="mr-1 h-3 w-3" />
                  Turn on
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Turn on macro context?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Each XAUUSD tick will fetch FRED and CFTC data, and the analysts will see it in their prompts. This uses vendor requests and extra prompt tokens, and can change live decisions.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => set(true)}>Turn on</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>
    </section>
  );
}

const SWITCH_INFO: Record<SwitchName, { label: string; hint: string }> = {
  intradayTechnical: { label: "Intraday price for the technical analyst", hint: "The technical read uses the latest price visible at decision time instead of only the last daily close." },
  independenceNote: { label: "Evidence rule in judge prompts", hint: "Judge prompts remind the model that agreeing analysts count as one source, not several." },
};

/**
 * Live decision switches (default OFF). Reads GET /api/switches, flips with POST /controls/switches.
 * They apply to NEW decisions immediately (no position snapshot). Backtests have their own per-run
 * checkboxes and ignore these.
 */
function DecisionSwitches() {
  const sw = useSwitches();
  const setSw = usePostSwitches();

  if (sw.isLoading) {
    return (
      <section className="flex items-center rounded-xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading decision switches…
      </section>
    );
  }
  if (sw.isError || !sw.data) {
    return <ErrorState message={sw.error?.message ?? "Failed to load the decision switches"} />;
  }

  const { effective, meta, error } = sw.data;
  const set = (name: SwitchName, on: boolean) =>
    setSw.mutate(
      { set: { [name]: on ? 1 : 0 } },
      {
        onSuccess: () => toast.success(`${SWITCH_INFO[name].label} ${on ? "on" : "off"}`),
        onError: (e) => toast.error(`Failed: ${e.message}`),
      },
    );

  return (
    <section className="rounded-xl border border-border bg-card p-4 card-hairline">
      <span className="font-display text-base font-semibold">Decision switches</span>
      <p className="mt-1 text-xs text-muted-foreground">
        Off by default. Changes apply to the next live decision; backtests choose per run.
      </p>
      {error && (
        <p className="mt-1 text-xs text-[color:var(--paused)]">Could not read the switches ({error}); treated as off.</p>
      )}
      <div className="mt-3 space-y-3">
        {SWITCH_NAMES.map((name) => {
          const on = effective[name] === 1;
          const m = meta[name];
          return (
            <div key={name} className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{SWITCH_INFO[name].label}</span>
                  <Pill tone={on ? "long" : "muted"} size="sm">
                    {on ? "On" : "Off"}
                  </Pill>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">{SWITCH_INFO[name].hint}</p>
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  Last changed {m?.updatedAt ? fmtRelative(m.updatedAt) : "—"} by {m?.updatedBy ?? "—"}
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={() => set(name, !on)} disabled={setSw.isPending} className="shrink-0">
                {on ? (
                  <>
                    <Pause className="mr-1 h-3 w-3" />
                    Turn off
                  </>
                ) : (
                  <>
                    <Play className="mr-1 h-3 w-3" />
                    Turn on
                  </>
                )}
              </Button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

const R_KNOBS: { key: KnobName; label: string; hint: string }[] = [
  { key: "breakEvenTriggerR", label: "Break-even trigger", hint: "Move the stop to entry once the trade is up this many R." },
  { key: "trailActivationR", label: "Trail activation", hint: "Start trailing once the trade is up this many R." },
  { key: "trailDistanceR", label: "Trail distance", hint: "How far behind the best price the trailing stop sits." },
];

/**
 * Live break-even / trailing knobs. Reads GET /api/knobs, saves with POST /controls/knobs.
 * R = the position's initial stop distance; 0 = off. SNAPSHOT semantics: a saved value only applies to
 * positions opened afterwards; positions already open keep the knobs they opened with. `draft` holds
 * unsaved edits as strings (null = show what the server has). Backtests ignore these.
 */
function LiveKnobs() {
  const knobs = useKnobs();
  const save = usePostKnobs();
  const [draft, setDraft] = useState<Partial<Record<KnobName, string>> | null>(null);

  if (knobs.isLoading) {
    return (
      <section className="flex items-center rounded-xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading exit knobs…
      </section>
    );
  }
  if (knobs.isError || !knobs.data) {
    return <ErrorState message={knobs.error?.message ?? "Failed to load the exit knobs"} />;
  }

  const { effective, defaults, live, meta, error } = knobs.data;
  const d = draft ?? {};
  const text = (k: KnobName) => d[k] ?? String(effective[k]);
  const badR = (k: KnobName) => {
    const v = d[k];
    if (v === undefined) return false;
    const n = Number(v);
    return v.trim() === "" || !Number.isFinite(n) || n < 0 || n > 10;
  };
  const changed = (Object.keys(d) as KnobName[]).filter((k) => d[k] !== undefined && Number(d[k]) !== effective[k]);
  const invalid = R_KNOBS.some((m) => badR(m.key));
  const liveNames = Object.keys(live);
  const removesTarget = Number(text("trailRemovesTarget")) === 1;
  const lastChange = Object.values(meta).find((m) => m?.updatedAt);

  const edit = (k: KnobName, v: string) => setDraft((prev) => ({ ...(prev ?? {}), [k]: v }));

  const onSave = () => {
    const set: Partial<Record<KnobName, number>> = {};
    for (const k of changed) set[k] = Number(d[k]);
    save.mutate(
      { set },
      {
        onSuccess: () => {
          setDraft(null);
          toast.success("Exit knobs saved (applies to new positions)");
        },
        onError: (e) => toast.error(`Failed: ${e.message}`),
      },
    );
  };

  const onResetLive = () => {
    save.mutate(
      { clear: "all" },
      {
        onSuccess: () => {
          setDraft(null);
          toast.success("Exit knobs back to defaults");
        },
        onError: (e) => toast.error(`Failed: ${e.message}`),
      },
    );
  };

  return (
    <Collapsible defaultOpen={liveNames.length > 0}>
      <section className="rounded-xl border border-border bg-card">
        <CollapsibleTrigger asChild>
          <button type="button" className="flex w-full items-center gap-2 px-4 py-3 text-left">
            <span className="font-display text-base font-semibold">Exit knobs</span>
            <Pill tone={effective.breakEvenTriggerR > 0 || effective.trailActivationR > 0 ? "long" : "muted"} size="sm">
              {effective.breakEvenTriggerR > 0 || effective.trailActivationR > 0 ? "Active" : "Off"}
            </Pill>
            <ChevronDown className="ml-auto h-4 w-4 text-muted-foreground" />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-3 border-t border-border p-4">
            {error && (
              <p className="text-xs text-[color:var(--paused)]">
                Could not read the live values ({error}); showing the defaults.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Break-even and trailing stop, in R (1R = the position's initial stop distance; 0 = off). Applies only to positions opened after you save; open positions keep the values they opened with. Backtests ignore these.
            </p>
            {R_KNOBS.map((m) => (
              <label key={m.key} className="block">
                <span className="flex items-center justify-between gap-2 text-sm font-medium">
                  {m.label}
                  <span className="text-[10px] font-normal text-muted-foreground">
                    default {defaults[m.key]}{m.key in live ? " · overridden" : ""}
                  </span>
                </span>
                <input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={10}
                  step={0.05}
                  value={text(m.key)}
                  onChange={(e) => edit(m.key, e.target.value)}
                  className={cn(
                    "mt-1 w-full rounded-lg border bg-muted/40 px-3 py-2 font-mono text-sm outline-none focus:border-primary",
                    badR(m.key) ? "border-[color:var(--paused)]" : "border-border",
                  )}
                />
                <span className="mt-0.5 block text-[11px] text-muted-foreground">{m.hint}</span>
              </label>
            ))}
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <Checkbox
                checked={removesTarget}
                onCheckedChange={(v) => edit("trailRemovesTarget", v === true ? "1" : "0")}
                className="mt-0.5 h-4 w-4"
              />
              <span>
                Trailing removes the take-profit target
                <span className="block text-[11px] text-muted-foreground">
                  default {defaults.trailRemovesTarget === 1 ? "on" : "off"}{"trailRemovesTarget" in live ? " · overridden" : ""}
                </span>
              </span>
            </label>
            <p className="text-[10px] text-muted-foreground">
              {liveNames.length > 0
                ? `Overridden live: ${liveNames.join(", ")}.`
                : "No live overrides; using the defaults."}{" "}
              Last changed {lastChange?.updatedAt ? fmtRelative(lastChange.updatedAt) : "—"} by {lastChange?.updatedBy ?? "—"}.
            </p>
            <div className="flex justify-end gap-2">
              {liveNames.length > 0 && (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="outline" size="sm" type="button" disabled={save.isPending}>
                      Reset to defaults
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Reset exit knobs?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Removes the live overrides, so new positions use the default values again. Open positions are not changed.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={onResetLive}>Reset</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
              {draft && (
                <Button variant="outline" size="sm" type="button" onClick={() => setDraft(null)}>
                  Discard
                </Button>
              )}
              <Button size="sm" type="button" onClick={onSave} disabled={changed.length === 0 || invalid || save.isPending}>
                {save.isPending ? (
                  <>
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    Saving…
                  </>
                ) : (
                  "Save knobs"
                )}
              </Button>
            </div>
          </div>
        </CollapsibleContent>
      </section>
    </Collapsible>
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
