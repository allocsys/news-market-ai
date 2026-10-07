"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";
import {
  Sidebar,
  MobileHeader,
  BottomNav,
  SectionTabs,
  ThemeToggle,
  SearchTrigger,
  Wordmark,
} from "@/components/dashboard/shell";
import { PageToolbar } from "@/components/dashboard/page-toolbar";
import { CommandPalette } from "@/components/dashboard/command-palette";
import { ViewErrorBoundary } from "@/components/dashboard/error-boundary";
import { MoreSheet } from "@/components/dashboard/more-sheet";
import { useAuth } from "@/components/auth-provider";
import { useLogout } from "@/lib/api";
import { getSection, getSiblingSections } from "@/lib/nav";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDown, LogOut, User } from "lucide-react";

import { OverviewView } from "@/components/dashboard/views/overview";
import { PositionsView } from "@/components/dashboard/views/positions";
import { SnapshotView } from "@/components/dashboard/views/snapshot";
import { ChartsView } from "@/components/dashboard/views/charts";
import { DecisionsView } from "@/components/dashboard/views/decisions";
import { PipelineView } from "@/components/dashboard/views/pipeline";
import { ActivityView } from "@/components/dashboard/views/activity";
import { LlmView } from "@/components/dashboard/views/llm";
import { BacktestView } from "@/components/dashboard/views/backtest";
import { BacktestDetailView } from "@/components/dashboard/views/backtest-detail";
import { BackfillView } from "@/components/dashboard/views/backfill";
import { HealthView } from "@/components/dashboard/views/health";
import { ControlsView } from "@/components/dashboard/views/controls";
import { MoreView } from "@/components/dashboard/views/more";

interface NavigateOpts {
  ticker?: string;
  decisionId?: string;
  llmCallId?: number;
  backtestId?: string;
}

export default function Home() {
  const { user, loading, logout: _logout } = useAuth();
  const router = useRouter();
  const logoutMutation = useLogout();

  const [section, setSection] = useState<string>("overview");
  const [env, setEnv] = useState<string>("live");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [moreSheetOpen, setMoreSheetOpen] = useState(false);
  const [tickerFilter, setTickerFilter] = useState<string | undefined>(undefined);
  const [backtestDetailId, setBacktestDetailId] = useState<string | null>(null);

  // Auth gate: redirect to /login when not authenticated
  useEffect(() => {
    if (!loading && !user) {
      const from = encodeURIComponent("/");
      router.replace(`/login?from=${from}`);
    }
  }, [loading, user, router]);

  // Open command palette via Cmd/Ctrl+K
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Scroll to top on section change
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.scrollTo({ top: 0, behavior: "instant" });
    }
  }, [section, backtestDetailId]);

  const handleNavigate = useCallback(
    (id: string, opts: NavigateOpts = {}) => {
      setSection(id);
      setTickerFilter(opts.ticker);
      if (id === "backtest" && opts.backtestId) {
        setBacktestDetailId(opts.backtestId);
      } else if (id !== "backtest") {
        setBacktestDetailId(null);
      }
      setMoreSheetOpen(false);
    },
    [],
  );

  const handleEnvChange = useCallback((newEnv: string) => {
    setEnv(newEnv);
  }, []);

  const activeSection = getSection(section);
  const envAware = activeSection?.envAware ?? false;

  // Loading state while we check the session
  if (loading || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
          <p className="text-sm">Loading dashboard…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar activeSection={section} onNavigate={handleNavigate} />

      <div className="flex min-w-0 flex-1 flex-col">
        <MobileHeader onOpenSearch={() => setPaletteOpen(true)} />

        {/* Desktop search trigger row */}
        <div className="hidden border-b border-border bg-background/85 px-6 py-2 backdrop-blur lg:block">
          <div className="flex items-center gap-3">
            <SearchTrigger onClick={() => setPaletteOpen(true)} />
            <ThemeToggle />
            <UserMenu username={user.username} onLogout={() => logoutMutation.mutate()} />
          </div>
        </div>

        {/* Page toolbar (env selector + refresh + auto-refresh + export) */}
        <PageToolbar
          env={env}
          onEnvChange={handleEnvChange}
          envAware={envAware}
        />

        {/* Mobile section tabs (segmented control) */}
        {getSiblingSections(section).length > 1 && (
          <div className="border-b border-border bg-background/85 px-3 py-2 backdrop-blur lg:hidden">
            <SectionTabs activeSection={section} onNavigate={handleNavigate} />
          </div>
        )}

        <main className="flex-1 px-3 pb-24 pt-4 md:px-6 lg:pb-12">
          {/* Env warning when viewing a backtest */}
          {env !== "live" && envAware && (
            <div className="mb-4 flex items-center gap-2 rounded-lg border border-[color:var(--info)]/25 bg-[color:var(--info)]/8 px-3 py-2 text-xs">
              <span className="font-mono font-medium text-[color:var(--info)]">
                Viewing backtest {env}
              </span>
              <span className="text-muted-foreground">— simulated results, not live trading</span>
              <button
                type="button"
                onClick={() => setEnv("live")}
                className="ml-auto text-[color:var(--info)] hover:underline"
              >
                Back to live
              </button>
            </div>
          )}

          <div className="mx-auto max-w-5xl">
            <ViewErrorBoundary
              key={`${section}|${env}|${backtestDetailId ?? ""}`}
              onReset={env !== "live" ? () => setEnv("live") : undefined}
            >
              {renderSection()}
            </ViewErrorBoundary>
          </div>
        </main>

        <BottomNav
          activeSection={section}
          onNavigate={handleNavigate}
          onOpenMore={() => setMoreSheetOpen(true)}
        />
      </div>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onNavigateSection={handleNavigate}
        onNavigateTicker={(t) => {
          handleNavigate("llm", { ticker: t });
        }}
      />

      <MoreSheet
        open={moreSheetOpen}
        onOpenChange={setMoreSheetOpen}
        activeSection={section}
        onNavigate={handleNavigate}
      />
    </div>
  );

  function renderSection() {
    const viewProps = {
      onNavigate: handleNavigate,
      env,
      onEnvChange: handleEnvChange,
    };

    // Special case: backtest detail (when backtestId is set)
    if (section === "backtest" && backtestDetailId) {
      return (
        <BacktestDetailView
          {...viewProps}
          backtestId={backtestDetailId}
          onClose={() => setBacktestDetailId(null)}
        />
      );
    }

    switch (section) {
      case "overview":
        return <OverviewView {...viewProps} />;
      case "positions":
        return <PositionsView {...viewProps} />;
      case "snapshot":
        return <SnapshotView {...viewProps} />;
      case "charts":
        return <ChartsView {...viewProps} />;
      case "decisions":
        return <DecisionsView {...viewProps} tickerFilter={tickerFilter} />;
      case "pipeline":
        return <PipelineView {...viewProps} />;
      case "activity":
        return <ActivityView {...viewProps} />;
      case "llm":
        return <LlmView {...viewProps} tickerFilter={tickerFilter} />;
      case "backtest":
        return <BacktestView {...viewProps} />;
      case "backfill":
        return <BackfillView {...viewProps} />;
      case "health":
        return <HealthView {...viewProps} />;
      case "controls":
        return <ControlsView {...viewProps} />;
      case "more":
        return <MoreView {...viewProps} />;
      default:
        return <OverviewView {...viewProps} />;
    }
  }
}

function UserMenu({
  username,
  onLogout,
}: {
  username: string;
  onLogout: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-accent/40"
        >
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/15 text-primary">
            <User className="h-3 w-3" />
          </span>
          <span className="hidden sm:inline">{username}</span>
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[200px]">
        <DropdownMenuLabel className="font-mono text-xs">{username}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onLogout} className="text-[color:var(--short)] focus:text-[color:var(--short)]">
          <LogOut className="mr-2 h-3.5 w-3.5" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
