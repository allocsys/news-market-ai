"use client";

import { useEffect, useState } from "react";
import { useDash } from "@/lib/dash/store";
import { TICKERS } from "@/lib/dash/mock-data";
import { useTheme } from "./theme-provider";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  Search, RefreshCw, Sun, Moon, Monitor, ChevronDown, LogOut,
  Command, X, Circle,
} from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { fmtRelativeTime } from "@/lib/dash/mock-data";

export function TopBar() {
  const tickerFilter = useDash((s) => s.tickerFilter);
  const setTickerFilter = useDash((s) => s.setTickerFilter);
  const autoRefresh = useDash((s) => s.autoRefresh);
  const setAutoRefresh = useDash((s) => s.setAutoRefresh);
  const lastRefreshedAt = useDash((s) => s.lastRefreshedAt);
  const markRefreshed = useDash((s) => s.markRefreshed);
  const currentUser = useDash((s) => s.currentUser);
  const logout = useDash((s) => s.logout);

  const { theme, setTheme } = useTheme();
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [, setNow] = useState(Date.now());

  // tick every 5s for relative-time label
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, [autoRefresh]);

  // simulated auto-refresh: refresh every refreshIntervalMs while autoRefresh is on and page visible
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        markRefreshed();
      }
    }, 15000);
    return () => clearInterval(id);
  }, [autoRefresh, markRefreshed]);

  // keyboard shortcut: / to focus search
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.key === "/" && document.activeElement?.tagName !== "INPUT" && document.activeElement?.tagName !== "TEXTAREA") {
        e.preventDefault();
        setSearchOpen(true);
      }
      if (e.key === "Escape") setSearchOpen(false);
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  function manualRefresh() {
    markRefreshed();
    toast.success("Refreshed", { description: "All panels re-read from the backend service binding." });
  }

  const filtered = searchQuery.trim().length === 0
    ? TICKERS
    : TICKERS.filter((t) =>
        t.symbol.toLowerCase().includes(searchQuery.toLowerCase()) ||
        t.name.toLowerCase().includes(searchQuery.toLowerCase())
      );

  return (
    <header className="sticky top-0 z-30 bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70 border-b border-border">
      <div className="h-14 px-4 md:px-6 flex items-center gap-3">
        {/* Mobile brand */}
        <div className="md:hidden flex items-center gap-2">
          <div className="size-7 rounded-md bg-gradient-to-br from-blue-500 to-blue-700 grid place-items-center">
            <span className="font-bold text-xs text-white">N</span>
          </div>
        </div>

        {/* Search trigger */}
        <button
          onClick={() => setSearchOpen(true)}
          className={cn(
            "group flex-1 max-w-md flex items-center gap-2.5 h-9 px-3 rounded-lg",
            "border border-border bg-muted/30 text-muted-foreground hover:bg-muted/60 transition-colors"
          )}
        >
          <Search className="size-4" />
          <span className="text-sm">
            {tickerFilter ? (
              <span className="flex items-center gap-1.5 text-foreground">
                <span className="size-1.5 rounded-full bg-primary" /> Filtering: {tickerFilter}
              </span>
            ) : (
              <span>Search ticker · AAPL, NVDA, …</span>
            )}
          </span>
          <kbd className="ml-auto hidden sm:inline-flex items-center gap-0.5 text-[10px] text-muted-foreground border border-border rounded px-1 py-0.5">
            /
          </kbd>
        </button>

        <div className="flex-1" />

        {/* Last refreshed indicator */}
        <div className="hidden lg:flex items-center gap-1.5 text-xs text-muted-foreground">
          <Circle className={cn("size-2", autoRefresh ? "text-emerald-500 pulse-dot" : "text-muted-foreground/40")} fill="currentColor" />
          <span className="tabular">{fmtRelativeTime(new Date(lastRefreshedAt).toISOString())}</span>
        </div>

        {/* Auto-refresh toggle */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className={cn(
                "h-9 px-2.5 rounded-lg border border-border flex items-center gap-1.5 text-xs",
                "hover:bg-muted/40 transition-colors",
                autoRefresh && "text-primary border-primary/40 bg-primary/10"
              )}
              title="Auto-refresh settings"
            >
              <RefreshCw className={cn("size-3.5", autoRefresh && "animate-spin")} style={{ animationDuration: "3s" }} />
              <span className="hidden sm:inline">{autoRefresh ? "Live" : "Paused"}</span>
              <ChevronDown className="size-3 opacity-60" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="text-xs">Auto-refresh</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => setAutoRefresh(true)} className="text-xs gap-2">
              <Circle className={cn("size-2", autoRefresh ? "text-emerald-500" : "text-muted-foreground")} fill="currentColor" />
              On — every 15s (gated by visibility)
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setAutoRefresh(false)} className="text-xs gap-2">
              <Circle className={cn("size-2", !autoRefresh ? "text-muted-foreground" : "text-muted-foreground/40")} fill="currentColor" />
              Pause — manual refresh only
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={manualRefresh} className="text-xs gap-2">
              <RefreshCw className="size-3.5" /> Refresh now
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Theme toggle */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="h-9 w-9 rounded-lg border border-border flex items-center justify-center hover:bg-muted/40 transition-colors"
              title="Toggle theme"
              aria-label="Toggle theme"
            >
              {theme === "dark" ? <Moon className="size-4" /> : theme === "light" ? <Sun className="size-4" /> : <Monitor className="size-4" />}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuLabel className="text-xs">Theme</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => setTheme("dark")} className="text-xs gap-2">
              <Moon className="size-3.5" /> Dark
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setTheme("light")} className="text-xs gap-2">
              <Sun className="size-3.5" /> Light
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setTheme("system")} className="text-xs gap-2">
              <Monitor className="size-3.5" /> System
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* User menu */}
        {currentUser && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="h-9 pl-1.5 pr-2 rounded-lg border border-border flex items-center gap-2 hover:bg-muted/40 transition-colors">
                <div className="size-6 rounded-full grid place-items-center text-white text-[10px] font-semibold bg-gradient-to-br from-blue-500 to-blue-600">
                  {currentUser[0]?.toUpperCase()}
                </div>
                <span className="text-xs font-medium hidden sm:block">{currentUser}</span>
                <ChevronDown className="size-3 opacity-60" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel className="text-xs">{currentUser}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => { if (confirm("Sign out?")) logout(); }} className="text-xs gap-2 text-red-500">
                <LogOut className="size-3.5" /> Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* Command palette search overlay */}
      {searchOpen && (
        <div
          className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-start justify-center p-4 md:p-12 animate-fade-in"
          onClick={() => setSearchOpen(false)}
        >
          <div
            className="w-full max-w-xl mt-[10vh] rounded-2xl border border-border bg-popover shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border">
              <Search className="size-4 text-muted-foreground" />
              <input
                autoFocus
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search ticker — e.g. AAPL, NVDA, …"
                className="flex-1 bg-transparent outline-none text-sm placeholder:text-muted-foreground"
              />
              {tickerFilter && (
                <button
                  onClick={() => { setTickerFilter(null); setSearchQuery(""); }}
                  className="text-[11px] flex items-center gap-1 px-2 py-0.5 rounded border border-border text-muted-foreground hover:bg-muted"
                >
                  Clear <X className="size-3" />
                </button>
              )}
              <kbd className="text-[10px] text-muted-foreground border border-border rounded px-1 py-0.5">ESC</kbd>
            </div>
            <div className="max-h-[50vh] overflow-y-auto scroll-thin p-2">
              {filtered.length === 0 && (
                <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                  No tickers match “{searchQuery}”.
                </div>
              )}
              {filtered.map((t) => (
                <button
                  key={t.symbol}
                  onClick={() => {
                    setTickerFilter(t.symbol);
                    setSearchOpen(false);
                    setSearchQuery("");
                    toast.success(`Filtering all sections by ${t.symbol}`, {
                      description: `Switched to ${t.name}. Active ticker filter is now ${t.symbol}.`,
                    });
                  }}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-muted/40 text-left"
                >
                  <div className="size-8 rounded-lg bg-muted/60 grid place-items-center text-[10px] font-semibold tracking-wider">
                    {t.symbol.slice(0, 4)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">{t.symbol}</div>
                    <div className="text-xs text-muted-foreground truncate">{t.name}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm tabular">${t.price.toFixed(2)}</div>
                    <div className={cn("text-xs tabular", t.changePct >= 0 ? "text-emerald-500" : "text-red-500")}>
                      {t.changePct >= 0 ? "+" : ""}{t.changePct.toFixed(2)}%
                    </div>
                  </div>
                </button>
              ))}
            </div>
            <div className="border-t border-border px-3 py-2 text-[10px] text-muted-foreground flex items-center gap-1.5">
              <Command className="size-3" /> Tip: press <kbd className="border border-border rounded px-1 py-0.5">/</kbd> anywhere to open this.
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
