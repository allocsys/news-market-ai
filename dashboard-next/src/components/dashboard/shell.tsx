"use client";

import { cn } from "@/lib/utils";
import { useTheme } from "@/components/theme-provider";
import { Moon, Sun, Search, Command } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  NAV_SECTIONS,
  NAV_GROUPS,
  MOBILE_TABS,
  getSection,
  getSiblingSections,
} from "@/lib/nav";
import { StatusDot } from "./primitives";

// ============================================================
// Theme toggle
// ============================================================
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, toggleTheme } = useTheme();
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggleTheme}
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
      className={cn("h-9 w-9", className)}
    >
      {theme === "dark" ? (
        <Sun className="h-4 w-4" />
      ) : (
        <Moon className="h-4 w-4" />
      )}
    </Button>
  );
}

// ============================================================
// Wordmark
// ============================================================
export function Wordmark({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/15 ring-1 ring-primary/30">
        <span className="font-display text-sm font-semibold text-primary">N</span>
      </div>
      <div className="leading-none">
        <p className="font-display text-sm font-semibold tracking-tight">
          news<span className="text-primary">·</span>market<span className="text-primary">·</span>ai
        </p>
        <p className="mt-0.5 text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
          ops dashboard
        </p>
      </div>
    </div>
  );
}

// ============================================================
// Desktop sidebar
// ============================================================
export function Sidebar({
  activeSection,
  onNavigate,
  className,
}: {
  activeSection: string;
  onNavigate: (id: string) => void;
  className?: string;
}) {
  return (
    <aside
      className={cn(
        "hidden w-[248px] shrink-0 flex-col border-r border-border bg-sidebar lg:flex",
        className,
      )}
    >
      <div className="flex h-14 items-center px-4 pt-safe">
        <Wordmark />
      </div>
      <nav aria-label="Primary" className="flex-1 overflow-y-auto px-2 py-3">
        {NAV_GROUPS.map((group) => {
          const sections = group.sections
            .map((id) => getSection(id))
            .filter((s): s is NonNullable<typeof s> => Boolean(s));
          if (!sections.length) return null;
          return (
            <div key={group.id} className="mb-4">
              {sections.length > 1 && (
                <p className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  {group.label}
                </p>
              )}
              <ul className="space-y-0.5">
                {sections.map((s) => {
                  const Icon = s.icon;
                  const active = activeSection === s.id;
                  return (
                    <li key={s.id}>
                      <button
                        type="button"
                        onClick={() => onNavigate(s.id)}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors",
                          active
                            ? "bg-sidebar-accent text-sidebar-accent-foreground"
                            : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
                        )}
                      >
                        <Icon
                          className={cn(
                            "h-4 w-4 shrink-0",
                            active ? "text-primary" : "text-muted-foreground group-hover:text-foreground",
                          )}
                          aria-hidden
                        />
                        <span className="truncate font-medium">{s.label}</span>
                        {active && (
                          <span className="ml-auto h-1.5 w-1.5 rounded-full bg-primary" aria-hidden />
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>
      <div className="border-t border-border px-3 py-3">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-muted-foreground">v0.2.1 · redesign</span>
          <ThemeToggle />
        </div>
      </div>
    </aside>
  );
}

// ============================================================
// Mobile top app bar
// ============================================================
export function MobileHeader({
  onOpenSearch,
  className,
}: {
  onOpenSearch: () => void;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "glass sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border px-3 pt-safe lg:hidden",
        className,
      )}
    >
      <Wordmark />
      <div className="ml-auto flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9"
          onClick={onOpenSearch}
          aria-label="Search"
        >
          <Search className="h-4 w-4" />
        </Button>
        <ThemeToggle />
      </div>
    </header>
  );
}

// ============================================================
// Mobile bottom tab bar
// ============================================================
export function BottomNav({
  activeSection,
  onNavigate,
  onOpenMore,
  className,
}: {
  activeSection: string;
  onNavigate: (id: string) => void;
  onOpenMore: () => void;
  className?: string;
}) {
  // Map active section → which mobile tab is highlighted
  const activeGroup = (() => {
    const sec = getSection(activeSection);
    if (!sec) return "today";
    if (sec.group === "system") return "more";
    return sec.group;
  })();

  return (
    <nav
      aria-label="Mobile primary"
      className={cn(
        "glass pb-safe fixed inset-x-0 bottom-0 z-30 flex items-stretch border-t border-border lg:hidden",
        className,
      )}
    >
      {MOBILE_TABS.map((tab) => {
        const Icon = tab.icon;
        const active = activeGroup === tab.id;
        if (tab.id === "more") {
          return (
            <button
              key="more"
              type="button"
              onClick={onOpenMore}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-medium",
                active ? "text-primary" : "text-muted-foreground",
              )}
            >
              <Icon className="h-5 w-5" aria-hidden />
              More
            </button>
          );
        }
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onNavigate(tab.sectionId)}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-medium",
              active ? "text-primary" : "text-muted-foreground",
            )}
          >
            <Icon className="h-5 w-5" aria-hidden />
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
}

// ============================================================
// Section sub-tabs (segmented control — mobile, when group has multiple sections)
// ============================================================
export function SectionTabs({
  activeSection,
  onNavigate,
  className,
}: {
  activeSection: string;
  onNavigate: (id: string) => void;
  className?: string;
}) {
  const siblings = getSiblingSections(activeSection);
  if (siblings.length < 2) return null;

  return (
    <div
      className={cn(
        "no-scrollbar flex gap-1 overflow-x-auto rounded-lg border border-border bg-muted/40 p-1",
        className,
      )}
      role="tablist"
    >
      {siblings.map((s) => {
        const Icon = s.icon;
        const active = activeSection === s.id;
        return (
          <button
            key={s.id}
            role="tab"
            aria-selected={active}
            type="button"
            onClick={() => onNavigate(s.id)}
            className={cn(
              "flex flex-1 shrink-0 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
              active
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden />
            {s.label}
          </button>
        );
      })}
    </div>
  );
}

// ============================================================
// Env selector — sticky pill row, switch between live and backtests
// ============================================================
import { useBacktestRuns } from "@/lib/api";
import type { BacktestRun } from "@/lib/types";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, Check } from "lucide-react";

type EnvStatus = "live" | "running" | "paused" | "complete" | "failed";
interface EnvOption {
  id: string;
  label: string;
  status: EnvStatus;
}

/** "AAPL, MSFT +2 · 2026-09-01", plus a status suffix for anything not complete (same as the old selector). */
function runEnvLabel(run: BacktestRun): string {
  const tickers = Array.isArray(run.tickers) ? run.tickers : [];
  const shown = tickers.slice(0, 3).join(", ");
  const more = tickers.length > 3 ? ` +${tickers.length - 3}` : "";
  const date = typeof run.testStart === "string" ? run.testStart.slice(0, 10) : "";
  const base = [shown + more || run.id, date].filter(Boolean).join(" · ");
  return run.status && run.status !== "complete" ? `${base} (${run.status})` : base;
}

function runEnvStatus(run: BacktestRun): EnvStatus {
  const s = String(run.status);
  if (s === "running" || s === "queued") return "running";
  if (s === "paused") return "paused";
  if (s === "failed" || s === "cancelled") return "failed";
  return "complete";
}

/** Live first, then non-failed runs, then failed ones; the active env is always present. */
function buildEnvironments(runs: BacktestRun[], active: string): EnvOption[] {
  const toOption = (r: BacktestRun): EnvOption => ({ id: r.id, label: runEnvLabel(r), status: runEnvStatus(r) });
  const ok = runs.filter((r) => runEnvStatus(r) !== "failed").map(toOption);
  const failed = runs.filter((r) => runEnvStatus(r) === "failed").map(toOption);
  const list: EnvOption[] = [{ id: "live", label: "Live", status: "live" }, ...ok, ...failed];
  if (!list.some((e) => e.id === active)) list.push({ id: active, label: active, status: "complete" });
  return list;
}

export function EnvSelector({
  env,
  onEnvChange,
  className,
}: {
  env: string;
  onEnvChange: (env: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const backtestRuns = useBacktestRuns();

  // Close on an outside tap. A `fixed inset-0` overlay doesn't work here: the page
  // toolbar has backdrop-blur, which makes fixed descendants span only the toolbar.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);
  const environments = buildEnvironments(backtestRuns.data?.backtestRuns ?? [], env);
  const current = environments.find((e) => e.id === env) ?? environments[0];
  const isLive = current.id === "live";

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="flex w-full items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-sm transition-colors hover:bg-accent/40"
      >
        <StatusDot status={current.status === "live" ? "live" : (current.status as "running" | "paused" | "complete" | "failed")} />
        <span className="truncate font-medium">{isLive ? "Live" : current.label}</span>
        {!isLive && (
          <span className="rounded bg-[color:var(--info)]/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[color:var(--info)]">
            Backtest
          </span>
        )}
        <ChevronDown className="ml-auto h-3.5 w-3.5 text-muted-foreground" aria-hidden />
      </button>
      {open && (
        <>
          <ul
            role="listbox"
            className="absolute z-50 mt-1 max-h-72 w-full min-w-[260px] overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-xl"
          >
            {environments.map((e) => {
              const active = e.id === env;
              return (
                <li key={e.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={active}
                    onClick={() => {
                      onEnvChange(e.id);
                      setOpen(false);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors",
                      active ? "bg-accent/60" : "hover:bg-accent/40",
                    )}
                  >
                    <StatusDot status={e.status === "live" ? "live" : (e.status as "running" | "paused" | "complete" | "failed")} />
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium">{e.id === "live" ? "Live" : e.label}</span>
                    </span>
                    {active && <Check className="h-3.5 w-3.5 text-primary" />}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

// ============================================================
// Command palette trigger — keyboard shortcut hint
// ============================================================
export function SearchTrigger({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <Search className="h-3.5 w-3.5" aria-hidden />
      <span>Search tickers, sections…</span>
      <kbd className="ml-auto flex items-center gap-0.5 rounded border border-border bg-card px-1.5 py-0.5 text-[10px] font-mono">
        <Command className="h-2.5 w-2.5" />K
      </kbd>
    </button>
  );
}
