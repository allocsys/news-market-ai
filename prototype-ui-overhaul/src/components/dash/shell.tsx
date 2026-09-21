"use client";

import { useDash } from "@/lib/dash/store";
import { NAV_ITEMS, MOBILE_NAV_IDS } from "@/lib/dash/mock-data";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard, Wallet, BarChart3, GitPullRequestArrow, Briefcase, LineChart,
  Workflow, BrainCircuit, DatabaseBackup, FlaskConical, HeartPulse, Settings,
  MoreHorizontal, type LucideIcon,
} from "lucide-react";
import type { ViewId } from "@/lib/dash/types";

const ICONS: Record<string, LucideIcon> = {
  LayoutDashboard, Wallet, BarChart3, GitPullRequestArrow, Briefcase, LineChart,
  Workflow, BrainCircuit, DatabaseBackup, FlaskConical, HeartPulse, Settings,
};

const GROUP_LABELS: Record<string, string> = {
  monitor: "Monitor",
  ops: "Operations",
  system: "System",
};

export function Sidebar() {
  const activeView = useDash((s) => s.activeView);
  const setView = useDash((s) => s.setView);
  const env = useDash((s) => s.env);
  const currentUser = useDash((s) => s.currentUser);
  const setMoreSheetOpen = useDash((s) => s.setMoreSheetOpen);

  const groups: ("monitor" | "ops" | "system")[] = ["monitor", "ops", "system"];

  return (
    <aside
      className={cn(
        "hidden md:flex flex-col",
        "lg:w-[248px] md:w-[72px] shrink-0",
        "border-r border-border bg-sidebar/40 backdrop-blur",
        "sticky top-0 h-screen"
      )}
    >
      {/* Brand */}
      <div className="h-14 px-4 lg:px-5 flex items-center gap-2.5 border-b border-border/60">
        <div className="size-8 rounded-lg bg-gradient-to-br from-blue-500 to-blue-700 grid place-items-center shadow-md shadow-blue-500/30 shrink-0">
          <span className="font-bold text-sm tracking-tight text-white">N</span>
        </div>
        <div className="hidden lg:block min-w-0">
          <div className="font-semibold text-sm tracking-tight leading-tight truncate">news-market-ai</div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-wider truncate">
            {env === "live" ? "live" : env.replace("backtest-", "bt · ")}
          </div>
        </div>
      </div>

      {/* Nav groups */}
      <nav className="flex-1 overflow-y-auto scroll-thin py-3 px-2 space-y-4">
        {groups.map((g) => {
          const items = NAV_ITEMS.filter((n) => n.group === g);
          if (items.length === 0) return null;
          return (
            <div key={g} className="space-y-1">
              <div className="hidden lg:block px-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                {GROUP_LABELS[g]}
              </div>
              {items.map((item) => {
                const Icon = ICONS[item.icon] ?? LayoutDashboard;
                const isActive = activeView === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => setView(item.id)}
                    aria-current={isActive ? "page" : undefined}
                    title={item.label}
                    className={cn(
                      "group relative w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm transition-colors",
                      "md:justify-center lg:justify-start",
                      isActive
                        ? "text-primary"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted/40"
                    )}
                  >
                    {isActive && (
                      <span
                        className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-[3px] rounded-r bg-primary"
                        aria-hidden
                      />
                    )}
                    <Icon className={cn("size-4 shrink-0", isActive && "text-primary")} />
                    <span className="hidden lg:block truncate">{item.label}</span>
                    {/* Mobile/tablet hover tooltip */}
                    <span
                      role="tooltip"
                      className={cn(
                        "md:lg:hidden pointer-events-none absolute left-full ml-2 z-50 px-2 py-1 rounded-md",
                        "bg-popover text-popover-foreground text-xs border border-border shadow-md",
                        "opacity-0 group-hover:opacity-100 transition-opacity"
                      )}
                    >
                      {item.label}
                    </span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="border-t border-border/60 p-3 space-y-2">
        <div className="hidden lg:flex items-center justify-between text-[11px] text-muted-foreground">
          <span>generated {new Date().toLocaleTimeString("en-US", { hour12: false })} UTC</span>
        </div>
        {currentUser && (
          <UserChip />
        )}
      </div>
    </aside>
  );
}

function UserChip() {
  const currentUser = useDash((s) => s.currentUser);
  const logout = useDash((s) => s.logout);
  if (!currentUser) return null;
  const HUES: Record<string, string> = {
    blue: "from-blue-500 to-blue-600",
    emerald: "from-emerald-500 to-emerald-600",
    amber: "from-amber-500 to-amber-600",
    purple: "from-purple-500 to-purple-600",
  };
  return (
    <button
      onClick={() => {
        if (confirm("Sign out?")) logout();
      }}
      className={cn(
        "w-full flex items-center gap-2.5 p-2 rounded-lg border border-border bg-card hover:bg-muted/40 transition-colors",
        "md:justify-center lg:justify-start"
      )}
      title={`Sign out ${currentUser.displayName}`}
    >
      <div
        className={cn(
          "size-7 rounded-full grid place-items-center text-white text-[11px] font-semibold shrink-0 bg-gradient-to-br",
          HUES[currentUser.hue]
        )}
      >
        {currentUser.initials}
      </div>
      <div className="hidden lg:block min-w-0">
        <div className="text-xs font-medium truncate">{currentUser.displayName}</div>
        <div className="text-[10px] text-muted-foreground truncate">Sign out →</div>
      </div>
    </button>
  );
}

export function BottomNav() {
  const activeView = useDash((s) => s.activeView);
  const setView = useDash((s) => s.setView);
  const setMoreSheetOpen = useDash((s) => s.setMoreSheetOpen);

  const items = NAV_ITEMS.filter((n) => MOBILE_NAV_IDS.includes(n.id));
  // Use 5 items max for the bar + "More" button
  const visible = items.slice(0, 5);

  return (
    <nav
      className={cn(
        "md:hidden fixed bottom-0 inset-x-0 z-40",
        "border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80",
        "pb-safe"
      )}
      aria-label="Mobile navigation"
    >
      <div className="flex items-stretch">
        {visible.map((item) => {
          const Icon = ICONS[item.icon] ?? LayoutDashboard;
          const isActive = activeView === item.id;
          return (
            <button
              key={item.id}
              onClick={() => setView(item.id)}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "flex-1 min-h-[48px] flex flex-col items-center justify-center gap-0.5 py-1.5 px-1",
                "text-[10px] font-medium transition-colors",
                isActive ? "text-primary" : "text-muted-foreground"
              )}
            >
              <Icon className="size-5" />
              <span className="truncate max-w-full">{item.label}</span>
            </button>
          );
        })}
        <button
          onClick={() => setMoreSheetOpen(true)}
          aria-label="More navigation"
          className={cn(
            "flex-1 min-h-[48px] flex flex-col items-center justify-center gap-0.5 py-1.5 px-1",
            "text-[10px] font-medium text-muted-foreground"
          )}
        >
          <MoreHorizontal className="size-5" />
          <span>More</span>
        </button>
      </div>
    </nav>
  );
}
