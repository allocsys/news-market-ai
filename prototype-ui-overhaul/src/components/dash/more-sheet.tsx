"use client";

import { useDash } from "@/lib/dash/store";
import { NAV_ITEMS } from "@/lib/dash/mock-data";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard, Wallet, BarChart3, GitPullRequestArrow, Briefcase, LineChart,
  Workflow, BrainCircuit, DatabaseBackup, FlaskConical, HeartPulse, Settings,
  type LucideIcon,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  LayoutDashboard, Wallet, BarChart3, GitPullRequestArrow, Briefcase, LineChart,
  Workflow, BrainCircuit, DatabaseBackup, FlaskConical, HeartPulse, Settings,
};

const GROUP_LABELS: Record<string, string> = {
  monitor: "Monitor",
  ops: "Operations",
  system: "System",
};

export function MoreSheet() {
  const open = useDash((s) => s.moreSheetOpen);
  const setOpen = useDash((s) => s.setMoreSheetOpen);
  const setView = useDash((s) => s.setView);
  const activeView = useDash((s) => s.activeView);

  function go(v: typeof NAV_ITEMS[number]["id"]) {
    setView(v);
    setOpen(false);
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent side="bottom" className="h-[80vh] p-0">
        <SheetHeader className="px-5 py-4 border-b border-border">
          <SheetTitle className="text-base">All sections</SheetTitle>
          <p className="text-xs text-muted-foreground mt-1">
            12 sections grouped by function. Tap any to jump there — your global ticker
            filter and env selector stay active.
          </p>
        </SheetHeader>
        <div className="overflow-y-auto scroll-thin px-5 py-4 space-y-5 pb-safe">
          {(["monitor", "ops", "system"] as const).map((g) => {
            const items = NAV_ITEMS.filter((n) => n.group === g);
            if (!items.length) return null;
            return (
              <div key={g} className="space-y-2">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {GROUP_LABELS[g]}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {items.map((item) => {
                    const Icon = ICONS[item.icon] ?? LayoutDashboard;
                    const isActive = activeView === item.id;
                    return (
                      <button
                        key={item.id}
                        onClick={() => go(item.id)}
                        className={cn(
                          "flex items-center gap-2.5 p-3 rounded-xl border text-left transition-colors",
                          isActive
                            ? "border-primary/40 bg-primary/10 text-primary"
                            : "border-border bg-card hover:bg-muted/40"
                        )}
                      >
                        <Icon className="size-4 shrink-0" />
                        <span className="text-sm font-medium">{item.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </SheetContent>
    </Sheet>
  );
}
