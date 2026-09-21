"use client";

import { Suspense } from "react";
import { useDash } from "@/lib/dash/store";
import { Sidebar, BottomNav } from "./shell";
import { TopBar } from "./top-bar";
import { MoreSheet } from "./more-sheet";
import { OverviewView } from "./views/overview";
import { SnapshotView } from "./views/snapshot";
import { ActivityView } from "./views/activity";
import { ChartsView } from "./views/charts";
import { HealthView } from "./views/health";
import { DecisionsView } from "./views/decisions";
import { PositionsView } from "./views/positions";
import { PipelineView } from "./views/pipeline";
import { LlmCallsView } from "./views/llm-calls";
import { BackfillView } from "./views/backfill";
import { BacktestView } from "./views/backtest";
import { SettingsView } from "./views/settings";
import { PageSkeleton } from "./shared/skeleton";
import type { ViewId } from "@/lib/dash/types";

const VIEW_RENDERERS: Record<ViewId, React.ComponentType> = {
  overview: OverviewView,
  snapshot: SnapshotView,
  activity: ActivityView,
  charts: ChartsView,
  health: HealthView,
  decisions: DecisionsView,
  positions: PositionsView,
  pipeline: PipelineView,
  llm: LlmCallsView,
  backfill: BackfillView,
  backtest: BacktestView,
  settings: SettingsView,
};

export function DashboardShell() {
  const activeView = useDash((s) => s.activeView);

  const View = VIEW_RENDERERS[activeView] ?? OverviewView;

  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar />
      <div className="flex-1 min-w-0 flex flex-col">
        <TopBar />
        <main className="flex-1 px-4 md:px-6 pt-5 pb-24 md:pb-8">
          <div className="max-w-[1400px] mx-auto">
            <Suspense fallback={<PageSkeleton />}>
              <div key={activeView} className="animate-fade-in">
                <View />
              </div>
            </Suspense>
          </div>
        </main>
      </div>
      <BottomNav />
      <MoreSheet />
    </div>
  );
}
